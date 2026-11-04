import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HarnessState, MonitorVerdict, TurnEvent } from "../shared/types";
import noticeSequence from "../shared/__fixtures__/noticeSequence.json";

const runtime = vi.hoisted(() => ({
  dataDir: "",
  handlers: new Map<string, (...arguments_: unknown[]) => unknown>(),
  captures: [] as Array<import("node:events").EventEmitter>,
  windows: [] as Array<{ webContents: { mainFrame: object; loadURL(url: string): Promise<void> } }>,
  notice: vi.fn(async () => undefined),
  start: vi.fn(async () => ({monitor: "fixture monitor"})),
  encryptionAvailable: false,
  encrypt: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
  verdict: undefined as MonitorVerdict | undefined,
}));

vi.mock("electron", () => ({
  app: {
    setName: vi.fn(),
    getPath: () => runtime.dataDir,
    whenReady: async () => undefined,
    on: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
  },
  BrowserWindow: class {
    webContents = {
      mainFrame: {},
      session: {},
      on: vi.fn(),
      getType: () => "window",
      getURL: () => this.url,
      loadURL: async (url: string) => { this.url = url; },
      loadFile: async () => undefined,
      send: vi.fn(),
      isDestroyed: () => false,
    };
    private url = "";
    constructor() { runtime.windows.push(this); }
    on = vi.fn();
    isDestroyed = () => false;
    show = vi.fn();
    focus = vi.fn();
  },
  dialog: {},
  safeStorage: {
    isEncryptionAvailable: () => runtime.encryptionAvailable,
    encryptString: runtime.encrypt,
    decryptString: (value: Buffer) => value.toString().replace(/^encrypted:/, ""),
  },
  ipcMain: {
    handle: (channel: string, handler: (...arguments_: unknown[]) => unknown) => runtime.handlers.set(channel, handler),
  },
}));
vi.mock("./allowlist", () => ({ installNavigationGuard: vi.fn() }));
vi.mock("./capture/cdpClient", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    CaptureService: class extends EventEmitter {
      constructor() { super(); runtime.captures.push(this); }
      attach = vi.fn();
    },
  };
});
vi.mock("../../../records/retentionController", () => ({
  RetentionController: class { start = vi.fn(); close = vi.fn(); },
}));
vi.mock("./interventionExecutor", async (importOriginal) => ({
  ...await importOriginal<typeof import("./interventionExecutor")>(),
  BrowserInterventionExecutor: class { displayGovernorNotice = runtime.notice; },
}));
vi.mock("./remoteMonitor", () => ({
  createMonitorSource: () => ({
    start: runtime.start,
    stop: async () => undefined,
    getClient: () => ({
      postTurn: async () => undefined,
      pollVerdict: async () => runtime.verdict,
    }),
  }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  runtime.handlers.clear();
  runtime.captures = [];
  runtime.windows = [];
  runtime.encryptionAvailable = false;
  runtime.dataDir = mkdtempSync(join(realpathSync(tmpdir()), "browser-startup-"));
  vi.stubEnv("RSH_MONITOR_REMOTE_TOKEN", "fixture-monitor-token");
  vi.stubEnv("RSH_BROWSER_GOVERNOR_MECHANISMS", undefined);
  vi.stubEnv("RSH_BROWSER_GOVERNOR_THRESHOLD", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(runtime.dataDir, { recursive: true, force: true });
});

it("claims in main, encrypts the token, and starts the configured monitor and browser", async () => {
  vi.stubEnv("RSH_MONITOR_REMOTE_TOKEN", undefined);
  runtime.encryptionAvailable = true;
  const token = "fixture-claimed-token";
  const fetchClaim = vi.fn(async () => new Response(JSON.stringify({token}), {status: 200}));
  vi.stubGlobal("fetch", fetchClaim);
  await import("./index");
  await vi.waitFor(() => expect(runtime.windows).toHaveLength(1));
  const sender = runtime.windows[0].webContents;
  const claim = runtime.handlers.get("harness:claim-monitor-token")!;
  const value = {url: "https://monitor.example", code: "fixture-invite"};
  await expect(claim({sender, senderFrame: {}}, value)).rejects.toThrow("untrusted settings source");
  await expect(claim({sender: {}, senderFrame: sender.mainFrame}, value)).rejects.toThrow("untrusted settings source");
  expect(fetchClaim).not.toHaveBeenCalled();
  const result = await claim({sender, senderFrame: sender.mainFrame}, value);
  expect(result).toEqual({ok: true});
  expect(fetchClaim).toHaveBeenCalledWith("https://monitor.example/monitor/v1/claim", expect.objectContaining({
    method: "POST", body: JSON.stringify({code: "fixture-invite"}),
  }));
  expect(runtime.encrypt).toHaveBeenCalledOnce();
  expect(runtime.encrypt).toHaveBeenCalledWith(token);
  expect(readFileSync(join(runtime.dataDir, "monitor-settings.json"), "utf8")).not.toContain(token);
  expect(runtime.start).toHaveBeenCalledOnce();
  expect(runtime.windows).toHaveLength(2);
  const state = runtime.handlers.get("harness:get-state")!() as HarnessState;
  expect(state.monitorConfigured).toBe(true);
  expect(state.monitorHealth).toBe("healthy");
  expect(JSON.stringify(state)).not.toContain(token);
  expect(JSON.stringify(state)).not.toContain("fixture-invite");
});

it.each([
  [401, "relay_claim_invalid_code", "That invite code didn't work."],
  [429, "relay_claim_lockout", "Too many tries. Wait 15 minutes."],
  [429, "relay_claim_daily", "A token was already given to this network today. Use that token, or try again tomorrow."],
  [429, "relay_claim_hourly", "Lots of people are getting tokens right now. Try again in an hour."],
  [410, "relay_claims_exhausted", "All trial tokens have been handed out. Contact the person who shared Sospio with you."],
])("returns the plain claim error for %s %s without configuring a monitor", async (status, error, message) => {
  vi.stubEnv("RSH_MONITOR_REMOTE_TOKEN", undefined);
  runtime.encryptionAvailable = true;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({error}), {status: status as number})));
  await import("./index");
  await vi.waitFor(() => expect(runtime.windows).toHaveLength(1));
  const sender = runtime.windows[0].webContents;
  expect(await runtime.handlers.get("harness:claim-monitor-token")!({sender, senderFrame: sender.mainFrame}, {url: "https://monitor.example", code: "fixture-invite"})).toEqual({ok: false, message});
  expect(runtime.encrypt).not.toHaveBeenCalled();
  expect(runtime.start).not.toHaveBeenCalled();
  expect(existsSync(join(runtime.dataDir, "monitor-settings.json"))).toBe(false);
  expect((runtime.handlers.get("harness:get-state")!() as HarnessState).monitorConfigured).toBe(false);
});

