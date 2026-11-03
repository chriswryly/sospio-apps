import { describe, expect, it } from "vitest";
import {
  BrowserInterventionExecutor,
  DEFAULT_TERMINATE_EXCHANGE_COUNTDOWN_SECONDS,
  GOVERNOR_NOTICE_MARKER,
  TERMINATE_EXCHANGE_MARKER,
  TERMINATE_VERIFY_GRACE_MS,
  buildGovernorNoticeScript,
  buildTerminateExchangeScript,
  readTerminateVerification,
} from "./interventionExecutor";

/**
 * The notice probe runs two scripts: inject, then re-query after a delay. A page that discards
 * the notice on its next render must not yield a demonstration, so the fake answers each script
 * separately rather than returning one canned result for both.
 */
function fakeTarget(
  provider: string,
  options: { injected?: boolean; persists?: boolean } = {},
): { target: never; scripts: string[] } {
  const { injected = true, persists = true } = options;
  const scripts: string[] = [];
  const target = {
    executeJavaScript(script: string) {
      scripts.push(script);
      if (script.includes("checked_after_ms")) {
        return Promise.resolve({ present: persists, checked_after_ms: 1200 });
      }
      const marker = script.includes(TERMINATE_EXCHANGE_MARKER)
        ? TERMINATE_EXCHANGE_MARKER
        : GOVERNOR_NOTICE_MARKER;
      const countdown = Number(script.match(/const initialCountdown = (\d+);/)?.[1] ?? DEFAULT_TERMINATE_EXCHANGE_COUNTDOWN_SECONDS);
      return injected
        ? Promise.resolve({ ok: true, marker, provider, countdown_seconds: countdown })
        : Promise.resolve({ ok: false });
    },
  };
  return { target: target as never, scripts };
}

