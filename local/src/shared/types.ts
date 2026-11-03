export type ChatProvider = "ollama" | "openrouter";
export type ChatModelChoice = { provider: ChatProvider; name: string; label?: string; vendor?: string };
export type HostedUsage = {
  generation_id?: string;
  upstream_provider?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  reported_cost_usd?: number;
};
export type HostedChatMetadata = HostedUsage & {
  settled_usd: number;
  basis: "reported_cost" | "token_prices" | "reservation";
};
export type HostedSpendState = { cap_usd: number; spent_usd: number; exhausted: boolean };

export type JudgeSignal = "overreliance_signals" | "sycophancy" | "emotional_dependence";
export type PooledNotice = {
  kind: "uncertainty_notice" | "check_in" | "suppressed";
  signal: JudgeSignal;
  cited: Array<{ ordinal: number; excerpt: string }>;
  text: string;
};
export type JudgeSignalDetail = {
  latency_ms?: number | null;
  category: "absent" | "positive" | "uncertain" | "unavailable" | "unjudged" | "not_monitored";
  band: "absent" | "emergent" | "present" | "strong" | null;
  ladder: { acting_tier: number; notice_seen_before?: boolean; notice_seen_after?: boolean };
  monitoring_unavailable: boolean;
  /** The judge's own reason when category is unavailable, e.g. budget_exhausted at the per-launch cap. */
  unavailable_reason?: string | null;
  evidence: { current: string | null; counter: string | null };
  text: { tier1: string; observation: string; tier3: string };
};
export type JudgeLadderVerdict = {
  schema: "judge_ladder_verdict_v1";
  pooled_version: string;
  arm: "browser" | "orchestrator";
  turn_ordinal: number;
  signals: Record<string, JudgeSignalDetail> &
    Record<Exclude<JudgeSignal, "emotional_dependence">, JudgeSignalDetail>;
  acting_signals: JudgeSignal[];
  pooled: PooledNotice[];
};

export type ProviderName = "local";

export type LocalInterventionMechanism =
  | "augment_request_context"
  | "display_governor_notice"
  | "withhold_candidate"
  | "visibly_redact_candidate"
  | "replace_presentation"
  // Tier 4. Acts on the session after delivery, never on the delivered message,
  // which is why it has its own stage.
  | "terminate_exchange";

export type LocalInterventionStage = "request" | "candidate" | "session";

/**
 * Where a plan came from. A rehearsal plan and a live one must never be
 * indistinguishable in a receipt, a log, or the surface.
 */
export type LocalInterventionPlanSource = "rehearsal_fixture" | "live_verdict";

export type LocalInterventionExecution = {
  mechanism: LocalInterventionMechanism;
  stage: LocalInterventionStage;
  // "superseded" preserves requested plan steps that lost terminal presentation precedence.
  status: "completed" | "superseded";
  detail: string;
  superseded_by?: LocalInterventionMechanism;
};

export type InterventionTier = 1 | 2 | 3 | 4;

/** Why a scored turn produced no intervention. Silent on screen, not in the log. */
export type NoInterventionReason =
  | "monitor_unavailable"
  | "no_ladder_decision"
  | "no_applicable_mechanisms"
  /** The notice utility assessed the turn and showed no notice. */
  | "utility_no_notice"
  /**
   * A ladder decision landed after a later turn had started. A Tier 1-3 plan
   * governs only its governing turn's successor, so this one governs nothing.
   */
  | "superseded_by_later_turn"
  /** The exchange was already closed by Tier 4; the decision is recorded, not applied. */
  | "session_terminated";

