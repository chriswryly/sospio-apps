/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armResponseMediationScript,
  PAGE_INTERVENTION_API,
  PAGE_INTERVENTION_SHIM,
  probeLatestPresentationScript,
} from "./pageInterventionShim";
import { chatgptSpec } from "./providers/chatgpt";
import { claudeaiSpec } from "./providers/claudeai";

describe("response-stage intervention shim", () => {
  const originalFetch = globalThis.fetch;
  const OriginalEventSource = globalThis.EventSource;

  beforeEach(() => {
    document.body.innerHTML = '<main><article data-message-author-role="assistant"><p>original candidate</p></article></main>';
    delete (globalThis as unknown as Record<string, unknown>)[PAGE_INTERVENTION_API];
    globalThis.fetch = async () => new Response("provider stream", { status: 200 });
    globalThis.EventSource = OriginalEventSource;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
    globalThis.EventSource = OriginalEventSource;
    delete (globalThis as unknown as Record<string, unknown>)[PAGE_INTERVENTION_API];
    delete (globalThis as unknown as Record<string, unknown>).rshCapabilityEvidence;
    document.body.replaceChildren();
  });

  it("wraps fetch and EventSource and exposes recoverable presentation mediation", () => {
    expect(PAGE_INTERVENTION_SHIM).toContain("rshMediatedFetch");
    expect(PAGE_INTERVENTION_SHIM).toContain("RshMediatedEventSource");
    expect(PAGE_INTERVENTION_SHIM).toContain("response.body?.cancel");
    expect(PAGE_INTERVENTION_SHIM).toContain("The candidate response was withheld by Sospio.");
    expect(PAGE_INTERVENTION_SHIM).toContain("replace_presentation");
    expect(PAGE_INTERVENTION_SHIM).toContain("recover(recoveryId)");
    expect(PAGE_INTERVENTION_SHIM).not.toContain("innerHTML");
  });

  it("arms provider-specific actions as serialized data", () => {
    expect(armResponseMediationScript("chatgpt", "withhold_candidate")).toContain(PAGE_INTERVENTION_API);
    expect(armResponseMediationScript("claudeai", "withhold_candidate")).toContain('"provider":"claudeai"');
    expect(probeLatestPresentationScript("claudeai", "replace_presentation")).toContain('"action":"replace_presentation"');
    expect(probeLatestPresentationScript("claudeai", "replace_presentation")).toContain('"emitEvidence":false');
  });

  /**
   * `assistant_not_found` claims the harness looked and the turn was missing. For a provider with
   * no characterized selectors it never knew where to look, and reporting the two the same way is
   * what made a missing claude.ai selector table read as a page-structure problem.
   */
  it("distinguishes an uncharacterized provider from a missing assistant turn", () => {
    const api = installShim();
    const uncharacterized = api.probeLatest({
      provider: "unlisted-provider" as "claudeai",
      action: "replace_presentation",
    });
    expect(uncharacterized.ok).toBe(false);
    expect(uncharacterized.reason).toBe("no_selectors_for_provider");

    document.body.innerHTML = "<main></main>";
    const missing = api.probeLatest({ provider: "chatgpt", action: "replace_presentation" });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("assistant_not_found");
  });

  /**
   * The live failure this whole selector table came from: on claude.ai `replace_presentation`
   * returned `assistant_not_found` because both selector tables only knew ChatGPT and a
   * Grok-shaped fallback. This fixture mirrors the structure a live discovery run reported.
   */
  it("mediates the latest assistant turn on a claude.ai-shaped surface", () => {
    document.body.innerHTML = `
      <main>
        <div role="article"><div data-cds="UserMessage">first user turn</div></div>
        <div role="article"><div data-is-streaming="false">first assistant turn</div></div>
        <div role="article"><div data-cds="UserMessage">second user turn</div></div>
        <div role="article"><div data-is-streaming="false">latest assistant turn</div></div>
      </main>`;
    const api = installShim();
    const result = api.probeLatest({ provider: "claudeai", action: "replace_presentation" });

    expect(result.ok).toBe(true);
    const surfaces = document.querySelectorAll('[data-rsh-governor-presentation="replace_presentation"]');
    expect(surfaces).toHaveLength(1);
    // The newest turn is mediated and the earlier one is untouched.
    const turns = document.querySelectorAll("div[data-is-streaming]");
    expect(turns[0].textContent).toBe("first assistant turn");
    expect(turns[1].textContent).toContain("replaced by Sospio");
  });

  it("replaces, restores, and re-applies the latest candidate presentation (toggle)", () => {
    const api = installShim();
    const result = api.probeLatest({ provider: "chatgpt", action: "replace_presentation" });

    expect(result.ok).toBe(true);
    expect(document.body.textContent).toContain("replaced by Sospio");
    expect(document.querySelector('[data-rsh-governor-presentation="replace_presentation"]')).not.toBeNull();
    // The assistant turn node stays in history; only its rendered content is swapped.
    expect(document.querySelector('[data-message-author-role="assistant"]')).not.toBeNull();

    const restore = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Restore original");
    expect(restore).toBeDefined();
    restore?.click();
    expect(document.querySelector("[data-rsh-governor-presentation]")).toBeNull();
    expect(document.body.textContent).toContain("original candidate");
    expect(document.body.textContent).not.toContain("replaced by Sospio");

    // Restore is a toggle: the restored view offers re-applying the replacement.
    const reapply = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Restore Sospio replacement");
    expect(reapply).toBeDefined();
    reapply?.click();
    expect(document.querySelector('[data-rsh-governor-control="restore-replacement"]')).toBeNull();
    expect(document.querySelector('[data-rsh-governor-presentation="replace_presentation"]')).not.toBeNull();
    expect(document.body.textContent).toContain("replaced by Sospio");

    // ...and it can be toggled back to the original again.
    const restoreAgain = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Restore original");
    expect(restoreAgain).toBeDefined();
    restoreAgain?.click();
    expect(document.querySelector('[data-rsh-governor-control="restore-replacement"]')).not.toBeNull();
    expect(document.body.textContent).toContain("original candidate");
  });

  it("does not emit demonstrated page-side for a replacement removed after injection", () => {
    const evidence: Array<Record<string, unknown>> = [];
    (globalThis as unknown as Record<string, unknown>).rshCapabilityEvidence = (payload: string) => {
      evidence.push(JSON.parse(payload));
    };
    const api = installShim();
    const result = api.probeLatest({ provider: "chatgpt", action: "replace_presentation" });

    expect(result.ok).toBe(true);
    document.querySelector('[data-rsh-governor-presentation="replace_presentation"]')?.remove();

    expect(evidence).not.toContainEqual(expect.objectContaining({
      mechanism: "replace_presentation",
      status: "demonstrated",
    }));
  });

  it("cancels and withholds an armed completion response", async () => {
    const evidence: Array<Record<string, unknown>> = [];
    (globalThis as unknown as Record<string, unknown>).rshCapabilityEvidence = (payload: string) => {
      evidence.push(JSON.parse(payload));
    };
    const api = installShim();
    api.arm({ provider: "chatgpt", action: "withhold_candidate" });

    const response = await globalThis.fetch("https://chatgpt.com/backend-api/conversation", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "disposable probe turn" }] }),
    });

    expect(await response.text()).toBe("");
    expect(evidence).not.toContainEqual(expect.objectContaining({
      provider: "chatgpt",
      mechanism: "withhold_candidate",
      status: "demonstrated",
    }));
    expect(document.body.textContent).toContain("candidate response was withheld");
  });

  it("does not emit demonstrated page-side for a withhold interruption removed after injection", async () => {
    const evidence: Array<Record<string, unknown>> = [];
    (globalThis as unknown as Record<string, unknown>).rshCapabilityEvidence = (payload: string) => {
      evidence.push(JSON.parse(payload));
    };
    const api = installShim();
    api.arm({ provider: "chatgpt", action: "withhold_candidate" });

    const response = await globalThis.fetch("https://chatgpt.com/backend-api/conversation", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "disposable probe turn" }] }),
    });
    document.querySelector('[data-rsh-governor-presentation="withhold_candidate"]')?.remove();

    expect(await response.text()).toBe("");
    expect(evidence).not.toContainEqual(expect.objectContaining({
      mechanism: "withhold_candidate",
      status: "demonstrated",
    }));
  });

  it("withholds completion requests classified by the capture adapters", async () => {
    const cases = [
      {
        provider: "chatgpt" as const,
        spec: chatgptSpec,
        url: "https://chatgpt.com/backend-api/f/conversation",
        body: JSON.stringify({
          body: {
            input: [
              {
                role: "user",
                content: [{ type: "input_text", text: "disposable probe turn" }],
              },
            ],
          },
        }),
      },
      {
        provider: "claudeai" as const,
        spec: claudeaiSpec,
        url: "https://claude.ai/api/organizations/org-1/chat_conversations/example/completion",
        body: JSON.stringify({ prompt: "disposable probe turn", attachments: [] }),
      },
    ];
    const evidence: Array<Record<string, unknown>> = [];
    (globalThis as unknown as Record<string, unknown>).rshCapabilityEvidence = (payload: string) => {
      evidence.push(JSON.parse(payload));
    };
    const api = installShim();

    for (const item of cases) {
      expect(item.spec.networkParser?.isCompletionRequestUrl(item.url, "POST")).toBe(true);
      expect(item.spec.networkParser?.parseRequest(item.body).user_prompt).toBe("disposable probe turn");
      api.arm({ provider: item.provider, action: "withhold_candidate" });

      const response = await globalThis.fetch(item.url, {
        method: "POST",
        body: item.body,
      });

      expect(await response.text()).toBe("");
      expect(evidence).not.toContainEqual(expect.objectContaining({
        provider: item.provider,
        mechanism: "withhold_candidate",
        status: "demonstrated",
      }));
      expect(document.body.textContent).toContain("candidate response was withheld");
    }
  });

  it("does not fire on background fetch traffic after arming", async () => {
    const evidence: Array<Record<string, unknown>> = [];
    (globalThis as unknown as Record<string, unknown>).rshCapabilityEvidence = (payload: string) => {
      evidence.push(JSON.parse(payload));
    };
    const api = installShim();
    api.arm({ provider: "chatgpt", action: "withhold_candidate" });

    const response = await globalThis.fetch("https://chatgpt.com/backend-api/conversation", {
      method: "POST",
      body: JSON.stringify({ event: "conversation_sync", messages: [{ role: "system", content: "background" }] }),
    });

    expect(await response.text()).toBe("provider stream");
    expect(evidence).not.toContainEqual(expect.objectContaining({
      mechanism: "withhold_candidate",
      status: "demonstrated",
    }));
    expect(api.status().armed).toEqual(expect.objectContaining({
      provider: "chatgpt",
      action: "withhold_candidate",
    }));
  });

  it("does not close background EventSource streams after arming", async () => {
    const evidence: Array<Record<string, unknown>> = [];
    const closes: string[] = [];
    (globalThis as unknown as Record<string, unknown>).rshCapabilityEvidence = (payload: string) => {
      evidence.push(JSON.parse(payload));
    };
    class FakeEventSource {
      constructor(public readonly url: string) {}
      close(): void {
        closes.push(this.url);
      }
    }
    globalThis.EventSource = FakeEventSource as never;
    const api = installShim();
    api.arm({ provider: "chatgpt", action: "withhold_candidate" });

    new EventSource("https://chatgpt.com/backend-api/responses");
    await Promise.resolve();

    expect(closes).toEqual([]);
    expect(evidence).not.toContainEqual(expect.objectContaining({
      mechanism: "withhold_candidate",
      status: "demonstrated",
    }));
  });

  it("times out an armed response probe with no prompt-correlated completion", () => {
    vi.useFakeTimers();
    const evidence: Array<Record<string, unknown>> = [];
    (globalThis as unknown as Record<string, unknown>).rshCapabilityEvidence = (payload: string) => {
      evidence.push(JSON.parse(payload));
    };
    const api = installShim();
    api.arm({ provider: "claudeai", action: "withhold_candidate" });

    vi.advanceTimersByTime(30000);

    expect(evidence).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      mechanism: "withhold_candidate",
      status: "failed",
      detail: expect.stringContaining("no prompt-correlated completion"),
    }));
    expect(api.status().armed).toBeNull();
  });
});

type ShimApi = {
  arm(config: { provider: "chatgpt" | "claudeai"; action: string }): { ok: boolean; reason?: string };
  probeLatest(config: { provider: "chatgpt" | "claudeai"; action: string }): { ok: boolean; reason?: string };
  status(): { installed: boolean; armed: { provider: string; action: string } | null };
};

function installShim(): ShimApi {
  (0, eval)(PAGE_INTERVENTION_SHIM);
  return (globalThis as unknown as Record<string, unknown>)[PAGE_INTERVENTION_API] as ShimApi;
}
it('uses Sospio headings while preserving mediation data attributes',()=>{expect(PAGE_INTERVENTION_SHIM).toContain('heading.textContent = "Sospio"');expect(PAGE_INTERVENTION_SHIM).toContain('rshGovernor');expect(PAGE_INTERVENTION_SHIM).not.toContain('Governor intervention')});
