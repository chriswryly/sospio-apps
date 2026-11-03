import type {
  GovernorActionExecution,
  GovernorActionRecord,
  HarnessState,
  InterventionTier,
  MonitorSignal,
  MonitorVerdict,
  ProviderName,
  TurnEvent,
  TurnRecord,
} from "../../shared/types";

export type DemoFixtureName =
  | "no_verdict"
  | "one_funded_signal"
  | "both_funded_observed_no_action"
  | "tier_1_notice"
  | "tier_2_dual_disclosure"
  | "tier_3_dual_observation"
  | "tier_4_capped"
  | "tier_4_closed"
  | "tier_4_not_closed"
  | "tier_4_unverified"
  | "replaced_and_withheld"
  | "monitor_error"
  | "pre_delivery_only"
  | "run_allowlist_excluded";

export const DEMO_FIXTURE_STATES: Record<DemoFixtureName, HarnessState> = {
  no_verdict: state([turnRecord("no-verdict")]),
  one_funded_signal: state([
    turnRecord("one-signal", {
      verdict: verdict("one-signal", [
        signal("sycophancy", "ai_system", true, 0.7, 0.82),
      ]),
      monitorStatus: "ready",
    }),
  ]),
  both_funded_observed_no_action: state([
    turnRecord("both-observed", {
      verdict: verdict("both-observed", [
        signal("sycophancy", "ai_system", true, 0.7, 0.85),
        signal("overreliance_signals", "user", true, 0.7, 0.8),
      ]),
      monitorStatus: "ready",
    }),
  ]),
  tier_1_notice: actedState("tier-1", 1, [
    execution("display_governor_notice", "retroactive", "applied"),
  ], {
    presented_text: "Sospio flagged a possible concern in this response. Review it before relying on it.",
  }),
  tier_2_dual_disclosure: actedState("tier-2", 2, [
    execution("display_governor_notice", "retroactive", "applied"),
    execution("augment_request_context", "next_turn", "armed"),
  ], {
    context_additions: ["Treat unverified claims as unconfirmed and preserve the user's original request."],
    presented_text: "Sospio flagged a possible concern in this response. Review it before relying on it.",
  }),
  tier_3_dual_observation: actedState("tier-3", 3, [
    execution("display_governor_notice", "retroactive", "applied"),
    execution("augment_request_context", "next_turn", "armed"),
  ], {
    presented_text: "Sospio observation: the possible concern noted on earlier turns is still present. If it continues, Sospio may close this conversation. You can hide this notice and continue.",
    context_additions: ["Sospio observation (not the user's words): a possible concern noted on earlier turns is still present in this message. If it continues, Sospio may close this conversation."],
    arm_capability_limit: { arm: "browser", status: "available" },
  }),
  tier_4_capped: actedState("tier-4-capped", 3, [
    execution("terminate_exchange", "retroactive", "capability_capped", "max_tier_by_arm"),
  ], {
    arm_capability_limit: {
      arm: "browser", status: "capability_capped", requested_tier: 4,
      selected_tier: 3, max_tier: 3, unavailable_tiers: [], reason: "max_tier_by_arm",
    },
  }),
  tier_4_closed: terminatedState("tier-4-closed", true, true),
  tier_4_not_closed: terminatedState("tier-4-not-closed", false, true),
  tier_4_unverified: terminatedState("tier-4-unverified", "unverified", "unverified"),
  replaced_and_withheld: actedState("replaced-withheld", 2, [
    execution("replace_presentation", "retroactive", "applied"),
    execution("withhold_candidate", "pre_delivery_only", "pre_delivery_only", "manual demo armed before delivery"),
  ], {
    original_candidate_text: "Original candidate text that remains available for audit.",
    presented_text: "The original candidate presentation was replaced by Sospio.",
  }),
  monitor_error: state([
    turnRecord("monitor-error", {
      verdict: monitorErrorVerdict("monitor-error"),
      monitorStatus: "error",
    }),
  ], {
    monitorHealth: "error",
    monitorLastError: "Ollama is not reachable at http://127.0.0.1:11434",
  }),
  // A Tier 2 the run's mechanism allowlist cut down to nothing. The receipt exists precisely so
  // the surface can say why the governor fired and nothing happened.
  run_allowlist_excluded: actedState("allowlist-excluded", 2, [
    execution("display_governor_notice", "retroactive", "not_permitted", "not in this run's mechanism allowlist"),
    execution("augment_request_context", "next_turn", "not_permitted", "not in this run's mechanism allowlist"),
  ]),
  pre_delivery_only: actedState("pre-delivery-only", 1, [
    execution("withhold_candidate", "pre_delivery_only", "pre_delivery_only", "requires a decision before delivery"),
  ]),
};

function state(
  turns: TurnRecord[],
  patch: Partial<HarnessState> = {},
): HarnessState {
  return {
    provider: "chatgpt",
    monitorHealth: "healthy",
    monitorIdentity: "Sospio remote monitor",
    governorLoopEnabled: true,
    governorAllowedMechanisms: null,
    turns,
    diagnostics: [],
    ...patch,
  };
}

function actedState(
  id: string,
  tier: InterventionTier,
  executions: GovernorActionExecution[],
  actionPatch: Partial<GovernorActionRecord> = {},
): HarnessState {
  const record = turnRecord(id, {
    verdict: verdict(id, [
      signal("sycophancy", "ai_system", true, 0.7, 0.83),
      signal("overreliance_signals", "user", true, 0.7, 0.81),
      signal("harmful_content", "ai_system", true, 0.3, 0.9),
    ], {
      tier,
      tier_reason: "persistence",
      selected_mechanisms: executions.map((item) => item.mechanism),
      arm_capability_limit: {
        arm: "orchestrator",
        status: "available",
        requested_tier: tier,
        selected_tier: tier,
        max_tier: 4,
        unavailable_tiers: [],
      },
    }),
    monitorStatus: "ready",
  });
  return state([
    {
      ...record,
      governorActions: [action(id, tier, executions, actionPatch)],
    },
  ]);
}

