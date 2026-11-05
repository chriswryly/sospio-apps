/** @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import { PAGE_INTERVENTION_API, PAGE_INTERVENTION_SHIM } from "./pageInterventionShim";
it("only treats Claude send buttons as a send, preserving keyboard and form sends", () => {
  const send = vi.fn();
  (globalThis as any).rshUserSend = send;
  const originalFetch = globalThis.fetch;
  new Function("location", PAGE_INTERVENTION_SHIM)({href: "https://claude.ai/new"});
  document.body.innerHTML = '<button type="button" aria-label="Settings">Settings</button><button type="button" aria-label="Send message"><span>Send</span></button><textarea></textarea><form></form>';
  document.querySelector("button")!.click();
  expect(send).not.toHaveBeenCalled();
  document.querySelector("span")!.click();
  expect(send).toHaveBeenCalledTimes(1);
  document.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", bubbles: true}));
  document.querySelector("form")!.dispatchEvent(new Event("submit", {bubbles: true}));
  expect(send).toHaveBeenCalledTimes(3);
  expect(JSON.parse(send.mock.calls[0][0]).provider).toBe("claudeai");
  globalThis.fetch = originalFetch;
  delete (globalThis as any).rshUserSend;
  delete (globalThis as any)[PAGE_INTERVENTION_API];
});
