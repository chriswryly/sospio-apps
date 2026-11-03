/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHATGPT_FETCH_HOOK } from "./cdpClient";

/**
 * The page hook is the path that fabricated turns, so it is tested by running it, not by
 * reading it. It carries its own copy of the ChatGPT completion rule — the exclusion in
 * completionMatcher.ts does not reach it — and it is the only caller of the DOM fallback that
 * dressed a pre-flight in the previous answer.
 */
function installHook(): void {
  delete (globalThis as Record<string, unknown>).__rshChatgptFetchHookInstalled;
  new Function(CHATGPT_FETCH_HOOK)();
}

function responseStub(body: string): Response {
  const response = {
    url: "https://chatgpt.com/x",
    clone: () => ({ text: async () => body }),
    text: async () => body,
  };
  return response as unknown as Response;
}

const PREVIOUS_ANSWER_DOM =
  "<div data-message-author-role=\"assistant\"><div class=\"markdown\">" +
  "a previous answer that is still on screen and long enough to win a length contest" +
  "</div></div>";

describe("ChatGPT page fetch hook", () => {
  let captured: string[];

  beforeEach(() => {
    // jsdom does not implement `innerText`, and the hook's DOM read uses nothing else. Without
    // this shim the rendered source is empty in every test here, and the fallback these tests are
    // about never runs at all.
    Object.defineProperty(window.HTMLElement.prototype, "innerText", {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent ?? "";
      },
    });
    captured = [];
    (globalThis as Record<string, unknown>).rshCapture = (payload: string) => captured.push(payload);
    globalThis.fetch = vi.fn(async () => responseStub("data: {\"message\":{\"author\":{\"role\":\"assistant\"},\"content\":{\"content_type\":\"text\",\"parts\":[\"answer\"]}}}")) as unknown as typeof fetch;
    // The real shape the DOM read looks for. A bare `.markdown` div does not match the outer
    // `[data-message-author-role="assistant"]` selector, so the rendered source would be empty
    // and these tests would pass without the fallback ever being reachable.
    document.body.innerHTML = PREVIOUS_ANSWER_DOM;
    installHook();
  });

  it("does not capture the draft pre-flight that fires on the first keystroke", async () => {
    await globalThis.fetch("https://chatgpt.com/backend-api/f/conversation/prepare", {
      method: "POST",
      body: JSON.stringify({ body: { input: [{ role: "user", content: [{ type: "input_text", text: "t" }] }] } }),
    });
    // Long enough to cover the hook's 2.5s DOM-settle wait, which is what used to supply the
    // previous answer to a request that had none of its own.
    await new Promise((resolve) => setTimeout(resolve, 3000));

    expect(captured).toEqual([]);
  });

  it("reports the network body and the rendered text separately, choosing between neither", async () => {
    // The hook has no provider parsers, so any choice it makes here can only compare raw sizes.
    // That comparison is what dressed a request with no reply of its own in the previous answer.
    // The page now reports both sources and the main process, where the parsers live, decides.
    const sse = "data: {\"message\":{\"author\":{\"role\":\"assistant\"},\"content\":{\"content_type\":\"text\",\"parts\":[\"short\"]}}}";
    const onScreen = "a previous answer that is still on screen. ".repeat(20);
    document.body.innerHTML =
      `<div data-message-author-role="assistant"><div class="markdown">${onScreen}</div></div>`;
    globalThis.fetch = vi.fn(async () => responseStub(sse)) as unknown as typeof fetch;
    installHook();

    await globalThis.fetch("https://chatgpt.com/backend-api/f/conversation", {
      method: "POST",
      body: JSON.stringify({ body: { input: [{ role: "user", content: [{ type: "input_text", text: "a real question" }] }] } }),
    });
    await vi.waitFor(() => expect(captured.length).toBe(1), { timeout: 6000 });

    const payload = JSON.parse(captured[0]!) as { responseBody: string; renderedText: string };
    // The screen holds more characters than the stream, which is exactly when the old comparison
    // discarded the provider's own bytes.
    expect(onScreen.length).toBeGreaterThan(sse.length);
    expect(payload.responseBody).toBe(sse);
    expect(payload.renderedText).toContain("a previous answer that is still on screen");
    expect(payload.renderedText.length).toBeGreaterThan(sse.length);
  });

  it("reads current ChatGPT assistant markup", async () => {
    document.body.innerHTML = '<div data-conversation-role="assistant"><div class="markdown">current assistant reply</div></div>';
    await globalThis.fetch("https://chatgpt.com/backend-api/f/conversation", {method:"POST",body:JSON.stringify({body:{input:[{role:"user",content:[{type:"input_text",text:"question"}]}]}})});
    await vi.waitFor(() => expect(captured.length).toBe(1), {timeout:6000});
    expect(JSON.parse(captured[0]!).renderedText).toBe("current assistant reply");
  });

  it("still captures a real completion on the same path prefix", async () => {
    await globalThis.fetch("https://chatgpt.com/backend-api/f/conversation", {
      method: "POST",
      body: JSON.stringify({ body: { input: [{ role: "user", content: [{ type: "input_text", text: "a real question" }] }] } }),
    });
    await vi.waitFor(() => expect(captured.length).toBe(1), { timeout: 6000 });

    expect(JSON.parse(captured[0]!).url).toContain("chatgpt.com");
  });
});
