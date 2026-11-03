import { emotionalNoticeTexts } from "../shared/emotionalDependencePrivacy";
import { isHostedModel } from "./config";
import type { HostedSpendRecord } from "./hostedSpend";
import type { ChatProvider } from "../shared/types";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ConversationMessage,
  HarnessState,
  LocalDiagnostic,
  LocalInterventionReceipt,
  ModelState,
  MonitorVerdict,
  SessionTermination,
  TurnEvent,
  TurnRecord,
} from "../shared/types";

type PersistedRecord =
  | HostedSpendRecord
  | { record_type: "conversation_state"; session_id: string; messages: ConversationMessage[]; chat_model?: string; chat_provider?: ChatProvider }
  | { record_type: "turn_event"; turn: TurnEvent }
  | { record_type: "intervention_receipt"; receipt: LocalInterventionReceipt }
  | { record_type: "verdict"; verdict: MonitorVerdict }
  | { record_type: "diagnostic"; diagnostic: LocalDiagnostic }
  | { record_type: "session_boundary"; session_id: string; timestamp: string }
  | { record_type: "session_termination"; termination: SessionTermination };

export class ConversationStore {
  sessionFile: string;
  sessionId: string = randomUUID();
  private messages: ConversationMessage[] = [];
  private turns: TurnRecord[] = [];
  private diagnostics: LocalDiagnostic[] = [];
  private state: Omit<HarnessState, "messages" | "turns" | "diagnostics" | "sessionId">;
  private restoredModel?: string;
  private restoredProvider?: ChatProvider;
  private defaultModel: string;
  private restoredTermination?: SessionTermination;
  private privateNotices: string[] = [];
  private turnHistory: "complete" | "partial" = "complete";

