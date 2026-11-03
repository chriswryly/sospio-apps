import type {
  FastPathRule,
  GovernorActionExecution,
  GovernorActionRecord,
  HarnessState,
  MonitorSignal,
  ParserDiagnostic,
  ProviderName,
  TerminateOutcome,
  TurnRecord,
} from "../shared/types";

export type FundedSignalName = "sycophancy" | "overreliance_signals";
export type CouplingState = "inactive" | "watching" | "selected_not_executed" | "fired" | "unavailable";
export type TierState = "none" | "tier_1" | "tier_2" | "tier_3" | "tier_4" | "capped" | "unknown";
export type ActionSummary = "applied" | "armed_next_turn" | "failed" | "superseded" | "none";
export type TerminationOutcome = "closed" | "not_closed" | "unverified" | "failed" | "not_applicable";
export type SignalPressureBand = "unavailable" | "quiet" | "watch" | "active" | "high";
export type ReceiptSource = "governor" | "manual_demo" | "unknown";
export type FastPathState =
  | "unknown"
  | "disabled"
  | "unreachable_by_construction"
  | "unreachable_under_current_monitor_output"
  | "live";

export type FastPathView = {
  state: FastPathState;
  threshold: number | null;
};

/**
 * The measured cut: the M1 monitor emitted no 0.9
 * intensities across the labeled pass. The "unreachable" reading is attached to this exact
 * threshold and to no other — a rule like ">= 0.9 is unreachable" would be the renderer
 * inventing a result the pass did not produce.
 */
const M1_MEASURED_FAST_PATH_CUT = 0.9;

/** The intensity contract's ceiling. A threshold above it cannot be met by any verdict. */
const MAX_MONITOR_INTENSITY = 1.0;

export type FundedSignalView = {
  name: FundedSignalName;
  label: string;
  channel: "ai_system" | "user";
  intensity: number | "unavailable";
  confidence: number | "unavailable";
  fired: boolean;
  rationale: string;
  ladder?: { known: true; tier: number };
  reading?: string;
  judgeBand?: string | null;
  evidence?: { current: string | null; counter: string | null };
  pressureBand: SignalPressureBand;
};

export type ReceiptSummary = {
  present: boolean;
  source: ReceiptSource;
  actionId?: string;
  policyMode: string;
  tierReason: string;
  monitorProfileId: string;
  interventionProfileId: string;
  userVisible: boolean;
  mechanisms: Array<{
    mechanism: string;
    timing: GovernorActionExecution["timing"];
    status: GovernorActionExecution["status"];
    detail: string;
  }>;
};

export type AuditDetails = {
  priorWindow: Array<{ role: "user" | "assistant"; content: string }>;
  context_additions: string[];
  original_candidate_text?: string;
  presented_text?: string;
  verdictJson?: unknown;
  actionJson: GovernorActionRecord[];
  captureProvenance: {
    turnId: string;
    sessionId: string;
    requestUrl: string;
    completedAt: string;
  };
};

export type DemoTurnView = {
  turnId: string;
  completedAt: string;
  providerLabel: string;
  userExcerpt: string;
  assistantExcerpt: string;
  monitorStatus: TurnRecord["monitorStatus"];
  monitorError: string | null;
  fundedSignals: [FundedSignalView, FundedSignalView];
  nonHeadlineFiredSignals: string[];
  couplingState: CouplingState;
  tierState: TierState;
  ladderRungState: TierState;
  selectedMechanisms: string[];
  tierReason: string;
  actionSummary: ActionSummary;
  terminationOutcome: TerminationOutcome;
  receiptSummary: ReceiptSummary;
  receiptSummaries: ReceiptSummary[];
  auditDetails: AuditDetails;
};

