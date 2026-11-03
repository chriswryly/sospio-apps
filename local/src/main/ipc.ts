import { open } from "node:fs/promises";
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { HarnessState } from "../shared/types";

export type IpcHandlers = {
  exportPath(fileName: string): Promise<string | undefined>;
  recordsInfo(): import("../../../records/disclosure").RecordsInfo;
  deleteRecords(): Promise<string>;
  monitorSettings(): {url: string; configured: boolean};
  saveMonitorSettings(value: {url: string; token: string}): Promise<void>;
  clearMonitorSettings(): Promise<void>;
  setConversationModel(name: string): Promise<void>;
  dismissJudgeNotice(turnId: string, signal: string): Promise<void>;
  isTrusted(event: IpcMainInvokeEvent): boolean;
  sendMessage(message: string): Promise<void>;
  newConversation(): Promise<void>;
  openDevTools(): Promise<void>;
  restartMonitor(): Promise<void>;
  reconnectMonitor(): Promise<void>;
  getState(): HarnessState;
};
export function installIpc(handlers: IpcHandlers): void {
  const trusted = (event: IpcMainInvokeEvent) => {if (!handlers.isTrusted(event)) throw new Error("untrusted source");};
  ipcMain.handle("harness:save-export", async (event, fileName: unknown, contents: unknown) => {
    trusted(event);
    if (typeof fileName !== "string" || !/^sospio-export-[A-Za-z0-9_.-]+\.json$/.test(fileName) || typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > 5 * 1024 * 1024) throw new Error("invalid_export");
    const path = await handlers.exportPath(fileName); if (!path) return false;
    const file = await open(path, "w", 0o600);
    try {await file.chmod(0o600); await file.writeFile(contents, "utf8");} finally {await file.close();}
    return true;
  });
  ipcMain.handle("harness:monitor-settings", event => {trusted(event); return handlers.monitorSettings();});
  ipcMain.handle("harness:save-monitor-settings", (event, value: unknown) => {
    trusted(event);
    if (!value || typeof value !== "object" || typeof (value as {url?: unknown}).url !== "string" || typeof (value as {token?: unknown}).token !== "string") throw new Error("invalid_monitor_settings");
    return handlers.saveMonitorSettings(value as {url: string; token: string});
  });
  ipcMain.handle("harness:clear-monitor-settings", event => {trusted(event); return handlers.clearMonitorSettings();});
  ipcMain.handle("harness:records-info", event => {trusted(event); return handlers.recordsInfo();});
  ipcMain.handle("harness:delete-records", event => {trusted(event); return handlers.deleteRecords();});
  ipcMain.handle("harness:set-conversation-model", (event, name: unknown) => {trusted(event); if (typeof name !== "string" || handlers.getState().messages.length) throw new Error("Invalid model selection"); return handlers.setConversationModel(name);});
  ipcMain.handle("harness:dismiss-judge-notice", (event, turnId: unknown, signal: unknown) => {trusted(event); if (typeof turnId !== "string" || (signal !== "sycophancy" && signal !== "overreliance_signals")) throw new Error("invalid dismissal"); return handlers.dismissJudgeNotice(turnId, signal);});
  ipcMain.handle("harness:send-message", (event, message: unknown) => {trusted(event); if (typeof message !== "string") throw new Error("invalid message"); return handlers.sendMessage(message);});
  for (const [channel, handler] of Object.entries({"new-conversation": handlers.newConversation, "open-devtools": handlers.openDevTools, "restart-monitor": handlers.restartMonitor, "reconnect-monitor": handlers.reconnectMonitor, "get-state": handlers.getState})) ipcMain.handle(`harness:${channel}`, event => {trusted(event); return handler();});
}
export function pushState(target: WebContents | undefined, state: HarnessState): void {if (target && !target.isDestroyed()) target.send("harness:state", state);}
export function pushToast(target: WebContents | undefined, message: string): void {if (target && !target.isDestroyed()) target.send("harness:toast", message);}