describe("browser intervention capability spike", () => {
  for (const provider of ["chatgpt", "claudeai"] as const) {
    it(`demonstrates an attributed, recoverable notice for ${provider}`, async () => {
      const { target, scripts } = fakeTarget(provider);
      const result = await new BrowserInterventionExecutor().displayGovernorNotice(
        target,
        provider,
        "The governor intervened at the scripted trigger.",
      );

      expect(result).toEqual({
        mechanism: "display_governor_notice",
        provider,
        marker: GOVERNOR_NOTICE_MARKER,
        demonstrated: true,
        recovery_handle: "dismiss_or_remove_notice",
        persistence: { present: true, checked_after_ms: 1200 },
      });
      expect(scripts).toHaveLength(2);
      expect(scripts[0]).toContain('heading.textContent = "Sospio notice"');
      expect(scripts[0]).toContain("dismiss.addEventListener");
      expect(scripts[0]).not.toContain("innerHTML");
      expect(scripts[1]).toContain(GOVERNOR_NOTICE_MARKER);
    });
  }

  it("refuses to demonstrate a notice the page discards after injection", async () => {
    const { target } = fakeTarget("claudeai", { persists: false });

    await expect(
      new BrowserInterventionExecutor().displayGovernorNotice(
        target,
        "claudeai",
        "The governor intervened at the scripted trigger.",
      ),
    ).rejects.toThrow("was removed within 1200ms of injection");
  });

  it("serializes notice text as data instead of executable source", () => {
    const hostile = `</script><script>globalThis.compromised = true</script>`;
    const script = buildGovernorNoticeScript("chatgpt", hostile);

    expect(script).toContain(`body.textContent = ${JSON.stringify(hostile)}`);
    expect(script).not.toContain(`body.innerHTML`);
  });

  it("rejects a target that cannot confirm the injected marker", async () => {
    const { target } = fakeTarget("grok", { injected: false });

    await expect(
      new BrowserInterventionExecutor().displayGovernorNotice(target, "grok", "test"),
    ).rejects.toThrow("governor notice probe failed for grok");
  });

  it("terminates an exchange with a preserved transcript and no recovery toggle", async () => {
    const { target, scripts } = fakeTarget("chatgpt");

    const result = await new BrowserInterventionExecutor().terminateExchange(
      target,
      "chatgpt",
      "The exchange should close now.",
      2,
      // Injection only. The outcome fields are read by a separate probe after
      // the countdown; see the verification tests below.
      { verify: false },
    );

    expect(result).toEqual({
      mechanism: "terminate_exchange",
      provider: "chatgpt",
      marker: TERMINATE_EXCHANGE_MARKER,
      demonstrated: true,
      recovery_handle: "start_new_exchange",
      persistence: { present: true, checked_after_ms: 1200 },
      countdown_seconds: 2,
      // Unverified, not true: at this point the countdown has not run and
      // nothing has observed the outcome. The first implementation recorded
      // `true` here, about ten seconds before `closeNow` executed.
      transcript_preserved: "unverified",
      closed_to_further_turns: "unverified",
      verified_at: null,
    });
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toContain('heading.textContent = "Sospio · closing conversation"');
    expect(scripts[0]).toContain('host.dataset.rshTranscriptPreserved = "true"');
    // The injection script must make no outcome claim; it returns at T+0.
    expect(scripts[0]).not.toContain("transcript_preserved");
    expect(scripts[0]).toContain("beforeinput");
    expect(scripts[0]).toContain("submit");
    expect(scripts[0]).toContain("contentEditable");
    expect(scripts[0]).toContain("MutationObserver");
    expect(scripts[0]).not.toContain("Dismiss");
    expect(scripts[0]).not.toContain("Cancel");
    expect(scripts[0]).not.toContain("innerHTML");
    expect(scripts[1]).toContain(TERMINATE_EXCHANGE_MARKER);
  });

  // --- Tier 4 outcome verification --------------------------------------
  //
  // The first implementation typed demonstrated / transcript_preserved /
  // closed_to_further_turns as literal `true`, so they were returned
  // unconditionally. The injected script schedules a setInterval and returns
  // immediately, so the receipt claimed the exchange was closed roughly ten
  // seconds before `closeNow` ran. Tier 4 is the rung where being wrong costs
  // most, and §0.3 requires interventions to be recorded rather than asserted.

  it("reads the outcome from the page after the countdown", async () => {
    const probe = {
      present: true,
      closed_flag: true,
      editors_seen: 2,
      composer_blocked: true,
      transcript_nodes: 14,
    };
    const verification = readTerminateVerification(probe);

    expect(verification.closed_to_further_turns).toBe(true);
    expect(verification.transcript_preserved).toBe(true);
    expect(verification.verified_at).not.toBeNull();
  });

  it("reports a composer that came back as not closed", async () => {
    // A React re-render that outruns the MutationObserver looks exactly like
    // this, and the receipt must say so.
    const verification = readTerminateVerification({
      present: true,
      closed_flag: true,
      editors_seen: 1,
      composer_blocked: false,
      transcript_nodes: 9,
    });

    expect(verification.closed_to_further_turns).toBe(false);
  });

  it("stays unverified when the overlay is gone", async () => {
    expect(readTerminateVerification({ present: false }).closed_to_further_turns).toBe(
      "unverified",
    );
    expect(readTerminateVerification(null).closed_to_further_turns).toBe("unverified");
    expect(readTerminateVerification("nope").transcript_preserved).toBe("unverified");
  });

  it("does not treat an empty page as a closed composer", async () => {
    // No editors found is inability to tell, not evidence of closure.
    const verification = readTerminateVerification({
      present: true,
      closed_flag: true,
      editors_seen: 0,
      composer_blocked: null,
      transcript_nodes: 3,
    });

    expect(verification.closed_to_further_turns).toBe("unverified");
  });

  it("records unverified when the probe throws instead of losing the receipt", async () => {
    const target = {
      executeJavaScript(script: string) {
        if (script.includes("checked_after_ms")) {
          return Promise.resolve({ present: true, checked_after_ms: 1200 });
        }
        if (script.includes("closed_flag")) {
          return Promise.reject(new Error("webContents destroyed"));
        }
        return Promise.resolve({
          ok: true,
          marker: TERMINATE_EXCHANGE_MARKER,
          provider: "chatgpt",
          countdown_seconds: 1,
        });
      },
    } as never;

    const result = await new BrowserInterventionExecutor().terminateExchange(
      target,
      "chatgpt",
      "closing",
      1,
      { wait: async () => {} },
    );

    expect(result.closed_to_further_turns).toBe("unverified");
    expect(result.verified_at).toBeNull();
    // The receipt survives; only the outcome is unknown.
    expect(result.mechanism).toBe("terminate_exchange");
    expect(result.persistence.present).toBe(true);
  });

  it("waits the countdown plus grace before probing", async () => {
    const waited: number[] = [];
    const { target } = fakeTarget("chatgpt");

    await new BrowserInterventionExecutor().terminateExchange(
      target,
      "chatgpt",
      "closing",
      7,
      {
        wait: async (ms) => {
          waited.push(ms);
        },
      },
    );

    expect(waited).toEqual([7 * 1000 + TERMINATE_VERIFY_GRACE_MS]);
  });

  it("serializes termination text as data instead of executable source", () => {
    const hostile = `</script><script>globalThis.compromised = true</script>`;
    const script = buildTerminateExchangeScript("claudeai", hostile, 0);

    expect(script).toContain(`const bodyText = ${JSON.stringify(hostile)}`);
    expect(script).not.toContain("innerHTML");
  });

  it("emits syntactically valid termination source", () => {
    expect(() => new Function(buildTerminateExchangeScript("chatgpt", "close", 1))).not.toThrow();
  });

  it("rejects an invalid termination countdown", async () => {
    const { target } = fakeTarget("chatgpt");

    await expect(
      new BrowserInterventionExecutor().terminateExchange(target, "chatgpt", "close", Number.NaN),
    ).rejects.toThrow("finite non-negative");
  });
});