it.each([undefined, "1", "false", "0"])("runs the startup governor unless the setting is exactly 0 (%s)", async (setting) => {
  vi.stubEnv("RSH_BROWSER_GOVERNOR_LOOP", setting);
  await import("./index");
  await vi.waitFor(() => expect(runtime.windows).toHaveLength(2));
  await runtime.handlers.get("harness:open-provider")!({}, "chatgpt");
  await runtime.windows[1].webContents.loadURL("https://chatgpt.com/c/startup-conversation");
  const turn: TurnEvent = {
    turn_id: "startup-turn",
    session_id: "startup-conversation",
    provider: "chatgpt",
    user_prompt: "Fixture user turn",
    assistant_text: "Fixture assistant turn",
    started_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T00:00:01Z",
    request_url: "https://chatgpt.com/backend-api/conversation",
  };
  const publicVerdict = noticeSequence[0] as MonitorVerdict;
  runtime.verdict = { ...publicVerdict, turn_id: turn.turn_id };
  runtime.captures[0].emit("turn", turn);
  const state = () => runtime.handlers.get("harness:get-state")!() as HarnessState;
  await vi.waitFor(() => {
    expect(state().turns[0].verdict?.error).toBeUndefined();
    expect(state().turns[0].monitorStatus).toBe("ready");
  });
  expect(state().governorLoopEnabled).toBe(setting !== "0");
  if (setting === "0") {
    expect(runtime.notice).not.toHaveBeenCalled();
    expect(state().turns[0].governorActions).toBeUndefined();
  } else {
    await vi.waitFor(() => expect(state().turns[0].governorActions).toHaveLength(1));
    expect(runtime.notice).toHaveBeenCalledOnce();
    expect(runtime.notice).toHaveBeenCalledWith(
      expect.anything(), "chatgpt", publicVerdict.judge_ladder!.signals.overreliance_signals.text.tier1,
      1, false, expect.any(String),
    );
    expect(state().turns[0].governorActions?.[0].executions).toContainEqual(expect.objectContaining({
      mechanism: "display_governor_notice", status: "applied",
    }));
  }
  for (const channel of ["harness:demonstrate-governor-notice", "harness:run-capability-probe", "harness:run-demo-intervention"])
    expect(runtime.handlers.has(channel)).toBe(false);
});
