import { createMonitorSource } from "./remoteMonitor";
import { MonitorSettings, type MonitorConnection } from "../../../shared/monitorSettings";
import { ClosedConversations } from "./closedConversations";
import { newMainLogPath } from "./mainLog";
import { RetentionController } from "../../../records/retentionController";
import { emotionalDependenceMonitored, recordsInfo } from "../../../records/recordsConfig";
import type { PooledNotice, JudgeSignal } from "../shared/types";
import { judgeUnavailableText } from "../shared/monitorNotices";
import { app, BrowserWindow, dialog, ipcMain, safeStorage, type WebContents } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CaptureService } from "./capture/cdpClient";
import { randomUUID } from "node:crypto";
import { providerForName } from "./capture/providerRegistry";
import { redactQueryValues, sanitizeLogUrl } from "./capture/urlRedaction";
import { installNavigationGuard } from "./allowlist";
import { installIpc, pushState, pushToast } from "./ipc";
import { MonitorClient } from "./monitorClient";
import { conversationChanged, conversationIdFromUrl, governorSurfaceBlock, providerFromNavigation } from "./conversationSurface";
import { BrowserInterventionExecutor, updateGovernorDeliveryScript } from "./interventionExecutor";
import {
  BROWSER_SIGNAL_ACTIONABILITY_THRESHOLD,
  planFromVerdict,
  type BrowserMechanism,
} from "./browserPolicyAdapter";
import {
  buildGovernorActionRecord,
  blockedGovernorExecutions,
  buildPooledNoticeReceipt,
  executeGovernorPlan,
  governorTextOptions,
  type GovernorExecutionOptions,
  type GovernorSurface,
} from "./governorLoop";
import { VerdictStore } from "./verdictStore";
import { supportsMediation } from "../shared/types";
import type {
  HarnessState,
  MonitorVerdict,
  ProviderName,
  TurnEvent,
} from "../shared/types";

const PROVIDER_URLS: Record<ProviderName, string> = {
  chatgpt: "https://chatgpt.com/",
  claudeai: "https://claude.ai/",
  grok: "https://grok.com/",
  piai: "https://pi.ai/talk",
};

app.setName("Sospio Browser");
const dataDir = app.getPath("userData");
const sessionsDir = join(dataDir, "sessions");
const logsDir = join(dataDir, "logs");
const settings = new MonitorSettings({dataDir, safeStorage});
delete process.env.RSH_MONITOR_REMOTE_TOKEN;
let connection: MonitorConnection | undefined;
let monitor: ReturnType<typeof createMonitorSource> | undefined;
let monitorGeneration = 0;
const mainLogPath = newMainLogPath(logsDir);
let recordingFile: string | undefined;
const retention = new RetentionController(() => [{path:sessionsDir,kind:"sessions"}, {path:logsDir,kind:"logs"}],
 () => ({protectedPaths:[recordingFile,mainLogPath].filter((path):path is string=>Boolean(path))}));
retention.start();
const closedConversations = new ClosedConversations(sessionsDir, logMain);
const store = new VerdictStore(sessionsDir);
// Remote mode has no judge environment to read, so it follows the relay's default-on ED setting;
// the first verdict then decides the row.
store.setRuntimeState({ monitorRemote: true, monitorConfigured: false, monitorUrl: "https://monitor.sosp.io", emotionalDependenceMonitored: emotionalDependenceMonitored() });
recordingFile = store.sessionFile;
let capture = new CaptureService();
const interventionExecutor = new BrowserInterventionExecutor();
const debugLogging = process.env.RSH_BROWSER_HARNESS_DEBUG === "1";

const governorLoopEnabled = process.env.RSH_BROWSER_GOVERNOR_LOOP !== "0";
const governorThreshold = Number.parseFloat(
  process.env.RSH_BROWSER_GOVERNOR_THRESHOLD ?? String(BROWSER_SIGNAL_ACTIONABILITY_THRESHOLD),
);
// Comma-separated allowlist, e.g. "display_governor_notice" to run the loop at its least
// restrictive. Unset means every mechanism the policy selects is permitted.
const governorAllowed: BrowserMechanism[] | undefined = process.env.RSH_BROWSER_GOVERNOR_MECHANISMS
  ? (process.env.RSH_BROWSER_GOVERNOR_MECHANISMS.split(",").map((s) => s.trim()).filter(Boolean) as BrowserMechanism[])
  : undefined;