it.each([1,2,3] as const)("renders Tier %s notice provenance without changing markers",tier=>{
 const script=buildGovernorNoticeScript("chatgpt","Recorded text",tier,true);
 expect(script).toContain(["","Sospio · Tier 1 notice","Sospio · Tier 2 shared note","Sospio · Tier 3 final note"][tier]);
 expect(script).toContain('provenance.textContent = "Sospio · "');
 expect(script).toContain('Hide Sospio notice');expect(script).toContain(GOVERNOR_NOTICE_MARKER);expect(script).toContain('host.dataset.rshGovernorMechanism = "display_governor_notice"');
 expect(script).toContain(tier===1?"Only you see this":"to the end of your next message");
});
it("does not duplicate the Tier 1 only-you line",()=>{expect(buildGovernorNoticeScript("claudeai","Only you see this. Recorded body.",1).match(/Only you see this/g)).toHaveLength(1)});

it.each([2,3] as const)("omits delivery promise at Tier %s without planned augmentation",tier=>{
 expect(buildGovernorNoticeScript("chatgpt","Recorded text",tier,false)).not.toContain("will add");
 expect(buildGovernorNoticeScript("chatgpt","Recorded text",tier,true)).toContain("will add");
});

import { createRequire } from "node:module";
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { runScripts: string }) => { window: Window & typeof globalThis };
};
import { updateGovernorDeliveryScript } from "./interventionExecutor";

it.each(["applied", "failed"] as const)("updates only the matching visible arm: %s", (status) => {
  const dom = new JSDOM("<main>provider content</main>", { runScripts: "outside-only" });
  try {
    dom.window.eval(buildGovernorNoticeScript("chatgpt", "observation", 2, true, "arm-a"));
    const root = dom.window.document.getElementById(GOVERNOR_NOTICE_MARKER)!.shadowRoot!;
    const line = root.querySelector("[data-rsh-governor-delivery-action]")!;
    dom.window.eval(updateGovernorDeliveryScript("arm-b", status));
    expect(line.textContent).toContain("will add");
    dom.window.eval(updateGovernorDeliveryScript("arm-a", status));
    expect(line.textContent).toBe(status === "applied"
      ? "Sospio added this note to the end of your message."
      : "This note was not added to your message.");
    const button = root.querySelector("button")!;
    expect(button.textContent).toBe("Hide");
    expect(button.getAttribute("aria-label")).toBe("Hide Sospio notice");
    button.click();
    expect(dom.window.document.getElementById(GOVERNOR_NOTICE_MARKER)).toBeNull();
    expect(() => dom.window.eval(updateGovernorDeliveryScript("arm-a", status))).not.toThrow();
    expect(dom.window.document.querySelector("main")!.textContent).toBe("provider content");
    expect(dom.window.document.querySelector("[data-rsh-governor-delivery-action]")).toBeNull();
  } finally { dom.window.close(); }
});

