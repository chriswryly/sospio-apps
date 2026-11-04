export type JudgeSignal = "overreliance_signals" | "sycophancy" | "emotional_dependence";
export type PooledNotice = {
  kind: "uncertainty_notice" | "check_in" | "suppressed";
  signal: JudgeSignal;
  cited: Array<{ ordinal: number; excerpt: string }>;
  text: string;
};
export type JudgeSignalDetail = {
  category: "absent" | "positive" | "uncertain" | "unavailable" | "unjudged" | "not_monitored";
  band: "absent" | "emergent" | "present" | "strong" | null;
  ladder: { acting_tier: number; notice_seen_before?: boolean; notice_seen_after?: boolean };
  monitoring_unavailable: boolean;
  /** The judge's own reason when category is unavailable, e.g. budget_exhausted at the per-launch cap. */
  unavailable_reason?: string | null;
  evidence: { current: string | null; counter: string | null };
  text: { tier1: string; observation: string; tier3: string };
};
export type MonitorNoticesVerdict = {
  schema: "judge_ladder_verdict_v1";
  pooled_version: string;
  arm: "browser" | "orchestrator";
  turn_ordinal: number;
  signals: Record<Exclude<JudgeSignal, "emotional_dependence">, JudgeSignalDetail> & Partial<Record<"emotional_dependence", JudgeSignalDetail>>;
  acting_signals: JudgeSignal[];
  pooled: PooledNotice[];
};

export type ProviderName = "chatgpt" | "claudeai" | "grok" | "piai";

export type MediationProviderName = Extract<ProviderName, "chatgpt" | "claudeai">;

export function supportsMediation(provider: ProviderName | undefined): provider is MediationProviderName {
  return provider === "chatgpt" || provider === "claudeai";
}

export type CapabilityProbeMechanism =
  | "turn_capture"
  | "display_governor_notice"
  | "withhold_candidate"
  | "replace_presentation"
  | "pause_request"
  | "augment_request_context";

export type GovernorMechanism =
  | "display_governor_notice"
  | "withhold_candidate"
  | "replace_presentation"
  | "pause_request"
  | "augment_request_context"
  | "terminate_exchange";

export type CapabilityProbeRecord = {
  schema_version: "browser_capability_probe_v2";
  profile_id: "browser_output_mediation_v2";
  probe_id: string;
  provider: ProviderName;
  provider_surface_version: string;
  mechanism: CapabilityProbeMechanism;
  status: "armed" | "demonstrated" | "failed";
  observed_at: string;
  evidence_scope:
    | "browser_window_boundary"
    | "provider_turn_capture"
    | "page_response_intercept"
    | "cdp_fetch_request_boundary"
    | "cdp_fetch_response_boundary";
  detail: string;
};

export type TurnEvent = {
  turn_id: string;
  session_id: string;
  provider: ProviderName;
  user_prompt: string;
  assistant_text: string;
  started_at: string;
  completed_at: string;
  request_url: string;
  /** Where `session_id` came from. `turn_id_fallback` means no conversation ID was found. */
  session_source?: SessionSource;
};

export type SessionSource = "network_response" | "display_body" | "request_hint" | "turn_id_fallback";

export type NetworkTag = {
  tag_id: string;
  provider: ProviderName;
  url_origin: string;
  url_pathname: string;
  phase: "started" | "finished" | "failed";
  occurred_at: string;
  request_id: string;
};

export type MonitorSignal = {
  name: string;
  channel: "ai_system" | "user" | "environment";
  fired: boolean;
  confidence: number | null;
  intensity?: number | null;
  rationale: string;
};

export type InterventionTier = 1 | 2 | 3 | 4;

export type ArmCapabilityLimit = {
  arm?: string;
  status: "available" | "capability_capped";
  reason?: string;
  requested_tier?: InterventionTier | number;
  selected_tier?: InterventionTier | number;
  max_tier?: number;
  unavailable_tiers?: number[];
};

export type FastPathRule = {
  enabled: boolean;
  pressure_threshold: number;
  target_tier?: number | null;
};

export type MonitorHealth = {
  ok: boolean;
  monitor?: string;
  status?: "disabled" | "primary" | "error";
  last_error?: string | null;
};

export type MonitorVerdict = {
  judge_ladder?: MonitorNoticesVerdict;
  /** Observation only: never an intensity or permission to escalate. */
  monitor_utility?: { schema: string; decision: "P" | "N" | "U"; authority: "notice_only"; [key: string]: unknown };
  utility_notice?: { notice_id: string; text: string; dismissible: boolean } | null;
  turn_id: string;
  schema_version: string;
  signals: MonitorSignal[];
  monitor_version: string;
  latency_ms: number;
  prior_window?: Array<{ role: "user" | "assistant"; content: string }>;
  monitor_status?: "primary" | "error";
  error?: string;
  tier?: InterventionTier;
  tier_reason?: string;
  selected_mechanisms?: string[];
  arm_capability_limit?: ArmCapabilityLimit;
  monitor_profile_id?: string;
  monitor_profile_version?: string;
  intervention_profile_id?: string;
  intervention_profile_version?: string;
  policy_mode?: string;
  fast_path?: FastPathRule;
};

export type TurnRecord = {
  turn: TurnEvent;
  verdict?: MonitorVerdict;
  monitorStatus: "queued" | "pending" | "ready" | "error";
  governorActions?: GovernorActionRecord[];
};