export type DemoRunView = {
  providerLabel: string;
  monitorIdentity: string;
  monitorHealth: HarnessState["monitorHealth"];
  monitorLastError: string | null;
  signalSubset: string[];
  emotionalDependenceMonitored?: boolean;
  dispatchMode: string;
  governorLoopEnabled: boolean;
  allowedMechanisms: string[];
  monitorProfileId: string;
  interventionProfileId: string;
  policyMode: string;
  fastPath: FastPathView;
  orphanReceipts: ReceiptSummary[];
  selectedTurn?: DemoTurnView;
  turns: DemoTurnView[];
  diagnostics: ParserDiagnostic[];
};

const FUNDED_SIGNAL_DEFS = [
  { name: "sycophancy", label: "Sycophancy", channel: "ai_system" },
  { name: "overreliance_signals", label: "Overreliance", channel: "user" },
] as const;

export function buildDemoRunView(
  state: HarnessState,
  selectedTurnId: string | null = null,
): DemoRunView {
  const turns = state.turns.map((record) => buildDemoTurnView(record));
  const selectedTurn =
    turns.find((turn) => turn.turnId === selectedTurnId) ??
    turns.at(-1);
  const profile = profileSource(state, selectedTurn);
  return {
    providerLabel: providerLabel(state.provider),
    monitorIdentity: state.monitorIdentity ?? "unknown monitor",
    monitorHealth: state.monitorHealth,
    monitorLastError: trimmedOrNull(state.monitorLastError),
    signalSubset: [],
    emotionalDependenceMonitored: state.emotionalDependenceMonitored,
    dispatchMode: "unknown",
    governorLoopEnabled: state.governorLoopEnabled ?? false,
    allowedMechanisms: state.governorAllowedMechanisms ?? [],
    monitorProfileId: profile.monitorProfileId,
    interventionProfileId: profile.interventionProfileId,
    policyMode: profile.policyMode,
    fastPath: fastPathView(fastPathRule(state, selectedTurn)),
    orphanReceipts: (state.orphanGovernorActions ?? []).map((action) => receiptSummary(action)),
    selectedTurn,
    turns,
    diagnostics: state.diagnostics,
  };
}

export function buildDemoTurnView(record: TurnRecord): DemoTurnView {
  const actions = record.governorActions ?? [];
  const action = headlineAction(actions);
  const fundedSignals = FUNDED_SIGNAL_DEFS.map((definition) =>
    fundedSignalView(record.verdict?.signals ?? [], definition)
  ) as [FundedSignalView, FundedSignalView];
  for (const signal of fundedSignals) {
    const detail = record.verdict?.judge_ladder?.signals[signal.name];
    if (detail) {
      signal.ladder = { known: true, tier: detail.ladder.acting_tier };
      signal.reading = detail.monitoring_unavailable ? "monitoring_unavailable" : detail.category === "unjudged" ? "not_covered" : detail.category;
      signal.evidence = detail.evidence;
      signal.judgeBand = detail.band;
    }
  }
  return {
    turnId: record.turn.turn_id,
    completedAt: record.turn.completed_at,
    providerLabel: providerLabel(record.turn.provider),
    userExcerpt: record.turn.user_prompt,
    assistantExcerpt: record.turn.assistant_text,
    monitorStatus: record.monitorStatus,
    monitorError: monitorError(record),
    fundedSignals,
    nonHeadlineFiredSignals: nonHeadlineFiredSignals(record.verdict?.signals ?? []),
    couplingState: couplingState(record, fundedSignals, action),
    tierState: tierState(record, action),
    ladderRungState: ladderRungState(record),
    selectedMechanisms: selectedMechanisms(record),
    tierReason: action?.tier_reason ?? record.verdict?.tier_reason ?? "unknown",
    actionSummary: actionSummary(action),
    terminationOutcome: terminationOutcome(actions),
    receiptSummary: receiptSummary(action),
    receiptSummaries: actions.map((item) => receiptSummary(item)),
    auditDetails: {
      priorWindow: record.verdict?.prior_window ?? [],
      context_additions: actions.flatMap((item) => item.context_additions ?? []),
      original_candidate_text: latestDefined(actions, "original_candidate_text"),
      presented_text: latestDefined(actions, "presented_text"),
      verdictJson: record.verdict,
      actionJson: actions,
      captureProvenance: {
        turnId: record.turn.turn_id,
        sessionId: record.turn.session_id,
        requestUrl: record.turn.request_url,
        completedAt: record.turn.completed_at,
      },
    },
  };
}

