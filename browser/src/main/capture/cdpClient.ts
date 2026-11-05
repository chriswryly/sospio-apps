import { ClaudeBodyDiagnostics } from "./claudeBodyDiagnostics";
import { ClaudeDiagnostics } from "./claudeDiagnostics";
import { conversationChanged, conversationIdFromUrl } from "../conversationSurface";
import type { WebContents } from "electron";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { DomObserverBridge } from "./domObserverBridge";
import {
  PAGE_INTERVENTION_SHIM,
  REPLACE_PRESENTATION_TEXT,
  probeLatestPresentationScript,
  type ResponseMediationAction,
} from "./pageInterventionShim";
import { hasCharacterizedDom, providerTurnSelectorsShimSource, turnSelectorsFor } from "./providerDomSelectors";
import { completionProviderFor, providerForUrl } from "./providerRegistry";
import {
  describePersistence,
  readSurfacePersistence,
  surfacePersistedScript,
  SURFACE_PERSISTENCE_DELAY_MS,
  type SurfacePersistence,
} from "./surfacePersistence";
import {
  REQUEST_CONTEXT_EFFECT_SIGNATURE,
  mediateRequestBody,
  type RequestMediationAction,
} from "./requestMediation";
import { EmissionOrder } from "./emissionOrder";
import { TurnAssembler } from "./turnAssembler";
import { describeBodyShape } from "./bodyShape";
import { parseSseEvents } from "./providers/types";
import type { ProviderSpec } from "./providers/types";
import { sanitizeNetworkUrl } from "./urlRedaction";
import type {
  GovernorArmOutcome,
  CapabilityProbeMechanism,
  CapabilityProbeRecord,
  NetworkTag,
  ParserDiagnostic,
  ProviderName,
  MediationProviderName,
  TurnEvent,
} from "../../shared/types";

type DebuggerParams = Record<string, unknown>;

export type CaptureEvents = {
  turn: [TurnEvent];
  governorArmOutcome: [GovernorArmOutcome];
  diagnostic: [ParserDiagnostic];
  networkTag: [NetworkTag];
  capabilityProbe: [CapabilityProbeRecord];
};

type ArmedRequestMediation = {
  actionId?: string;
  conversationId?: string | null;
  provider: MediationProviderName;
  action: RequestMediationAction;
  authorizedContext: string;
  // Set when the operator is testing a declared, user-authorized annotation rather than the
  // anonymous probe context. Results are reported as diagnostics, never capability probes, so
  // attributed context cannot be mistaken for an anonymous mediation result.
  attributed: boolean;
  noticeText?: string;
  effectSignature: string | null;
  diagnosticLabel: string;
  armedAt: number;
  timeout: ReturnType<typeof setTimeout>;
};

type ArmedResponseMediation = {
  provider: MediationProviderName;
  action: ResponseMediationAction;
  reportAs: "capability_probe" | "diagnostic";
  diagnosticLabel: string;
  armedAt: number;
  timeout: ReturnType<typeof setTimeout>;
  requestId?: string;
  requestUrl?: string;
};

type PendingRequestMediation = {
  actionId?: string;
  conversationId?: string | null;
  provider: MediationProviderName;
  action: RequestMediationAction;
  strategy: string;
  noticeDisplayed: boolean;
  providerAccepted?: boolean;
  effectSignature: string | null;
  attributed?: boolean;
  diagnosticLabel: string;
};

type RequestMediationRunOptions = {
  actionId?: string;
  conversationId?: string | null;
  attributed?: boolean;
  noticeText?: string;
  effectSignature?: string | null;
  diagnosticLabel?: string;
};

type ResponseMediationRunOptions = {
  reportAs?: "capability_probe" | "diagnostic";
  diagnosticLabel?: string;
};

export type LatestPresentationMediationResult = {
  provider: ProviderName;
  action: Exclude<ResponseMediationAction, "withhold_candidate">;
  persistence: SurfacePersistence;
  recoveryId?: string;
};

type RecentUserSend = {
  provider: MediationProviderName;
  at: number;
};

const USER_SEND_WINDOW_MS = 15_000;
const PROBE_TIMEOUT_MS = 30_000;
const WITHHELD_MARKER_TEXT = "Sospio withheld the candidate response.";
const REPLACE_PRESENTATION_SELECTOR = '[data-rsh-governor-presentation="replace_presentation"]';
const WITHHELD_MARKER_SELECTOR = "[data-rsh-governor-withheld='true']";

export class CaptureService extends EventEmitter<CaptureEvents> {
  private claudeBodies = new ClaudeBodyDiagnostics(d => this.emitDiagnostic(d));
  private claudeDiagnostics = new ClaudeDiagnostics(d => this.emitDiagnostic(d));
  private claudeRequestMethods = new Map<string, string>();
  private targetWindows = new WeakMap<Electron.Debugger, WebContents>();
  private attached = new WeakSet<WebContents>();
  private assembler = new TurnAssembler();
  private turnOrder = new Map<string, { owner: Electron.Debugger; requestId: string }>();
  private requestWindows = new Map<string, Electron.Debugger>();
  private emissionOrder = new EmissionOrder((id, earlier, waitMs) => this.emitDiagnostic({
    id: randomUUID(), kind: "measurement", requestId: id,
    reason: `emission_held_for_order earlier_request=${earlier} wait_ms=${waitMs}`,
    timestamp: new Date().toISOString(),
  }), (_window, id) => {
    const diagnostic = this.assembler.fail(id, "capture ordering wait exceeded settle bound");
    this.cleanupRequest(id);
    if (diagnostic) this.emitDiagnostic(diagnostic);
  }, RENDERED_TEXT_SETTLE_TIMEOUT_MS + RENDERED_TEXT_SAMPLE_INTERVAL_MS);
  private activeCompletionRequests = new Set<string>();
  private streamedBodies = new Map<string, string[]>();
  private requestProviders = new Map<string, ProviderSpec>();
  private requestUrls = new Map<string, string>();
  private requestPrompts = new Map<string, string>();
  private freshUserSendCompletionRequests = new Set<string>();
  private recentDiagnosticKeys = new Map<string, number>();
  private recentClaudeDomKeys = new Map<string, number>();
  private recentTurnKeys = new Map<string, number>();
  private recentUserSends = new Map<Electron.Debugger, RecentUserSend>();
  private domBridge = new DomObserverBridge();
  private armedRequestMediation = new Map<Electron.Debugger, ArmedRequestMediation>();
  private armedResponseMediation = new Map<Electron.Debugger, ArmedResponseMediation>();
  private pendingRequestMediation = new Map<string, PendingRequestMediation>();
  // How the assistant text for a request was obtained. Kept so a failed effect check can say
  // *why* it failed (truncated rendered read vs empty network body) instead of reporting a bare
  // negative -- the ambiguity that made the 2026-07-29 augment failures unreadable.
  private captureSourceDiagnostics = new Map<string, string>();

  constructor() {
    super();
    this.domBridge.on("diagnostic", (diagnostic) => this.emitDiagnostic(diagnostic));
    this.domBridge.on("turn", (turn) => {
      this.emitTurn(turn, "DOM turn pair captured");
    });
  }

  disposeRecording(): void { this.claudeBodies.dispose(); this.claudeDiagnostics.dispose(); this.domBridge.dispose(); this.removeAllListeners(); }

  hasPendingRecords(): boolean {
    return this.domBridge.hasPending() || this.activeCompletionRequests.size > 0 || this.turnOrder.size > 0 || this.pendingRequestMediation.size > 0;
  }

