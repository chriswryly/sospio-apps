import { app, BrowserWindow, dialog, safeStorage } from "electron";
import { join } from "node:path";
import { MonitorSettings } from "../../../shared/monitorSettings";
import { RetentionController } from "../../../records/retentionController";
import { recordsInfo } from "../../../records/recordsConfig";
import { createMonitorSource } from "./remoteMonitor";
import { loadRuntimeConfig } from "./config";
import { HarnessRuntime } from "./runtime";
import { ChatClient } from "./chatClient";
import { ChatRouter } from "./chatRouter";
import { HostedChatClient } from "./hostedChatClient";
import { HostedSpend, promptTokenBound, reservationUsd } from "./hostedSpend";
import { installIpc, pushState, pushToast } from "./ipc";
import { monitorSetupHandlers } from "./monitorSetup";
import { migrateChatData } from "./migrateData";

app.setName("Sospio Chat");
migrateChatData(app.getPath("appData"));
app.disableHardwareAcceleration();
let window: BrowserWindow | undefined;
let runtime: HarnessRuntime | undefined;
let retention: RetentionController | undefined;
app.whenReady().then(async () => {
  const dataDir = app.getPath("userData");
  app.setAppLogsPath(join(dataDir, "logs"));
  const settings = new MonitorSettings({dataDir, safeStorage});
  const monitor = createMonitorSource(settings.load());
  const config = loadRuntimeConfig();
  delete process.env.RSH_LOCAL_ASSISTANT_OPENROUTER_API_KEY;
  delete process.env.RSH_MONITOR_REMOTE_TOKEN;
  const sessionsDir = join(dataDir, "sessions");
  retention = new RetentionController(() => [{path: sessionsDir, kind: "sessions"}, {path: join(dataDir, "logs"), kind: "logs"}], () => ({protectedPaths: [runtime?.recordingFile()].filter((path): path is string => Boolean(path))}));
  retention.start();
  const spend = config.hosted ? new HostedSpend(config.hosted.capUsd, Math.min(...config.hosted.models.map(model => reservationUsd(model, promptTokenBound([]))))) : undefined;
  const hosted = config.hosted && spend ? new HostedChatClient(config.hosted, spend, record => runtime!.recordSettlement(record)) : undefined;
  runtime = new HarnessRuntime(config, sessionsDir, new ChatRouter(config, new ChatClient(config), hosted), monitor.getClient,
    state => pushState(window?.webContents, state), message => pushToast(window?.webContents, message),
    {spend, startMonitor: monitor.start, settings: () => settings.view()});
  installIpc({
    monitorSettings: () => settings.view(),
    ...monitorSetupHandlers(settings, monitor, () => runtime!.initialize()),
    clearMonitorSettings: async () => {if (runtime!.recordsBusy()) throw new Error("records_busy"); settings.clear(); monitor.clear(); await runtime!.initialize();},
    exportPath: async fileName => {const result = await dialog.showSaveDialog({defaultPath: fileName, filters: [{name: "JSON", extensions: ["json"]}]}); return result.canceled ? undefined : result.filePath;},
    recordsInfo: () => ({...recordsInfo("computer", process.env, false, true), hosted: Boolean(config.hosted)}),
    deleteRecords: async () => {await runtime!.prepareRecordDeletion(); if (runtime!.recordsBusy()) throw new Error("records_busy"); runtime!.rotateRecording(); return retention!.deleteAll();},
    setConversationModel: runtime.setConversationModel, dismissJudgeNotice: runtime.dismissJudgeNotice,
    sendMessage: runtime.sendMessage, newConversation: runtime.newConversation,
    restartMonitor: runtime.restartMonitor, reconnectMonitor: runtime.reconnectMonitor, getState: runtime.getState,
    openDevTools: async () => {window?.webContents.openDevTools({mode: "detach"});},
    isTrusted: event => Boolean(window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame),
  });
  const createWindow = () => {
    window = new BrowserWindow({width: 1360, height: 920, minWidth: 980, minHeight: 680, title: "Sospio chat", backgroundColor: "#101418",
      webPreferences: {preload: join(__dirname, "../preload/index.cjs"), contextIsolation: true, nodeIntegration: false}});
    window.on("closed", () => {window = undefined;});
    if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    else void window.loadFile(join(__dirname, "../renderer/index.html"));
  };
  createWindow(); await runtime.initialize();
  app.on("activate", () => {if (!window) createWindow();});
});
app.on("before-quit", () => {retention?.close(); runtime?.dispose();});
app.on("window-all-closed", () => {if (process.platform !== "darwin") app.quit();});