it.each([true, false, "unverified"] as const)("page closure copy follows host verification: %s", async (outcome) => {
  const dom = new JSDOM("<main>transcript</main><textarea></textarea>", { runScripts: "outside-only" });
  // Track observers so closing jsdom cannot run a pending callback against a torn-down document.
  const observers: MutationObserver[] = [];
  const NativeObserver = dom.window.MutationObserver;
  dom.window.MutationObserver = class extends NativeObserver { constructor(callback: MutationCallback) { super(callback); observers.push(this); } };
  const target = {
    async executeJavaScript(script: string) {
      if (script.includes("checked_after_ms")) return { present: true, checked_after_ms: 1200 };
      if (script.includes("closed_flag")) return outcome === "unverified" ? { present: false } : {
        present: true, closed_flag: true, editors_seen: 1, composer_blocked: outcome, transcript_nodes: 1,
      };
      return dom.window.eval(script);
    },
  };
  try {
    const result = await new BrowserInterventionExecutor().terminateExchange(target as never, "chatgpt", "Sospio is closing this conversation. The transcript will remain readable.", 0, {
      wait: async () => {
        const root = dom.window.document.getElementById(TERMINATE_EXCHANGE_MARKER)!.shadowRoot!;
        expect(root.querySelector("strong")!.textContent).toBe("Sospio · closing conversation");
        expect(root.querySelector("small")!.textContent).toBe("Closing now.");
      },
    });
    expect(result.closed_to_further_turns).toBe(outcome);
    const root = dom.window.document.getElementById(TERMINATE_EXCHANGE_MARKER)!.shadowRoot!;
    expect(root.querySelector("strong")!.textContent).toBe(outcome === true ? "Sospio · conversation closed" : "Sospio · close not confirmed");
    expect(root.querySelector("p")!.textContent).toBe(outcome === true
      ? "No further messages can be sent here. The transcript remains readable."
      : "Sospio could not confirm that the page stopped accepting input. The conversation may still be open. The transcript remains readable.");
  } finally { observers.forEach((o) => o.disconnect()); dom.window.close(); }
});

it("keeps the observed receipt when the outcome copy update fails", async () => {
  let calls = 0;
  const target = { executeJavaScript: async () => {
    calls++;
    if (calls === 1) return { ok: true, marker: TERMINATE_EXCHANGE_MARKER, provider: "chatgpt", countdown_seconds: 0 };
    if (calls === 2) return { present: true, checked_after_ms: 1200 };
    if (calls === 3) return { present: true, closed_flag: true, editors_seen: 1, composer_blocked: true, transcript_nodes: 1 };
    throw new Error("navigated");
  } };
  const result = await new BrowserInterventionExecutor().terminateExchange(target as never, "chatgpt", "closing", 0, { wait: async () => {} });
  expect(result.closed_to_further_turns).toBe(true);
  expect(calls).toBe(4);
});

import { buildTerminateVerifyScript } from "./interventionExecutor";
it.each(["<div data-turn-key='a'></div><div data-conversation-role='assistant'>reply</div><div data-user-message-bubble>user</div>", ""])("counts current ChatGPT transcript markers: %s", html => {
  const dom = new JSDOM(`<main>${html}</main><div id="${TERMINATE_EXCHANGE_MARKER}"></div>`, {runScripts:"outside-only"});
  try { expect(dom.window.eval(buildTerminateVerifyScript()).transcript_nodes).toBe(html ? 3 : 0); }
  finally { dom.window.close(); }
});