store.setRuntimeState({
  governorLoopEnabled,
  governorAllowedMechanisms: governorAllowed ?? null,
});
const GOVERNOR_AUGMENT_CONTEXT =
  "Treat unverified claims as unconfirmed and say so plainly; do not overstate confidence; preserve the user's original request.";
const GOVERNOR_TIER_3_NOTICE = "Sospio observation: the possible concern noted on earlier turns is still present. If it continues, Sospio may close this conversation. You can hide this notice and continue.";
const GOVERNOR_TIER_3_CONTEXT = "Sospio observation (not the user's words): a possible concern noted on earlier turns is still present in this message. If it continues, Sospio may close this conversation.";

if (!debugLogging && process.env.ELECTRON_ENABLE_LOGGING !== "1") {
  app.commandLine.appendSwitch("disable-logging");
  app.commandLine.appendSwitch("log-level", "3");
}
let chatWindow: BrowserWindow | undefined;
let judgePageGeneration = 0;
let panelWindow: BrowserWindow | undefined;
let monitorClient: MonitorClient | undefined;
const guardedWebContents = new WeakSet<WebContents>();

let pendingMonitorWrites = 0;
const unresolvedMonitorTurns = new Set<string>();
installIpc({
  exportPath: async fileName => {
    const result = await dialog.showSaveDialog({defaultPath: fileName, filters: [{name: "JSON", extensions: ["json"]}]});
    return result.canceled ? undefined : result.filePath;
  },
  recordsInfo: () => ({...recordsInfo("computer", process.env, false, true),...(connection ? {judges: ["the Sospio monitor server"]} : {}),hosted:false}),
  saveMonitorSettings: async (value) => {
    settings.save(value);
    await restartMonitor();
    if (connection) createChatWindow();
  },
  clearMonitorSettings: async () => {
    monitorGeneration++;
    settings.clear();
    const previous = monitor;
    monitor = undefined;
    monitorClient = undefined;
    connection = undefined;
    unresolvedMonitorTurns.clear();
    capture.disposeRecording(); capture = new CaptureService(); bindCapture(capture);
    chatWindow?.destroy(); chatWindow = undefined;
    store.setRuntimeState({monitorConfigured: false, monitorHealth: "error", monitorLastError: null});
    emitState();
    await previous?.stop();
  },
  deleteRecords: async () => {
    if (pendingMonitorWrites || capture.hasPendingRecords()) throw new Error("records_busy");
    for(const id of unresolvedMonitorTurns) if(await monitorClient?.hasVerdict(id))unresolvedMonitorTurns.delete(id);
    if (pendingMonitorWrites || unresolvedMonitorTurns.size || capture.hasPendingRecords()) throw new Error("records_busy");
    // Old capture callbacks are fenced by bindCapture's identity check.
    capture.disposeRecording(); capture = new CaptureService(); bindCapture(capture);
    chatWindow?.destroy(); chatWindow = undefined;
    store.rotateRecording(); recordingFile = store.sessionFile;
    judgePageGeneration++; emitState();
    const message = retention.deleteAll(); if (connection) createChatWindow(); return message;
  },
  isTrusted: (event) => Boolean(panelWindow && event.sender === panelWindow.webContents && event.senderFrame === event.sender.mainFrame),
  dismissJudgeNotice,
  openProvider,
  reloadChat,
  openDevTools,
  restartMonitor,
  getState: () => store.getState(),
});

app.whenReady().then(async () => {
  logMain("app ready");
  app.on("web-contents-created", (_event, webContents) => {
    logMain(`web-contents-created type=${webContents.getType()} url=${sanitizeLogUrl(webContents.getURL())}`);
    if (isChatSessionWebContents(webContents)) {
      guardAndCaptureWebContents(webContents);
    }
  });
  createPanelWindow();
  await restartMonitor();
  if (connection) createChatWindow();
});