export function providerLabel(provider: ProviderName | undefined): string {
  if (provider === "chatgpt") return "ChatGPT";
  if (provider === "claudeai") return "Claude";
  if (provider === "grok") return "Grok";
  if (provider === "piai") return "Pi.ai";
  return "No provider";
}

export function outcomeLabel(outcome: TerminationOutcome): string {
  if (outcome === "closed") return "closed";
  if (outcome === "not_closed") return "not closed";
  if (outcome === "unverified") return "unverified";
  if (outcome === "failed") return "failed";
  return "not applicable";
}

function fundedSignalView(
  signals: MonitorSignal[],
  definition: (typeof FUNDED_SIGNAL_DEFS)[number],
): FundedSignalView {
  const signal = signals.find((item) => item.name === definition.name && item.channel === definition.channel) ??
    signals.find((item) => item.name === definition.name);
  const intensity = typeof signal?.intensity === "number" ? signal.intensity : "unavailable";
  return {
    name: definition.name,
    label: definition.label,
    channel: definition.channel,
    intensity,
    confidence: typeof signal?.confidence === "number" ? signal.confidence : "unavailable",
    fired: signal?.fired === true,
    rationale: signal?.rationale ?? "unavailable",
    pressureBand: pressureBand(intensity),
  };
}

function pressureBand(intensity: number | "unavailable"): SignalPressureBand {
  if (intensity === "unavailable") return "unavailable";
  if (intensity <= 0) return "quiet";
  if (intensity < 0.5) return "watch";
  if (intensity < 0.9) return "active";
  return "high";
}

function nonHeadlineFiredSignals(signals: MonitorSignal[]): string[] {
  return signals
    .filter((signal) =>
      signal.fired &&
      !FUNDED_SIGNAL_DEFS.some((definition) =>
        definition.name === signal.name && definition.channel === signal.channel
      )
    )
    .map((signal) => signal.name);
}

function monitorError(record: TurnRecord): string | null {
  if (record.monitorStatus !== "error") {
    return null;
  }
  return trimmedOrNull(record.verdict?.error);
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function couplingState(
  record: TurnRecord,
  fundedSignals: [FundedSignalView, FundedSignalView],
  action: GovernorActionRecord | undefined,
): CouplingState {
  if (!record.verdict || record.monitorStatus === "error") {
    return "unavailable";
  }
  const hasFundedObservation = fundedSignals.some((signal) =>
    signal.intensity !== "unavailable" || signal.confidence !== "unavailable"
  );
  if (!hasFundedObservation) {
    return "unavailable";
  }
  const anyFundedFired = fundedSignals.some((signal) => signal.fired);
  const receiptBacked = Boolean(action && typeof action.tier === "number" && action.executions.length > 0);
  if (anyFundedFired && receiptBacked) {
    return "fired";
  }
  if (anyFundedFired && selectedMechanisms(record).length > 0) {
    return "selected_not_executed";
  }
  if (anyFundedFired) {
    return "watching";
  }
  return "inactive";
}

function tierState(
  record: TurnRecord,
  action: GovernorActionRecord | undefined,
): TierState {
  if (action?.arm_capability_limit?.status === "capability_capped") {
    return "capped";
  }
  if (action?.tier === null) {
    return "unknown";
  }
  const tier = action?.tier;
  if (tier !== undefined) {
    return `tier_${tier}` as TierState;
  }
  if (selectedMechanisms(record).length === 0) {
    return "none";
  }
  const verdictTier = record.verdict?.tier;
  if (verdictTier === undefined) {
    return "unknown";
  }
  return `tier_${verdictTier}` as TierState;
}

function ladderRungState(record: TurnRecord): TierState {
  const tier = record.verdict?.tier;
  if (tier === undefined) {
    return "none";
  }
  return `tier_${tier}` as TierState;
}

function selectedMechanisms(record: TurnRecord): string[] {
  return record.verdict?.selected_mechanisms ?? [];
}

function actionSummary(action: GovernorActionRecord | undefined): ActionSummary {
  const executions = action?.executions ?? [];
  if (executions.length === 0) return "none";
  if (executions.some((execution) => execution.status === "failed")) return "failed";
  if (executions.some((execution) => execution.status === "applied")) return "applied";
  if (executions.some((execution) => execution.status === "armed")) return "armed_next_turn";
  if (executions.some((execution) => execution.status === "superseded")) return "superseded";
  return "none";
}

/**
 * Read across every receipt on the turn, latest first, not just the headline one.
 *
 * The headline is pinned to the governor action so a later manual receipt cannot hide it. That
 * makes this the one metric that must look wider: a manual `terminate_exchange` on a turn the
 * governor had already acted on is a termination that happened, and reading only the headline
 * reported it as "not applicable".
 */
function terminationOutcome(actions: GovernorActionRecord[]): TerminationOutcome {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    const terminationExecution = action?.executions.find(
      (execution) => execution.mechanism === "terminate_exchange",
    );
    if (!action || !terminationExecution) {
      continue;
    }
    if (terminationExecution.status === "failed") {
      return "failed";
    }
    const value = action.state_at_termination?.closed_to_further_turns ??
      terminationExecution.observed?.closed_to_further_turns ??
      "unverified";
    return terminationOutcomeFromValue(value);
  }
  return "not_applicable";
}

