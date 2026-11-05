/** @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClaudeDomCapture, DOM_TEXT_SETTLE_MS } from "./claudeDomCapture";
import { claudeaiSpec } from "../main/capture/providers/claudeai";
import { turnSelectorsFor } from "../main/capture/providerDomSelectors";
const ipc = vi.hoisted(() => new Map<string, Function>());
vi.mock("electron", () => ({ipcMain: {on: vi.fn((name, fn) => ipc.set(name, fn)), off: vi.fn()}}));
import { DomObserverBridge } from "../main/capture/domObserverBridge";
let capture: ClaudeDomCapture;
let emit: ReturnType<typeof vi.fn>;
const user = (text: string) => `<div data-cds="UserMessage">${text}</div>`;
// "done" renders a reply as streaming and finish() flips it, as claude.ai does; "false" is a reply
// that was already complete when it appeared (history), which must never be captured.
const assistant = (text: string, streaming = "done") =>
  streaming === "done" ? `<div data-is-streaming="true" data-test-finish>${text}</div>` : `<div data-is-streaming="${streaming}">${text}</div>`;
function finish() {
  for (const node of document.querySelectorAll("[data-test-finish]")) {
    node.removeAttribute("data-test-finish"); node.setAttribute("data-is-streaming", "false");
  }
}
function start(html: string) {
  document.body.innerHTML = `<main>${html}</main>`;
  emit = vi.fn();
  capture = new ClaudeDomCapture(claudeaiSpec.domSelectors!, node => node.textContent?.trim() ?? "", emit);
  finish();
}
async function settle(ms = DOM_TEXT_SETTLE_MS) {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(ms);
}
const pairs = () => emit.mock.calls.map(([payload]) => payload);
beforeEach(() => vi.useFakeTimers());
afterEach(() => {capture?.stop(); document.body.replaceChildren(); vi.useRealTimers();});

it("uses the shared characterized selectors and keeps the legacy network parser", () => {
  expect(claudeaiSpec.primary).toBe("dom"); expect(claudeaiSpec.domEnabled).toBe(true);
  expect(claudeaiSpec.domSelectors!.userMessageSelectors).toBe(turnSelectorsFor("claudeai").user);
  expect(claudeaiSpec.domSelectors!.assistantMessageSelectors).toBe(turnSelectorsFor("claudeai").assistant);
  expect(claudeaiSpec.networkParser!.parseResponse('data: {"completion":"Hello"}\n\n').assistant_text).toBe("Hello");
});

it("captures a settled turn once, ignoring later text and unrelated mutations", async () => {
  start(user("PRIVATE_PROMPT") + assistant("PRIVATE_REPLY"));
  await settle();
  expect(pairs()).toEqual([{kind: "user_turn", text: "PRIVATE_PROMPT"}, {kind: "assistant_complete", final_text: "PRIVATE_REPLY"}]);
  document.querySelector("[data-is-streaming]")!.append(" extra");
  await settle(1000); expect(emit).toHaveBeenCalledTimes(2);
});

it("pairs several assistants with their latest preceding user across selector alternatives", async () => {
  start(user("First") + assistant("One") + '<div data-testid="user-message">Second</div>' + assistant("Two") + user("Third"));
  await settle();
  expect(pairs()).toEqual([{kind: "user_turn", text: "First"}, {kind: "assistant_complete", final_text: "One"},
    {kind: "user_turn", text: "Second"}, {kind: "assistant_complete", final_text: "Two"}]);
});

it("captures a regenerate on a new assistant node, even with identical prompt and reply", async () => {
  start(user("Same") + assistant("Same answer")); await settle();
  document.querySelector("[data-is-streaming]")!.remove();
  document.querySelector("main")!.insertAdjacentHTML("beforeend", assistant("Same answer"));
  await settle(10); finish();
  await settle(); expect(emit).toHaveBeenCalledTimes(4);
  expect(pairs()[2]).toEqual({kind: "user_turn", text: "Same"});
});

it("waits for the streaming attribute flip and then settles text, cancelling when streaming resumes", async () => {
  start(user("Question") + assistant("Partial", "true"));
  await settle(1000); expect(emit).not.toHaveBeenCalled();
  const node = document.querySelector("[data-is-streaming]")!;
  node.setAttribute("data-is-streaming", "false");
  await settle(150); node.textContent = "Final reply";
  await settle(200); expect(emit).not.toHaveBeenCalled();
  node.setAttribute("data-is-streaming", "true"); await settle(1000);
  expect(emit).not.toHaveBeenCalled();
  node.setAttribute("data-is-streaming", ""); await settle();
  expect(pairs()[1]).toEqual({kind: "assistant_complete", final_text: "Final reply"});
});

it("does not emit a disconnected node, an unmarked node, or an assistant without a preceding prompt", async () => {
  start(assistant("Orphan") + user("Question") + assistant("Detached"));
  document.querySelectorAll("[data-is-streaming]")[1].remove();
  document.querySelector("main")!.insertAdjacentHTML("beforeend", '<div>Unmarked reply</div>');
  await settle(); expect(emit).not.toHaveBeenCalled();
});

it("logs bounded selector counts after a send with missing matches, and cancels on stop", async () => {
  start('<div>PRIVATE_PAGE_TEXT</div>');
  for (let i = 0; i < 6; i++) {capture.userSend(); await settle(10_000);}
  expect(emit).toHaveBeenCalledTimes(3);
  expect(pairs()[0]).toEqual({kind: "diagnostic", reason: "Claude DOM selector matches after send: user=0 assistant=0"});
  expect(JSON.stringify(pairs())).not.toContain("PRIVATE");
  capture.stop(); start(user("Question")); capture.userSend(); await settle(10_000);
  expect(pairs()[0].reason).toContain("user=1 assistant=0");
  capture.userSend(); capture.stop(); await settle(10_000); expect(emit).toHaveBeenCalledTimes(1);
});

it("does not report missing matches when the nodes arrive within ten seconds", async () => {
  start(""); capture.userSend(); await settle(5000);
  document.querySelector("main")!.innerHTML = user("Hi") + assistant("Hello");
  await settle(10); finish();
  await settle(5000); expect(pairs().filter(p => p.kind === "diagnostic")).toEqual([]);
});

it("passes page text into the monitor turn through the bridge, never into diagnostics", async () => {
  const bridge = new DomObserverBridge(), turns = vi.fn(), logs = vi.fn();
  bridge.configure({send: vi.fn()} as any, claudeaiSpec);
  bridge.on("turn", turns); bridge.on("diagnostic", logs);
  start(user("PRIVATE_PROMPT") + assistant("PRIVATE_REPLY"));
  emit.mockImplementation(payload => ipc.get("harness:dom-event")!({sender: {id: 1}}, {...payload, provider: "claudeai"}));
  await settle();
  expect(turns).toHaveBeenCalledTimes(1);
  expect(turns.mock.calls[0][0]).toMatchObject({provider: "claudeai", user_prompt: "PRIVATE_PROMPT", assistant_text: "PRIVATE_REPLY"});
  expect(logs).not.toHaveBeenCalled();
  document.querySelector("main")!.replaceChildren(); capture.userSend(); await settle(10_000);
  expect(logs).toHaveBeenCalledTimes(1); expect(JSON.stringify(logs.mock.calls)).not.toContain("PRIVATE");
  bridge.dispose();
});

it("never captures replies that were already complete when they appeared (opened from history)", async () => {
  start(user("Old question") + assistant("Old answer", "false") + user("Older") + assistant("Older answer", "false"));
  await settle(1000); expect(emit).not.toHaveBeenCalled();
  // Switching to another past conversation renders its history after the observer started.
  document.querySelector("main")!.innerHTML = user("Other old") + assistant("Other answer", "false");
  await settle(1000); expect(emit).not.toHaveBeenCalled();
  // A new reply in that conversation streams and is captured, paired with its own prompt.
  document.querySelector("main")!.insertAdjacentHTML("beforeend", user("New question") + assistant("New answer"));
  await settle(10); finish(); await settle();
  expect(pairs()).toEqual([{kind: "user_turn", text: "New question"}, {kind: "assistant_complete", final_text: "New answer"}]);
});

it("counts a reply as streamed even when the flip lands between observer callbacks", async () => {
  start(user("Q"));
  const main = document.querySelector("main")!;
  main.insertAdjacentHTML("beforeend", assistant("Fast", "true"));
  const node = main.lastElementChild!;
  node.setAttribute("data-is-streaming", "false"); // same task: the observer sees only the old value
  await settle();
  expect(pairs()).toEqual([{kind: "user_turn", text: "Q"}, {kind: "assistant_complete", final_text: "Fast"}]);
});