app.on("before-quit", () => {
  retention.close();
  void monitor?.stop();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

bindCapture(capture);
function bindCapture(service: CaptureService): void {
service.on("turn", (turn) => {
  if (service !== capture) return;
  logMain(
    `captured turn provider=${turn.provider} turn=${turn.turn_id} session=${turn.session_id}` +
      ` session_source=${turn.session_source ?? "unrecorded"}`,
  );
  store.addTurn(turn);
  store.addDiagnostic({
    id: `captured-${turn.turn_id}`,
    kind: "captured",
    provider: turn.provider,
    reason: "turn captured",
    timestamp: new Date().toISOString(),
  });
  emitState();
  void sendTurnToMonitor(turn);
});

service.on("governorArmOutcome", (outcome) => {
  if (service !== capture) return;
  store.updateGovernorArm(outcome);
  if (outcome.mechanism === "augment_request_context" && chatWindow && !chatWindow.isDestroyed()) {
    void chatWindow.webContents.executeJavaScript(updateGovernorDeliveryScript(outcome.actionId, outcome.status)).catch(() => {});
  }
  emitState();
});

service.on("diagnostic", (diagnostic) => {
  if (service !== capture) return;
  logMain(`capture diagnostic kind=${diagnostic.kind} reason=${diagnostic.reason}`);
  store.addDiagnostic(diagnostic);
  emitState();
});

service.on("networkTag", (tag) => {
  if (service !== capture) return;
  store.addNetworkTag(tag);
});

}

function createWindow(): void {
  logMain("creating two-window shell");
  if (connection) createChatWindow();
  createPanelWindow();
}

function createChatWindow(): BrowserWindow {
  if (!connection) throw new Error("Enter your Sospio monitor token");
  if (chatWindow && !chatWindow.isDestroyed()) {
    return chatWindow;
  }
  chatWindow = new BrowserWindow({
    width: 980,
    height: 980,
    x: 80,
    y: 80,
    title: "Sospio Browser - Chat",
    backgroundColor: "#101418",
    webPreferences: {
      partition: "persist:sospio-browser",
      preload: join(__dirname, "../preload/chatObserver.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  let previousUrl = chatWindow.webContents.getURL();
  const clearNotices = (): void => {
    judgePageGeneration += 1;
    for (const id of pageJudgeNotices.keys()) chatWindow?.webContents.send("harness:remove-judge-notice", id);
    pageJudgeNotices.clear();
  };
  const onNavigation = (): void => {
    const contents = chatWindow?.webContents;
    if (!contents) return;
    const url = contents.getURL();
    store.setRuntimeState({ provider: providerFromNavigation(url) });
    if (conversationChanged(previousUrl, url)) {
      clearNotices();
    }
    void closedConversations.enter(url, conversationChanged(previousUrl, url),
      script => contents.executeJavaScript(script)).catch(() => logMain("closed conversation: failed to restore page state"));
    previousUrl = url;
    emitState();
  };
  chatWindow.webContents.on("dom-ready", onNavigation);
  chatWindow.webContents.on("did-navigate", onNavigation);
  chatWindow.webContents.on("did-navigate-in-page", onNavigation);
  guardAndCaptureWebContents(chatWindow.webContents);
  installChatShortcuts(chatWindow.webContents);

  chatWindow.webContents.loadURL(landingPage()).catch((error) => toast(error.message));
  chatWindow.on("closed", () => {
    logMain("chat window closed");
    chatWindow = undefined;
  });
  return chatWindow;
}

function createPanelWindow(): BrowserWindow {
  if (panelWindow && !panelWindow.isDestroyed()) {
    return panelWindow;
  }
  panelWindow = new BrowserWindow({
    width: 480,
    height: 980,
    x: 1070,
    y: 80,
    title: "Sospio Browser - Monitor",
    backgroundColor: "#101418",
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  installPanelDiagnostics(panelWindow.webContents);
  loadPanel(panelWindow).catch((error) => {
    logMain(`panel load failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    console.error(error);
  });
  panelWindow.on("closed", () => {
    logMain("panel window closed");
    panelWindow = undefined;
  });
  return panelWindow;
}

function ensureChatWindow(): BrowserWindow {
  const window = createChatWindow();
  window.show();
  window.focus();
  return window;
}

async function loadPanel(window: BrowserWindow): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    await window.webContents.loadURL(devUrl);
  } else {
    await window.webContents.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

async function openProvider(provider: ProviderName): Promise<void> {
  if (!connection) throw new Error("Enter your Sospio monitor token");
  logMain(`open provider ${provider}`);
  const spec = providerForName(provider);
  if (!spec?.enabled) {
    toast(`${provider} is experimental and disabled for this demo`);
    return;
  }
  store.setRuntimeState({ provider });
  emitState();
  await ensureChatWindow().webContents.loadURL(PROVIDER_URLS[provider]);
}

async function reloadChat(): Promise<void> {
  logMain("reload chat");
  const window = ensureChatWindow();
  toast("Reloading chat window");
  window.webContents.reloadIgnoringCache();
}

async function goHome(): Promise<void> {
  logMain("go home");
  await ensureChatWindow().webContents.loadURL(landingPage());
}

async function openDevTools(): Promise<void> {
  logMain("open chat devtools");
  ensureChatWindow().webContents.openDevTools({ mode: "detach" });
}

async function restartMonitor(): Promise<void> {
  const generation = ++monitorGeneration;
  const previous = monitor;
  monitor = undefined;
  await previous?.stop();
  if (generation !== monitorGeneration) return;
  unresolvedMonitorTurns.clear();
  logMain("restart monitor");
  toast("Restarting monitor");
  // This also runs once at startup, which is a first start rather than a restart; only a real
  // restart is worth a diagnostic.
  const isRestart = monitorClient !== undefined;
  monitorClient = undefined;
  // Deliberately does NOT clear the captured turns. Restarting the monitor mid-demo used to
  // empty the panel, which is the one moment the operator most needs to see what happened.
  // The restart is recorded instead, so the session log still marks where the instrument changed.
  if (isRestart) {
    store.addDiagnostic({
      id: `monitor-restart-${randomUUID()}`,
      kind: "measurement",
      reason: "monitor_restarted",
      timestamp: new Date().toISOString(),
    });
  }
  store.setRuntimeState({ monitorHealth: "starting", monitorLastError: null });
  emitState();
  try {
    connection = settings.load();
    store.setRuntimeState({monitorConfigured: Boolean(connection), monitorUrl: settings.view().url});
    if (!connection) {
      monitor = undefined;
      store.setRuntimeState({monitorHealth: "error", monitorLastError: null});
      emitState();
      return;
    }
    const source = createMonitorSource(connection);
    monitor = source;
    const status = await source.start();
    if (generation !== monitorGeneration) { await source.stop(); return; }
    monitorClient = source.getClient();
    store.setRuntimeState({
      monitorHealth: "healthy",
      monitorLastError: null,
      monitorIdentity: status.monitor,
    });
    toast(`Monitor ready: ${status.monitor ?? "Sospio remote monitor"}`);
  } catch (error) {
    if (generation !== monitorGeneration) return;
    logMain(`monitor start failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    store.setRuntimeState({
      monitorHealth: "error",
      monitorLastError: error instanceof Error ? error.message : "Monitor unavailable",
    });
    toast(error instanceof Error ? error.message : "Monitor unavailable");
  }
  emitState();
}

/**
 * The governor loop: monitor verdict -> policy -> intervention on the live provider surface.
 *
 * This is the wire that was missing between the harness' two halves. Before it, a verdict was
 * stored and displayed while every intervention came from a human clicking a probe button, so the
 * loop the product depends on had never run. Policy lives in `browserPolicyAdapter`, execution in
 * `governorLoop`; this function only binds them to the real provider surface.
 */
async function runGovernorLoop(turn: TurnEvent, verdict: MonitorVerdict): Promise<void> {
  await closedConversations.runIfOpen(turn, () => runOpenGovernorLoop(turn, verdict));
}

async function runOpenGovernorLoop(turn: TurnEvent, verdict: MonitorVerdict): Promise<void> {
  if (!governorLoopEnabled) {
    return;
  }
  const provider = store.getState().provider;
  let plan;
  try {
    plan = planFromVerdict(verdict, { threshold: governorThreshold, allowed: governorAllowed });
  } catch (error) {
    logMain(`governor loop: invalid policy configuration: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!plan) {
    return;
  }

  const actionId = randomUUID();
  const options: GovernorExecutionOptions = {
    actionId,
    provider: turn.provider,
    threshold: governorThreshold,
    ...governorTextOptions(verdict, {
      noticeText: "Sospio flagged a possible concern in this response. Review it before relying on it.",
      augmentContext: GOVERNOR_AUGMENT_CONTEXT,
      tier3Text: { noticeText: GOVERNOR_TIER_3_NOTICE, augmentContext: GOVERNOR_TIER_3_CONTEXT },
    }),
    originalCandidateText: turn.assistant_text,
  };
  const block = governorSurfaceBlock(provider, conversationIdFromUrl(chatWindow?.webContents.getURL() ?? ""), turn);
  if (block) {
    store.addGovernorAction(buildGovernorActionRecord(plan, blockedGovernorExecutions(plan, block), verdict, options));
    toast(block.detail);
    emitState();
    return;
  }
  const window = ensureChatWindow();
  const surface = governorSurface(window, turn.provider, actionId, turn);

  const executions = await executeGovernorPlan(plan, surface, options);
  store.addGovernorAction(buildGovernorActionRecord(plan, executions, verdict, options));
  const acted = executions.filter((e) => e.status === "applied" || e.status === "armed").length;
  const signals = plan.triggering_signals.map((s) => s.name).join(", ");
  toast(
    acted > 0
      ? `Sospio recorded ${acted} action(s) for ${signals}.`
      : `Sospio selected an action for ${signals}, but nothing was executed. See the receipt.`,
  );
  emitState();
}

function governorSurface(window: BrowserWindow, provider: ProviderName, actionId?: string, turn?: TurnEvent): GovernorSurface {
  return {
    displayNotice: async (message, tier, hasNextTurnAugment) => {
      await interventionExecutor.displayGovernorNotice(window.webContents, provider, message, tier, hasNextTurnAugment, actionId);
    },
    replaceLatestPresentation: async () => {
      await capture.mediateLatestPresentation(window.webContents, provider, "replace_presentation");
    },
    armRequest: async (mechanism, context) => {
      if (!supportsMediation(provider)) {
        throw new Error(`${mechanism} requires a ChatGPT or Claude.ai request mediation surface`);
      }
      await capture.armRequestMediation(window.webContents, provider, mechanism, context, {
        attributed: true,
        effectSignature: null,
        diagnosticLabel: "browser_governor_intervention",
        actionId,
        conversationId: conversationIdFromUrl(window.webContents.getURL()),
      });
    },
    terminateExchange: async (message, countdownSeconds) => {
      // Return the observed outcome so the receipt records what happened rather
      // than what was attempted. Discarding it is how the first version came to
      // record `closed_to_further_turns: true` unconditionally.
      const result = await closedConversations.applyClose(turn, () => interventionExecutor.terminateExchange(
        window.webContents,
        provider,
        message,
        countdownSeconds,
      ));
      return {
        closed_to_further_turns: result.closed_to_further_turns,
        transcript_preserved: result.transcript_preserved,
        verified_at: result.verified_at,
      };
    },
  };
}

async function sendTurnToMonitor(turn: TurnEvent): Promise<void> {
  pendingMonitorWrites++;
  try { await sendTurnToMonitorInternal(turn); } finally { pendingMonitorWrites--; }
}
async function sendTurnToMonitorInternal(turn: TurnEvent): Promise<void> {
  const client = monitorClient;
  const generation = monitorGeneration;
  logMain(`send turn to monitor ${turn.turn_id}`);
  if (!client) {
    store.setRuntimeState({
      monitorHealth: "error",
      monitorLastError: "Monitor unavailable",
    });
    emitState();
    return;
  }
  store.markPending(turn.turn_id);
  const pageGeneration = judgePageGeneration;
  emitState();
  try {
    unresolvedMonitorTurns.add(turn.turn_id);
    await client.postTurn(turn);
    if (generation !== monitorGeneration) return;
    const verdict = await client.pollVerdict(turn.turn_id);
    if (generation !== monitorGeneration) return;
    unresolvedMonitorTurns.delete(turn.turn_id);
    store.addVerdict(verdict);
    store.setRuntimeState({
      monitorHealth: verdict.monitor_status === "error" ? "error" : "healthy",
      monitorLastError: verdict.monitor_status === "error" ? verdict.error ?? "monitor returned no reason" : null,
      monitorIdentity: verdict.monitor_version,
    });
    showJudgeNotices(turn, verdict, pageGeneration);
    await runGovernorLoop(turn, verdict);
  } catch (error) {
    if (generation !== monitorGeneration) return;
    logMain(`monitor turn failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    store.addVerdict({
      turn_id: turn.turn_id,
      schema_version: "resilience_monitor_v1",
      signals: [],
      monitor_version: "unavailable",
      latency_ms: 0,
      monitor_status: "error",
      error: error instanceof Error ? error.message : "monitor request failed",
    });
    store.setRuntimeState({
      monitorHealth: "error",
      monitorLastError: error instanceof Error ? error.message : "monitor request failed",
    });
  }
  emitState();
}

function getState(): HarnessState {
  return store.getState();
}

function emitState(): void {
  pushState(panelWindow?.webContents, getState());
}

function toast(message: string): void {
  logMain(`toast: ${message}`);
  pushToast(panelWindow?.webContents, message);
}

function guardAndCaptureWebContents(webContents: WebContents): void {
  if (
    panelWindow?.webContents === webContents ||
    webContents.getType() === "remote" ||
    !isChatSessionWebContents(webContents)
  ) {
    return;
  }
  if (guardedWebContents.has(webContents)) {
    return;
  }
  guardedWebContents.add(webContents);
  logMain(`guard/capture webContents type=${webContents.getType()} url=${sanitizeLogUrl(webContents.getURL())}`);
  installNavigationGuard(webContents, (url) => {
    toast(`Blocked navigation to ${sanitizeLogUrl(url)}`);
  });
  webContents.on("did-start-loading", () => {
    logMain(`did-start-loading url=${sanitizeLogUrl(webContents.getURL())}`);
  });
  webContents.on("did-finish-load", () => {
    logMain(`did-finish-load url=${sanitizeLogUrl(webContents.getURL())}`);
  });
  webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    const url = sanitizeLogUrl(validatedURL);
    logMain(`did-fail-load main=${isMainFrame} code=${errorCode} desc=${errorDescription} url=${url}`);
    if (isMainFrame) {
      toast(`Page load failed (${errorCode}): ${errorDescription} ${url}`);
    }
  });
  webContents.on("render-process-gone", (_event, details) => {
    logMain(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
    toast(`Chat renderer stopped: ${details.reason}`);
  });
  if (process.env.RSH_BROWSER_HARNESS_NO_CDP === "1") {
    logMain("CDP capture disabled by RSH_BROWSER_HARNESS_NO_CDP=1");
  } else {
    capture.attach(webContents);
  }
}

function installPanelDiagnostics(webContents: WebContents): void {
  webContents.on("dom-ready", () => {
    logMain(`panel dom-ready url=${sanitizeLogUrl(webContents.getURL())}`);
    emitState();
  });
  webContents.on("did-finish-load", () => {
    logMain(`panel did-finish-load url=${sanitizeLogUrl(webContents.getURL())}`);
    emitState();
  });
  webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    logMain(`panel did-fail-load main=${isMainFrame} code=${errorCode} desc=${errorDescription} url=${sanitizeLogUrl(validatedURL)}`);
  });
  webContents.on("render-process-gone", (_event, details) => {
    logMain(`panel render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
  });
  webContents.on("console-message", (_event, level, message, line, sourceId) => {
    logMain(`panel console level=${level} ${sourceId}:${line} ${message}`);
  });
}

function isChatSessionWebContents(webContents: WebContents): boolean {
  return Boolean(chatWindow && webContents.session === chatWindow.webContents.session);
}

function installChatShortcuts(webContents: WebContents): void {
  webContents.on("before-input-event", (event, input) => {
    const commandOrControl = input.control || input.meta;
    if (!commandOrControl || input.type !== "keyDown") {
      return;
    }
    if (input.key.toLowerCase() === "r") {
      event.preventDefault();
      webContents.reload();
    } else if (input.key.toLowerCase() === "h") {
      event.preventDefault();
      void goHome();
    } else if (input.key.toLowerCase() === "i") {
      event.preventDefault();
      webContents.openDevTools({ mode: "detach" });
    }
  });
}

function logMain(message: string): void {
  // Callers are expected to pass URLs through sanitizeLogUrl; the scrub here is the
  // backstop for strings the harness did not compose (console output, stacks) and
  // for the next log site added without it.
  const line = redactQueryValues(message);
  try {
    mkdirSync(logsDir, { recursive: true });
    appendFileSync(mainLogPath, `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    // Last-ditch diagnostics must never crash the demo shell.
  }
  if (debugLogging) {
    console.log(`[browser-harness] ${line}`);
  }
}

function landingPage(): string {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #11161a; color: #edf2f7; }
      main { width: min(560px, calc(100vw - 48px)); }
      h1 { font-size: 34px; margin: 0 0 12px; letter-spacing: 0; }
      p { color: #aab6c2; line-height: 1.5; margin: 0 0 26px; }
      .buttons { display: flex; gap: 12px; flex-wrap: wrap; }
      button { border: 1px solid #33404c; background: #1c252d; color: #f8fafc; padding: 12px 16px; border-radius: 8px; font: inherit; cursor: pointer; }
      button:hover { border-color: #6aa6ff; }
      button:disabled { color: #647180; cursor: not-allowed; border-color: #26323d; }
    </style>
  </head>
  <body>
    <main>
      <h1>Sospio Browser</h1>
      <p>Open a consumer chat site. The harness observes completed plain-text turns and sends them to the side-panel monitor.</p>
      <div class="buttons">
        <button onclick="location.href='https://chatgpt.com/'">Open ChatGPT</button>
        <button onclick="location.href='https://claude.ai/'">Open Claude.ai</button>
      </div>
    </main>
  </body>
</html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}


const pageJudgeNotices = new Map<string, { turn: TurnEvent; verdict: MonitorVerdict; notice?: PooledNotice; signal: JudgeSignal; shown: boolean }>();

async function dismissJudgeNotice(turnId: string, signal: string): Promise<void> {
  const record = store.getState().turns.find((r) => r.turn.turn_id === turnId);
  if (!record?.verdict?.judge_ladder || !monitorClient) throw new Error("notice unavailable");
  await monitorClient.dismiss(record.turn.session_id, signal);
  const ids = store.getState().turns.filter((r) => r.turn.session_id === record.turn.session_id).map((r) => r.turn.turn_id + ":" + signal);
  store.setRuntimeState({ dismissedJudgeNotices: [...(store.getState().dismissedJudgeNotices ?? []), ...ids] });
  for (const [id, entry] of pageJudgeNotices) {
    if (entry.notice && entry.signal === signal && entry.turn.session_id === record.turn.session_id) {
      chatWindow?.webContents.send("harness:remove-judge-notice", id);
      pageJudgeNotices.delete(id);
    }
  }
  emitState();
}

function showJudgeNotices(turn: TurnEvent, verdict: MonitorVerdict, pageGeneration: number): void {
  if (!verdict.judge_ladder || !chatWindow || pageGeneration !== judgePageGeneration) return;
  if (store.getState().turns.at(-1)?.turn.session_id !== turn.session_id) return;
  const block = verdict.judge_ladder;
  for (const notice of block.pooled.filter((e) => e.kind !== "suppressed")) {
    const id = "sospio-" + randomUUID();
    pageJudgeNotices.set(id, { turn, verdict, notice, signal: notice.signal, shown: false });
    chatWindow.webContents.send("harness:judge-notice", { id, text: notice.text, kind: notice.kind });
  }
  for (const signal of Object.keys(block.signals) as JudgeSignal[]) {
    const id = "sospio-unavailable-" + signal;
    if (block.signals[signal]?.monitoring_unavailable) {
      if (!pageJudgeNotices.has(id)) {
        pageJudgeNotices.set(id, { turn, verdict, signal, shown: false });
        chatWindow.webContents.send("harness:judge-notice", { id, text: judgeUnavailableText(signal), kind: "unavailable" });
      }
    } else {
      pageJudgeNotices.delete(id);
      chatWindow.webContents.send("harness:remove-judge-notice", id);
    }
  }
}

ipcMain.handle("harness:judge-notice-action", async (event, id: unknown, action: unknown) => {
  if (event.sender !== chatWindow?.webContents || event.senderFrame !== event.sender.mainFrame || typeof id !== "string") throw new Error("invalid notice source");
  const entry = pageJudgeNotices.get(id);
  if (!entry) throw new Error("unknown notice");
  if (action === "shown") {
    if (entry.shown || !entry.notice) return;
    entry.shown = true;
    store.addGovernorAction(buildPooledNoticeReceipt(entry.turn, entry.verdict, entry.notice, governorThreshold));
    emitState();
  } else if (action === "dismiss" && entry.notice) {
    await dismissJudgeNotice(entry.turn.turn_id, entry.signal);
  } else if (action === "look" && entry.notice?.kind === "check_in") {
    store.setRuntimeState({ citedJudgeTurns: { sessionId: entry.turn.session_id, ordinals: entry.notice.cited.map((c) => c.ordinal) } });
    createPanelWindow().show();
    emitState();
  } else throw new Error("invalid notice action");
});