  attach(webContents: WebContents): void {
    if (this.attached.has(webContents) || webContents.isDestroyed()) {
      return;
    }
    this.attached.add(webContents);
    const dbg = webContents.debugger;
    this.targetWindows.set(dbg, webContents);
    try {
      if (!dbg.isAttached()) {
        dbg.attach("1.3");
      }
      const setup = (method: string, params?: Record<string, unknown>): void => {
        void dbg.sendCommand(method, params).catch((error) => {
          this.emitDiagnostic({id: `debugger-${method}-${Date.now()}`, kind: "parse_error",
            reason: error instanceof Error ? error.message : "failed to configure CDP debugger",
            timestamp: new Date().toISOString()});
        });
      };
      setup("Runtime.enable");
      setup("Page.enable");
      setup("Runtime.addBinding", { name: "rshCapture" });
      setup("Runtime.addBinding", { name: "rshCapabilityEvidence" });
      setup("Runtime.addBinding", { name: "rshUserSend" });
      setup("Page.addScriptToEvaluateOnNewDocument", { source: CHATGPT_FETCH_HOOK });
      setup("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_INTERVENTION_SHIM });
      setup("Runtime.evaluate", { expression: CHATGPT_FETCH_HOOK });
      setup("Runtime.evaluate", { expression: PAGE_INTERVENTION_SHIM });
      setup("Network.enable", {
        maxTotalBufferSize: 100_000_000,
        maxResourceBufferSize: 50_000_000,
      });
    } catch (error) {
      this.emitDiagnostic({
        id: `debugger-${Date.now()}`,
        kind: "parse_error",
        reason: error instanceof Error ? error.message : "failed to attach CDP debugger",
        timestamp: new Date().toISOString(),
      });
      return;
    }
    dbg.on("message", (_event, method, params) => {
      void this.handleMessage(dbg, method, params as DebuggerParams);
    });
    webContents.on("did-finish-load", () => {
      this.configureDomObserver(webContents);
    });
    let previousUrl = webContents.getURL();
    const onNavigation = () => {
      const url = webContents.getURL();
      if (conversationChanged(previousUrl, url)) {
        this.cancelGovernorArm(webContents, "conversation changed or provider navigated away");
        this.cancelPendingCapture(dbg);
        this.domBridge.forget(webContents.id);
      }
      previousUrl = url;
    };
    webContents.on("did-navigate", onNavigation);
    webContents.on("did-navigate-in-page", onNavigation);
    webContents.once("destroyed", () => {
      this.domBridge.forget(webContents.id);
      this.cancelGovernorArmForDebugger(dbg, "chat window closed");
      this.cancelPendingCapture(dbg);
      this.clearArmedRequestMediation(dbg);
      this.clearArmedResponseMediation(dbg);
      this.recentUserSends.delete(dbg);
      try {
        if (dbg.isAttached()) {
          dbg.detach();
        }
      } catch {
        // WebContents teardown can race with detach; no user-visible action needed.
      }
    });
  }

  async armResponseMediation(
    webContents: WebContents,
    provider: MediationProviderName,
    action: ResponseMediationAction,
    runOptions: ResponseMediationRunOptions = {},
  ): Promise<void> {
    const options = normalizeResponseMediationRunOptions(runOptions);
    const dbg = webContents.debugger;
    if (!dbg.isAttached()) {
      throw new Error("CDP debugger is not attached to the provider surface");
    }
    this.clearArmedRequestMediation(dbg);
    if (action === "withhold_candidate") {
      await dbg.sendCommand("Fetch.enable", {
        patterns: responseFetchPatterns(provider),
      });
    } else {
      await this.disableOrRestorePassiveFetch(dbg);
    }
    this.clearArmedResponseMediation(dbg);
    const evidenceScope = action === "withhold_candidate"
      ? "cdp_fetch_response_boundary"
      : "page_response_intercept";
    const armed: ArmedResponseMediation = {
      provider,
      action,
      reportAs: options.reportAs,
      diagnosticLabel: options.diagnosticLabel,
      armedAt: Date.now(),
      timeout: setTimeout(() => {
        if (this.armedResponseMediation.get(dbg) !== armed) {
          return;
        }
        this.armedResponseMediation.delete(dbg);
        void this.disableOrRestorePassiveFetch(dbg);
        this.emitResponseMediationOutcome(
          armed,
          "failed",
          evidenceScope,
          action === "withhold_candidate"
            ? "no fresh user-send completion response observed before timeout"
            : "no fresh user-send assistant turn observed before timeout",
        );
      }, PROBE_TIMEOUT_MS),
    };
    this.armedResponseMediation.set(dbg, armed);
    this.emitResponseMediationOutcome(
      armed,
      "armed",
      evidenceScope,
      action === "withhold_candidate"
        ? "armed for the next fresh provider completion response"
        : "armed for DOM mediation after the next fresh assistant turn",
    );
  }

  async probeLatestPresentation(
    webContents: WebContents,
    provider: MediationProviderName,
    action: Exclude<ResponseMediationAction, "withhold_candidate">,
  ): Promise<void> {
    try {
      const mediated = await this.mediateLatestPresentation(webContents, provider, action);
      this.emitCapabilityProbe(
        provider,
        action,
        "demonstrated",
        "page_response_intercept",
        `provider presentation mediated with recovery handle; ${describePersistence(mediated.persistence)}`,
      );
    } catch (error) {
      this.emitCapabilityProbe(
        provider,
        action,
        "failed",
        "page_response_intercept",
        error instanceof Error ? error.message : "provider assistant presentation not found",
      );
    }
  }

  async mediateLatestPresentation(
    webContents: WebContents,
    provider: ProviderName,
    action: Exclude<ResponseMediationAction, "withhold_candidate">,
  ): Promise<LatestPresentationMediationResult> {
    const result = await this.evaluate(webContents, probeLatestPresentationScript(provider, action));
    const record = objectField(result);
    if (record?.ok !== true) {
      throw new Error(stringField(record?.reason) ?? "provider assistant presentation not found");
    }
    const persistedResult = await this.evaluate(
      webContents,
      surfacePersistedScript(REPLACE_PRESENTATION_SELECTOR),
    );
    const persisted = readSurfacePersistence(objectField(persistedResult), SURFACE_PERSISTENCE_DELAY_MS);
    if (!persisted.present) {
      throw new Error(`provider presentation mediated with recovery handle; ${describePersistence(persisted)}`);
    }

    return {
      provider,
      action,
      persistence: persisted,
      recoveryId: stringField(record.recoveryId),
    };
  }

  async armRequestMediation(
    webContents: WebContents,
    provider: MediationProviderName,
    action: RequestMediationAction,
    authorizedContext: string,
    runOptions: boolean | RequestMediationRunOptions = false,
  ): Promise<void> {
    const options = normalizeRequestMediationRunOptions(runOptions);
    const dbg = webContents.debugger;
    if (!dbg.isAttached()) {
      throw new Error("CDP debugger is not attached to the provider surface");
    }
    this.cancelGovernorArm(webContents, "replaced by a newer governor arm");
    this.clearArmedResponseMediation(dbg);
    await dbg.sendCommand("Fetch.enable", {
      patterns: requestFetchPatterns(provider),
    });
    this.clearArmedRequestMediation(dbg);
    const armed: ArmedRequestMediation = {
      provider,
      action,
      authorizedContext,
      attributed: options.attributed,
      actionId: options.actionId,
      conversationId: options.conversationId ?? conversationIdFromUrl(webContents.getURL?.() ?? ""),
      noticeText: options.noticeText,
      effectSignature: options.effectSignature,
      diagnosticLabel: options.diagnosticLabel,
      armedAt: Date.now(),
      timeout: setTimeout(() => {
        if (this.armedRequestMediation.get(dbg) !== armed) {
          return;
        }
        this.armedRequestMediation.delete(dbg);
        void dbg.sendCommand("Fetch.disable").catch(() => {
          // The debugger may have detached or navigation may have reset Fetch.
        });
        this.emitRequestMediationFailure(armed, options.actionId ? "governor arm exceeded 30 minute safety cap" : "no fresh user-send completion request observed before timeout");
      }, options.actionId ? 30 * 60_000 : PROBE_TIMEOUT_MS),
    };
    this.armedRequestMediation.set(dbg, armed);
    if (options.attributed) {
      // `armed` is non-terminal and `finalize_live_profile` ignores it today, so this is defence
      // in depth rather than a live contamination fix: the invariant "an attributed run emits zero
      // capability probes of any status" is stronger than "no terminal ones", and survives someone
      // later widening TERMINAL_STATUSES.
      this.emitDiagnostic({
        id: `augment-attribution-armed-${Date.now()}-${randomUUID()}`,
        kind: "measurement",
        provider,
        reason: `${options.diagnosticLabel} armed action=${action}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    this.emitCapabilityProbe(provider, action, "armed", "cdp_fetch_request_boundary", "armed for the next provider completion request");
  }

  private async handleMessage(
    dbg: Electron.Debugger,
    method: string,
    params: DebuggerParams,
  ): Promise<void> {
    void this.claudeBodies.handle(dbg, method, params);
    if (method === "Network.requestWillBeSent") {
      const sent = objectField(params.request);
      this.claudeDiagnostics.request(dbg, stringField(sent?.url) ?? "", stringField(sent?.method) ?? "GET");
      await this.onRequest(dbg, params);
    } else if (method === "Fetch.requestPaused") {
      await this.onRequestPaused(dbg, params);
    } else if (method === "Runtime.bindingCalled") {
      await this.onBindingCalled(dbg, params);
    } else if (method === "Network.responseReceived") {
      await this.onResponseReceived(dbg, params);
    } else if (method === "Network.dataReceived") {
      this.onDataReceived(params);
    } else if (method === "Network.loadingFinished") {
      await this.onFinished(dbg, params);
    } else if (method === "Network.loadingFailed") {
      const requestId = stringField(params.requestId);
      if (requestId) {
        const mediation = this.pendingRequestMediation.get(requestId);
        if (mediation) {
          this.pendingRequestMediation.delete(requestId);
          this.emitRequestMediationFailure(
            mediation,
            stringField(params.errorText) ?? "provider request failed after mediation",
            requestId,
          );
        }
        const provider = this.requestProviders.get(requestId);
        const url = this.requestUrls.get(requestId);
        this.failBoundArmedResponseMediation(dbg, requestId, stringField(params.errorText) ?? "network loading failed");
        if (provider && url) {
          this.emit("networkTag", networkTag(provider, url, requestId, "failed"));
        }
        const buffered = this.streamedBodies.get(requestId)?.join("") ?? "";
        // ChatGPT may cancel the transport after delivering its terminal SSE marker.
        // Recover only this request's complete, parseable network reply; never consult the DOM.
        if (provider?.name === "chatgpt" && params.errorText === "net::ERR_ABORTED" &&
          completeChatgptReply(provider, buffered)) {
          this.emitDiagnostic({
            id: randomUUID(), kind: "measurement", provider: provider.name, requestId,
            reason: "captured completed ChatGPT stream after transport abort", timestamp: new Date().toISOString(),
          });
          this.recordNetworkComplete(requestId, provider, buffered, "abort_recovery");
          await this.emitFinishResult(requestId, buffered, dbg, [buffered]);
          void this.compareRenderedLater(dbg, provider, requestId, buffered);

          return;
        }
        const diagnostic = this.assembler.fail(requestId,
          (stringField(params.errorText) ?? "network loading failed") +
          ` buffered_chars=${buffered.length} done_marker=${/^data:\s*\[DONE\]\s*$/m.test(buffered)}`);
        this.cleanupRequest(requestId);
        if (diagnostic) {
          diagnostic.body_shape = [...new Set(parseSseEvents(buffered).map(event => describeBodyShape(event.data)))].slice(0, 20).join(" | ");
          this.emitDiagnostic(diagnostic);
        }
      }
    }
  }

  private async onRequest(dbg: Electron.Debugger, params: DebuggerParams): Promise<void> {
    const request = objectField(params.request);
    const requestId = stringField(params.requestId);
    const url = stringField(request?.url);
    const method = stringField(request?.method) ?? "GET";
    if (!requestId || !url) {
      return;
    }
    if (providerForUrl(url)?.name === "claudeai") {
      if (this.claudeRequestMethods.size >= 1000) this.claudeRequestMethods.delete(this.claudeRequestMethods.keys().next().value!);
      this.claudeRequestMethods.set(requestId, method);
    }
    const provider = completionProviderFor(url, method);
    if (!provider) {
      this.claudeDiagnostics.unmatched(url, method);
      const diagnostic = unmatchedChatgptDiagnostic(requestId, url, method);
      if (diagnostic) {
        this.emitDiagnostic(diagnostic);
      }
      return;
    }
    const requestBody = await this.requestPostData(dbg, requestId, request);
    if (!requestBody) {
      this.emitDiagnostic({
        id: `missing-body-${requestId}`,
        kind: "parse_error",
        provider: provider.name,
        requestId,
        reason: "completion request had no retrievable post body",
        timestamp: new Date().toISOString(),
      });
      return;
    }
    const diagnostic = this.assembler.start(requestId, url, requestBody, provider);
    if (diagnostic) {
      this.emitDiagnostic(diagnostic);
      return;
    }
    const parsedPrompt = provider.networkParser?.parseRequest(requestBody).user_prompt?.trim();
    this.emissionOrder.start(dbg, requestId);
    this.requestWindows.set(requestId, dbg);
    this.activeCompletionRequests.add(requestId);
    this.requestProviders.set(requestId, provider);
    this.requestUrls.set(requestId, url);
    if (parsedPrompt) {
      this.requestPrompts.set(requestId, parsedPrompt);
    }
    const studyName = mediationProvider(provider.name);
    const armedResponse = this.armedResponseMediation.get(dbg);
    if (
      studyName &&
      armedResponse?.provider === studyName &&
      this.hasFreshUserSend(dbg, studyName, armedResponse.armedAt)
    ) {
      if (!armedResponse.requestId) {
        armedResponse.requestId = requestId;
        armedResponse.requestUrl = url;
        this.freshUserSendCompletionRequests.add(requestId);
      } else if (armedResponse.requestId === requestId) {
        this.freshUserSendCompletionRequests.add(requestId);
      }
    }
    this.emit("networkTag", networkTag(provider, url, requestId, "started"));
  }

  private async onBindingCalled(dbg: Electron.Debugger, params: DebuggerParams): Promise<void> {
    const name = stringField(params.name);
    const payloadText = stringField(params.payload);
    if (!payloadText) {
      return;
    }
    if (name === "rshUserSend") {
      this.onUserSendBinding(dbg, payloadText);
      return;
    }
    if (name === "rshCapabilityEvidence") {
      this.onCapabilityEvidence(payloadText);
      return;
    }
    if (name !== "rshCapture") return;
    try {
      const payload = JSON.parse(payloadText) as unknown;
      const record = objectField(payload);
      const url = stringField(record?.url);
      const requestBody = stringField(record?.requestBody);
      const responseBody = stringField(record?.responseBody);
      const renderedText = stringField(record?.renderedText) ?? "";
      if (!url || !requestBody || !responseBody) {
        return;
      }
      const provider = completionProviderFor(url, "POST");
      if (!provider) {
        return;
      }
      const requestId = `binding-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const startDiagnostic = this.assembler.start(requestId, url, requestBody, provider);
      if (startDiagnostic) {
        this.emitDiagnostic(startDiagnostic);
        return;
      }
      // The page cannot make this choice. Provider parsers live here, so the hook could only
      // compare raw byte lengths — the comparison `chooseAssistantTextSource` was written to
      // replace, still in place on this path long after the CDP path moved off it. The hook now
      // reports both sources and the decision is made where the parsers are.
      const choice = chooseAssistantTextSource(provider, responseBody, renderedText);
      this.captureSourceDiagnostics.set(requestId, `path=page_binding source=${choice.source} network_bytes=${responseBody.length} network_extracted=${choice.networkExtractedChars} rendered_chars=${renderedText.length} settle=page_hook elapsed_ms=0`);
      await this.emitFinishResult(requestId, choice.body, undefined, [responseBody]);
    } catch (error) {
      this.emitDiagnostic({
        id: `binding-${Date.now()}`,
        kind: "parse_error",
        provider: "chatgpt",
        reason: error instanceof Error ? error.message : "failed to parse page capture payload",
        timestamp: new Date().toISOString(),
      });
    }
  }

  private onUserSendBinding(dbg: Electron.Debugger, payloadText: string): void {
    try {
      const payload = objectField(JSON.parse(payloadText));
      const provider = mediationProvider(payload?.provider);
      if (!provider) {
        return;
      }
      const at = typeof payload?.at === "number" ? payload.at : Date.now();
      this.recentUserSends.set(dbg, { provider, at });
      if (provider === "claudeai") {
        const window = this.targetWindows.get(dbg);
        if (window && !window.isDestroyed() && providerForUrl(window.getURL())?.name === "claudeai") {
          window.send("harness:dom-user-send");
        }
        this.claudeDiagnostics.userSend(dbg, () => {
          const window = this.targetWindows.get(dbg);
          if (!window || window.isDestroyed()) return false;
          try { return new URL(window.getURL()).hostname === "claude.ai"; } catch { return false; }
        });
      }
    } catch {
      // User-send correlation is a guardrail; malformed metadata should not disrupt capture.
    }
  }

  private onCapabilityEvidence(payloadText: string): void {
    try {
      const payload = objectField(JSON.parse(payloadText));
      const provider = mediationProvider(payload?.provider);
      const mechanism = capabilityMechanism(payload?.mechanism);
      const status = payload?.status === "demonstrated" ? "demonstrated" : "failed";
      if (!provider || !mechanism) return;
      const responseAction = responseMediationAction(mechanism);
      if (responseAction) {
        this.clearMatchingArmedResponseMediation(provider, responseAction);
      }
      this.emitCapabilityProbe(
        provider,
        mechanism,
        status,
        "page_response_intercept",
        stringField(payload?.detail) ?? "page response intervention",
      );
    } catch {
      // Evidence bindings are metadata-only and must never disrupt capture.
    }
  }

  private async onRequestPaused(dbg: Electron.Debugger, params: DebuggerParams): Promise<void> {
    if (typeof params.responseStatusCode === "number") {
      await this.onResponsePaused(dbg, params);
      return;
    }
    const fetchRequestId = stringField(params.requestId);
    const networkId = stringField(params.networkId);
    const request = objectField(params.request);
    const url = stringField(request?.url);
    const method = stringField(request?.method) ?? "GET";
    if (!fetchRequestId) return;
    const armed = this.armedRequestMediation.get(dbg);
    const provider = url ? completionProviderFor(url, method) : undefined;
    if (!armed || provider?.name !== armed.provider) {
      await dbg.sendCommand("Fetch.continueRequest", { requestId: fetchRequestId });
      return;
    }
    let postData = stringField(request?.postData) ?? "";
    if (!postData) {
      try {
        const result = await dbg.sendCommand("Fetch.getRequestPostData", { requestId: fetchRequestId }) as { postData?: unknown };
        postData = stringField(result.postData) ?? "";
      } catch {
        await dbg.sendCommand("Fetch.continueRequest", { requestId: fetchRequestId });
        return;
      }
    }
    if (armed.actionId) {
      const requestConversation = provider.networkParser?.extractConversationId(url ?? "", postData, "");
      if (requestConversation && armed.conversationId && requestConversation !== armed.conversationId) {
        this.clearArmedRequestMediation(dbg);
        this.emitRequestMediationFailure(armed, "request belongs to another conversation", networkId);
        await dbg.sendCommand("Fetch.continueRequest", { requestId: fetchRequestId });
        await this.disableOrRestorePassiveFetch(dbg);
        return;
      }
    }
    const parsedPrompt = provider.networkParser?.parseRequest(postData).user_prompt?.trim();
    if (!parsedPrompt || !this.hasFreshUserSend(dbg, armed.provider, armed.armedAt)) {
      await dbg.sendCommand("Fetch.continueRequest", { requestId: fetchRequestId });
      return;
    }
    this.clearArmedRequestMediation(dbg);
    try {
      if (armed.action === "pause_request") {
        await delay(50);
        await dbg.sendCommand("Fetch.continueRequest", { requestId: fetchRequestId });
        if (armed.actionId) this.emit("governorArmOutcome", {
          actionId: armed.actionId, mechanism: armed.action, status: "applied",
          detail: `request resumed after pause: ${networkId ?? fetchRequestId}`, updatedAt: new Date().toISOString(),
        });
        if (networkId) {
          this.pendingRequestMediation.set(networkId, {
            provider: armed.provider,
            action: armed.action,
            strategy: "completion request paused and resumed after bounded delay",
            noticeDisplayed: true,
            effectSignature: armed.effectSignature,
            attributed: armed.attributed,
            diagnosticLabel: armed.diagnosticLabel,
            actionId: armed.actionId,
          });
        } else {
          this.emitRequestMediationFailure(
            armed,
            "CDP supplied no network id to verify provider acceptance",
          );
        }
        return;
      }
      const mediated = mediateRequestBody(armed.provider, postData, armed.action, armed.authorizedContext, {
        allowAttribution: armed.attributed,
      });
      if (!mediated.changed) {
        await dbg.sendCommand("Fetch.continueRequest", { requestId: fetchRequestId });
        this.emitRequestMediationFailure(armed, mediated.strategy, networkId);
        return;
      }
      const noticeDisplayed = await this.displayRequestMediationNotice(dbg, armed.action, armed.noticeText);
      await dbg.sendCommand("Fetch.continueRequest", {
        requestId: fetchRequestId,
        postData: Buffer.from(mediated.postData, "utf8").toString("base64"),
      });
      if (armed.actionId) this.emit("governorArmOutcome", {
        actionId: armed.actionId, mechanism: armed.action, status: "applied",
        detail: `request modified and continued: ${networkId ?? fetchRequestId}`,
        updatedAt: new Date().toISOString(),
      });
      if (networkId) {
        this.pendingRequestMediation.set(networkId, {
          provider: armed.provider,
          action: armed.action,
          strategy: mediated.strategy,
          noticeDisplayed,
          effectSignature: armed.effectSignature,
          attributed: armed.attributed,
          diagnosticLabel: armed.diagnosticLabel,
          actionId: armed.actionId,
        });
      } else {
        this.emitRequestMediationFailure(
          armed,
          "CDP supplied no network id to verify provider acceptance",
        );
      }
    } catch (error) {
      try {
        await dbg.sendCommand("Fetch.continueRequest", { requestId: fetchRequestId });
      } catch {
        // The provider navigation may have already closed the paused request.
      }
      this.emitRequestMediationFailure(
        armed,
        error instanceof Error ? error.message : "request mediation failed",
      );
    } finally {
      await this.disableOrRestorePassiveFetch(dbg);
    }
  }

  private async onResponsePaused(dbg: Electron.Debugger, params: DebuggerParams): Promise<void> {
    const fetchRequestId = stringField(params.requestId);
    const networkId = stringField(params.networkId);
    const request = objectField(params.request);
    const url = stringField(request?.url);
    const method = stringField(request?.method) ?? "GET";
    if (!fetchRequestId) return;
    const armed = this.armedResponseMediation.get(dbg);
    const provider = url ? completionProviderFor(url, method) : undefined;
    if (!armed) {
      await dbg.sendCommand("Fetch.continueRequest", { requestId: fetchRequestId });
      return;
    }
    if (provider?.name !== armed.provider) {
      await dbg.sendCommand("Fetch.continueRequest", { requestId: fetchRequestId });
      return;
    }
    const parsedPrompt = networkId ? this.requestPrompts.get(networkId) : undefined;
    const correlatedRequest = Boolean(networkId && this.freshUserSendCompletionRequests.has(networkId));
    if (
      !parsedPrompt ||
      !correlatedRequest ||
      (armed.requestId !== undefined && networkId !== armed.requestId)
    ) {
      await dbg.sendCommand("Fetch.continueRequest", { requestId: fetchRequestId });
      return;
    }
    if (armed.action !== "withhold_candidate") {
      await dbg.sendCommand("Fetch.continueRequest", { requestId: fetchRequestId });
      return;
    }
    if (!armed.requestId && networkId) {
      armed.requestId = networkId;
      armed.requestUrl = url;
    }
    this.clearArmedResponseMediation(dbg);
    try {
      const mediated = responseMediationPayload(armed.action);
      const markerTurn = networkId
        ? this.assembler.syntheticTurn(networkId, WITHHELD_MARKER_TEXT)
        : null;
      await dbg.sendCommand("Fetch.fulfillRequest", {
        requestId: fetchRequestId,
        responseCode: 200,
        responsePhrase: "OK",
        responseHeaders: [
          { name: "content-type", value: "text/plain; charset=utf-8" },
          { name: "cache-control", value: "no-store" },
        ],
        body: Buffer.from(mediated.body, "utf8").toString("base64"),
      });
      if (networkId) {
        this.assembler.fail(networkId, "completion response mediated by governor");
        this.cleanupRequest(networkId);
      }
      const marker = await this.injectWithheldMarker(dbg, armed.provider);
      if (!marker.ok || !marker.retryGuardInstalled) {
        this.emitResponseMediationOutcome(
          armed,
          "failed",
          "cdp_fetch_response_boundary",
          marker.reason ?? "withheld marker or retry guard was not present in the transcript",
          networkId,
        );
        return;
      }
      // The stream really was stopped, but a marker the page discards is not a governor
      // presentation the user ever saw. Injection-time presence is not the claim.
      if (!marker.persisted.present) {
        this.emitResponseMediationOutcome(
          armed,
          "failed",
          "cdp_fetch_response_boundary",
          `${mediated.detail}; but ${describePersistence(marker.persisted)}; marker reassertions before persistence read=${marker.markerReassertions}`,
          networkId,
        );
        return;
      }
      if (!markerTurn) {
        this.emitResponseMediationOutcome(
          armed,
          "failed",
          "cdp_fetch_response_boundary",
          "withheld marker present in DOM but no transcript turn could be materialized",
          networkId,
        );
        return;
      }
      this.emitTurn(markerTurn, "CDP response boundary transcript marker captured");
      this.emitResponseMediationOutcome(
        armed,
        "demonstrated",
        "cdp_fetch_response_boundary",
        `${mediated.detail}; transcript marker inserted ${marker.anchored ? "inline after the user turn" : "unanchored at container end (turn selectors " + (marker.selectorsCharacterized ? "matched nothing" : "not characterized for this provider") + ")"}; ${describePersistence(marker.persisted)}; retry controls blocked=${marker.retryControlsBlocked}; retry guard installed=${marker.retryGuardInstalled}; marker reassertions before persistence read=${marker.markerReassertions}`,
        networkId,
      );
    } catch (error) {
      try {
        await dbg.sendCommand("Fetch.continueRequest", { requestId: fetchRequestId });
      } catch {
        // The paused response may already have been resolved by Chromium.
      }
      this.emitResponseMediationOutcome(
        armed,
        "failed",
        "cdp_fetch_response_boundary",
        error instanceof Error ? error.message : "response mediation failed",
        networkId,
      );
    } finally {
      await this.disableOrRestorePassiveFetch(dbg);
    }
  }

  private async onResponseReceived(dbg: Electron.Debugger, params: DebuggerParams): Promise<void> {
    const responseMethod = this.claudeRequestMethods.get(stringField(params.requestId) ?? "") ?? "UNKNOWN";
    this.claudeRequestMethods.delete(stringField(params.requestId) ?? "");
    const responseMeta = objectField(params.response);
    const responseUrl = stringField(responseMeta?.url);
    const mime = stringField(responseMeta?.mimeType) ?? "";
    const streaming = mime === "text/event-stream" || mime === "application/x-ndjson" ||
      mime.startsWith("application/connect+") || params.type === "EventSource";
    if (responseUrl && streaming) {
      this.claudeDiagnostics.request(dbg, responseUrl, responseMethod, true);
      if (!completionProviderFor(responseUrl, responseMethod)) {
        this.claudeDiagnostics.unmatched(responseUrl, responseMethod, true);
      }
    }
    const requestId = stringField(params.requestId);
    if (!requestId) return;
    const mediation = this.pendingRequestMediation.get(requestId);
    if (mediation) {
      const response = objectField(params.response);
      const status = typeof response?.status === "number" ? response.status : 0;
      const providerAccepted = status >= 200 && status < 400;
      mediation.providerAccepted = providerAccepted;
      if (!providerAccepted) {
        this.pendingRequestMediation.delete(requestId);
        this.emitRequestMediationFailure(
          mediation,
          `${mediation.strategy}; provider rejected with HTTP ${status || "unknown"}`,
          requestId,
        );
      } else if (mediation.action === "pause_request") {
        this.pendingRequestMediation.delete(requestId);
        if (mediation.attributed) {
          this.emitDiagnostic({
            id: `augment-attribution-${Date.now()}-${randomUUID()}`,
            kind: "measurement",
            provider: mediation.provider,
            requestId,
            reason: `${mediation.diagnosticLabel} outcome=${mediation.noticeDisplayed ? "observed" : "failed"}` +
              ` strategy=${mediation.strategy}` +
              ` provider_acceptance=observed`,
            timestamp: new Date().toISOString(),
          });
          return;
        }
        this.emitCapabilityProbe(
          mediation.provider,
          mediation.action,
          mediation.noticeDisplayed ? "demonstrated" : "failed",
          "cdp_fetch_request_boundary",
          mediation.noticeDisplayed
            ? `${mediation.strategy}; user-facing attribution notice displayed; provider accepted with HTTP ${status}`
            : `${mediation.strategy}; provider accepted with HTTP ${status}; attribution notice was not displayed`,
        );
      } else if (!mediation.noticeDisplayed) {
        this.pendingRequestMediation.delete(requestId);
        this.emitRequestMediationFailure(
          mediation,
          `${mediation.strategy}; provider accepted with HTTP ${status}; attribution notice was not displayed`,
          requestId,
        );
      }
    }
    if (!this.activeCompletionRequests.has(requestId)) {
      return;
    }
    try {
      const result = (await dbg.sendCommand("Network.streamResourceContent", { requestId })) as {
        bufferedData?: string;
      };
      const bufferedData = stringField(result.bufferedData);
      if (bufferedData) {
        this.streamedBodies.set(requestId, [decodeNetworkData(bufferedData)]);
      }
    } catch {
      // Older Chromium builds may not support response streaming; getResponseBody remains the primary path.
    }
  }

  private onDataReceived(params: DebuggerParams): void {
    const requestId = stringField(params.requestId);
    const data = stringField(params.data);
    if (!requestId || !data || !this.activeCompletionRequests.has(requestId)) {
      return;
    }
    const chunks = this.streamedBodies.get(requestId) ?? [];
    chunks.push(decodeNetworkData(data));
    this.streamedBodies.set(requestId, chunks);
  }

  private async onFinished(dbg: Electron.Debugger, params: DebuggerParams): Promise<void> {
    const requestId = stringField(params.requestId);
    if (!requestId || !this.activeCompletionRequests.has(requestId)) {
      return;
    }
    const provider = this.requestProviders.get(requestId);
    const url = this.requestUrls.get(requestId) ?? "about:blank";
    if (provider) {
      this.emit("networkTag", networkTag(provider, url, requestId, "finished"));
    }
    this.emissionOrder.settling(dbg, requestId);
    // Raw network bodies, kept for conversation-ID extraction even when display text is swapped.
    const idSources: string[] = [];
    const streamedForId = this.streamedBodies.get(requestId)?.join("") ?? "";
    try {
      const bodyResult = (await dbg.sendCommand("Network.getResponseBody", { requestId })) as {
        body?: string;
        base64Encoded?: boolean;
      };
      let rawBody = bodyResult.base64Encoded
        ? Buffer.from(bodyResult.body ?? "", "base64").toString("utf8")
        : bodyResult.body ?? "";
      if (provider?.name === "chatgpt") {
        const complete = completeChatgptReply(provider, rawBody) ? rawBody
          : completeChatgptReply(provider, streamedForId) ? streamedForId : null;
        if (complete !== null) {
          this.recordNetworkComplete(requestId, provider, complete, "normal_finish");
          await this.emitFinishResult(requestId, complete, dbg, [rawBody, streamedForId]);
          void this.compareRenderedLater(dbg, provider, requestId, complete);
          return;
        }
      }
      if (provider) {
        // Two changes here, 2026-08-15, both prompted by four unattributable claude.ai
        // `augment_request_context` failures.
        //
        // 1. The capture-source diagnostic is now recorded for **every** provider, including those
        //    with no rendered fallback. Its whole purpose is to tell "the model did not condition
        //    on the context" from "we read a truncated reply", and it was absent on the only
        //    provider that was failing — so every one of those failures was uninterpretable. This
        //    half is pure observability and carries no behavioural risk.
        // 2. The rendered-text fallback can now extend to `claudeai`, whose DOM has been
        //    characterized since 2026-08-09 (the assistant selector matches `data-is-streaming` on
        //    presence, so it catches a turn mid-stream). It is **opt-in and off by default**:
        //    `settleVisibleAssistantText` polls until the text stabilises or
        //    RENDERED_TEXT_SETTLE_TIMEOUT_MS — **75 s** — elapses, so if the selector fails to
        //    match a completed claude.ai turn, every turn would stall for 75 s before capture
        //    completes. That is not a risk to take silently on a study provider on the strength of
        //    a selector table; prove it on one opted-in session first, reading `settle=` and
        //    `rendered_chars=` from the diagnostic.
        //
        // The `piai` clause is preserved verbatim: its DOM is uncharacterized, so the name test is
        // still the only thing that can select it.
        const networkBytes = rawBody.length;
        idSources.push(rawBody);
        const renderedFallbackOptIn = provider.name !== "claudeai" ||
          process.env.RSH_BROWSER_RENDERED_FALLBACK_CLAUDEAI === "1";
        const canSettle = (hasCharacterizedDom(provider.name) && renderedFallbackOptIn) ||
          (provider.name === "piai" && !rawBody.trim());
        if (canSettle) {
          const settle = await settleVisibleAssistantText(dbg, provider.name);
          const choice = chooseAssistantTextSource(provider, rawBody, settle.text);
          rawBody = choice.body;
          this.captureSourceDiagnostics.set(
            requestId,
            `path=normal_finish source=${choice.source} network_bytes=${networkBytes}` +
              ` network_extracted=${choice.networkExtractedChars} rendered_chars=${settle.text.length}` +
              ` settle=${settle.reason} samples=${settle.samples} elapsed_ms=${settle.elapsedMs}` +
              renderedRefusalSuffix(choice.renderedRefused),
          );
        } else {
          // No rendered fallback taken. `rawBody` is deliberately left untouched; this branch is
          // observability only. `network_extracted` versus `network_bytes` is the signal that
          // matters — a large gap means the parser saw far less text than arrived on the wire,
          // which is the truncation hypothesis for the claude.ai augment failures.
          const choice = chooseAssistantTextSource(provider, rawBody, "");
          const skipReason = hasCharacterizedDom(provider.name)
            ? "skipped_rendered_fallback_opt_out"
            : "skipped_uncharacterized_dom";
          this.captureSourceDiagnostics.set(
            requestId,
            `path=normal_finish source=${choice.source} network_bytes=${networkBytes}` +
              ` network_extracted=${choice.networkExtractedChars} rendered_chars=0` +
              ` settle=${skipReason} elapsed_ms=0` +
              renderedRefusalSuffix(choice.renderedRefused),
          );
        }
      }
      await this.emitFinishResult(requestId, rawBody, dbg, [...idSources, streamedForId]);
    } catch (error) {
      let streamedBody = this.streamedBodies.get(requestId)?.join("") ?? "";
      const rawStreamed = streamedBody;
      if (provider?.name === "chatgpt" && completeChatgptReply(provider, rawStreamed)) {
        this.recordNetworkComplete(requestId, provider, rawStreamed, "buffered_after_body_error");
        await this.emitFinishResult(requestId, rawStreamed, dbg, [rawStreamed]);
        void this.compareRenderedLater(dbg, provider, requestId, rawStreamed);
        return;
      }
      if (provider?.name === "chatgpt") {
        // Same discipline as the success path above: compare what each source *extracts*, and
        // refuse the screen when this request produced no reply of its own.
        const settle = await settleVisibleAssistantText(dbg, provider.name);
        const choice = chooseAssistantTextSource(provider, streamedBody, settle.text);
        this.captureSourceDiagnostics.set(requestId, `path=body_error_fallback source=${choice.source} network_bytes=${rawStreamed.length} network_extracted=${choice.networkExtractedChars} rendered_chars=${settle.text.length} settle=${settle.reason} elapsed_ms=${settle.elapsedMs}`);
        streamedBody = choice.body;
      } else if (provider?.name === "piai" && !streamedBody.trim()) {
        streamedBody = await delayedVisibleAssistantText(dbg, provider.name);
      }
      if (streamedBody.trim()) {
        await this.emitFinishResult(requestId, streamedBody, dbg, [rawStreamed]);
      } else {
        this.completePendingRequestMediation(
          requestId,
          undefined,
          error instanceof Error ? humanizeResponseBodyError(error.message) : "failed to read response body",
        );
        this.failBoundArmedResponseMediation(
          dbg,
          requestId,
          error instanceof Error ? humanizeResponseBodyError(error.message) : "failed to read response body",
        );
        const diagnostic = this.assembler.fail(
          requestId,
          error instanceof Error ? humanizeResponseBodyError(error.message) : "failed to read response body",
        );
        this.cleanupRequest(requestId);
        if (diagnostic) {
          this.emitDiagnostic(diagnostic);
        }
      }
    }
  }

  private async emitFinishResult(
    requestId: string,
    responseBody: string,
    dbg?: Electron.Debugger,
    idSources: readonly string[] = [],
  ): Promise<void> {
    const providerSpec = this.requestProviders.get(requestId);
    const url = this.requestUrls.get(requestId);
    const freshUserSendCorrelated = this.freshUserSendCompletionRequests.has(requestId);
    const result = this.assembler.finish(requestId, responseBody, idSources);
    const owner = this.requestWindows.get(requestId);
    const source = this.captureSourceDiagnostics.get(requestId);
    if (source) this.emitDiagnostic({ id: randomUUID(), kind: "measurement", provider: providerSpec?.name,
      requestId, reason: `capture_source ${source}`, timestamp: new Date().toISOString() });
    this.cleanupRequest(requestId, Boolean(result.turn));
    if (result.turn) {
      if (owner) this.turnOrder.set(result.turn.turn_id, { owner, requestId });
      const handledByResponseMediation = dbg && providerSpec && url
        ? await this.tryEmitResponseMediatedTurn(
            dbg,
            requestId,
            providerSpec,
            url,
            freshUserSendCorrelated,
            result.turn,
          )
        : false;
      if (!handledByResponseMediation) {
        this.emitTurn(result.turn, "network request/response turn pair captured");
      }
      this.completePendingRequestMediation(requestId, result.turn.assistant_text);
    } else {
      if (dbg && providerSpec && url) {
        this.failBoundArmedResponseMediation(dbg, requestId, result.diagnostic?.reason ?? "assistant turn not captured");
      }
      this.completePendingRequestMediation(requestId, undefined, result.diagnostic?.reason ?? "assistant turn not captured");
    }
    if (result.diagnostic) {
      this.emitDiagnostic(result.diagnostic);
    }
  }

  private emitTurn(turn: TurnEvent, detail: string): void {
    const order = this.turnOrder.get(turn.turn_id);
    if (order) {
      this.turnOrder.delete(turn.turn_id);
      this.emissionOrder.complete(order.owner, order.requestId, () => this.emitTurn(turn, detail));
      return;
    }
    const key = `${turn.provider}:${turn.user_prompt}:${turn.assistant_text}`;
    const claudeDom = turn.provider === "claudeai" && detail === "DOM turn pair captured";
    if (claudeDom) {
      // Distinct DOM nodes may contain identical text, but a legacy network copy is redundant.
      const networkAt = this.recentTurnKeys.get(key);
      if (networkAt !== undefined && Date.now() - networkAt < 15_000) return;
      this.seenRecently(this.recentClaudeDomKeys, key, 15_000);
    } else {
      const domAt = turn.provider === "claudeai" ? this.recentClaudeDomKeys.get(key) : undefined;
      if (domAt !== undefined && Date.now() - domAt < 15_000) return;
      if (this.seenRecently(this.recentTurnKeys, key, 15_000)) return;
    }
    this.emit("turn", turn);
    const provider = mediationProvider(turn.provider);
    if (provider) {
      this.emitCapabilityProbe(provider, "turn_capture", "demonstrated", "provider_turn_capture", detail);
    }
  }

  private emitDiagnostic(diagnostic: ParserDiagnostic): void {
    if (diagnostic.kind === "measurement") {
      this.emit("diagnostic", diagnostic);
      return;
    }
    const windowMs = diagnostic.provider === "chatgpt" &&
      diagnostic.reason === "completion request was not a plain user-text turn"
      ? 60_000
      : 10_000;
    // Include body_shape in the key. Several *different* requests can be skipped for the same
    // reason, and keying on the reason alone suppresses every shape after the first — which hid
    // the one that mattered on Grok: a metadata call carrying only `responseIds` was reported
    // while the real completion request, if it was also skipped, was deduped away.
    const key = [
      diagnostic.kind,
      diagnostic.provider ?? "unknown",
      diagnostic.reason,
      diagnostic.body_shape ?? "",
    ].join(":");
    if (!this.seenRecently(this.recentDiagnosticKeys, key, windowMs)) {
      this.emit("diagnostic", diagnostic);
    }
  }

  private seenRecently(cache: Map<string, number>, key: string, windowMs: number): boolean {
    const now = Date.now();
    for (const [cacheKey, timestamp] of cache) {
      if (now - timestamp > Math.max(windowMs, 60_000)) {
        cache.delete(cacheKey);
      }
    }
    const lastSeen = cache.get(key);
    cache.set(key, now);
    return lastSeen !== undefined && now - lastSeen < windowMs;
  }

  private hasFreshUserSend(
    dbg: Electron.Debugger,
    provider: MediationProviderName,
    armedAt: number,
  ): boolean {
    const sent = this.recentUserSends.get(dbg);
    return Boolean(sent &&
      sent.provider === provider &&
      sent.at >= armedAt &&
      Date.now() - sent.at <= USER_SEND_WINDOW_MS);
  }

  private async disableOrRestorePassiveFetch(dbg: Electron.Debugger): Promise<void> {
    try { await dbg.sendCommand("Fetch.disable"); } catch {}
  }

  private cleanupRequest(requestId: string, completing = false): void {
    const owner = this.requestWindows.get(requestId);
    this.requestWindows.delete(requestId);
    if (owner && !completing) this.emissionOrder.fail(owner, requestId);
    this.activeCompletionRequests.delete(requestId);
    this.streamedBodies.delete(requestId);
    this.requestProviders.delete(requestId);
    this.requestUrls.delete(requestId);
    this.requestPrompts.delete(requestId);
    this.freshUserSendCompletionRequests.delete(requestId);
  }

  private cancelPendingCapture(dbg: Electron.Debugger): void {
    for (const id of this.emissionOrder.cancel(dbg)) {
      const diagnostic = this.assembler.fail(id, "capture cancelled by conversation navigation");
      this.cleanupRequest(id);
      if (diagnostic) this.emitDiagnostic(diagnostic);
    }
  }

  private recordNetworkComplete(id: string, provider: ProviderSpec, body: string, path: string): void {
    const chars = provider.networkParser!.parseResponse(body).assistant_text!.length;
    this.captureSourceDiagnostics.set(id, `path=${path} source=network_body network_bytes=${body.length} network_extracted=${chars} rendered_chars=0 settle=skipped_complete_network elapsed_ms=0`);
  }

  private async compareRenderedLater(dbg: Electron.Debugger, provider: ProviderSpec, id: string, body: string): Promise<void> {
    const network = provider.networkParser!.parseResponse(body).assistant_text!.length;
    const rendered = await settleVisibleAssistantText(dbg, provider.name);
    if (rendered.settled && rendered.text.length > network) this.emitDiagnostic({
      id: randomUUID(), kind: "measurement", provider: provider.name, requestId: id,
      reason: `rendered_longer_than_network network_extracted=${network} rendered_chars=${rendered.text.length}`,
      timestamp: new Date().toISOString(),
    });
  }

  cancelGovernorArm(webContents: WebContents, reason: string): void {
    this.cancelGovernorArmForDebugger(webContents.debugger, reason);
  }

  private cancelGovernorArmForDebugger(dbg: Electron.Debugger, reason: string): void {
    const armed = this.armedRequestMediation.get(dbg);
    if (!armed?.actionId) return;
    this.clearArmedRequestMediation(dbg);
    this.emitRequestMediationFailure(armed, reason);
    void this.disableOrRestorePassiveFetch(dbg).catch(() => {});
  }

  private clearArmedRequestMediation(dbg: Electron.Debugger): ArmedRequestMediation | undefined {
    const armed = this.armedRequestMediation.get(dbg);
    if (armed) {
      clearTimeout(armed.timeout);
      this.armedRequestMediation.delete(dbg);
    }
    return armed;
  }

  private clearArmedResponseMediation(dbg: Electron.Debugger): ArmedResponseMediation | undefined {
    const armed = this.armedResponseMediation.get(dbg);
    if (armed) {
      clearTimeout(armed.timeout);
      this.armedResponseMediation.delete(dbg);
    }
    return armed;
  }

  private clearMatchingArmedResponseMediation(
    provider: MediationProviderName,
    action: ResponseMediationAction,
  ): void {
    for (const [dbg, armed] of this.armedResponseMediation) {
      if (armed.provider === provider && armed.action === action) {
        this.clearArmedResponseMediation(dbg);
      }
    }
  }

  private async tryEmitResponseMediatedTurn(
    dbg: Electron.Debugger,
    requestId: string,
    provider: ProviderSpec,
    url: string,
    freshUserSendCorrelated: boolean,
    turn: TurnEvent,
  ): Promise<boolean> {
    const studyName = mediationProvider(provider.name);
    const armed = this.armedResponseMediation.get(dbg);
    if (!studyName || !armed || armed.provider !== studyName) {
      return false;
    }
    if (armed.requestId !== requestId) {
      return false;
    }
    if (!freshUserSendCorrelated) {
      return false;
    }
    const sanitized = sanitizeNetworkUrl(url, provider.networkParser);
    if (armed.action === "withhold_candidate") {
      this.clearArmedResponseMediation(dbg);
      this.emitTurn(turn, "network request/response turn pair captured");
      this.emitResponseMediationOutcome(
        armed,
        "failed",
        "cdp_fetch_response_boundary",
        `captured ${sanitized}; CDP response mediation did not withhold the bound turn`,
        requestId,
      );
      return true;
    }

    const result = await this.mediateCapturedPresentation(dbg, armed, sanitized);
    if (result.ok) {
      this.emitTurn(
        { ...turn, assistant_text: result.assistantText },
        "network request/response turn pair captured after presentation mediation",
      );
      this.emitResponseMediationOutcome(
        armed,
        "demonstrated",
        "page_response_intercept",
        result.detail,
        requestId,
      );
      return true;
    }
    this.emitTurn(turn, "network request/response turn pair captured");
    this.emitResponseMediationOutcome(
      armed,
      "failed",
      "page_response_intercept",
      result.detail,
      requestId,
    );
    return true;
  }

  private failBoundArmedResponseMediation(
    dbg: Electron.Debugger,
    requestId: string,
    reason: string,
  ): void {
    const armed = this.armedResponseMediation.get(dbg);
    if (!armed || armed.requestId !== requestId) {
      return;
    }
    this.clearArmedResponseMediation(dbg);
    this.emitResponseMediationOutcome(
      armed,
      "failed",
      armed.action === "withhold_candidate" ? "cdp_fetch_response_boundary" : "page_response_intercept",
      `bound completion ${requestId} produced no verifiable mediated transcript state: ${reason}`,
      requestId,
    );
  }

  private emitResponseMediationOutcome(
    armed: Pick<ArmedResponseMediation, "provider" | "action" | "reportAs" | "diagnosticLabel">,
    status: CapabilityProbeRecord["status"],
    evidenceScope: CapabilityProbeRecord["evidence_scope"],
    detail: string,
    requestId?: string,
  ): void {
    if (armed.reportAs === "diagnostic") {
      this.emitDiagnostic({
        id: `response-mediation-${Date.now()}-${randomUUID()}`,
        kind: "measurement",
        provider: armed.provider,
        requestId,
        reason: `${armed.diagnosticLabel} action=${armed.action} outcome=${status} scope=${evidenceScope} detail=${detail}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    this.emitCapabilityProbe(
      armed.provider,
      armed.action,
      status,
      evidenceScope,
      detail,
    );
  }

  private emitRequestMediationFailure(
    mediation: Pick<ArmedRequestMediation | PendingRequestMediation,
      "provider" | "action" | "attributed" | "diagnosticLabel" | "actionId">,
    reason: string,
    requestId?: string,
  ): void {
    if (mediation.actionId) this.emit("governorArmOutcome", {
      actionId: mediation.actionId, mechanism: mediation.action, status: "failed", detail: reason,
      updatedAt: new Date().toISOString(),
    });
    if (mediation.attributed) {
      this.emitDiagnostic({
        id: `augment-attribution-${Date.now()}-${randomUUID()}`,
        kind: "measurement",
        provider: mediation.provider,
        requestId,
        reason: `${mediation.diagnosticLabel} outcome=failed reason=${reason}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    this.emitCapabilityProbe(
      mediation.provider,
      mediation.action,
      "failed",
      "cdp_fetch_request_boundary",
      reason,
    );
  }

  private completePendingRequestMediation(
    requestId: string,
    assistantText: string | undefined,
    failureReason?: string,
  ): void {
    const mediation = this.pendingRequestMediation.get(requestId);
    const capture = this.captureSourceDiagnostics.get(requestId);
    this.captureSourceDiagnostics.delete(requestId);
    if (!mediation) {
      return;
    }
    this.pendingRequestMediation.delete(requestId);
    const captureSuffix = capture ? `; capture: ${capture}` : "";
    if (mediation.attributed) {
      const observed = mediation.effectSignature
        ? Boolean(assistantText && assistantText.includes(mediation.effectSignature))
        : false;
      const outcome = mediation.effectSignature
        ? observed ? "observed" : "not_observed"
        : "unscored";
      this.emitDiagnostic({
        id: `augment-attribution-${Date.now()}-${randomUUID()}`,
        kind: "measurement",
        provider: mediation.provider,
        requestId,
        reason: `${mediation.diagnosticLabel} outcome=${outcome}` +
          ` strategy=${mediation.strategy}` +
          (failureReason ? ` failure=${failureReason}` : "") +
          (mediation.providerAccepted === true ? "" : "; provider_acceptance=not_observed") +
          captureSuffix,
        timestamp: new Date().toISOString(),
      });
      return;
    }
    if (failureReason) {
      this.emitCapabilityProbe(
        mediation.provider,
        mediation.action,
        "failed",
        "cdp_fetch_request_boundary",
        `${mediation.strategy}; ${failureReason}; effect signature not verified`,
      );
      return;
    }
    if (!mediation.effectSignature) {
      this.emitCapabilityProbe(
        mediation.provider,
        mediation.action,
        "failed",
        "cdp_fetch_request_boundary",
        `${mediation.strategy}; effect signature not configured`,
      );
      return;
    }
    if (mediation.providerAccepted !== true) {
      this.emitCapabilityProbe(
        mediation.provider,
        mediation.action,
        "failed",
        "cdp_fetch_request_boundary",
        `${mediation.strategy}; provider acceptance was not observed before effect verification`,
      );
      return;
    }
    const observed = Boolean(assistantText && assistantText.includes(mediation.effectSignature));
    // On a negative, record how the text was obtained. A missing sentinel can mean the model
    // did not condition on the context, or that we read a truncated reply -- and a bare
    // "not observed" cannot tell those apart. It reported a harness capture race as a
    // capability failure for a month.
    this.emitCapabilityProbe(
      mediation.provider,
      mediation.action,
      observed ? "demonstrated" : "failed",
      "cdp_fetch_request_boundary",
      observed
        ? `${mediation.strategy}; user-facing attribution notice displayed; provider accepted; effect signature observed in assistant output`
        : `${mediation.strategy}; provider accepted but effect signature was not observed in assistant output` +
          ` (captured ${assistantText?.length ?? 0} chars)${captureSuffix}`,
    );
  }

  private async mediateCapturedPresentation(
    dbg: Electron.Debugger,
    armed: ArmedResponseMediation,
    sanitizedUrl: string,
  ): Promise<{ ok: true; assistantText: string; detail: string } | { ok: false; detail: string }> {
    try {
      const result = await this.evaluateInDebugger(
        dbg,
        probeLatestPresentationStateScript(armed.provider, armed.action),
      );
      const record = objectField(result);
      if (record?.ok === true) {
        const persistedResult = await this.evaluateInDebugger(
          dbg,
          surfacePersistedScript(REPLACE_PRESENTATION_SELECTOR),
        );
        const persisted = readSurfacePersistence(objectField(persistedResult), SURFACE_PERSISTENCE_DELAY_MS);
        this.clearArmedResponseMediation(dbg);
        if (!persisted.present) {
          return {
            ok: false,
            detail: `assistant turn captured from ${sanitizedUrl}; rendered presentation mediated with restore handle; ${describePersistence(persisted)}`,
          };
        }
        return {
          ok: true,
          assistantText: mediatedPresentationText(armed.action),
          detail: `assistant turn captured from ${sanitizedUrl}; rendered presentation mediated with restore handle; judge transcript captured mediated presentation; ${describePersistence(persisted)}`,
        };
      }
      this.clearArmedResponseMediation(dbg);
      return {
        ok: false,
        detail: stringField(record?.reason) ?? `captured ${sanitizedUrl}; assistant presentation not found after render`,
      };
    } catch (error) {
      this.clearArmedResponseMediation(dbg);
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "DOM after-render mediation failed",
      };
    }
  }

  private async injectWithheldMarker(
    dbg: Electron.Debugger,
    provider: MediationProviderName,
  ): Promise<{
    ok: boolean;
    reason?: string;
    retryControlsBlocked: number;
    retryGuardInstalled: boolean;
    anchored: boolean;
    selectorsCharacterized: boolean;
    markerReassertions: number;
    persisted: SurfacePersistence;
  }> {
    try {
      const result = await this.evaluateInDebugger(dbg, withheldMarkerScript(provider));
      const record = objectField(result);
      const persistedResult = await this.evaluateInDebugger(
        dbg,
        surfacePersistedScript(WITHHELD_MARKER_SELECTOR),
      );
      const markerState = objectField(await this.evaluateInDebugger(dbg, withheldMarkerStateScript()));
      return {
        ok: record?.ok === true,
        reason: stringField(record?.reason),
        retryControlsBlocked: typeof record?.retryControlsBlocked === "number" ? record.retryControlsBlocked : 0,
        retryGuardInstalled: record?.retryGuardInstalled === true,
        anchored: record?.anchored === true,
        selectorsCharacterized: record?.selectorsCharacterized === true,
        markerReassertions: typeof markerState?.markerReassertions === "number"
          ? markerState.markerReassertions
          : typeof record?.markerReassertions === "number"
            ? record.markerReassertions
            : 0,
        persisted: readSurfacePersistence(objectField(persistedResult), SURFACE_PERSISTENCE_DELAY_MS),
      };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : "withheld marker injection failed",
        retryControlsBlocked: 0,
        retryGuardInstalled: false,
        anchored: false,
        selectorsCharacterized: false,
        markerReassertions: 0,
        persisted: { present: false, checked_after_ms: SURFACE_PERSISTENCE_DELAY_MS },
      };
    }
  }

  private async displayRequestMediationNotice(
    dbg: Electron.Debugger,
    action: RequestMediationAction,
    noticeText?: string,
  ): Promise<boolean> {
    if (action === "pause_request") {
      return true;
    }
    try {
      await this.evaluateInDebugger(dbg, requestMediationNoticeScript(action, noticeText));
      return true;
    } catch {
      return false;
    }
  }

  private configureDomObserver(webContents: WebContents): void {
    if (webContents.isDestroyed()) {
      return;
    }
    const provider = providerForUrl(webContents.getURL());
    this.domBridge.configure(webContents, provider);
  }

  private async evaluate(webContents: WebContents, expression: string): Promise<unknown> {
    return this.evaluateInDebugger(webContents.debugger, expression);
  }

  private async evaluateInDebugger(dbg: Electron.Debugger, expression: string): Promise<unknown> {
    const result = await dbg.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }) as { result?: { value?: unknown } };
    return result.result?.value;
  }

  private emitCapabilityProbe(
    provider: MediationProviderName,
    mechanism: CapabilityProbeMechanism,
    status: CapabilityProbeRecord["status"],
    evidenceScope: CapabilityProbeRecord["evidence_scope"],
    detail: string,
  ): void {
    this.emit("capabilityProbe", {
      schema_version: "browser_capability_probe_v2",
      profile_id: "browser_output_mediation_v2",
      probe_id: randomUUID(),
      provider,
      provider_surface_version: providerSurfaceVersion(provider),
      mechanism,
      status,
      observed_at: new Date().toISOString(),
      evidence_scope: evidenceScope,
      detail,
    });
  }

  private async requestPostData(
    dbg: Electron.Debugger,
    requestId: string,
    request: Record<string, unknown> | undefined,
  ): Promise<string | null> {
    const inlinePostData = stringField(request?.postData);
    if (inlinePostData) {
      return inlinePostData;
    }
    if (request?.hasPostData !== true) {
      return null;
    }
    const result = (await dbg.sendCommand("Network.getRequestPostData", { requestId })) as {
      postData?: string;
    };
    return result.postData ?? null;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mediationProvider(value: unknown): MediationProviderName | undefined {
  return value === "chatgpt" || value === "claudeai" ? value : undefined;
}

function capabilityMechanism(value: unknown): CapabilityProbeMechanism | undefined {
  const mechanisms: CapabilityProbeMechanism[] = [
    "turn_capture",
    "display_governor_notice",
    "withhold_candidate",
    "replace_presentation",
    "pause_request",
    "augment_request_context",
  ];
  return mechanisms.find((mechanism) => mechanism === value);
}

function responseMediationAction(value: CapabilityProbeMechanism): ResponseMediationAction | undefined {
  return value === "withhold_candidate" ||
    value === "replace_presentation"
    ? value
    : undefined;
}

function decodeNetworkData(data: string): string {
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(data) || data.length % 4 !== 0) {
    return data;
  }
  const decoded = Buffer.from(data, "base64").toString("utf8");
  if (!decoded || decoded.includes("\uFFFD")) {
    return data;
  }
  return decoded;
}

function humanizeResponseBodyError(message: string): string {
  if (message.includes("No resource with given identifier found")) {
    return "completion response body was not retained by Chromium";
  }
  return message;
}

/**
 * Does this response body look like a completion stream at all?
 *
 * The discriminator is the SSE frame: every provider whose replies this harness reads streams
 * `data:` lines. A body that is non-empty, carries no such frame, and yields no assistant text to
 * the provider's own parser is not a truncated completion — it is a *different endpoint* that
 * happened to match the completion rule. Dressing it in whatever is on screen invents an exchange
 * that never happened; ChatGPT's draft pre-flight
 * (`/backend-api/f/conversation/prepare`, a JSON conduit token) is the case that motivated this.
 *
 * An **empty** body is deliberately not treated as structureless. `Network.getResponseBody` is
 * routinely empty for ChatGPT's SSE stream, which is
 * exactly the case the rendered fallback exists to cover. "No bytes" is not "not a completion".
 */
export function hasCompletionStructure(body: string): boolean {
  return /^\s*data:/m.test(body);
}

function renderedRefusalSuffix(refused: "no_completion_structure" | undefined): string {
  return refused ? ` rendered_refused=${refused}` : "";
}

/**
 * Pick the source that yields the most *assistant text*, comparing what each one actually
 * extracts rather than their raw sizes.
 *
 * The raw comparison was the bug. A ChatGPT SSE body is many KB of JSON envelope, so it always
 * won a length contest against a few dozen characters of rendered text — even when the parser
 * could only recover a fragment of the reply from it. Measured on 2026-07-29: an 11,557-byte
 * network body yielded **4 characters** of assistant text while the rendered DOM held 58, and
 * the 4-character version was chosen, so the browser effect sentinel was absent from a reply that
 * plainly contained it on screen. Comparing extracted-to-extracted removes the whole class.
 *
 * The network body stays preferred on ties: it is the provider's own bytes, and the rendered
 * DOM is a lossy view of them.
 */
export function chooseAssistantTextSource(
  provider: { name: string; networkParser?: { parseResponse(body: string): { assistant_text: string | null } } },
  responseBody: string,
  renderedText: string,
): {
  body: string;
  source: "network_body" | "rendered_dom";
  networkExtractedChars: number;
  renderedRefused?: "no_completion_structure";
} {
  if (provider.name === "piai") {
    const body = responseBody.trim() ? responseBody : renderedText;
    return {
      body,
      source: body === responseBody && responseBody.trim() ? "network_body" : "rendered_dom",
      networkExtractedChars: -1,
    };
  }
  let networkExtracted = "";
  let parserThrew = false;
  try {
    networkExtracted = provider.networkParser?.parseResponse(responseBody).assistant_text ?? "";
  } catch {
    networkExtracted = "";
    parserThrew = true;
  }
  const networkExtractedChars = networkExtracted.trim().length;
  // A parser *throw* is not evidence about the body — the parser choked, and the rendered text is
  // still the better guess. A parser that ran cleanly and found nothing in a body that carries no
  // stream frames is different: that request produced no reply, so there is nothing to fall back
  // *to*, and the screen still holds the previous one.
  if (!parserThrew && networkExtractedChars === 0 && responseBody.trim() && !hasCompletionStructure(responseBody)) {
    return {
      body: responseBody,
      source: "network_body",
      networkExtractedChars,
      renderedRefused: "no_completion_structure",
    };
  }
  const useRendered = renderedText.trim().length > networkExtractedChars;
  return {
    body: useRendered ? renderedText : responseBody,
    source: useRendered ? "rendered_dom" : "network_body",
    networkExtractedChars,
  };
}

function isSubstantiveRenderedText(text: string): boolean {
  const normalized = normalizeVisibleText(text);
  if (!normalized) {
    return false;
  }
  return !UI_CHROME_TEXT.has(normalized.toLowerCase());
}

function normalizeVisibleText(text: string): string {
  return text.replace(/\u00a0/g, " ").trim();
}

const UI_CHROME_TEXT = new Set([
  "copy",
  "copied",
  "dislike",
  "like",
  "bad response",
  "good response",
  "more options",
  "regenerate",
  "retry",
  "share",
]);

// Rendered-text settle parameters. Exported for the tests that pin the behaviour.
export const RENDERED_TEXT_SAMPLE_INTERVAL_MS = 500;
// A provider that pauses mid-generation (between paragraphs, or while "thinking") holds the
// rendered text still for a beat. Requiring several consecutive identical samples means a
// pause is not mistaken for a finished reply.
export const RENDERED_TEXT_STABLE_SAMPLES = 4;
// Long replies stream for far longer than the 12s this was first set to; three of five browser
// trials on 2026-07-29 ran past that cap and returned a partial reply.
export const RENDERED_TEXT_SETTLE_TIMEOUT_MS = 75_000;

export type RenderedTextSettleResult = {
  text: string;
  /** True when the text stopped changing; false when the timeout or an error ended the wait. */
  settled: boolean;
  reason: "stable" | "timeout" | "evaluate_failed";
  samples: number;
  elapsedMs: number;
};

/**
 * Read the rendered assistant text, waiting for it to *settle* rather than sampling once.
 *
 * `Network.loadingFinished` fires before the provider has finished painting the reply, so a
 * fixed-delay read returns a partially-rendered answer. The original implementation took
 * exactly one sample 2.5s after finish for every non-pi.ai provider (the `provider !== "piai"`
 * branch returned on the first iteration, so the loop never iterated). That truncated longer
 * replies and systematically dropped anything at the *end* of the answer — including the browser
 * effect sentinel, which the probe deliberately places last. Measured consequence:
 * augment_request_context detected at 2/6 while the operator observed the sentinel 6/6.
 *
 * Settled = `RENDERED_TEXT_STABLE_SAMPLES` consecutive identical non-empty samples. This is
 * provider-agnostic and never looks for the caller's marker, so it cannot bias an effect check
 * toward finding its own sentinel. The result reports whether it settled or gave up, so a
 * caller can say *why* a check failed instead of reporting a bare negative.
 */
export async function settleVisibleAssistantText(
  dbg: Electron.Debugger,
  provider: string,
): Promise<RenderedTextSettleResult> {
  const started = Date.now();
  let latest = "";
  let previous: string | null = null;
  let stable = 1;
  let samples = 0;
  const done = (reason: RenderedTextSettleResult["reason"]): RenderedTextSettleResult => ({
    text: latest,
    settled: reason === "stable",
    reason,
    samples,
    elapsedMs: Date.now() - started,
  });
  do {
    await delay(RENDERED_TEXT_SAMPLE_INTERVAL_MS);
    try {
      const result = (await dbg.sendCommand("Runtime.evaluate", {
        expression: visibleAssistantTextScript(provider),
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      latest = typeof result.result?.value === "string" ? result.result.value : "";
      samples += 1;
    } catch {
      // A failed evaluate mid-stream must not discard text already read.
      return done("evaluate_failed");
    }
    const usable = provider === "piai" ? isSubstantiveRenderedText(latest) : latest.trim().length > 0;
    if (!usable) {
      previous = latest;
      stable = 1;
      continue;
    }
    stable = latest === previous ? stable + 1 : 1;
    if (stable >= RENDERED_TEXT_STABLE_SAMPLES) {
      return done("stable");
    }
    previous = latest;
  } while (Date.now() - started < RENDERED_TEXT_SETTLE_TIMEOUT_MS);
  return done("timeout");
}

/** Text-only wrapper for callers that do not need the settle diagnostics. */
export async function delayedVisibleAssistantText(dbg: Electron.Debugger, provider: string): Promise<string> {
  return (await settleVisibleAssistantText(dbg, provider)).text;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unmatchedChatgptDiagnostic(
  requestId: string,
  url: string,
  method: string,
): ParserDiagnostic | null {
  if (method.toUpperCase() !== "POST") {
    return null;
  }
  try {
    const parsed = new URL(url);
    const isChatgpt = parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com";
    const looksRelevant = parsed.pathname.startsWith("/backend-api/") &&
      /(conversation|responses|completion|message|messages)/i.test(parsed.pathname);
    if (!isChatgpt || !looksRelevant) {
      return null;
    }
    return {
      id: `unmatched-chatgpt-${requestId}`,
      kind: "skipped",
      provider: "chatgpt",
      requestId,
      reason: `unmatched ChatGPT endpoint: ${parsed.pathname}`,
      timestamp: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function networkTag(
  provider: ProviderSpec,
  url: string,
  requestId: string,
  phase: NetworkTag["phase"],
): NetworkTag {
  const sanitized = sanitizeNetworkUrl(url, provider.networkParser);
  try {
    const parsed = new URL(sanitized);
    return {
      tag_id: randomUUID(),
      provider: provider.name,
      url_origin: parsed.origin,
      url_pathname: parsed.pathname,
      phase,
      occurred_at: new Date().toISOString(),
      request_id: requestId,
    };
  } catch {
    return {
      tag_id: randomUUID(),
      provider: provider.name,
      url_origin: "unknown://invalid-url",
      url_pathname: "/",
      phase,
      occurred_at: new Date().toISOString(),
      request_id: requestId,
    };
  }
}

function requestFetchPatterns(provider: MediationProviderName): Array<{ urlPattern: string; requestStage: "Request" }> {
  if (provider === "chatgpt") {
    return [
      { urlPattern: "https://chatgpt.com/*", requestStage: "Request" },
      { urlPattern: "https://*.chatgpt.com/*", requestStage: "Request" },
      { urlPattern: "https://chat.openai.com/*", requestStage: "Request" },
    ];
  }
  return [
    { urlPattern: "https://claude.ai/*", requestStage: "Request" },
  ];
}

function responseFetchPatterns(provider: MediationProviderName): Array<{ urlPattern: string; requestStage: "Response" }> {
  if (provider === "chatgpt") {
    return [
      { urlPattern: "https://chatgpt.com/*", requestStage: "Response" },
      { urlPattern: "https://*.chatgpt.com/*", requestStage: "Response" },
      { urlPattern: "https://chat.openai.com/*", requestStage: "Response" },
    ];
  }
  return [
    { urlPattern: "https://claude.ai/*", requestStage: "Response" },
  ];
}

function responseMediationPayload(action: ResponseMediationAction): { body: string; detail: string } {
  if (action !== "withhold_candidate") {
    throw new Error(`${action} must use DOM-after-render mediation`);
  }
  return {
    body: "",
    detail: "CDP stopped the correlated completion response before provider presentation",
  };
}

function mediatedPresentationText(action: ResponseMediationAction): string {
  if (action === "replace_presentation") {
    return REPLACE_PRESENTATION_TEXT;
  }
  return WITHHELD_MARKER_TEXT;
}

function normalizeRequestMediationRunOptions(
  input: boolean | RequestMediationRunOptions,
): Required<Pick<RequestMediationRunOptions, "attributed" | "effectSignature" | "diagnosticLabel">> &
  Pick<RequestMediationRunOptions, "noticeText" | "actionId" | "conversationId"> {
  if (typeof input === "boolean") {
    return {
      attributed: input,
      effectSignature: REQUEST_CONTEXT_EFFECT_SIGNATURE,
      diagnosticLabel: "augment_attribution_probe",
    };
  }
  return {
    actionId: input.actionId,
    conversationId: input.conversationId,
    attributed: input.attributed ?? false,
    noticeText: input.noticeText,
    effectSignature: input.effectSignature === undefined
      ? REQUEST_CONTEXT_EFFECT_SIGNATURE
      : input.effectSignature,
    diagnosticLabel: input.diagnosticLabel ?? "augment_attribution_probe",
  };
}

function normalizeResponseMediationRunOptions(
  input: ResponseMediationRunOptions,
): Required<ResponseMediationRunOptions> {
  return {
    reportAs: input.reportAs ?? "capability_probe",
    diagnosticLabel: input.diagnosticLabel ?? "response_mediation",
  };
}

export function requestMediationNoticeScript(action: RequestMediationAction, noticeText?: string): string {
  // Only augment_request_context reaches here (pause_request returns before the notice).
  // The text must describe the *append-to-user-turn* channel, which is the only one a
  // consumer web backend conditions the model on: the added text is therefore visible in
  // the user's own bubble and is persisted by the provider as part of the user's message.
  // An earlier version claimed the bubble was unchanged. That was false once the channel
  // moved from a separate (silently dropped) system message to the user turn, and a notice
  // that understates what the governor changed is a user-covertness defect, not a wording
  // nit.
  const text = noticeText ??
    "Sospio added a note to your message before sending it to the assistant. " +
    "The note appears in your message bubble and is stored by the provider as part of your message.";
  return `(() => {
    // One attribution banner at a time: it describes the latest modified turn, so an earlier one is stale.
    document.querySelectorAll("[data-rsh-governor-request-mediation]").forEach((node) => node.remove());
    const surface = document.createElement("section");
    surface.dataset.rshGovernorRequestMediation = ${JSON.stringify(action)};
    surface.setAttribute("role", "status");
    surface.style.cssText = "box-sizing:border-box;position:fixed;z-index:2147483647;top:16px;right:16px;width:min(420px, calc(100vw - 32px));margin:8px 0;padding:12px 14px;border:1px solid #d89c35;border-radius:8px;background:#241c0f;color:#fff7e6;font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
    const heading = document.createElement("strong");
    heading.textContent = "Sospio";
    const body = document.createElement("p");
    body.style.margin = "6px 0 0";
    body.textContent = ${JSON.stringify(text)};
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Hide";
    button.setAttribute("aria-label", "Hide Sospio notice");
    button.style.cssText = "margin-top:10px;border:1px solid #80642f;border-radius:6px;padding:4px 8px;background:transparent;color:inherit;cursor:pointer;font:inherit";
    button.addEventListener("click", () => surface.remove(), { once: true });
    surface.append(heading, body, button);
    (document.body || document.documentElement).appendChild(surface);
    return { ok: true };
  })()`;
}

function probeLatestPresentationStateScript(
  provider: MediationProviderName,
  action: ResponseMediationAction,
): string {
  return `(() => {
    const api = globalThis.__rshGovernorSpikeV2;
    if (!api || typeof api.probeLatest !== "function") return { ok: false, reason: "shim_unavailable" };
    return api.probeLatest(${JSON.stringify({ provider, action, emitEvidence: false })});
  })()`;
}

function withheldMarkerStateScript(): string {
  return `(() => {
    const state = window.__rshGovernorWithheldMarkerState;
    return {
      markerReassertions: typeof state?.markerReassertions === "number" ? state.markerReassertions : 0,
      dismissed: state?.dismissedInterventionId === state?.interventionId,
      interventionId: typeof state?.interventionId === "string" ? state.interventionId : null,
    };
  })()`;
}

function withheldMarkerScript(provider: MediationProviderName): string {
  return `(() => {
    const provider = ${JSON.stringify(provider)};
    const markerSelector = ${JSON.stringify(WITHHELD_MARKER_SELECTOR)};
    const interventionId = "rsh-withhold-" + Date.now() + "-" + Math.random().toString(16).slice(2);
    const state = { markerReassertions: 0, dismissedInterventionId: null, interventionId };
    window.__rshGovernorWithheldMarkerState = state;
    let anchored = false;
    ${providerTurnSelectorsShimSource()}
    function cleanText(text) {
      return String(text || "").replace(/\\u00a0/g, " ").trim();
    }
    function candidates(selectors, root) {
      const scope = root || document;
      const found = [];
      const seen = new Set();
      for (const selector of selectors) {
        try {
          for (const element of scope.querySelectorAll(selector)) {
            if (!seen.has(element)) {
              seen.add(element);
              found.push(element);
            }
          }
        } catch {}
      }
      return rshDocumentOrder(found);
    }
    function latestUserTurn() {
      return candidates(rshTurnSelectors(provider, "user")).at(-1) || null;
    }
    function elementControlText(element) {
      const parts = [
        element.textContent,
        element.getAttribute && element.getAttribute("aria-label"),
        element.getAttribute && element.getAttribute("title"),
        element.getAttribute && element.getAttribute("data-testid"),
        element.getAttribute && element.getAttribute("data-test-id"),
        element.getAttribute && element.getAttribute("name"),
      ];
      return cleanText(parts.filter(Boolean).join(" ")).toLowerCase();
    }
    function isRetryControl(element) {
      return /\\b(retry|regenerate|try again|continue generating|resend|rerun)\\b/.test(elementControlText(element));
    }
    function suppressElement(element) {
      if (!element || element.getAttribute("data-rsh-retry-blocked") === "true") return 0;
      element.setAttribute("aria-disabled", "true");
      element.setAttribute("data-rsh-retry-blocked", "true");
      element.style.pointerEvents = "none";
      element.style.display = "none";
      if ("disabled" in element) element.disabled = true;
      return 1;
    }
    function blockRetryControls() {
      let blocked = 0;
      for (const element of candidates(["button", "[role='button']", "a", "[aria-label]", "[title]", "[data-testid]", "[data-test-id]"])) {
        if (!isRetryControl(element)) continue;
        blocked += suppressElement(element);
      }
      for (const element of candidates(["[role='alert']", "[data-testid*='error' i]", "[class*='error' i]"])) {
        if (/something went wrong|error generating|try again|retry/i.test(cleanText(element.textContent))) {
          element.setAttribute("data-rsh-provider-error-suppressed", "true");
          element.style.display = "none";
        }
      }
      return blocked;
    }
    function installRetryGuard() {
      if (window.__rshGovernorRetryGuardInstalled) return true;
      const guard = (event) => {
        const target = event.target;
        const element = target && typeof target.closest === "function"
          ? target.closest("button,[role='button'],a,[aria-label],[title],[data-testid],[data-test-id]")
          : null;
        if (!element || !isRetryControl(element)) return;
        suppressElement(element);
        event.preventDefault();
        event.stopPropagation();
        if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      };
      const submitGuard = (event) => {
        const target = event.target;
        if (!target || !target.querySelectorAll) return;
        for (const element of target.querySelectorAll("button,[role='button'],a,[aria-label],[title],[data-testid],[data-test-id]")) {
          if (!isRetryControl(element)) continue;
          suppressElement(element);
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
          return;
        }
      };
      document.addEventListener("click", guard, true);
      document.addEventListener("pointerdown", guard, true);
      document.addEventListener("submit", submitGuard, true);
      window.__rshGovernorRetryGuardInstalled = true;
      return true;
    }
    function isDismissed() {
      return state.dismissedInterventionId === interventionId;
    }
    function markDismissed(surface) {
      if (surface && typeof surface.setAttribute === "function") {
        surface.setAttribute("data-rsh-governor-dismissed", interventionId);
      }
      state.dismissedInterventionId = interventionId;
    }
    function marker() {
      if (isDismissed()) {
        return null;
      }
      const existing = document.querySelector(markerSelector);
      if (existing) return existing;
      const surface = document.createElement("article");
      surface.dataset.rshGovernorWithheld = "true";
      surface.dataset.messageAuthorRole = "assistant";
      surface.setAttribute("role", "status");
      surface.style.cssText = "box-sizing:border-box;margin:8px 0;padding:12px 14px;border:1px solid #d89c35;border-radius:8px;background:#241c0f;color:#fff7e6;font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
      const heading = document.createElement("strong");
      heading.textContent = "Sospio";
      const body = document.createElement("p");
      body.style.margin = "6px 0 0";
      body.textContent = "Sospio withheld the candidate response.";
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Dismiss";
      button.style.cssText = "margin-top:10px;border:1px solid #80642f;border-radius:6px;padding:4px 8px;background:transparent;color:inherit;cursor:pointer;font:inherit";
      button.addEventListener("click", () => {
        markDismissed(surface);
        surface.remove();
      }, { once: true });
      surface.append(heading, body, button);
      const anchor = latestUserTurn();
      if (anchor && typeof anchor.insertAdjacentElement === "function") {
        anchor.insertAdjacentElement("afterend", surface);
        anchored = true;
      } else {
        // Unanchored fallback: the marker still enters the DOM, but at the end of the
        // container rather than inline after the user's turn. Reported, not silent —
        // an unanchored marker is easy to miss and must not read as an inline one.
        const parent = document.querySelector("main") || document.body || document.documentElement;
        parent.appendChild(surface);
      }
      return surface;
    }
    function reassertMarker() {
      if (window.__rshGovernorWithheldMarkerState !== state) {
        return;
      }
      if (isDismissed()) {
        return;
      }
      if (document.querySelector(markerSelector)) return;
      const reinserted = marker();
      if (reinserted) {
        state.markerReassertions += 1;
      }
    }
    const surface = marker();
    const retryGuardInstalled = installRetryGuard();
    const retryControlsBlocked = blockRetryControls();
    if (document.body && typeof MutationObserver !== "undefined") {
      const observer = new MutationObserver(() => {
        blockRetryControls();
        reassertMarker();
      });
      observer.observe(document.body, { childList: true, subtree: true });
      window.setTimeout(() => observer.disconnect(), 8000);
    }
    return {
      ok: Boolean(surface && document.querySelector(markerSelector)),
      reason: isDismissed() ? "withheld marker dismissed" : undefined,
      retryControlsBlocked,
      retryGuardInstalled,
      anchored,
      selectorsCharacterized: rshTurnSelectors(provider, "user").length > 0,
      markerReassertions: state.markerReassertions,
    };
  })()`;
}

function providerSurfaceVersion(provider: MediationProviderName): string {
  if (provider === "claudeai") {
    return "claudeai-web@2026-08-09";
  }
  return "chatgpt-web@2026-06-20";
}

export const CHATGPT_FETCH_HOOK = `(() => {
  if (globalThis.__rshChatgptFetchHookInstalled) {
    return;
  }
  globalThis.__rshChatgptFetchHookInstalled = true;
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    return;
  }
  function requestUrl(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }
  function requestMethod(input, init) {
    return String((init && init.method) || (input && input.method) || "GET").toUpperCase();
  }
  function isCompletion(url, method) {
    try {
      const parsed = new URL(url, location.href);
      if (method !== "POST") {
        return false;
      }
      if ((parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com") &&
        parsed.pathname.startsWith("/backend-api/") &&
        !parsed.pathname.includes("/experimental/") &&
        // The page hook keeps its own copy of the completion rule, so the exclusion in
        // completionMatcher.ts does not reach it. /backend-api/f/conversation/prepare is the
        // first-keystroke pre-flight; this hook is the path that paired it with DOM-scraped
        // text and fabricated a turn, so the exclusion has to exist here too.
        // (No backticks in this comment: it lives inside a template literal.)
        !/(^|\\/)prepare(\\/|$)/i.test(parsed.pathname) &&
        /(^|\\/)(conversation|responses|completion|message|messages)(\\/|$)/i.test(parsed.pathname)) {
        return true;
      }
      return (parsed.hostname === "pi.ai" || parsed.hostname.endsWith(".pi.ai")) &&
        /\\/(api\\/)?(chat|talk|conversation|completion|message|messages)\\b/i.test(parsed.pathname);
    } catch {
      return false;
    }
  }
  async function requestBodyText(input, init) {
    if (init && typeof init.body === "string") {
      return init.body;
    }
    if (init && init.body instanceof URLSearchParams) {
      return init.body.toString();
    }
    if (input && typeof input.clone === "function") {
      try {
        return await input.clone().text();
      } catch {
        return "";
      }
    }
    return "";
  }
  function cleanText(text) {
    return String(text || "").replace(/\\u00a0/g, " ").trim();
  }
  function isUiChromeText(text) {
    return ["copy", "copied", "dislike", "like", "bad response", "good response", "more options", "regenerate", "retry", "share"]
      .includes(cleanText(text).toLowerCase());
  }
  function isControlText(text) {
    const normalized = cleanText(text);
    return !normalized || /^v\\d+$/i.test(normalized) || isUiChromeText(normalized);
  }
  function isSubstantiveRenderedText(text) {
    return !isControlText(text);
  }
  function providerName(url) {
    try {
      const parsed = new URL(url, location.href);
      if (parsed.hostname === "chatgpt.com" || parsed.hostname === "chat.openai.com") {
        return "chatgpt";
      }
      if (parsed.hostname === "pi.ai" || parsed.hostname.endsWith(".pi.ai")) {
        return "piai";
      }
    } catch {}
    return "unknown";
  }
  function contentSelectorsFor(provider) {
    if (provider === "chatgpt") {
      return [
        ".markdown",
        '[class*="markdown"]',
        "[data-message-content-part]",
        '[data-testid*="message" i] [dir="auto"]'
      ];
    }
    if (provider === "piai") {
      return [
        '[data-testid*="message" i]',
        '[data-testid*="text" i]',
        '[class*="message" i]',
        '[class*="bubble" i]',
        '[class*="content" i]',
        "p"
      ];
    }
    return [];
  }
  function elementText(element, provider) {
    const contentSelectors = contentSelectorsFor(provider);
    if (contentSelectors.length > 0) {
      for (const selector of contentSelectors) {
        let contentNodes = [];
        try {
          contentNodes = candidateElements([selector], element);
        } catch {}
        for (let index = contentNodes.length - 1; index >= 0; index -= 1) {
          const text = cleanText(contentNodes[index].innerText);
          if (!isControlText(text) && text.length <= 12000) {
            return text;
          }
        }
      }
    }
    const clone = element.cloneNode(true);
    if (clone instanceof HTMLElement) {
      for (const selector of ["button", "[role='button']", "svg", "textarea", "input", "select", "nav", "menu"]) {
        for (const removable of clone.querySelectorAll(selector)) {
          removable.remove();
        }
      }
      const text = cleanText(clone.innerText);
      return !isControlText(text) && text.length <= 12000 ? text : "";
    }
    const text = cleanText(element.innerText);
    return !isControlText(text) && text.length <= 12000 ? text : "";
  }
  function candidateElements(selectors, root) {
    const scope = root || document;
    try {
      return Array.from(scope.querySelectorAll(selectors.join(",")))
        .filter((element, index, list) => list.indexOf(element) === index);
    } catch {}
    const seen = new Set();
    const elements = [];
    for (const selector of selectors) {
      try {
        for (const element of scope.querySelectorAll(selector)) {
          if (!seen.has(element)) {
            seen.add(element);
            elements.push(element);
          }
        }
      } catch {}
    }
    return elements.sort((left, right) => {
      if (left === right) return 0;
      return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }
  function visibleAssistantText(provider) {
    const selectors = provider === "chatgpt"
      ? ${JSON.stringify(turnSelectorsFor("chatgpt").assistant)}
      : [
        '[data-testid*="assistant" i]',
        '[data-testid*="bot" i]',
        '[data-testid*="message" i]',
        '[class*="assistant" i]',
        '[class*="bot" i]',
        '[class*="message" i]',
        '[class*="response" i]'
      ];
    const candidates = candidateElements(selectors);
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const element = candidates[index];
      if (!(element instanceof HTMLElement)) {
        continue;
      }
      const text = elementText(element, provider);
      if (text) {
        return text;
      }
    }
    return "";
  }
  async function waitForVisibleAssistantText(provider) {
    const timeoutMs = provider === "piai" ? 10000 : 2500;
    const intervalMs = provider === "piai" ? 1000 : 2500;
    const started = Date.now();
    let latest = "";
    do {
      await new Promise((resolve) => window.setTimeout(resolve, intervalMs));
      latest = visibleAssistantText(provider);
      if (provider !== "piai" || isSubstantiveRenderedText(latest)) {
        return latest;
      }
    } while (Date.now() - started < timeoutMs);
    return latest;
  }
  globalThis.fetch = async function rshObservedFetch(input, init) {
    const url = requestUrl(input);
    const method = requestMethod(input, init);
    const shouldCapture = isCompletion(url, method);
    const requestBodyPromise = shouldCapture ? requestBodyText(input, init) : Promise.resolve("");
    const response = await originalFetch.apply(this, arguments);
    if (shouldCapture && typeof globalThis.rshCapture === "function") {
      const responseUrl = response.url || url;
      const responseClone = response.clone();
      // Both sources go to the main process unreduced. The page has no provider parsers, so any
      // choice made here can only compare raw sizes -- which is how a pre-flight that returned no
      // reply came to be captured wearing the previous answer. The main process decides.
      // (No backticks in this comment: the whole script is a template literal.)
      Promise.all([requestBodyPromise, responseClone.text()])
        .then(async ([requestBody, responseBody]) => {
          if (requestBody && responseBody) {
            const provider = providerName(responseUrl);
            const renderedText = provider === "piai" && String(responseBody || "").trim()
              ? ""
              : await waitForVisibleAssistantText(provider);
            globalThis.rshCapture(JSON.stringify({
              url: responseUrl,
              requestBody,
              responseBody,
              renderedText
            }));
          }
        })
        .catch(() => {});
    }
    return response;
  };
})();`;

function visibleAssistantTextScript(provider: string): string {
  return `(() => {
  const provider = ${JSON.stringify(provider)};
  function cleanText(text) {
    return String(text || "").replace(/\\u00a0/g, " ").trim();
  }
  function isUiChromeText(text) {
    return ["copy", "copied", "dislike", "like", "bad response", "good response", "more options", "regenerate", "retry", "share"]
      .includes(cleanText(text).toLowerCase());
  }
  function isControlText(text) {
    const normalized = cleanText(text);
    return !normalized || /^v\\d+$/i.test(normalized) || isUiChromeText(normalized);
  }
  function contentSelectorsFor(provider) {
    if (provider === "chatgpt") {
      return [
        ".markdown",
        '[class*="markdown"]',
        "[data-message-content-part]",
        '[data-testid*="message" i] [dir="auto"]'
      ];
    }
    if (provider === "piai") {
      return [
        '[data-testid*="message" i]',
        '[data-testid*="text" i]',
        '[class*="message" i]',
        '[class*="bubble" i]',
        '[class*="content" i]',
        "p"
      ];
    }
    return [];
  }
  function elementText(element, provider) {
    const contentSelectors = contentSelectorsFor(provider);
    if (contentSelectors.length > 0) {
      for (const selector of contentSelectors) {
        let contentNodes = [];
        try {
          contentNodes = candidateElements([selector], element);
        } catch {}
        for (let index = contentNodes.length - 1; index >= 0; index -= 1) {
          const text = cleanText(contentNodes[index].innerText);
          if (!isControlText(text) && text.length <= 12000) {
            return text;
          }
        }
      }
    }
    const clone = element.cloneNode(true);
    if (clone instanceof HTMLElement) {
      for (const selector of ["button", "[role='button']", "svg", "textarea", "input", "select", "nav", "menu"]) {
        for (const removable of clone.querySelectorAll(selector)) {
          removable.remove();
        }
      }
      const text = cleanText(clone.innerText);
      return !isControlText(text) && text.length <= 12000 ? text : "";
    }
    const text = cleanText(element.innerText);
    return !isControlText(text) && text.length <= 12000 ? text : "";
  }
  function candidateElements(selectors, root) {
    const scope = root || document;
    try {
      return Array.from(scope.querySelectorAll(selectors.join(",")))
        .filter((element, index, list) => list.indexOf(element) === index);
    } catch {}
    const seen = new Set();
    const elements = [];
    for (const selector of selectors) {
      try {
        for (const element of scope.querySelectorAll(selector)) {
          if (!seen.has(element)) {
            seen.add(element);
            elements.push(element);
          }
        }
      } catch {}
    }
    return elements.sort((left, right) => {
      if (left === right) return 0;
      return left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }
  const selectors = provider === "chatgpt"
    ? ${JSON.stringify(turnSelectorsFor("chatgpt").assistant)}
    : [
      '[data-testid*="assistant" i]',
      '[data-testid*="bot" i]',
      '[data-testid*="message" i]',
      '[class*="assistant" i]',
      '[class*="bot" i]',
      '[class*="message" i]',
      '[class*="response" i]'
    ];
  const candidates = candidateElements(selectors);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const element = candidates[index];
    if (!(element instanceof HTMLElement)) {
      continue;
    }
    const text = elementText(element, provider);
    if (text) {
      return text;
    }
  }
  return "";
})();`;
}

/** The same request-local terminal evidence is required on finish and abort recovery. */
export function completeChatgptReply(provider: ProviderSpec, body: string): boolean {
  return provider.name === "chatgpt" && /^data:\s*\[DONE\]\s*$/m.test(body) &&
    Boolean(provider.networkParser?.parseResponse(body).assistant_text?.trim());
}