export type LocalInterventionReceipt = {
  chat_model?: string;
  chat_provider?: ChatProvider;
  hosted_chat?: HostedChatMetadata;
  // v1 receipts stay readable; everything written from now on is v2.
  schema_version: "rsh_local_intervention_receipt_v1" | "rsh_local_intervention_receipt_v2";
  receipt_id: string;
  turn_id: string;
  plan_id: string;
  policy_version: string;
  authority_profile_id: string;
  created_at: string;
  user_visible: boolean;
  tier?: InterventionTier | null;
  pooled_notice?: PooledNotice;
  tier_reason?: string;
  /**
   * The turn whose verdict produced this plan — never the turn the plan was
   * applied to. They differ by one by construction: the orchestrator emits
   * before it monitors, so a verdict on turn N governs turn N+1.
   */
  governing_turn_id?: string;
  plan_source?: LocalInterventionPlanSource;
  no_intervention_reason?: NoInterventionReason;
  /** Set when the notice utility produced a notice for this turn. */
  utility_notice_id?: string;
  executions: LocalInterventionExecution[];
  context_additions?: string[];
  original_candidate_text?: string;
  presented_text?: string;
};

export type ToolCall = {
  id?: string;
  name?: string;
  arguments?: unknown;
  result?: unknown;
};

export type ChatRole = "system" | "user" | "assistant" | "governor";

export type ConversationMessage = {
  /** Offsets of local-only notice text in this presentation; omitted when sharing. */
  sharingOmissions?: Array<{start: number; end: number}>;
  turn_id?: string;
  id: string;
  role: Exclude<ChatRole, "system">;
  content: string;
  created_at: string;
  streaming?: boolean;
  /**
   * The turn failed before the model produced anything; `content` is a harness
   * error, not model output. Failed messages are shown as errors and are NOT
   * persisted into `conversation_state`, so a transient failure cannot become
   * part of the transcript on the next restart.
   */
  failed?: boolean;
};

export type TurnEvent = {
  chat_model?: string;
  chat_provider?: ChatProvider;
  hosted_chat?: HostedChatMetadata;
  turn_id: string;
  session_id: string;
  provider: ProviderName;
  user_prompt: string;
  assistant_text: string;
  started_at: string;
  completed_at: string;
  request_url: string;
  system_prompt?: string | null;
  tool_calls?: ToolCall[];
  /**
   * Set when generation failed. `assistant_text` is empty in that case rather
   * than carrying the error, so nothing downstream reads a harness failure as
   * something the model said.
   */
  error?: string;
};

export type MonitorSignal = {
  name: string;
  channel: "ai_system" | "user" | "environment";
  fired: boolean;
  confidence: number | null;
  intensity?: number | null;
  rationale: string;
};

export type MonitorHealth = {
  ok: boolean;
  monitor?: string;
  status?: "disabled" | "primary" | "baseline" | "fallback" | "error";
  last_error?: string | null;
};

export type VerdictIntervention = {
  tier: InterventionTier;
  tier_reason: string;
  selected_mechanisms: string[];
};

export type MonitorVerdict = {
  judge_ladder?: JudgeLadderVerdict;
  /** Observation only: never an intensity or permission to escalate. */
  monitor_utility?: { schema: string; decision: "P" | "N" | "U"; authority: "notice_only"; [key: string]: unknown };
  utility_notice?: { notice_id: string; text: string; dismissible: boolean } | null;
  turn_id: string;
  schema_version: string;
  signals: MonitorSignal[];
  monitor_version: string;
  latency_ms?: number;
  monitor_status?: "primary" | "baseline" | "fallback" | "error";
  tier?: InterventionTier;
  tier_reason?: string;
  selected_mechanisms?: string[];
  /** Derived from the flat fields above by `normalizeVerdict`; never sent. */
  intervention?: VerdictIntervention;
  error?: string;
};

export type TurnRecord = {
  turn: TurnEvent;
  verdict?: MonitorVerdict;
  interventionReceipts?: LocalInterventionReceipt[];
  monitorStatus: "queued" | "pending" | "ready" | "error" | "bypassed";
};

export type LocalDiagnostic = {
  id: string;
  kind: "info" | "warning" | "error";
  reason: string;
  timestamp: string;
};