  constructor(private sessionsDir: string, initialModelState: ModelState) {
    this.defaultModel = initialModelState.chatModel;
    {
      mkdirSync(sessionsDir, { recursive: true });
      this.restoreLatestConversation();
    }
    if (!this.messages.length && (this.restoredProvider === "openrouter" || isHostedModel(this.restoredModel ?? ""))) {
      this.restoredModel = undefined;
      this.restoredProvider = undefined;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.sessionFile = join(sessionsDir, `${stamp}.jsonl`);
    this.state = {
      monitorHealth: "starting",
      isGenerating: false,
      modelState: {...initialModelState, chatModel: this.restoredModel??initialModelState.chatModel,
        ...((this.restoredProvider === "openrouter" || isHostedModel(this.restoredModel ?? "")) ? {chatProvider: "openrouter" as const} : {})},
      ...(this.restoredTermination ? { termination: this.restoredTermination } : {}),
    };
    this.persistConversationState();
    if (this.restoredTermination) {
      // Carry the closed state into the new file, or the next relaunch, which
      // reads only the latest file, would reopen the exchange.
      this.append({ record_type: "session_termination", termination: this.restoredTermination });
    }
  }

  setConversationModel(name:string):void {
    if(this.messages.length)throw new Error("The model is fixed after the first message.");
    if(!name.trim())throw new Error("Invalid model name");
    const {chatProvider: _oldProvider, ...modelState} = this.state.modelState;
    this.state.modelState = modelState;
    this.setModelState({chatModel:name,chatModelDigest:undefined,chatModelPresent:false,modelWarmth:'cold',
      ...(isHostedModel(name) ? {chatProvider: 'openrouter' as const} : {})});
    this.persistConversationState();
  }

  getMessages(): ConversationMessage[] {
    return [...this.messages];
  }

  getRecentMessages(limit: number): ConversationMessage[] {
    return this.messages.slice(-Math.max(limit, 1));
  }

  appendUser(content: string, turnId?: string): ConversationMessage {
    const message = { ...this.message("user", content), ...(turnId ? {turn_id: turnId} : {}) };
    this.messages.push(message);
    this.persistConversationState();
    return message;
  }

  beginAssistant(turnId?: string): ConversationMessage {
    const message = { ...this.message("assistant", ""), ...(turnId ? {turn_id: turnId} : {}), streaming: true };
    this.messages.push(message);
    this.persistConversationState();
    return message;
  }

  updateAssistant(id: string, content: string): void {
    this.messages = this.messages.map((message) =>
      message.id === id ? { ...message, content, streaming: true } : message
    );
  }

  finalizeAssistant(id: string, content: string): void {
    const sharingOmissions: Array<{start: number; end: number}> = [];
    for (const notice of new Set(this.privateNotices)) {
      for (let start = content.indexOf(notice); start >= 0; start = content.indexOf(notice, start + notice.length)) {
        sharingOmissions.push({start, end: start + notice.length});
      }
    }
    this.messages = this.messages.map((message) =>
      message.id === id ? { ...message, content, streaming: false,
        ...(sharingOmissions.length ? {sharingOmissions} : {}) } : message
    );
    this.persistConversationState();
  }

  /**
   * End a turn that failed before the model produced output.
   *
   * The reason is shown in place of a response, but is marked so it is rendered
   * as an error and kept out of the persisted transcript. Previously the error
   * text was finalized as ordinary assistant content, so it survived restarts
   * and read as something the model had said.
   */
  finalizeAssistantFailure(id: string, reason: string): void {
    this.messages = this.messages.map((message) =>
      message.id === id ? { ...message, content: reason, streaming: false, failed: true } : message
    );
    this.persistConversationState();
  }

  addTurn(turn: TurnEvent, monitorStatus: TurnRecord["monitorStatus"] = "queued"): void {
    turn={...turn,chat_model:turn.chat_model??this.state.modelState.chatModel,chat_provider:turn.chat_provider??this.chatProvider()};
    this.turns.push({ turn, monitorStatus });
    this.append({ record_type: "turn_event", turn });
  }

  markPending(turnId: string): void {
    this.updateTurn(turnId, { monitorStatus: "pending" });
  }

  addInterventionReceipt(turnId: string, receipt: LocalInterventionReceipt): void {
    const turn = this.turns.find(record => record.turn.turn_id === turnId)?.turn;
    receipt={...receipt,chat_model:turn?.chat_model??receipt.chat_model??this.state.modelState.chatModel,
      chat_provider:turn?.chat_provider??receipt.chat_provider??this.chatProvider(),
      ...(turn?.hosted_chat ? {hosted_chat: turn.hosted_chat} : {}),
    };
    const existing = this.turns.find((record) => record.turn.turn_id === turnId)?.interventionReceipts ?? [];
    this.updateTurn(turnId, { interventionReceipts: [...existing, receipt] });
    this.append({ record_type: "intervention_receipt", receipt });
  }

  addVerdict(verdict: MonitorVerdict): void {
    if (this.turns.some(r => r.turn.turn_id === verdict.turn_id && r.turn.session_id === this.sessionId)) {
      this.privateNotices.push(...emotionalNoticeTexts(verdict));
    }
    this.updateTurn(verdict.turn_id, {
      verdict,
      monitorStatus: verdict.monitor_status === "error" ? "error" : "ready",
    });
    this.append({ record_type: "verdict", verdict });
  }

  addDiagnostic(kind: LocalDiagnostic["kind"], reason: string): void {
    const diagnostic = {
      id: randomUUID(),
      kind,
      reason,
      timestamp: new Date().toISOString(),
    };
    this.diagnostics.push(diagnostic);
    this.append({ record_type: "diagnostic", diagnostic });
  }

  setRuntimeState(state: Partial<Omit<HarnessState, "messages" | "turns" | "diagnostics" | "sessionId">>): void {
    this.state = { ...this.state, ...state };
  }

  /** Tier 4. Recorded in the session log so a closed exchange is auditable. */
  setTermination(termination: SessionTermination): void {
    const scoped = { ...termination, session_id: this.sessionId };
    this.state = { ...this.state, termination: scoped };
    this.append({ record_type: "session_termination", termination: scoped });
  }

  setModelState(modelState: Partial<ModelState>): void {
    this.state = {
      ...this.state,
      modelState: { ...this.state.modelState, ...modelState },
    };
  }

  rotateRecording(): void {
    this.sessionFile = join(this.sessionsDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.jsonl`);
    this.diagnostics = [];
    this.newConversation();
  }

  newConversation(): void {
    this.sessionId = randomUUID();
    this.messages = [];
    this.turns = [];
    this.privateNotices = [];
    this.turnHistory = "complete";
    // Termination closes one conversation; New conversation is its exit. The
    // session_termination record already in the log is kept.
    const { termination: _closed, ladder: _ladder, dismissedJudgeNotices: _dismissed, ...rest } = this.state;
    this.state = {...rest, isGenerating: false};
    // Preserve ordinary local-only behavior; hosted sessions always leave New conversation on local.
    this.append({ record_type: "session_boundary", session_id: this.sessionId, timestamp: new Date().toISOString() });
    if (this.chatProvider() === "openrouter") this.setConversationModel(this.defaultModel);
    this.persistConversationState();
  }

  getState(): HarnessState {
    return {
      ...this.state,
      sessionId: this.sessionId,
      turnHistory: this.turnHistory,
      messages: [...this.messages],
      turns: [...this.turns],
      diagnostics: [...this.diagnostics],
    };
  }

  private message(role: ConversationMessage["role"], content: string): ConversationMessage {
    return {
      id: randomUUID(),
      role,
      content,
      created_at: new Date().toISOString(),
    };
  }

  private updateTurn(turnId: string, patch: Partial<TurnRecord>): void {
    const index = this.turns.findIndex((record) => record.turn.turn_id === turnId);
    if (index >= 0) {
      this.turns[index] = { ...this.turns[index], ...patch };
    }
  }

  private persistConversationState(): void {
    this.append({
      record_type: "conversation_state",
      session_id: this.sessionId,
      // Failed turns are harness errors, not conversation. They stay on screen
      // for the session and are recorded as diagnostics; persisting them would
      // restore them as transcript on the next launch.
      chat_model: this.state.modelState.chatModel,
      chat_provider: this.chatProvider(),
      messages: this.messages.filter((message) => !message.failed),
    });
  }

  chatProvider(): ChatProvider {
    return this.state.modelState.chatProvider ?? (isHostedModel(this.state.modelState.chatModel) ? "openrouter" : "ollama");
  }

  addHostedSpend(record: HostedSpendRecord): void { this.append(record); }

  private append(record: PersistedRecord): void {
    appendFileSync(this.sessionFile, `${JSON.stringify(record)}\n`, "utf8");
  }

  private restoreLatestConversation(): void {
    const latest = latestSessionFile(this.sessionsDir);
    if (!latest) {
      return;
    }
    const terminated = new Map<string, SessionTermination>();
    try {
      // The session in effect while scanning, so a termination record written
      // before records carried session_id is attributed to its own session.
      let inEffect: string | undefined;
      for (const line of readFileSync(latest, "utf8").split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        const record = JSON.parse(line) as Partial<PersistedRecord>;
        if (record.record_type === "conversation_state" && Array.isArray(record.messages)) {
          this.sessionId = typeof record.session_id === "string" ? record.session_id : this.sessionId;
          this.messages = record.messages;
          this.restoredModel = record.chat_model;
          this.restoredProvider = record.chat_provider;
          inEffect = this.sessionId;
        } else if (record.record_type === "session_boundary" && typeof record.session_id === "string") {
          inEffect = record.session_id;
        } else if (record.record_type === "session_termination" && record.termination) {
          const owner = record.termination.session_id ?? inEffect;
          if (owner) terminated.set(owner, { ...record.termination, session_id: owner });
        }
      }
    } catch {
      this.messages = [];
      return;
    }
    // The transcript comes back without its turn records.
    if (this.messages.length > 0) this.turnHistory = "partial";
    // Stay closed: a terminated conversation reopens terminated, and only New
    // conversation leaves it.
    this.restoredTermination = terminated.get(this.sessionId);
  }
}

function latestSessionFile(sessionsDir: string): string | null {
  if (!existsSync(sessionsDir)) {
    return null;
  }
  const files = readdirSync(sessionsDir)
    .filter((name) => /^\d{4}-.*\.jsonl$/.test(name))
    .sort();
  const latest = files.at(-1);
  return latest ? join(sessionsDir, latest) : null;
}
