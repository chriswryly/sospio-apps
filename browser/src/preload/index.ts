import { contextBridge, ipcRenderer } from "electron";
import type { HarnessApi, HarnessState, ProviderName } from "../shared/types";

const api: HarnessApi = {
  saveMonitorSettings: value => ipcRenderer.invoke("harness:save-monitor-settings", value),
  clearMonitorSettings: () => ipcRenderer.invoke("harness:clear-monitor-settings"),
  saveExport: (fileName, contents) => ipcRenderer.invoke("harness:save-export", fileName, contents),
  recordsInfo: () => ipcRenderer.invoke("harness:records-info"),
  deleteRecords: () => ipcRenderer.invoke("harness:delete-records"),
  dismissJudgeNotice: (turnId, signal) => ipcRenderer.invoke("harness:dismiss-judge-notice", turnId, signal),
  openProvider(provider: ProviderName) {
    return ipcRenderer.invoke("harness:open-provider", provider);
  },
  reloadChat() {
    return ipcRenderer.invoke("harness:reload-chat");
  },
  openDevTools() {
    return ipcRenderer.invoke("harness:open-devtools");
  },
  restartMonitor() {
    return ipcRenderer.invoke("harness:restart-monitor");
  },
  getState() {
    return ipcRenderer.invoke("harness:get-state") as Promise<HarnessState>;
  },
  onState(callback) {
    const listener = (_event: Electron.IpcRendererEvent, state: HarnessState) => callback(state);
    ipcRenderer.on("harness:state", listener);
    return () => ipcRenderer.off("harness:state", listener);
  },
  onToast(callback) {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on("harness:toast", listener);
    return () => ipcRenderer.off("harness:toast", listener);
  },
};

contextBridge.exposeInMainWorld("harness", api);