function terminatedState(
  id: string,
  closed_to_further_turns: true | false | "unverified",
  transcript_preserved: true | false | "unverified",
): HarnessState {
  return actedState(id, 4, [
    {
      ...execution("terminate_exchange", "retroactive", "applied"),
      observed: {
        closed_to_further_turns,
        transcript_preserved,
        verified_at: closed_to_further_turns === "unverified" ? null : "2026-09-05T00:00:00.000Z",
      },
    },
  ], {
    state_at_termination: {
      mechanism: "terminate_exchange",
      closed_to_further_turns,
      transcript_preserved,
      verified_at: closed_to_further_turns === "unverified" ? null : "2026-09-05T00:00:00.000Z",
      countdown_seconds: 10,
      enforcement: "browser_composer_disabled_after_countdown",
    },
    presented_text: "Sospio is closing this conversation. The transcript will remain readable.",
  });
}

function turnRecord(
  id: string,
  patch: Partial<TurnRecord> = {},
): TurnRecord {
  return {
    turn: turn(id),
    monitorStatus: "queued",
    ...patch,
  };
}

function turn(id: string, provider: ProviderName = "chatgpt"): TurnEvent {
  return {
    turn_id: id,
    session_id: "demo-fixture-session",
    provider,
    user_prompt: `User prompt for ${id}`,
    assistant_text: `Assistant response for ${id}`,
    started_at: "2026-09-05T00:00:00.000Z",
    completed_at: "2026-09-05T00:00:05.000Z",
    request_url: "https://chatgpt.com/backend-api/conversation",
  };
}

function verdict(
  turn_id: string,
  signals: MonitorSignal[],
  patch: Partial<MonitorVerdict> = {},
): MonitorVerdict {
  return {
    turn_id,
    schema_version: "resilience_monitor_v1",
    signals,
    monitor_version: "Sospio remote monitor",
    latency_ms: 1200,
    monitor_status: "primary",
    tier: 1,
    tier_reason: "condition_inactive",
    selected_mechanisms: [],
    arm_capability_limit: {
      arm: "orchestrator",
      status: "available",
      requested_tier: 1,
      selected_tier: 1,
      max_tier: 4,
      unavailable_tiers: [],
    },
    // The remote monitor's default intervention profile: fast path enabled at the 0.9 cut.
    // Errored verdicts carry no rule at all.
    fast_path: { enabled: true, pressure_threshold: 0.9, target_tier: 3 },
    prior_window: [{ role: "user", content: "Earlier user context" }],
    monitor_profile_id: "quiet",
    monitor_profile_version: "quiet_v1",
    intervention_profile_id: "observe_first",
    intervention_profile_version: "observe_first_v1",
    policy_mode: "m0_ladder",
    ...patch,
  };
}

function monitorErrorVerdict(turn_id: string): MonitorVerdict {
  return {
    turn_id,
    schema_version: "resilience_monitor_v1",
    signals: [],
    monitor_version: "Sospio remote monitor",
    latency_ms: 1200,
    monitor_status: "error",
    prior_window: [{ role: "user", content: "Earlier user context" }],
    // A real message from the default local monitor rather than a placeholder: the point of the
    // fixture is that the surface passes the monitor's own words through, and a generic string
    // cannot show that.
    error: "Ollama is not reachable at http://127.0.0.1:11434",
  };
}

function signal(
  name: string,
  channel: MonitorSignal["channel"],
  fired: boolean,
  intensity: number | null,
  confidence: number,
): MonitorSignal {
  return {
    name,
    channel,
    fired,
    intensity,
    confidence,
    rationale: `${name} fixture rationale`,
  };
}

function action(
  turn_id: string,
  tier: InterventionTier | null,
  executions: GovernorActionExecution[],
  patch: Partial<GovernorActionRecord> = {},
): GovernorActionRecord {
  return {
    schema_version: "rsh_browser_governor_action_v3",
    action_id: `action-${turn_id}`,
    turn_id,
    provider: "chatgpt",
    policy_version: "browser_policy_adapter_v1",
    authority_profile_id: "browser_governor_surface_v1",
    observed_at: "2026-09-05T00:00:06.000Z",
    monitor_version: "Sospio remote monitor",
    threshold: 0.7,
    tier,
    tier_reason: "persistence",
    monitor_profile_id: "quiet",
    monitor_profile_version: "quiet_v1",
    intervention_profile_id: "observe_first",
    intervention_profile_version: "observe_first_v1",
    policy_mode: "m0_ladder",
    triggering_signals: [
      { name: "sycophancy", confidence: 0.83, intensity: 0.7 },
      { name: "overreliance_signals", confidence: 0.81, intensity: 0.7 },
    ],
    user_visible: executions.some((item) => item.status === "applied"),
    executions,
    original_candidate_text: "Original candidate text that remains available for audit.",
    ...patch,
  };
}

function execution(
  mechanism: string,
  timing: GovernorActionExecution["timing"],
  status: GovernorActionExecution["status"],
  detail = `${mechanism} ${status}`,
): GovernorActionExecution {
  return { mechanism, timing, status, detail };
}
