import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HarnessState, MonitorVerdict, TurnEvent } from "../shared/types";
import noticeSequence from "../shared/__fixtures__/noticeSequence.json";

const runtime = vi.hoisted(() => ({
  dataDir: "",
  handlers: new Map<string, (...arguments_: unknown[]) => unknown>(),
  captures: [] as Array<import("node:events").EventEmitter>,
  windows: [] as Array<{ webContents: { loadURL(url: string): Promise<void> } }>,
  notice: vi.fn(async () => undefined),
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
  safeStorage: { isEncryptionAvailable: () => false },
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
    start: async () => ({ monitor: "fixture monitor" }),
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
  runtime.dataDir = mkdtempSync(join(realpathSync(tmpdir()), "browser-startup-"));
  vi.stubEnv("RSH_MONITOR_REMOTE_TOKEN", "fixture-monitor-token");
  vi.stubEnv("RSH_BROWSER_GOVERNOR_MECHANISMS", undefined);
  vi.stubEnv("RSH_BROWSER_GOVERNOR_THRESHOLD", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(runtime.dataDir, { recursive: true, force: true });
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
