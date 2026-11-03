import { emotionalVerdict } from "../../renderer/__fixtures__/emotionalDependence";
import { planFromVerdict } from "../browserPolicyAdapter";
import { executeGovernorPlan, governorTextOptions } from "../governorLoop";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";

vi.mock("electron", () => ({
  ipcMain: { on: vi.fn() },
}));

import { CaptureService, CHATGPT_FETCH_HOOK } from "./cdpClient";
import { REQUEST_CONTEXT_EFFECT_SIGNATURE } from "./requestMediation";
import { PAGE_INTERVENTION_SHIM } from "./pageInterventionShim";
import type { CapabilityProbeRecord, ParserDiagnostic, TurnEvent } from "../../shared/types";

type Command = { method: string; params?: Record<string, unknown> };
const CLAUDE_COMPLETION_URL =
  "https://claude.ai/api/organizations/org-1/chat_conversations/example/completion";
type MarkerDom = {
  window: Window & typeof globalThis & {
    close(): void;
    document: Document;
    MutationObserver: typeof MutationObserver;
    queueMicrotask(callback: () => void): void;
  };
};
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (html: string, options: { url: string }) => MarkerDom;
};

/**
 * The withhold path evaluates two scripts: inject the transcript marker, then re-query it after a
 * delay. They return different shapes, so a fake that answers both with one canned value would
 * make the persistence check trivially pass (or trivially fail). Dispatch on the expression.
 */
function markerOrPersistence(
  params: Record<string, unknown> | undefined,
  marker: {
    retryControlsBlocked: number;
    anchored?: boolean;
    selectorsCharacterized?: boolean;
    markerReassertions?: number;
    dismissed?: boolean;
  },
  persists = true,
): Record<string, unknown> {
  const expression = String(params?.expression ?? "");
  if (expression.includes("const state = window.__rshGovernorWithheldMarkerState")) {
    return {
      markerReassertions: marker.markerReassertions ?? 0,
      dismissed: marker.dismissed === true,
      interventionId: "test-intervention",
    };
  }
  if (expression.includes("checked_after_ms")) {
    return { present: persists, checked_after_ms: 1200 };
  }
  return {
    ok: true,
    retryGuardInstalled: true,
    anchored: marker.anchored ?? true,
    selectorsCharacterized: marker.selectorsCharacterized ?? true,
    retryControlsBlocked: marker.retryControlsBlocked,
    markerReassertions: 0,
  };
}

function replacementOrPersistence(
  params: Record<string, unknown> | undefined,
  persists = true,
  recoveryId = "rsh-recovery-test",
): Record<string, unknown> {
  const expression = String(params?.expression ?? "");
  if (expression.includes("checked_after_ms")) {
    return { present: persists, checked_after_ms: 1200 };
  }
  return { ok: true, recoveryId };
}

