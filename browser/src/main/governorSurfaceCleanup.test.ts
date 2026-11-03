// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestMediationNoticeScript } from "./capture/cdpClient";
import {
  GOVERNOR_NOTICE_MARKER,
  TERMINATE_EXCHANGE_MARKER,
  buildTerminateExchangeScript,
  removeGovernorNoticeScript,
} from "./interventionExecutor";

// Both scripts are evaluated in the page; run them against jsdom's document the same way.
const run = (script: string): unknown => (0, eval)(script);

describe("governor page surfaces at a conversation boundary", () => {
  it("removes the tier notice and the request-mediation attribution banner", () => {
    document.body.innerHTML = "";
    const tier = document.createElement("div");
    tier.id = GOVERNOR_NOTICE_MARKER;
    document.documentElement.appendChild(tier);
    run(requestMediationNoticeScript("augment_request_context"));
    expect(document.querySelectorAll("[data-rsh-governor-request-mediation]")).toHaveLength(1);

    run(removeGovernorNoticeScript());

    expect(document.getElementById(GOVERNOR_NOTICE_MARKER)).toBeNull();
    expect(document.querySelectorAll("[data-rsh-governor-request-mediation]")).toHaveLength(0);
  });

  it("keeps only the latest request-mediation banner", () => {
    document.body.innerHTML = "";
    run(requestMediationNoticeScript("augment_request_context", "first"));
    run(requestMediationNoticeScript("augment_request_context", "second"));
    const banners = document.querySelectorAll("[data-rsh-governor-request-mediation]");
    expect(banners).toHaveLength(1);
    expect(banners[0].textContent).toContain("second");
  });

  it("leaves unrelated page content alone", () => {
    document.body.innerHTML = '<main id="chat"><p>hello</p></main>';
    run(removeGovernorNoticeScript());
    expect(document.getElementById("chat")?.textContent).toBe("hello");
  });
});

describe("a Tier 4 close at a conversation boundary", () => {
  const composer = (): HTMLTextAreaElement => {
    document.body.innerHTML = '<form><textarea id="prompt"></textarea><button type="submit" id="send">Send</button></form>';
    return document.getElementById("prompt") as HTMLTextAreaElement;
  };
  const keydownBlocked = (target: Element): boolean =>
    !target.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));

  afterEach(() => {
    run(removeGovernorNoticeScript());
    vi.useRealTimers();
  });

  it("locks the composer, then New chat releases the lock and removes the close", async () => {
    const prompt = composer();
    run(buildTerminateExchangeScript("chatgpt", "closing", 0));
    expect(prompt.disabled).toBe(true);
    expect(keydownBlocked(prompt)).toBe(true);

    run(removeGovernorNoticeScript());

    expect(document.getElementById(TERMINATE_EXCHANGE_MARKER)).toBeNull();
    expect(prompt.disabled).toBe(false);
    expect(prompt.hasAttribute("data-rsh-exchange-terminated")).toBe(false);
    expect(prompt.hasAttribute("aria-disabled")).toBe(false);
    expect((document.getElementById("send") as HTMLButtonElement).disabled).toBe(false);
    expect(keydownBlocked(prompt)).toBe(false);

    // The new chat's composer, rendered after the boundary, is not locked by a leftover observer.
    const fresh = document.createElement("textarea");
    document.body.appendChild(fresh);
    await Promise.resolve();
    expect(fresh.disabled).toBe(false);
    expect(keydownBlocked(fresh)).toBe(false);
  });

  it("a countdown interrupted by New chat never closes the new conversation", () => {
    vi.useFakeTimers();
    const prompt = composer();
    run(buildTerminateExchangeScript("chatgpt", "closing", 3));
    run(removeGovernorNoticeScript());
    vi.advanceTimersByTime(5000);
    expect(prompt.disabled).toBe(false);
    expect(document.getElementById(TERMINATE_EXCHANGE_MARKER)).toBeNull();
  });

  it("a second close replaces the first without stacking guards", () => {
    const prompt = composer();
    run(buildTerminateExchangeScript("chatgpt", "first", 0));
    run(buildTerminateExchangeScript("chatgpt", "second", 0));
    expect(document.querySelectorAll("#" + TERMINATE_EXCHANGE_MARKER)).toHaveLength(1);
    run(removeGovernorNoticeScript());
    expect(prompt.disabled).toBe(false);
    expect(keydownBlocked(prompt)).toBe(false);
  });
});
