import { open } from "node:fs/promises";
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import type {
  HarnessState,
  ProviderName,
} from "../shared/types";

export type IpcHandlers = {
  claimMonitorToken?(value: {url: string; code: string}): Promise<import("../../../shared/types").MonitorClaimResult>;
  saveMonitorSettings?(value: {url: string; token: string}): Promise<void>;
  clearMonitorSettings?(): Promise<void>;
  exportPath?(fileName: string): Promise<string | undefined>;
  recordsInfo?(): import("../../../records/disclosure").RecordsInfo;
  deleteRecords?(): Promise<string>;
  isTrusted?(event: IpcMainInvokeEvent): boolean;
  dismissJudgeNotice?(turnId: string, signal: string): Promise<void>;
  openProvider(provider: ProviderName): Promise<void>;
  reloadChat(): Promise<void>;
  openDevTools(): Promise<void>;
  restartMonitor(): Promise<void>;
  getState(): HarnessState;
};

export function installIpc(handlers: IpcHandlers): void {
  ipcMain.handle("harness:claim-monitor-token", async (event, value: unknown) => {
    if (!handlers.isTrusted?.(event)) throw new Error("untrusted settings source");
    if (!value || typeof value !== "object" || typeof (value as {url?: unknown}).url !== "string" || typeof (value as {code?: unknown}).code !== "string") throw new Error("invalid_monitor_claim");
    return handlers.claimMonitorToken?.(value as {url: string; code: string});
  });
  ipcMain.handle("harness:save-monitor-settings", async (event, value: unknown) => {
    if (!handlers.isTrusted?.(event)) throw new Error("untrusted settings source");
    if (!value || typeof value !== "object" || typeof (value as {url?: unknown}).url !== "string" || typeof (value as {token?: unknown}).token !== "string") throw new Error("invalid_monitor_settings");
    await handlers.saveMonitorSettings?.(value as {url: string; token: string});
  });
  ipcMain.handle("harness:clear-monitor-settings", async event => {
    if (!handlers.isTrusted?.(event)) throw new Error("untrusted settings source");
    await handlers.clearMonitorSettings?.();
  });
  ipcMain.handle("harness:save-export", async (event, fileName: unknown, contents: unknown) => {
    if (!handlers.isTrusted?.(event)) throw new Error("untrusted records source");
    if (typeof fileName !== "string" || !/^sospio-export-[A-Za-z0-9_.-]+\.json$/.test(fileName)
      || typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > 5 * 1024 * 1024)
      throw new Error("invalid_export");
    const path = await handlers.exportPath?.(fileName);
    if (!path) return false;
    const file = await open(path, "w", 0o600);
    try { await file.chmod(0o600); await file.writeFile(contents, "utf8"); }
    finally { await file.close(); }
    return true;
  });
  ipcMain.handle("harness:records-info", event => {
    if (!handlers.isTrusted?.(event)) throw new Error("untrusted records source");
    return handlers.recordsInfo?.();
  });
  ipcMain.handle("harness:delete-records", event => {
    if (!handlers.isTrusted?.(event)) throw new Error("untrusted records source");
    return handlers.deleteRecords?.();
  });
  ipcMain.handle("harness:dismiss-judge-notice", (event, turnId: unknown, signal: unknown) => {
    if (!handlers.isTrusted?.(event)) throw new Error("untrusted dismissal source");
    if (typeof turnId !== "string" || (signal !== "sycophancy" && signal !== "overreliance_signals")) throw new Error("invalid dismissal");
    return handlers.dismissJudgeNotice?.(turnId, signal);
  });
  ipcMain.handle("harness:open-provider", (_event, provider: ProviderName) => handlers.openProvider(provider));
  ipcMain.handle("harness:reload-chat", () => handlers.reloadChat());
  ipcMain.handle("harness:open-devtools", () => handlers.openDevTools());
  ipcMain.handle("harness:restart-monitor", () => handlers.restartMonitor());
  ipcMain.handle("harness:get-state", () => handlers.getState());
}

export function pushState(target: WebContents | undefined, state: HarnessState): void {
  if (target && !target.isDestroyed()) {
    target.send("harness:state", state);
  }
}

export function pushToast(target: WebContents | undefined, message: string): void {
  if (target && !target.isDestroyed()) {
    target.send("harness:toast", message);
  }
}