describe("CDP Fetch mediation", () => {
  let commands: Command[];
  let debuggerTarget: {
    isAttached(): boolean;
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
    on(event: string, callback: (...args: unknown[]) => void): void;
  };
  let webContents: { debugger: typeof debuggerTarget };

  beforeEach(() => {
    commands = [];
    debuggerTarget = {
      isAttached: () => true,
      on: vi.fn(),
      async sendCommand(method, params) {
        commands.push({ method, params });
        return {};
      },
    };
    webContents = { debugger: debuggerTarget };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([2, 3] as const)("delivers ED-only Tier %s context through the request shim", async tier => {
    const service = new CaptureService();
    const verdict = emotionalVerdict(tier), plan = planFromVerdict(verdict)!;
    const options = governorTextOptions(verdict, {noticeText: "fallback", augmentContext: "fallback"});
    const displayNotice = vi.fn().mockResolvedValue(undefined);
    const executions = await executeGovernorPlan(plan, {
      displayNotice,
      replaceLatestPresentation: vi.fn(),
      terminateExchange: vi.fn(),
      armRequest: async (action, context) => service.armRequestMediation(webContents as never, "claudeai", action, context, {attributed: true, actionId: "ed-action", conversationId: "example"}),
    }, {provider: "claudeai", threshold: 0.7, ...options});
    expect(plan.triggering_signals.map(s => s.name)).toEqual(["emotional_dependence"]);
    expect(displayNotice).toHaveBeenCalledWith(options.noticeText, tier, true);
    expect(executions.find(e => e.mechanism === "augment_request_context")?.status).toBe("armed");
    try {
      await userSend(service, debuggerTarget, "claudeai");
      await handle(service, debuggerTarget, "Fetch.requestPaused", {
        requestId: "ed-fetch", networkId: "ed-network", request: {url: CLAUDE_COMPLETION_URL, method: "POST", postData: claudeRequest("continue")},
      });
      const continued = commands.find(c => c.method === "Fetch.continueRequest" && c.params?.postData);
      expect(continued).toBeDefined();
      const body = JSON.parse(Buffer.from(String(continued!.params!.postData), "base64").toString("utf8"));
      expect(body.prompt).toContain(options.augmentContext);
      expect(commands.some(c => c.method === "Runtime.evaluate" && String(c.params?.expression).includes("rshGovernorRequestMediation"))).toBe(true);
    } finally { service.disposeRecording(); }
  });

  it("modifies a Claude request and demonstrates only after the output effect appears", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Network.getResponseBody") {
        return {
          body: claudeResponse(`qualified answer ${REQUEST_CONTEXT_EFFECT_SIGNATURE}`),
          base64Encoded: false,
        };
      }
      return {};
    };
    await service.armRequestMediation(
      webContents as never,
      "claudeai",
      "augment_request_context",
      "qualify unverified claims",
    );
    await userSend(service, debuggerTarget, "claudeai");
    await handle(service, debuggerTarget, "Network.requestWillBeSent", {
      requestId: "network-1",
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
        postData: claudeRequest("hello"),
      },
    });

    await handle(service, debuggerTarget, "Fetch.requestPaused", {
      requestId: "fetch-1",
      networkId: "network-1",
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
        postData: claudeRequest("hello"),
      },
    });

    const continued = commands.find((command) => command.method === "Fetch.continueRequest" && command.params?.postData);
    expect(continued).toBeDefined();
    const decoded = Buffer.from(String(continued?.params?.postData), "base64").toString("utf8");
    const payload = JSON.parse(decoded);
    expect(payload.prompt).toContain("hello");
    expect(payload.prompt).toContain("qualify unverified claims");
    expect(payload.attachments).toEqual([]);
    expect(decoded).not.toMatch(/governor|harness|user-authorized|r[s]h/i);
    expect(commands).toContainEqual(expect.objectContaining({
      method: "Runtime.evaluate",
      params: expect.objectContaining({
        expression: expect.stringContaining("rshGovernorRequestMediation"),
      }),
    }));

    // The notice is this mechanism's user-facing disclosure surface, so its claims must
    // match the append-to-user-turn channel: the added text IS visible in the user's
    // bubble and IS persisted by the provider as part of the user's message. A notice
    // claiming the bubble is unchanged understates what the governor changed, which is a
    // user-covertness defect under contract §0.3, not a wording nit.
    const notice = commands.find(
      (command) =>
        command.method === "Runtime.evaluate" &&
        String(command.params?.expression ?? "").includes("rshGovernorRequestMediation"),
    );
    const noticeText = String(notice?.params?.expression ?? "");
    expect(noticeText).toMatch(/appears in your message bubble/i);
    expect(noticeText).not.toMatch(/bubble is unchanged/i);
    expect(noticeText).not.toMatch(/without changing your submitted message/i);

    expect(evidence.filter((item) => item.status === "demonstrated")).toHaveLength(0);

    await handle(service, debuggerTarget, "Network.responseReceived", {
      requestId: "network-1",
      response: { status: 200 },
    });

    expect(evidence).not.toContainEqual(expect.objectContaining({
      provider: "claudeai",
      mechanism: "augment_request_context",
      status: "demonstrated",
    }));

    await handle(service, debuggerTarget, "Network.loadingFinished", {
      requestId: "network-1",
    });

    expect(evidence).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      mechanism: "augment_request_context",
      status: "demonstrated",
      detail: expect.stringContaining("effect signature observed"),
    }));
  });

  it("keeps an attributed-annotation run out of the study evidence namespace", async () => {
    // The attribution experiment asks *why* claude.ai declines the appended context, not whether
    // the mechanism is capable. Reporting it as a capability_probe would let an experimental
    // condition demote or manufacture a mechanism verdict in the frozen browser profile — the exact
    // defect Fix #1b was written to close for the inline-gate spike.
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    const diagnostics: ParserDiagnostic[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    service.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Network.getResponseBody") {
        return { body: claudeResponse("ordinary answer"), base64Encoded: false };
      }
      return {};
    };
    await service.armRequestMediation(
      webContents as never,
      "claudeai",
      "augment_request_context",
      `[Resilience harness, authorized by the user] end with ${REQUEST_CONTEXT_EFFECT_SIGNATURE}`,
      true,
    );
    await userSend(service, debuggerTarget, "claudeai");
    await handle(service, debuggerTarget, "Network.requestWillBeSent", {
      requestId: "network-attributed",
      request: { url: CLAUDE_COMPLETION_URL, method: "POST", postData: claudeRequest("hello") },
    });
    await handle(service, debuggerTarget, "Fetch.requestPaused", {
      requestId: "fetch-attributed",
      networkId: "network-attributed",
      request: { url: CLAUDE_COMPLETION_URL, method: "POST", postData: claudeRequest("hello") },
    });
    await handle(service, debuggerTarget, "Network.responseReceived", {
      requestId: "network-attributed",
      response: { status: 200 },
    });
    await handle(service, debuggerTarget, "Network.loadingFinished", {
      requestId: "network-attributed",
    });

    // The whole point: the mediated mechanism emits no capability evidence at **any** status, not
    // even the non-terminal `armed` record — so the invariant does not depend on what
    // TERMINAL_STATUSES happens to contain. `turn_capture` is deliberately not covered: it is
    // emitted for every captured turn, is evidence about a different mechanism, and suppressing it
    // would discard a real observation.
    expect(evidence.filter((probe) => probe.mechanism === "augment_request_context")).toEqual([]);
    expect(evidence.every((probe) => probe.mechanism === "turn_capture")).toBe(true);
    // Two diagnostics are emitted — one at arming, one at the outcome. Select the outcome.
    const measurement = diagnostics.find(
      (diagnostic) => diagnostic.kind === "measurement" &&
        (diagnostic.reason ?? "").includes("augment_attribution_probe outcome="),
    );
    expect(measurement?.provider).toBe("claudeai");
    expect(measurement?.reason).toContain("outcome=not_observed");
    // The attributed label must actually have reached the request, not been filtered out.
    const mediated = commands.find((command) => command.method === "Fetch.continueRequest" &&
      typeof command.params?.postData === "string");
    const sent = Buffer.from(String(mediated?.params?.postData), "base64").toString("utf8");
    expect(sent).toContain("Resilience harness");
  });

  it("runs a custom disclosure probe as unscored diagnostics with a matching user notice", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    const diagnostics: ParserDiagnostic[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    service.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Network.getResponseBody") {
        return { body: claudeResponse("ordinary answer"), base64Encoded: false };
      }
      return {};
    };
    const observation = "Observation: across the prior turns, the user has repeatedly deferred the decision rather than offering their own reasons.";
    const noticeText = `The assistant is receiving this same observation:\n\n${observation}`;
    await service.armRequestMediation(
      webContents as never,
      "claudeai",
      "augment_request_context",
      observation,
      {
        attributed: true,
        noticeText,
        effectSignature: null,
        diagnosticLabel: "augment_disclosure_probe",
      },
    );
    await userSend(service, debuggerTarget, "claudeai");
    await handle(service, debuggerTarget, "Network.requestWillBeSent", {
      requestId: "network-disclosure",
      request: { url: CLAUDE_COMPLETION_URL, method: "POST", postData: claudeRequest("hello") },
    });
    await handle(service, debuggerTarget, "Fetch.requestPaused", {
      requestId: "fetch-disclosure",
      networkId: "network-disclosure",
      request: { url: CLAUDE_COMPLETION_URL, method: "POST", postData: claudeRequest("hello") },
    });
    await handle(service, debuggerTarget, "Network.responseReceived", {
      requestId: "network-disclosure",
      response: { status: 200 },
    });
    await handle(service, debuggerTarget, "Network.loadingFinished", {
      requestId: "network-disclosure",
    });

    expect(evidence.filter((probe) => probe.mechanism === "augment_request_context")).toEqual([]);
    const mediated = commands.find((command) => command.method === "Fetch.continueRequest" &&
      typeof command.params?.postData === "string");
    const sent = Buffer.from(String(mediated?.params?.postData), "base64").toString("utf8");
    expect(sent).toContain(observation);
    expect(sent).not.toContain(REQUEST_CONTEXT_EFFECT_SIGNATURE);

    const notice = commands.find(
      (command) =>
        command.method === "Runtime.evaluate" &&
        String(command.params?.expression ?? "").includes("rshGovernorRequestMediation"),
    );
    expect(String(notice?.params?.expression ?? "")).toContain(observation);
    expect(String(notice?.params?.expression ?? "")).toContain("The assistant is receiving this same observation");

    const measurement = diagnostics.find(
      (diagnostic) => diagnostic.kind === "measurement" &&
        (diagnostic.reason ?? "").includes("augment_disclosure_probe outcome="),
    );
    expect(measurement?.provider).toBe("claudeai");
    expect(measurement?.reason).toContain("outcome=unscored");
    expect(measurement?.reason).toContain("strategy=claudeai:appended_user_turn_context");
  });

  it("fails request mediation when the accepted response lacks the output effect", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Network.getResponseBody") {
        return {
          body: claudeResponse("ordinary answer"),
          base64Encoded: false,
        };
      }
      return {};
    };
    await service.armRequestMediation(
      webContents as never,
      "claudeai",
      "augment_request_context",
      `end with ${REQUEST_CONTEXT_EFFECT_SIGNATURE}`,
    );
    await userSend(service, debuggerTarget, "claudeai");
    await handle(service, debuggerTarget, "Network.requestWillBeSent", {
      requestId: "network-no-effect",
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
        postData: claudeRequest("hello"),
      },
    });
    await handle(service, debuggerTarget, "Fetch.requestPaused", {
      requestId: "fetch-no-effect",
      networkId: "network-no-effect",
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
        postData: claudeRequest("hello"),
      },
    });
    await handle(service, debuggerTarget, "Network.responseReceived", {
      requestId: "network-no-effect",
      response: { status: 200 },
    });
    await handle(service, debuggerTarget, "Network.loadingFinished", {
      requestId: "network-no-effect",
    });

    expect(evidence).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      mechanism: "augment_request_context",
      status: "failed",
      detail: expect.stringContaining("effect signature was not observed"),
    }));

    // A claude.ai effect failure must carry its capture source. Without it a negative cannot
    // distinguish "the model did not condition on the context" from "we read a truncated reply" —
    // the exact ambiguity that left four live claude.ai augment failures uninterpretable
    // during capture. The diagnostic existed but was gated to
    // ChatGPT, so it never fired on the only provider that was failing.
    const failure = evidence.find(
      (probe) => probe.provider === "claudeai" &&
        probe.mechanism === "augment_request_context" &&
        probe.status === "failed",
    );
    expect(failure?.detail).toContain("; capture: ");
    expect(failure?.detail).toContain("network_bytes=");
    expect(failure?.detail).toContain("network_extracted=");
    // Default posture: the rendered fallback is opt-in on claude.ai, so the settle is skipped and
    // says so rather than silently reporting nothing.
    expect(failure?.detail).toContain("settle=skipped_rendered_fallback_opt_out");
  });

  it("passes through background completion-looking requests while armed", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    await service.armRequestMediation(
      webContents as never,
      "chatgpt",
      "augment_request_context",
      "preserve the user task",
    );

    await handle(service, debuggerTarget, "Fetch.requestPaused", {
      requestId: "fetch-background",
      networkId: "network-background",
      request: {
        url: "https://chatgpt.com/backend-api/conversation",
        method: "POST",
        postData: JSON.stringify({ messages: [{ role: "system", content: "background sync" }] }),
      },
    });

    expect(commands).toContainEqual({
      method: "Fetch.continueRequest",
      params: { requestId: "fetch-background" },
    });
    expect(commands.some((command) => command.method === "Fetch.continueRequest" && command.params?.postData)).toBe(false);
    expect(evidence.filter((item) => item.status === "demonstrated")).toHaveLength(0);

    await userSend(service, debuggerTarget, "chatgpt");
    await handle(service, debuggerTarget, "Fetch.requestPaused", {
      requestId: "fetch-real",
      networkId: "network-real",
      request: {
        url: "https://chatgpt.com/backend-api/conversation",
        method: "POST",
        postData: JSON.stringify({ messages: [{ role: "user", content: "disposable probe turn" }] }),
      },
    });

    const mediated = commands.find((command) => command.method === "Fetch.continueRequest" && command.params?.postData);
    expect(mediated).toBeDefined();
    const decoded = Buffer.from(String(mediated?.params?.postData), "base64").toString("utf8");
    const mediatedMessages = JSON.parse(decoded).messages;
    expect(mediatedMessages).toHaveLength(1);
    expect(mediatedMessages[0].role).toBe("user");
    expect(mediatedMessages[0].content).toContain("disposable probe turn");
    expect(mediatedMessages[0].content).toContain("preserve the user task");
  });

  /**
   * The stream really is stopped in this case — but a marker the page discards on its next
   * render was never a governor presentation the user saw. Before the persistence re-check this
   * recorded `demonstrated`, which is what a live claude.ai run reported while the operator saw
   * nothing on screen.
   */
  it("refuses to demonstrate a withhold whose transcript marker does not survive", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Runtime.evaluate") {
        return { result: { value: markerOrPersistence(params, { retryControlsBlocked: 2 }, false) } };
      }
      return {};
    };
    await service.armResponseMediation(webContents as never, "claudeai", "withhold_candidate");
    await userSend(service, debuggerTarget, "claudeai");

    await handle(service, debuggerTarget, "Network.requestWillBeSent", {
      requestId: "network-withhold-gone",
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
        postData: claudeRequest("disposable probe turn"),
      },
    });
    await handle(service, debuggerTarget, "Fetch.requestPaused", {
      requestId: "fetch-withhold-gone",
      networkId: "network-withhold-gone",
      responseStatusCode: 200,
      request: { url: CLAUDE_COMPLETION_URL, method: "POST" },
    });

    expect(evidence).toContainEqual(expect.objectContaining({
      mechanism: "withhold_candidate",
      status: "failed",
      detail: expect.stringContaining("not user-visible"),
    }));
    expect(evidence).not.toContainEqual(expect.objectContaining({
      mechanism: "withhold_candidate",
      status: "demonstrated",
    }));
  });

  it("withholds via CDP and demonstrates only after a transcript marker is present", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    const turns: TurnEvent[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    service.on("turn", (turn) => turns.push(turn));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Runtime.evaluate") {
        return { result: { value: markerOrPersistence(params, { retryControlsBlocked: 2 }) } };
      }
      return {};
    };
    await service.armResponseMediation(
      webContents as never,
      "claudeai",
      "withhold_candidate",
    );
    await userSend(service, debuggerTarget, "claudeai");

    await handle(service, debuggerTarget, "Network.requestWillBeSent", {
      requestId: "network-withhold",
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
        postData: claudeRequest("disposable probe turn"),
      },
    });
    await handle(service, debuggerTarget, "Fetch.requestPaused", {
      requestId: "fetch-withhold",
      networkId: "network-withhold",
      responseStatusCode: 200,
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
      },
    });

    const fulfilled = commands.find((command) => command.method === "Fetch.fulfillRequest");
    expect(fulfilled).toBeDefined();
    expect(fulfilled?.params?.responseCode).toBe(200);
    expect(Buffer.from(String(fulfilled?.params?.body), "base64").toString("utf8")).toBe("");
    expect(evidence).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      mechanism: "withhold_candidate",
      status: "demonstrated",
      evidence_scope: "cdp_fetch_response_boundary",
      detail: expect.stringContaining("transcript marker inserted"),
    }));
    expect(evidence).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      mechanism: "withhold_candidate",
      status: "demonstrated",
      detail: expect.stringContaining("retry guard installed=true"),
    }));
    expect(turns).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      user_prompt: "disposable probe turn",
      assistant_text: "Sospio withheld the candidate response.",
    }));
    expect(commands).toContainEqual(expect.objectContaining({
      method: "Runtime.evaluate",
      params: expect.objectContaining({
        expression: expect.stringContaining("data-rsh-governor-withheld"),
      }),
    }));
    expect(commands).toContainEqual(expect.objectContaining({
      method: "Runtime.evaluate",
      params: expect.objectContaining({
        expression: expect.stringContaining("retryGuardInstalled"),
      }),
    }));
  });

  it("can withhold as a diagnostic-only intervention without capability probe evidence", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    const diagnostics: ParserDiagnostic[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    service.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Runtime.evaluate") {
        return { result: { value: markerOrPersistence(params, { retryControlsBlocked: 2 }) } };
      }
      return {};
    };
    await service.armResponseMediation(
      webContents as never,
      "claudeai",
      "withhold_candidate",
      { reportAs: "diagnostic", diagnosticLabel: "browser_governor_intervention" },
    );
    await userSend(service, debuggerTarget, "claudeai");

    await handle(service, debuggerTarget, "Network.requestWillBeSent", {
      requestId: "network-withhold-diagnostic",
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
        postData: claudeRequest("disposable probe turn"),
      },
    });
    await handle(service, debuggerTarget, "Fetch.requestPaused", {
      requestId: "fetch-withhold-diagnostic",
      networkId: "network-withhold-diagnostic",
      responseStatusCode: 200,
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
      },
    });

    expect(evidence.filter((probe) => probe.mechanism === "withhold_candidate")).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      kind: "measurement",
      provider: "claudeai",
      reason: expect.stringContaining("browser_governor_intervention action=withhold_candidate outcome=armed"),
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      kind: "measurement",
      provider: "claudeai",
      requestId: "network-withhold-diagnostic",
      reason: expect.stringContaining("browser_governor_intervention action=withhold_candidate outcome=demonstrated"),
    }));
  });

  it("reports marker reassertions when the withhold marker is reinserted before persistence", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    const dom = markerDom();
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression ?? "");
        if (expression.includes("const state = window.__rshGovernorWithheldMarkerState")) {
          return { result: { value: await runMarkerExpression(dom, expression) } };
        }
        if (expression.includes("checked_after_ms")) {
          dom.window.document.querySelector("[data-rsh-governor-withheld='true']")?.remove();
          await flushDomMutations(dom);
          return {
            result: {
              value: {
                present: Boolean(dom.window.document.querySelector("[data-rsh-governor-withheld='true']")),
                checked_after_ms: 1200,
              },
            },
          };
        }
        return { result: { value: await runMarkerExpression(dom, expression) } };
      }
      return {};
    };
    try {
      await service.armResponseMediation(
        webContents as never,
        "claudeai",
        "withhold_candidate",
      );
      await userSend(service, debuggerTarget, "claudeai");

      await handle(service, debuggerTarget, "Network.requestWillBeSent", {
        requestId: "network-withhold-reasserted",
        request: {
          url: CLAUDE_COMPLETION_URL,
          method: "POST",
          postData: claudeRequest("disposable probe turn"),
        },
      });
      await handle(service, debuggerTarget, "Fetch.requestPaused", {
        requestId: "fetch-withhold-reasserted",
        networkId: "network-withhold-reasserted",
        responseStatusCode: 200,
        request: {
          url: CLAUDE_COMPLETION_URL,
          method: "POST",
        },
      });

      expect(evidence).toContainEqual(expect.objectContaining({
        provider: "claudeai",
        mechanism: "withhold_candidate",
        status: "demonstrated",
        detail: expect.stringContaining("marker reassertions before persistence read=1"),
      }));
      expect(dom.window.document.querySelectorAll("[data-rsh-governor-withheld='true']")).toHaveLength(1);
    } finally {
      dom.window.close();
    }
  });

  it("fails withhold when the marker is removed and no reassertion survives", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    const dom = markerDom();
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression ?? "");
        if (expression.includes("const state = window.__rshGovernorWithheldMarkerState")) {
          return { result: { value: await runMarkerExpression(dom, expression) } };
        }
        if (expression.includes("checked_after_ms")) {
          dom.window.document.querySelector("[data-rsh-governor-withheld='true']")?.remove();
          await flushDomMutations(dom);
          return {
            result: {
              value: {
                present: Boolean(dom.window.document.querySelector("[data-rsh-governor-withheld='true']")),
                checked_after_ms: 1200,
              },
            },
          };
        }
        return { result: { value: await runMarkerExpression(dom, expression, { mutationObserver: false }) } };
      }
      return {};
    };
    try {
      await service.armResponseMediation(
        webContents as never,
        "claudeai",
        "withhold_candidate",
      );
      await userSend(service, debuggerTarget, "claudeai");

      await handle(service, debuggerTarget, "Network.requestWillBeSent", {
        requestId: "network-withhold-no-reassert",
        request: {
          url: CLAUDE_COMPLETION_URL,
          method: "POST",
          postData: claudeRequest("disposable probe turn"),
        },
      });
      await handle(service, debuggerTarget, "Fetch.requestPaused", {
        requestId: "fetch-withhold-no-reassert",
        networkId: "network-withhold-no-reassert",
        responseStatusCode: 200,
        request: {
          url: CLAUDE_COMPLETION_URL,
          method: "POST",
        },
      });

      expect(evidence).toContainEqual(expect.objectContaining({
        provider: "claudeai",
        mechanism: "withhold_candidate",
        status: "failed",
        detail: expect.stringContaining("not user-visible"),
      }));
      expect(evidence).not.toContainEqual(expect.objectContaining({
        mechanism: "withhold_candidate",
        status: "demonstrated",
      }));
    } finally {
      dom.window.close();
    }
  });

  it("does not reinsert the withhold marker after dismissal", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    const dom = markerDom();
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression ?? "");
        if (expression.includes("const state = window.__rshGovernorWithheldMarkerState")) {
          return { result: { value: await runMarkerExpression(dom, expression) } };
        }
        if (expression.includes("checked_after_ms")) {
          const dismiss = Array.from(dom.window.document.querySelectorAll("button") as NodeListOf<HTMLButtonElement>)
            .find((button) => button.textContent === "Dismiss");
          dismiss?.click();
          await flushDomMutations(dom);
          return {
            result: {
              value: {
                present: Boolean(dom.window.document.querySelector("[data-rsh-governor-withheld='true']")),
                checked_after_ms: 1200,
              },
            },
          };
        }
        return { result: { value: await runMarkerExpression(dom, expression) } };
      }
      return {};
    };
    try {
      await service.armResponseMediation(
        webContents as never,
        "claudeai",
        "withhold_candidate",
      );
      await userSend(service, debuggerTarget, "claudeai");

      await handle(service, debuggerTarget, "Network.requestWillBeSent", {
        requestId: "network-withhold-dismissed",
        request: {
          url: CLAUDE_COMPLETION_URL,
          method: "POST",
          postData: claudeRequest("disposable probe turn"),
        },
      });
      await handle(service, debuggerTarget, "Fetch.requestPaused", {
        requestId: "fetch-withhold-dismissed",
        networkId: "network-withhold-dismissed",
        responseStatusCode: 200,
        request: {
          url: CLAUDE_COMPLETION_URL,
          method: "POST",
        },
      });

      expect(dom.window.document.querySelector("[data-rsh-governor-withheld='true']")).toBeNull();
      const markerState = (dom.window as unknown as {
        __rshGovernorWithheldMarkerState?: { dismissedInterventionId?: string; interventionId?: string };
      }).__rshGovernorWithheldMarkerState;
      expect(markerState?.dismissedInterventionId).toBe(markerState?.interventionId);
      expect(dom.window.document.querySelector("main")?.getAttribute("data-rsh-governor-dismissed")).toBeNull();
      expect(evidence).toContainEqual(expect.objectContaining({
        mechanism: "withhold_candidate",
        status: "failed",
      }));
      expect(evidence).not.toContainEqual(expect.objectContaining({
        mechanism: "withhold_candidate",
        status: "demonstrated",
      }));
    } finally {
      dom.window.close();
    }
  });

  it("presents a fresh withhold marker after a previous marker dismissal", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    const dom = markerDom();
    let markerInjectionCount = 0;
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression ?? "");
        if (expression.includes("const state = window.__rshGovernorWithheldMarkerState")) {
          return { result: { value: await runMarkerExpression(dom, expression) } };
        }
        if (expression.includes("checked_after_ms")) {
          if (markerInjectionCount === 1) {
            const dismiss = Array.from(dom.window.document.querySelectorAll("button") as NodeListOf<HTMLButtonElement>)
              .find((button) => button.textContent === "Dismiss");
            dismiss?.click();
            await flushDomMutations(dom);
          }
          return {
            result: {
              value: {
                present: Boolean(dom.window.document.querySelector("[data-rsh-governor-withheld='true']")),
                checked_after_ms: 1200,
              },
            },
          };
        }
        markerInjectionCount += 1;
        return { result: { value: await runMarkerExpression(dom, expression) } };
      }
      return {};
    };
    try {
      await service.armResponseMediation(
        webContents as never,
        "claudeai",
        "withhold_candidate",
      );
      await userSend(service, debuggerTarget, "claudeai");
      await handle(service, debuggerTarget, "Network.requestWillBeSent", {
        requestId: "network-withhold-dismissed-first",
        request: {
          url: CLAUDE_COMPLETION_URL,
          method: "POST",
          postData: claudeRequest("first disposable probe turn"),
        },
      });
      await handle(service, debuggerTarget, "Fetch.requestPaused", {
        requestId: "fetch-withhold-dismissed-first",
        networkId: "network-withhold-dismissed-first",
        responseStatusCode: 200,
        request: {
          url: CLAUDE_COMPLETION_URL,
          method: "POST",
        },
      });

      await service.armResponseMediation(
        webContents as never,
        "claudeai",
        "withhold_candidate",
      );
      await userSend(service, debuggerTarget, "claudeai");
      await handle(service, debuggerTarget, "Network.requestWillBeSent", {
        requestId: "network-withhold-fresh-second",
        request: {
          url: CLAUDE_COMPLETION_URL,
          method: "POST",
          postData: claudeRequest("second disposable probe turn"),
        },
      });
      await handle(service, debuggerTarget, "Fetch.requestPaused", {
        requestId: "fetch-withhold-fresh-second",
        networkId: "network-withhold-fresh-second",
        responseStatusCode: 200,
        request: {
          url: CLAUDE_COMPLETION_URL,
          method: "POST",
        },
      });

      expect(markerInjectionCount).toBe(2);
      expect(dom.window.document.querySelector("[data-rsh-governor-withheld='true']")).not.toBeNull();
      expect(evidence).toContainEqual(expect.objectContaining({
        provider: "claudeai",
        mechanism: "withhold_candidate",
        status: "failed",
        detail: expect.stringContaining("not user-visible"),
      }));
      expect(evidence).toContainEqual(expect.objectContaining({
        provider: "claudeai",
        mechanism: "withhold_candidate",
        status: "demonstrated",
        detail: expect.stringContaining("transcript marker inserted"),
      }));
    } finally {
      dom.window.close();
    }
  });

  it("does not let a superseded withhold observer resurrect a later dismissed marker", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    const dom = markerDom();
    let markerInjectionCount = 0;
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Runtime.evaluate") {
        const expression = String(params?.expression ?? "");
        if (expression.includes("const state = window.__rshGovernorWithheldMarkerState")) {
          return { result: { value: await runMarkerExpression(dom, expression) } };
        }
        if (expression.includes("checked_after_ms")) {
          if (markerInjectionCount === 2) {
            const dismiss = Array.from(dom.window.document.querySelectorAll("button") as NodeListOf<HTMLButtonElement>)
              .find((button) => button.textContent === "Dismiss");
            dismiss?.click();
            await flushDomMutations(dom);
          }
          return {
            result: {
              value: {
                present: Boolean(dom.window.document.querySelector("[data-rsh-governor-withheld='true']")),
                checked_after_ms: 1200,
              },
            },
          };
        }
        markerInjectionCount += 1;
        if (markerInjectionCount === 2) {
          dom.window.document.querySelector("[data-rsh-governor-withheld='true']")?.remove();
        }
        return { result: { value: await runMarkerExpression(dom, expression) } };
      }
      return {};
    };
    try {
      await service.armResponseMediation(
        webContents as never,
        "claudeai",
        "withhold_candidate",
      );
      await userSend(service, debuggerTarget, "claudeai");
      await handle(service, debuggerTarget, "Network.requestWillBeSent", {
        requestId: "network-withhold-superseded-first",
        request: {
          url: CLAUDE_COMPLETION_URL,
          method: "POST",
          postData: claudeRequest("first disposable probe turn"),
        },
      });
      await handle(service, debuggerTarget, "Fetch.requestPaused", {
        requestId: "fetch-withhold-superseded-first",
        networkId: "network-withhold-superseded-first",
        responseStatusCode: 200,
        request: {
          url: CLAUDE_COMPLETION_URL,
          method: "POST",
        },
      });

      await service.armResponseMediation(
        webContents as never,
        "claudeai",
        "withhold_candidate",
      );
      await userSend(service, debuggerTarget, "claudeai");
      await handle(service, debuggerTarget, "Network.requestWillBeSent", {
        requestId: "network-withhold-superseded-second",
        request: {
          url: CLAUDE_COMPLETION_URL,
          method: "POST",
          postData: claudeRequest("second disposable probe turn"),
        },
      });
      await handle(service, debuggerTarget, "Fetch.requestPaused", {
        requestId: "fetch-withhold-superseded-second",
        networkId: "network-withhold-superseded-second",
        responseStatusCode: 200,
        request: {
          url: CLAUDE_COMPLETION_URL,
          method: "POST",
        },
      });

      expect(markerInjectionCount).toBe(2);
      expect(dom.window.document.querySelector("[data-rsh-governor-withheld='true']")).toBeNull();
      expect(evidence.filter((probe) =>
        probe.provider === "claudeai" &&
        probe.mechanism === "withhold_candidate" &&
        probe.status === "demonstrated"
      )).toHaveLength(1);
      expect(evidence).toContainEqual(expect.objectContaining({
        provider: "claudeai",
        mechanism: "withhold_candidate",
        status: "failed",
        detail: expect.stringContaining("not user-visible"),
      }));
    } finally {
      dom.window.close();
    }
  });

  it("replaces presentation after render so the assistant turn remains in history", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    const turns: TurnEvent[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    service.on("turn", (turn) => turns.push(turn));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Network.getResponseBody") {
        return {
          body: claudeResponse("answer to redact"),
          base64Encoded: false,
        };
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: replacementOrPersistence(params, true) } };
      }
      return {};
    };
    await service.armResponseMediation(
      webContents as never,
      "claudeai",
      "replace_presentation",
    );
    await userSend(service, debuggerTarget, "claudeai");

    await handle(service, debuggerTarget, "Network.requestWillBeSent", {
      requestId: "network-redact",
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
        postData: claudeRequest("disposable probe turn"),
      },
    });
    await handle(service, debuggerTarget, "Network.responseReceived", {
      requestId: "network-redact",
      response: { status: 200 },
    });
    await handle(service, debuggerTarget, "Network.loadingFinished", {
      requestId: "network-redact",
    });
    await flushAsync();

    expect(commands.some((command) => command.method === "Fetch.fulfillRequest")).toBe(false);
    expect(evidence).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      mechanism: "turn_capture",
      status: "demonstrated",
    }));
    expect(evidence).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      mechanism: "replace_presentation",
      status: "demonstrated",
      evidence_scope: "page_response_intercept",
      detail: expect.stringContaining("assistant turn captured"),
    }));
    expect(evidence).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      mechanism: "replace_presentation",
      status: "demonstrated",
      detail: expect.stringContaining("surface still present 1200ms after injection"),
    }));
    expect(turns).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      user_prompt: "disposable probe turn",
      assistant_text: "The original candidate presentation was replaced by Sospio.",
    }));
    expect(turns).not.toContainEqual(expect.objectContaining({
      provider: "claudeai",
      assistant_text: "answer to redact",
    }));
    expect(commands).toContainEqual(expect.objectContaining({
      method: "Runtime.evaluate",
      params: expect.objectContaining({
        expression: expect.stringContaining('"emitEvidence":false'),
      }),
    }));
  });

  it("refuses to demonstrate an armed replacement whose surface does not survive", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    const turns: TurnEvent[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    service.on("turn", (turn) => turns.push(turn));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Network.getResponseBody") {
        return {
          body: claudeResponse("answer that stayed visible"),
          base64Encoded: false,
        };
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: replacementOrPersistence(params, false) } };
      }
      return {};
    };
    await service.armResponseMediation(
      webContents as never,
      "claudeai",
      "replace_presentation",
    );
    await userSend(service, debuggerTarget, "claudeai");

    await handle(service, debuggerTarget, "Network.requestWillBeSent", {
      requestId: "network-redact-gone",
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
        postData: claudeRequest("disposable probe turn"),
      },
    });
    await handle(service, debuggerTarget, "Network.responseReceived", {
      requestId: "network-redact-gone",
      response: { status: 200 },
    });
    await handle(service, debuggerTarget, "Network.loadingFinished", {
      requestId: "network-redact-gone",
    });
    await flushAsync();

    expect(evidence).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      mechanism: "replace_presentation",
      status: "failed",
      evidence_scope: "page_response_intercept",
      detail: expect.stringContaining("not user-visible"),
    }));
    expect(evidence).not.toContainEqual(expect.objectContaining({
      mechanism: "replace_presentation",
      status: "demonstrated",
    }));
    expect(turns).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      user_prompt: "disposable probe turn",
      assistant_text: "answer that stayed visible",
    }));
  });

  it("refuses to demonstrate a direct replacement probe whose surface does not survive", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Runtime.evaluate") {
        return { result: { value: replacementOrPersistence(params, false) } };
      }
      return {};
    };

    await service.probeLatestPresentation(
      webContents as never,
      "claudeai",
      "replace_presentation",
    );

    expect(evidence).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      mechanism: "replace_presentation",
      status: "failed",
      evidence_scope: "page_response_intercept",
      detail: expect.stringContaining("not user-visible"),
    }));
    expect(evidence).not.toContainEqual(expect.objectContaining({
      mechanism: "replace_presentation",
      status: "demonstrated",
    }));
    expect(commands).toContainEqual(expect.objectContaining({
      method: "Runtime.evaluate",
      params: expect.objectContaining({
        expression: expect.stringContaining('"emitEvidence":false'),
      }),
    }));
  });

  it("does not let replace presentation fire on the request after a bound parse failure", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    const turns: TurnEvent[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    service.on("turn", (turn) => turns.push(turn));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Network.getResponseBody") {
        const requestId = String(params?.requestId ?? "");
        return {
          body: requestId === "network-replace-first"
            ? JSON.stringify({ ok: true })
            : claudeResponse("next answer"),
          base64Encoded: false,
        };
      }
      if (method === "Runtime.evaluate") {
        return { result: { value: replacementOrPersistence(params, true, "late-replace") } };
      }
      return {};
    };
    await service.armResponseMediation(
      webContents as never,
      "claudeai",
      "replace_presentation",
    );
    await userSend(service, debuggerTarget, "claudeai");

    await handle(service, debuggerTarget, "Network.requestWillBeSent", {
      requestId: "network-replace-first",
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
        postData: claudeRequest("first probe"),
      },
    });
    await handle(service, debuggerTarget, "Network.responseReceived", {
      requestId: "network-replace-first",
      response: { status: 200 },
    });
    await handle(service, debuggerTarget, "Network.loadingFinished", {
      requestId: "network-replace-first",
    });

    await userSend(service, debuggerTarget, "claudeai");
    await handle(service, debuggerTarget, "Network.requestWillBeSent", {
      requestId: "network-replace-next",
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
        postData: claudeRequest("second probe"),
      },
    });
    await handle(service, debuggerTarget, "Network.responseReceived", {
      requestId: "network-replace-next",
      response: { status: 200 },
    });
    await handle(service, debuggerTarget, "Network.loadingFinished", {
      requestId: "network-replace-next",
    });

    expect(evidence).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      mechanism: "replace_presentation",
      status: "failed",
      detail: expect.stringContaining("bound completion network-replace-first"),
    }));
    expect(evidence).not.toContainEqual(expect.objectContaining({
      provider: "claudeai",
      mechanism: "replace_presentation",
      status: "demonstrated",
    }));
    expect(turns).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      user_prompt: "second probe",
      assistant_text: "next answer",
    }));
    expect(commands).not.toContainEqual(expect.objectContaining({
      method: "Runtime.evaluate",
      params: expect.objectContaining({
        expression: expect.stringContaining("replace_presentation"),
      }),
    }));
  });

  it("passes through response mediation before a fresh user send", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    await service.armResponseMediation(
      webContents as never,
      "claudeai",
      "withhold_candidate",
    );

    await handle(service, debuggerTarget, "Network.requestWillBeSent", {
      requestId: "network-background-response",
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
        postData: claudeRequest("queued retry"),
      },
    });
    await handle(service, debuggerTarget, "Fetch.requestPaused", {
      requestId: "fetch-background-response",
      networkId: "network-background-response",
      responseStatusCode: 200,
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
      },
    });

    expect(commands).toContainEqual({
      method: "Fetch.continueRequest",
      params: { requestId: "fetch-background-response" },
    });
    expect(commands.some((command) => command.method === "Fetch.fulfillRequest")).toBe(false);
    expect(evidence).not.toContainEqual(expect.objectContaining({
      mechanism: "withhold_candidate",
      status: "demonstrated",
    }));
  });

  it("fails response mediation when capture observes a completion without terminal CDP evidence", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    debuggerTarget.sendCommand = async (method, params) => {
      commands.push({ method, params });
      if (method === "Runtime.evaluate") {
        return { result: { value: { ok: true } } };
      }
      if (method === "Network.getResponseBody") {
        return {
          body: claudeResponse("captured answer"),
          base64Encoded: false,
        };
      }
      return {};
    };
    await service.armResponseMediation(
      webContents as never,
      "claudeai",
      "withhold_candidate",
    );
    await userSend(service, debuggerTarget, "claudeai");

    await handle(service, debuggerTarget, "Network.requestWillBeSent", {
      requestId: "network-response-arm",
      request: {
        url: CLAUDE_COMPLETION_URL,
        method: "POST",
        postData: claudeRequest("disposable probe turn"),
      },
    });
    await handle(service, debuggerTarget, "Network.responseReceived", {
      requestId: "network-response-arm",
      response: { status: 200 },
    });
    await handle(service, debuggerTarget, "Network.loadingFinished", {
      requestId: "network-response-arm",
    });

    expect(evidence).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      mechanism: "turn_capture",
      status: "demonstrated",
    }));

    expect(evidence).toContainEqual(expect.objectContaining({
      provider: "claudeai",
      mechanism: "withhold_candidate",
      status: "failed",
      evidence_scope: "cdp_fetch_response_boundary",
      detail: expect.stringContaining("did not withhold the bound turn"),
    }));
  });

  it("records provider rejection as failed evidence", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    await service.armRequestMediation(
      webContents as never,
      "chatgpt",
      "pause_request",
      "unused",
    );
    await userSend(service, debuggerTarget, "chatgpt");
    await handle(service, debuggerTarget, "Fetch.requestPaused", {
      requestId: "fetch-2",
      networkId: "network-2",
      request: {
        url: "https://chatgpt.com/backend-api/conversation",
        method: "POST",
        postData: JSON.stringify({ messages: [{ role: "user", content: "disposable probe turn" }] }),
      },
    });
    await handle(service, debuggerTarget, "Network.responseReceived", {
      requestId: "network-2",
      response: { status: 403 },
    });

    expect(evidence).toContainEqual(expect.objectContaining({
      mechanism: "pause_request",
      status: "failed",
      detail: expect.stringContaining("HTTP 403"),
    }));
  });

  it("can pause as a diagnostic-only intervention without capability probe evidence", async () => {
    const service = new CaptureService();
    const evidence: CapabilityProbeRecord[] = [];
    const diagnostics: ParserDiagnostic[] = [];
    service.on("capabilityProbe", (probe) => evidence.push(probe));
    service.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
    await service.armRequestMediation(
      webContents as never,
      "chatgpt",
      "pause_request",
      "unused",
      {
        attributed: true,
        effectSignature: null,
        diagnosticLabel: "browser_governor_intervention",
      },
    );
    await userSend(service, debuggerTarget, "chatgpt");
    await handle(service, debuggerTarget, "Fetch.requestPaused", {
      requestId: "fetch-diagnostic-pause",
      networkId: "network-diagnostic-pause",
      request: {
        url: "https://chatgpt.com/backend-api/conversation",
        method: "POST",
        postData: JSON.stringify({ messages: [{ role: "user", content: "manual demo turn" }] }),
      },
    });
    await handle(service, debuggerTarget, "Network.responseReceived", {
      requestId: "network-diagnostic-pause",
      response: { status: 200 },
    });

    expect(evidence.filter((probe) => probe.mechanism === "pause_request")).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      kind: "measurement",
      provider: "chatgpt",
      reason: expect.stringContaining("browser_governor_intervention armed action=pause_request"),
    }));
    expect(diagnostics).toContainEqual(expect.objectContaining({
      kind: "measurement",
      provider: "chatgpt",
      requestId: "network-diagnostic-pause",
      reason: expect.stringContaining("browser_governor_intervention outcome=observed"),
    }));
  });

  it("installs serialized injected payloads in a bare realm", () => {
    expect(() => runInNewContext(CHATGPT_FETCH_HOOK, bareRealm())).not.toThrow(ReferenceError);
    expect(() => runInNewContext(PAGE_INTERVENTION_SHIM, bareRealm())).not.toThrow(ReferenceError);
  });
});