export type ModelState = {
  chatProvider?: ChatProvider;
  chatModel: string;
  chatModelDigest?: string;
  monitorModel: string;
  ollamaUrl: string;
  ollamaHealth: "checking" | "healthy" | "missing" | "error";
  chatModelPresent: boolean;
  monitorModelPresent: boolean;
  modelWarmth: "cold" | "warming" | "warm" | "error";
  lastTokenRate?: number;
};

export type HarnessState = {
  monitorSetup?: {url: string; configured: boolean};
  monitorRemote?: boolean;
  monitorLastError?: string | null;
  sessionId: string;
  hostedSpend?: HostedSpendState;
  chatModels?: ChatModelChoice[];
  dismissedJudgeNotices?: string[];
  monitorHealth: "starting" | "healthy" | "fallback" | "error" | "bypassed";
  monitorIdentity?: string;
  /** Set only when the launch monitors emotional dependence, so the cockpit can show its row before a first reading. */
  emotionalDependenceMonitored?: boolean;
  messages: ConversationMessage[];
  turns: TurnRecord[];
  diagnostics: LocalDiagnostic[];
  isGenerating: boolean;
  setupMessage?: string;
  termination?: SessionTermination;
  /** The ladder decision actually in force for the next turn, not the last one seen. */
  ladder?: LadderState;
  /**
   * "partial" when the conversation was restored on relaunch: its transcript is
   * back but its earlier turn records are not, so turn ordinals cannot be known.
   */
  turnHistory?: "complete" | "partial";
  modelState: ModelState;
};

export type LadderState =
  | {
      status: "held";
      tier: InterventionTier;
      tier_reason: string;
      governing_turn_id: string;
      mechanisms: string[];
    }
  | {
      status: "none";
      reason: NoInterventionReason | "no_verdict_yet" | "consumed" | "shown_on_turn" | "terminated";
      turn_id?: string;
    }
  /** The rehearsal override is on; live decisions are not applied. */
  | { status: "override" };

/** Tier 4's end-of-exchange state. Delivered turns stay delivered. */
export type SessionTermination = {
  /** Absent on records written before termination was scoped to a session. */
  session_id?: string;
  terminated_at: string;
  governing_turn_id: string;
  tier_reason: string;
  notice: string;
  plan_source: LocalInterventionPlanSource;
};

export const problemReportCategories = ["missed_sycophancy", "missed_overreliance", "false_positive", "other"] as const;
export type ProblemReportCategory = typeof problemReportCategories[number];
export type ProblemReportRequest = {
  client_report_id: string;
  session_id: string;
  reported_turn_id?: string | null;
  categories: ProblemReportCategory[];
  note: string | null;
};
export type ProblemReportResult = { report_id: string; reported_at: string; complete: boolean };

export type HarnessApi = {
  monitorSettings?(): Promise<{url: string; configured: boolean}>;
  saveMonitorSettings?(value: {url: string; token: string}): Promise<void>;
  clearMonitorSettings?(): Promise<void>;
  reportProblem?(request: ProblemReportRequest): Promise<ProblemReportResult>;
  saveExport(fileName: string, contents: string): Promise<boolean>;
  recordsInfo?(): Promise<import("../../../records/disclosure").RecordsInfo>;
  deleteRecords?(): Promise<string>;
  setConversationModel(name: string): Promise<void>;
  dismissJudgeNotice(turnId: string, signal: JudgeSignal): Promise<void>;
  sendMessage(message: string): Promise<void>;
  newConversation(): Promise<void>;
  openDevTools(): Promise<void>;
  restartMonitor(): Promise<void>;
  reconnectMonitor(): Promise<void>;
  getState(): Promise<HarnessState>;
  onState(callback: (state: HarnessState) => void): () => void;
  onToast(callback: (message: string) => void): () => void;
};
