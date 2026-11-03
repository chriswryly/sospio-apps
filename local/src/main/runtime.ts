import { availableChatModel, type RuntimeConfig } from "./config";
import type { HostedSpend, HostedSpendRecord } from "./hostedSpend";
import type { HarnessState } from "../shared/types";
import type { ChatPort } from "./chatClient";
import { ConversationStore } from "./conversationStore";
import { checkModelReadiness, modelState } from "./modelReadiness";
import type { MonitorClient } from "./monitorClient";
import type { MonitorStatus } from "./remoteMonitor";
import { Orchestrator } from "./orchestrator";

export type RuntimeOptions = {
  spend?: Pick<HostedSpend, "state">;
  startMonitor: () => Promise<MonitorStatus>;
  settings: () => {url: string; configured: boolean};
};
export class HarnessRuntime {
  private store: ConversationStore;
  private orchestrator: Orchestrator;
  constructor(private config: RuntimeConfig, sessionsDir: string, private chat: ChatPort,
    private monitorSource: () => MonitorClient | undefined, private emit: (state: HarnessState) => void,
    private toast: (message: string) => void, private options: RuntimeOptions) {
    this.store = new ConversationStore(sessionsDir, modelState(config, "checking", false, "cold"));
    this.store.setRuntimeState({monitorRemote: true});
    this.orchestrator = new Orchestrator(config, this.store, chat, monitorSource, this.emitState);
  }
  getState = (): HarnessState => ({...this.store.getState(), monitorSetup: this.options.settings(),
    emotionalDependenceMonitored: process.env.RSH_EMOTIONAL_DEPENDENCE?.trim() !== "0", chatModels: this.config.chatModels,
    ...(this.options.spend ? {hostedSpend: this.options.spend.state()} : {})});
  private emitState = (): void => this.emit(this.getState());
  recordingFile = () => this.store.sessionFile;
  recordsBusy = () => this.orchestrator.hasPendingWrites();
  prepareRecordDeletion = () => this.orchestrator.prepareRecordDeletion();
  rotateRecording = (): void => {this.store.rotateRecording(); this.orchestrator.resetSession(); this.emitState();};
  dispose = (): void => this.orchestrator.dispose();
  recordSettlement = (record: HostedSpendRecord): void => {this.store.addHostedSpend(record); this.emitState();};
  initialize = async (): Promise<void> => {
    this.emitState();
    if (!this.options.settings().configured) return;
    await this.startMonitor();
    if (!(await this.refreshReadiness())) return;
    this.store.setModelState({modelWarmth: "warming"}); this.emitState();
    try {await this.chat.prewarm(this.store.getState().modelState.chatModel); this.store.setModelState({modelWarmth: "warm"});}
    catch {this.store.setModelState({modelWarmth: "error"}); this.store.addDiagnostic("warning", "model pre-warm failed");}
    this.emitState();
  };
  private refreshReadiness = async (): Promise<boolean> => {
    const selected = this.store.getState().modelState;
    const readiness = await checkModelReadiness({...this.config, chatModel: selected.chatModel}, this.options.spend?.state(), selected.chatProvider);
    if (this.store.getState().modelState.chatModel !== selected.chatModel) return false;
    this.store.setRuntimeState({setupMessage: readiness.setupMessage, modelState: readiness.modelState});
    this.emitState(); return readiness.ok;
  };
  private startMonitor = async (): Promise<void> => {
    this.store.setRuntimeState({monitorHealth: "starting", monitorLastError: null}); this.emitState();
    try {
      const status = await this.options.startMonitor();
      this.store.setRuntimeState({monitorHealth: "healthy", monitorIdentity: status.monitor});
    } catch (error) {
      const message = error instanceof Error ? error.message : "Monitor unavailable";
      this.store.setRuntimeState({monitorHealth: "error", monitorLastError: message}); this.toast(message);
    }
    this.emitState();
  };
  setConversationModel = async (name: string): Promise<void> => {
    if (!availableChatModel(this.config, name)) throw new Error("Unknown model");
    this.store.setConversationModel(name); await this.refreshReadiness();
  };
  dismissJudgeNotice = async (turnId: string, signal: string): Promise<void> => {
    const record = this.store.getState().turns.find(item => item.turn.turn_id === turnId);
    const monitor = this.monitorSource();
    if (!record?.verdict?.judge_ladder || record.turn.session_id !== this.store.sessionId || !monitor) throw new Error("notice unavailable");
    await monitor.dismiss(record.turn.session_id, signal);
    const ids = this.store.getState().turns.filter(item => item.turn.session_id === record.turn.session_id).map(item => item.turn.turn_id + ":" + signal);
    this.store.setRuntimeState({dismissedJudgeNotices: [...(this.store.getState().dismissedJudgeNotices ?? []), ...ids]}); this.emitState();
  };
  sendMessage = async (message: string): Promise<void> => {
    if (!this.options.settings().configured) throw new Error("Enter your Sospio monitor token");
    await this.orchestrator.handleUserMessage(message);
  };
  newConversation = async (): Promise<void> => {
    if (this.store.getState().isGenerating) throw new Error("chat_busy");
    this.store.newConversation(); if (this.config.hosted) this.store.setConversationModel(this.config.chatModel);
    this.orchestrator.resetSession(); await this.refreshReadiness(); this.emitState();
  };
  restartMonitor = async (): Promise<void> => this.initialize();
  reconnectMonitor = async (): Promise<void> => {
    const client = this.monitorSource();
    if (!client) return this.initialize();
    try {
      const health = await client.reconnect();
      this.store.setRuntimeState({monitorHealth: health.status === "disabled" || health.status === "error" ? "error" : health.status === "fallback" ? "fallback" : "healthy", monitorIdentity: health.monitor});
    } catch (error) {this.store.setRuntimeState({monitorHealth: "error", monitorLastError: error instanceof Error ? error.message : "Monitor unavailable"});}
    this.emitState();
  };
}