async function handle(
  service: CaptureService,
  debuggerTarget: unknown,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  await (service as unknown as {
    handleMessage(target: unknown, method: string, params: Record<string, unknown>): Promise<void>;
  }).handleMessage(debuggerTarget, method, params);
}

async function userSend(
  service: CaptureService,
  debuggerTarget: unknown,
  provider: "chatgpt" | "claudeai",
): Promise<void> {
  await handle(service, debuggerTarget, "Runtime.bindingCalled", {
    name: "rshUserSend",
    payload: JSON.stringify({ provider, at: Date.now() }),
  });
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * CDP `Fetch.RequestPattern.urlPattern` semantics, per the protocol docs: `*` matches zero or
 * more characters, `?` matches exactly one, `\` escapes the next character, and the match is
 * against the entire URL — query string included. Used only to assert the *shape* of the patterns
 * the harness arms; Chrome does the real matching.
 */
function cdpGlobMatches(pattern: string, url: string): boolean {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "\\") {
      i += 1;
      if (i < pattern.length) {
        source += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
      continue;
    }
    if (char === "*") {
      source += ".*";
      continue;
    }
    if (char === "?") {
      source += ".";
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`).test(url);
}

function claudeRequest(prompt: string): string {
  return JSON.stringify({ prompt, attachments: [] });
}