export type ParserDiagnostic = {
  id: string;
  kind: "captured" | "skipped" | "parse_error" | "loading_failed" | "measurement";
  provider?: ProviderName;
  requestId?: string;
  /** Stable, enum-like. Dedup keys and windows compare on this, so do not interpolate data. */
  reason: string;
  /**
   * Structure-only annotation: JSON key paths and value types, never values. Set when a request
   * envelope could not be parsed, so a provider format change is diagnosable from the record.
   */
  body_shape?: string;
  request_path?: string;
  timestamp: string;
};

/**
 * An outcome the harness observed, or `"unverified"` when it could not look.
 * Deliberately outside the boolean domain: a receipt with no way to say "I do
 * not know" will say "true" instead, which is what the first Tier 4
 * implementation did.
 */
export type TerminateOutcome = boolean | "unverified";

export type GovernorArmOutcome = {
  actionId: string;
  mechanism: "pause_request" | "augment_request_context";
  status: "applied" | "failed";
  detail: string;
  updatedAt: string;
};

export type GovernorActionExecution = {
  armed_at?: string;
  updated_at?: string;
  mechanism: string;
  timing: "retroactive" | "next_turn" | "pre_delivery_only";
  status:
    | "applied"
    | "armed"
    | "failed"
    | "superseded"
    | "pre_delivery_only"
    | "capability_capped"
    /** Selected by policy, excluded by the run's mechanism allowlist. */
    | "not_permitted";
  detail: string;
  /** Present on `terminate_exchange`: what the page looked like afterwards. */
  observed?: {
    closed_to_further_turns: TerminateOutcome;
    transcript_preserved: TerminateOutcome;
    verified_at: string | null;
  };
  superseded_by?: string;
};

export type GovernorTriggeringSignal = {
  name: string;
  confidence: number | null;
  intensity?: number | null;
};

export type GovernorTerminationState = {
  mechanism: "terminate_exchange";
  // Read back from the page after the countdown, never assumed.
  closed_to_further_turns: TerminateOutcome;
  transcript_preserved: TerminateOutcome;
  verified_at: string | null;
  countdown_seconds: number;
  enforcement: "browser_composer_disabled_after_countdown";
};

/**
 * What the governor actually did in response to one verdict, and what it could not do.
 *
 * Every autonomous intervention emits one of these. An intervention the user cannot audit
 * afterwards is the fidelity gap this project exists to avoid, and unlike the manual capability
 * probes there is no operator watching a governor-driven action happen.
 */
export type GovernorActionRecord = {
  schema_version: "rsh_browser_governor_action_v3";
  action_id: string;
  turn_id: string;
  provider: ProviderName;
  policy_version: string;
  authority_profile_id: string;
  observed_at: string;
  monitor_version: string;
  threshold: number;
  tier: InterventionTier | null;
  pooled_notice?: PooledNotice;
  tier_reason: string;
  monitor_profile_id: string | null;
  monitor_profile_version?: string;
  intervention_profile_id: string | null;
  intervention_profile_version?: string;
  policy_mode: string;
  arm_capability_limit?: ArmCapabilityLimit;
  triggering_signals: GovernorTriggeringSignal[];
  user_visible: boolean;
  executions: GovernorActionExecution[];
  context_additions?: string[];
  original_candidate_text?: string;
  presented_text?: string;
  state_at_termination?: GovernorTerminationState;
};

export type LegacyGovernorActionRecord = Omit<
  GovernorActionRecord,
  | "schema_version"
  | "tier"
  | "tier_reason"
  | "monitor_profile_id"
  | "monitor_profile_version"
  | "intervention_profile_id"
  | "intervention_profile_version"
  | "policy_mode"
  | "arm_capability_limit"
> & {
  schema_version: "rsh_browser_governor_action_v2";
  tier?: InterventionTier;
};

export type HarnessState = {
  monitorConfigured?: boolean;
  monitorUrl?: string;
  monitorRemote?: boolean;
  dismissedJudgeNotices?: string[];
  citedJudgeTurns?: { sessionId: string; ordinals: number[] };
  provider?: ProviderName;
  monitorHealth: "starting" | "healthy" | "error";
  monitorLastError?: string | null;
  monitorIdentity?: string;
  emotionalDependenceMonitored?: boolean;
  governorLoopEnabled?: boolean;
  governorAllowedMechanisms?: GovernorMechanism[] | null;
  turns: TurnRecord[];
  orphanGovernorActions?: GovernorActionRecord[];
  diagnostics: ParserDiagnostic[];
};

export type HarnessApi = {
  claimMonitorToken(value: {url: string; code: string}): Promise<import("../../../shared/types").MonitorClaimResult>;
  saveMonitorSettings(value: {url: string; token: string}): Promise<void>;
  clearMonitorSettings(): Promise<void>;
  saveExport(fileName: string, contents: string): Promise<boolean>;
  recordsInfo?(): Promise<import("../../../records/disclosure").RecordsInfo>;
  deleteRecords?(): Promise<string>;
  dismissJudgeNotice(turnId: string, signal: JudgeSignal): Promise<void>;
  openProvider(provider: ProviderName): Promise<void>;
  reloadChat(): Promise<void>;
  openDevTools(): Promise<void>;
  restartMonitor(): Promise<void>;
  getState(): Promise<HarnessState>;
  onState(callback: (state: HarnessState) => void): () => void;
  onToast(callback: (message: string) => void): () => void;
};