function terminationOutcomeFromValue(value: TerminateOutcome): TerminationOutcome {
  if (value === true) return "closed";
  if (value === false) return "not_closed";
  return "unverified";
}

function receiptSummary(action: GovernorActionRecord | undefined): ReceiptSummary {
  if (!action) {
    return {
      present: false,
      source: "unknown",
      policyMode: "unknown",
      tierReason: "unknown",
      monitorProfileId: "unknown",
      interventionProfileId: "unknown",
      userVisible: false,
      mechanisms: [],
    };
  }
  return {
    present: true,
    source: receiptSource(action),
    actionId: action.action_id,
    policyMode: action.policy_mode,
    tierReason: action.tier_reason,
    monitorProfileId: action.monitor_profile_id ?? "unknown",
    interventionProfileId: action.intervention_profile_id ?? "unknown",
    userVisible: action.user_visible,
    mechanisms: action.executions.map((execution) => ({
      mechanism: execution.mechanism,
      timing: execution.timing,
      status: execution.status,
      detail: execution.detail,
    })),
  };
}

function fastPathView(rule: FastPathRule | undefined): FastPathView {
  if (!rule) {
    return { state: "unknown", threshold: null };
  }
  const threshold = typeof rule.pressure_threshold === "number" ? rule.pressure_threshold : null;
  if (!rule.enabled) {
    return { state: "disabled", threshold };
  }
  // Arithmetic, not a finding: the intensity contract is bounded at 1.0, and
  // FAST_PATH_DISABLED_INTENSITY sits above it precisely so the rung cannot be reached.
  // Without this an enabled-at-2.0 rule would render as "live".
  if (threshold !== null && threshold > MAX_MONITOR_INTENSITY) {
    return { state: "unreachable_by_construction", threshold };
  }
  if (threshold === M1_MEASURED_FAST_PATH_CUT) {
    return { state: "unreachable_under_current_monitor_output", threshold };
  }
  return { state: "live", threshold };
}

/** The rule the run is operating under: the selected turn's verdict, else the most recent one. */
function fastPathRule(
  state: HarnessState,
  selectedTurn: DemoTurnView | undefined,
): FastPathRule | undefined {
  const selected = state.turns.find(
    (record) => record.turn.turn_id === selectedTurn?.turnId,
  )?.verdict?.fast_path;
  if (selected) {
    return selected;
  }
  for (let index = state.turns.length - 1; index >= 0; index -= 1) {
    const rule = state.turns[index]?.verdict?.fast_path;
    if (rule) {
      return rule;
    }
  }
  return undefined;
}