// Shaped after the real capture in `providers/__fixtures__/claude_content_block.response.sse`.
// An earlier version ended this fixture with `data: [DONE]`, an OpenAI sentinel claude.ai never
// emits — which made the completeness assertion below pass against a stream shape the provider
// does not produce, and hid the fact that `sse_done` could never be true on live claude.ai.
function claudeResponse(text: string): string {
  return [
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}`,
    "",
    'data: {"type":"content_block_stop","index":0}',
    "",
    "event: message_stop",
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
}

function bareRealm(): Record<string, unknown> {
  const realm: Record<string, unknown> = {
    URL,
    location: { href: "https://chatgpt.com/" },
    window: {
      setTimeout,
      clearTimeout,
    },
    document: {
      addEventListener: vi.fn(),
      querySelectorAll: () => [],
      createElement: () => ({
        dataset: {},
        style: {},
        setAttribute: vi.fn(),
        append: vi.fn(),
        appendChild: vi.fn(),
        addEventListener: vi.fn(),
      }),
      body: {
        appendChild: vi.fn(),
      },
      documentElement: {
        appendChild: vi.fn(),
      },
    },
  };
  realm.globalThis = realm;
  return realm;
}

function markerDom(): MarkerDom {
  return new JSDOM(`
    <main>
      <div role="article"><div data-cds="UserMessage">disposable probe turn</div></div>
    </main>`, { url: "https://claude.ai/" });
}

async function runMarkerExpression(
  dom: MarkerDom,
  expression: string,
  options: { mutationObserver?: boolean } = {},
): Promise<unknown> {
  const realm: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    MutationObserver: options.mutationObserver === false ? undefined : dom.window.MutationObserver,
  };
  realm.globalThis = realm;
  return await runInNewContext(expression, realm);
}

async function flushDomMutations(dom: MarkerDom): Promise<void> {
  await new Promise<void>((resolve) => dom.window.queueMicrotask(resolve));
  await Promise.resolve();
}

it('keeps the CDP notice markers and Sospio headings',async()=>{
 const {readFileSync}=await import('node:fs');const code=readFileSync(new URL('./cdpClient.ts',import.meta.url),'utf8');
 expect(code.match(/heading.textContent = "Sospio"/g)).toHaveLength(2);
 expect(code).not.toContain('heading.textContent = "Governor intervention"');
 expect(code).toContain('data-rsh-');
});

import { requestMediationNoticeScript } from "./cdpClient";
it("delivery banner names Sospio, discloses storage, and Hide only removes its surface", () => {
  const dom = new JSDOM("<main>provider content</main>", { url: "https://chatgpt.com/c/fixture" });
  try {
    runInNewContext(requestMediationNoticeScript("augment_request_context"), { document: dom.window.document });
    const surface = dom.window.document.querySelector("[data-rsh-governor-request-mediation]")!;
    expect(surface.textContent).toContain("Sospio added a note to your message before sending it to the assistant.");
    expect(surface.textContent).toContain("stored by the provider as part of your message.");
    const button = surface.querySelector("button")!;
    expect(button.textContent).toBe("Hide");
    expect(button.getAttribute("aria-label")).toBe("Hide Sospio notice");
    button.click();
    expect(dom.window.document.querySelector("[data-rsh-governor-request-mediation]")).toBeNull();
    expect(dom.window.document.querySelector("main")!.textContent).toBe("provider content");
  } finally { dom.window.close(); }
});