function receiptSource(action: GovernorActionRecord): ReceiptSource {
  if (action.policy_mode === "manual_demo_intervention" || action.tier_reason === "manual_demo_button") {
    return "manual_demo";
  }
  return "governor";
}

function headlineAction(actions: GovernorActionRecord[]): GovernorActionRecord | undefined {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    if (action && !action.pooled_notice && receiptSource(action) === "governor") {
      return action;
    }
  }
  return actions.at(-1);
}

function profileSource(
  state: HarnessState,
  selectedTurn: DemoTurnView | undefined,
): { monitorProfileId: string; interventionProfileId: string; policyMode: string } {
  const selectedAction = selectedTurn ? headlineAction(selectedTurn.auditDetails.actionJson) : undefined;
  if (selectedAction) {
    return {
      monitorProfileId: selectedAction.monitor_profile_id ?? "unknown",
      interventionProfileId: selectedAction.intervention_profile_id ?? "unknown",
      policyMode: selectedAction.policy_mode,
    };
  }
  for (let index = state.turns.length - 1; index >= 0; index -= 1) {
    const record = state.turns[index];
    const action = record?.governorActions?.at(-1);
    if (action) {
      return {
        monitorProfileId: action.monitor_profile_id ?? "unknown",
        interventionProfileId: action.intervention_profile_id ?? "unknown",
        policyMode: action.policy_mode,
      };
    }
    const verdict = record?.verdict;
    if (verdict?.monitor_profile_id || verdict?.intervention_profile_id || verdict?.policy_mode) {
      return {
        monitorProfileId: verdict.monitor_profile_id ?? "unknown",
        interventionProfileId: verdict.intervention_profile_id ?? "unknown",
        policyMode: verdict.policy_mode ?? "unknown",
      };
    }
  }
  return {
    monitorProfileId: "unknown",
    interventionProfileId: "unknown",
    policyMode: "unknown",
  };
}

function latestDefined<K extends "original_candidate_text" | "presented_text">(
  actions: GovernorActionRecord[],
  key: K,
): GovernorActionRecord[K] | undefined {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const value = actions[index]?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

/** Cockpit-only selectors preserve the full recorded values behind the demo projection. */
export function cockpitVerdict(turn: DemoTurnView): import('../shared/types').MonitorVerdict | undefined {
  return turn.auditDetails.verdictJson as import('../shared/types').MonitorVerdict | undefined;
}
export function cockpitActions(turn: DemoTurnView): GovernorActionRecord[] {return turn.auditDetails.actionJson;}
export function cockpitOrdinal(run: DemoRunView, turn: DemoTurnView): number {
  const sameSession=run.turns.filter(t=>t.auditDetails.captureProvenance.sessionId===turn.auditDetails.captureProvenance.sessionId);
  if (!sameSession.some(t => cockpitVerdict(t)?.judge_ladder)) return sameSession.indexOf(turn) + 1;
  const judged = cockpitVerdict(turn)?.judge_ladder?.turn_ordinal;
  if (judged !== undefined) return judged;
  // Fractional slots are ordering keys only: they never appear as citation numbers.
  const index = sameSession.indexOf(turn);
  const prior = sameSession.slice(0, index).reverse().find(t => cockpitVerdict(t)?.judge_ladder);
  const base = prior ? cockpitVerdict(prior)!.judge_ladder!.turn_ordinal : 0;
  const group = sameSession.filter((t, i) => !cockpitVerdict(t)?.judge_ladder &&
    (sameSession.slice(0, i).reverse().find(x => cockpitVerdict(x)?.judge_ladder) === prior));
  return base + (group.indexOf(turn) + 1) / (group.length + 1);
}
