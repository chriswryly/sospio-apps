import { describe, expect, it } from "vitest";
import { buildDemoRunView, buildDemoTurnView } from "./demoViewModel";
import { DEMO_FIXTURE_STATES } from "./__fixtures__/demoStates";
import type { GovernorActionRecord, HarnessState, MonitorSignal, MonitorVerdict, TurnEvent } from "../shared/types";

describe("Sospio demo view model", () => {
  it("does not render missing intensity as zero pressure", () => {
    const view = buildDemoRunView(stateWithSignals([
      signal("sycophancy", "ai_system", true, undefined, 0.9),
    ])).selectedTurn;

    expect(view?.fundedSignals[0].intensity).toBe("unavailable");
    expect(view?.fundedSignals[0].pressureBand).toBe("unavailable");
    expect(view?.fundedSignals[0].confidence).toBe(0.9);
  });

  it("keeps both fired funded signals observation-only until a trigger record supports the action", () => {
    const view = buildDemoRunView(DEMO_FIXTURE_STATES.both_funded_observed_no_action).selectedTurn;

    expect(view?.fundedSignals.map((item) => item.fired)).toEqual([true, true]);
    expect(view?.couplingState).toBe("watching");
    expect(view?.tierState).toBe("none");
    expect(view?.ladderRungState).toBe("tier_1");
    expect(view?.receiptSummary.present).toBe(false);
  });

  it("treats a quiet remote monitor ladder rung as no selected intervention", () => {
    const view = buildDemoTurnView({
      turn: turn("turn-1"),
      monitorStatus: "ready",
      verdict: verdict("turn-1", [
        signal("sycophancy", "ai_system", false, 0, 0.8),
      ]),
    });

    expect(view.ladderRungState).toBe("tier_1");
    expect(view.selectedMechanisms).toEqual([]);
    expect(view.tierState).toBe("none");
    expect(view.couplingState).toBe("inactive");
  });

  it("renders a remote monitor-selected tier without claiming an execution receipt", () => {
    const view = buildDemoTurnView({
      turn: turn("turn-1"),
      monitorStatus: "ready",
      verdict: verdict("turn-1", [
        signal("sycophancy", "ai_system", true, 0.7, 0.9),
      ], {
        tier: 2,
        tier_reason: "persistence",
        selected_mechanisms: ["display_governor_notice"],
      }),
    });

    expect(view.tierState).toBe("tier_2");
    expect(view.couplingState).toBe("selected_not_executed");
    expect(view.receiptSummary.present).toBe(false);
  });

  it("lets an action record win over the verdict ladder rung", () => {
    const view = buildDemoTurnView({
      turn: turn("turn-1"),
      monitorStatus: "ready",
      verdict: verdict("turn-1", [
        signal("sycophancy", "ai_system", true, 0.7, 0.9),
      ]),
      governorActions: [actionRecord("turn-1", 2)],
    });

    expect(view.ladderRungState).toBe("tier_1");
    expect(view.tierState).toBe("tier_2");
    expect(view.couplingState).toBe("fired");
  });

  it("renders a verdict-only browser Tier 3", () => {
    const remoteShaped = buildDemoTurnView({
      turn: turn("turn-1"),
      monitorStatus: "ready",
      verdict: verdict("turn-1", [], {
        tier: 3,
        selected_mechanisms: ["augment_request_context"],
      }),
    });

    expect(remoteShaped.ladderRungState).toBe("tier_3");
    expect(remoteShaped.tierState).toBe("tier_3");
  });

  it("renders executed Tier 3 with both mechanisms", () => {
    const view = buildDemoRunView(DEMO_FIXTURE_STATES.tier_3_dual_observation).selectedTurn;
    expect(view?.tierState).toBe("tier_3");
    expect(view?.receiptSummary.mechanisms).toEqual([
      expect.objectContaining({ mechanism: "display_governor_notice", status: "applied" }),
      expect.objectContaining({ mechanism: "augment_request_context", status: "armed" }),
    ]);
  });

  it("still renders a maximum-tier capability cap", () => {
    const view = buildDemoRunView(DEMO_FIXTURE_STATES.tier_4_capped).selectedTurn;
    expect(view?.tierState).toBe("capped");
    expect(view?.receiptSummary.mechanisms).toContainEqual(expect.objectContaining({
      mechanism: "terminate_exchange", status: "capability_capped",
    }));
  });

  it("keeps non-funded fired signals out of the headline validation lanes", () => {
    const view = buildDemoRunView(DEMO_FIXTURE_STATES.tier_1_notice).selectedTurn;

    expect(view?.fundedSignals.map((item) => item.name)).toEqual(["sycophancy", "overreliance_signals"]);
    expect(view?.nonHeadlineFiredSignals).toEqual(["harmful_content"]);
  });

  it("flows receipt payload fields into audit details without truncation", () => {
    const longContext = "context ".repeat(120);
    const longOriginal = "original ".repeat(120);
    const longPresented = "presented ".repeat(120);
    const action = actionRecord("turn-1", 2, {
      context_additions: [longContext],
      original_candidate_text: longOriginal,
      presented_text: longPresented,
    });
    const view = buildDemoTurnView({
      turn: turn("turn-1"),
      monitorStatus: "ready",
      verdict: verdict("turn-1", []),
      governorActions: [action],
    });

    expect(view.auditDetails.context_additions).toEqual([longContext]);
    expect(view.auditDetails.original_candidate_text).toBe(longOriginal);
    expect(view.auditDetails.presented_text).toBe(longPresented);
  });

  it("renders unverified termination as its own state", () => {
    const view = buildDemoRunView(DEMO_FIXTURE_STATES.tier_4_unverified).selectedTurn;

    expect(view?.terminationOutcome).toBe("unverified");
    expect(view?.terminationOutcome).not.toBe("closed");
  });

  it("renders a failed terminate execution as failed, not unverified", () => {
    const view = buildDemoTurnView({
      turn: turn("turn-1"),
      monitorStatus: "ready",
      verdict: verdict("turn-1", []),
      governorActions: [actionRecord("turn-1", 4, {
        executions: [{
          mechanism: "terminate_exchange",
          timing: "retroactive",
          status: "failed",
          detail: "terminate_exchange failed: composer missing",
        }],
      })],
    });

    expect(view.actionSummary).toBe("failed");
    expect(view.terminationOutcome).toBe("failed");
  });

  it("renders a null action tier as unknown, not Tier 1", () => {
    const action = actionRecord("turn-1", null);
    const view = buildDemoTurnView({
      turn: turn("turn-1"),
      monitorStatus: "ready",
      verdict: verdict("turn-1", []),
      governorActions: [action],
    });

    expect(view.tierState).toBe("unknown");
  });

  it("does not count a manual null-tier receipt as trigger support", () => {
    const action = actionRecord("turn-1", null, {
      tier_reason: "manual_demo_button",
      policy_mode: "manual_demo_intervention",
    });
    const view = buildDemoTurnView({
      turn: turn("turn-1"),
      monitorStatus: "ready",
      verdict: verdict("turn-1", [
        signal("sycophancy", "ai_system", true, 0.7, 0.9),
      ]),
      governorActions: [action],
    });

    expect(view.receiptSummary.source).toBe("manual_demo");
    expect(view.couplingState).toBe("watching");
  });

  it("keeps a governor action as the headline when a later manual receipt is attached", () => {
    const governor = actionRecord("turn-1", 2, {
      action_id: "governor-action",
      executions: [
        {
          mechanism: "display_governor_notice",
          timing: "retroactive",
          status: "applied",
          detail: "notice displayed",
        },
        {
          mechanism: "augment_request_context",
          timing: "next_turn",
          status: "armed",
          detail: "context armed",
        },
      ],
    });
    const manual = actionRecord("turn-1", null, {
      action_id: "manual-action",
      tier_reason: "manual_demo_button",
      policy_mode: "manual_demo_intervention",
    });
    const view = buildDemoTurnView({
      turn: turn("turn-1"),
      monitorStatus: "ready",
      verdict: verdict("turn-1", [
        signal("sycophancy", "ai_system", true, 0.7, 0.9),
      ], {
        tier: 2,
        selected_mechanisms: ["display_governor_notice", "augment_request_context"],
      }),
      governorActions: [governor, manual],
    });

    expect(view.receiptSummary.actionId).toBe("governor-action");
    expect(view.receiptSummary.source).toBe("governor");
    expect(view.tierState).toBe("tier_2");
    expect(view.couplingState).toBe("fired");
    expect(view.receiptSummaries.map((receipt) => receipt.source)).toEqual(["governor", "manual_demo"]);
  });

  it("keeps multiple governor receipts available to the panel", () => {
    const view = buildDemoTurnView({
      turn: turn("turn-1"),
      monitorStatus: "ready",
      verdict: verdict("turn-1", []),
      governorActions: [
        actionRecord("turn-1", 1, { action_id: "governor-action-1" }),
        actionRecord("turn-1", 2, { action_id: "governor-action-2" }),
      ],
    });

    expect(view.receiptSummary.actionId).toBe("governor-action-2");
    expect(view.receiptSummaries.map((receipt) => receipt.actionId)).toEqual([
      "governor-action-1",
      "governor-action-2",
    ]);
  });

  it("uses profile ids from state records and renders missing ids as unknown", () => {
    const known = buildDemoRunView(DEMO_FIXTURE_STATES.tier_2_dual_disclosure);
    const unknown = buildDemoRunView({
      ...DEMO_FIXTURE_STATES.tier_2_dual_disclosure,
      turns: [{
        ...DEMO_FIXTURE_STATES.tier_2_dual_disclosure.turns[0],
        governorActions: [
          actionRecord("tier-2", 2, {
            monitor_profile_id: null,
            intervention_profile_id: null,
          }),
        ],
      }],
    });

    expect(known.monitorProfileId).toBe("quiet");
    expect(known.interventionProfileId).toBe("observe_first");
    expect(unknown.monitorProfileId).toBe("unknown");
    expect(unknown.interventionProfileId).toBe("unknown");
  });

  it("reads the fast-path state from the verdict rather than asserting one", () => {
    const rule = (fast_path: MonitorVerdict["fast_path"]): HarnessState => {
      const base = DEMO_FIXTURE_STATES.tier_1_notice;
      const record = base.turns[0]!;
      return { ...base, turns: [{ ...record, verdict: { ...record.verdict!, fast_path } }] };
    };

    expect(buildDemoRunView(rule({ enabled: true, pressure_threshold: 0.9 })).fastPath)
      .toEqual({ state: "unreachable_under_current_monitor_output", threshold: 0.9 });
    expect(buildDemoRunView(rule({ enabled: false, pressure_threshold: 0.95 })).fastPath)
      .toEqual({ state: "disabled", threshold: 0.95 });
    expect(buildDemoRunView(rule({ enabled: true, pressure_threshold: 0.7 })).fastPath)
      .toEqual({ state: "live", threshold: 0.7 });
    expect(buildDemoRunView(rule(undefined)).fastPath)
      .toEqual({ state: "unknown", threshold: null });
    // FAST_PATH_DISABLED_INTENSITY: enabled, but above the intensity contract's ceiling.
    expect(buildDemoRunView(rule({ enabled: true, pressure_threshold: 2.0 })).fastPath)
      .toEqual({ state: "unreachable_by_construction", threshold: 2.0 });
  });

  it("does not extend the M1 result to cuts the M1 pass did not measure", () => {
    const base = DEMO_FIXTURE_STATES.tier_1_notice;
    const record = base.turns[0]!;
    const above: HarnessState = {
      ...base,
      turns: [{ ...record, verdict: { ...record.verdict!, fast_path: { enabled: true, pressure_threshold: 0.95 } } }],
    };

    expect(buildDemoRunView(above).fastPath.state).toBe("live");
  });

  it("reports a manual termination on a turn whose headline receipt is the governor's", () => {
    const governor = actionRecord("turn-1", 2);
    const manualTerminate = actionRecord("turn-1", null, {
      action_id: "action-manual",
      tier_reason: "manual_demo_button",
      policy_mode: "manual_demo_intervention",
      executions: [{
        mechanism: "terminate_exchange",
        timing: "retroactive",
        status: "applied",
        detail: "manual terminate",
        observed: {
          closed_to_further_turns: true,
          transcript_preserved: "unverified",
          verified_at: "2026-09-05T00:00:10.000Z",
        },
      }],
    });
    const view = buildDemoTurnView({
      turn: turn("turn-1"),
      monitorStatus: "ready",
      verdict: verdict("turn-1", [signal("sycophancy", "ai_system", true, 0.7, 0.9)]),
      governorActions: [governor, manualTerminate],
    });

    // The headline stays the governor's receipt, but the termination that happened is reported.
    expect(view.receiptSummary.source).toBe("governor");
    expect(view.tierState).toBe("tier_2");
    expect(view.terminationOutcome).toBe("closed");
  });

  it("keeps the monitor-error fixture profile-free like the remote monitor error path", () => {
    const view = buildDemoRunView(DEMO_FIXTURE_STATES.monitor_error);

    expect(view.monitorProfileId).toBe("unknown");
    expect(view.interventionProfileId).toBe("unknown");
    expect(view.selectedTurn?.tierState).toBe("none");
  });

  it("reads the fast-path rule the remote monitor records on the verdict", () => {
    expect(buildDemoRunView(DEMO_FIXTURE_STATES.tier_1_notice).fastPath).toEqual({
      state: "unreachable_under_current_monitor_output",
      threshold: 0.9,
    });
  });

  it("surfaces orphan action receipts separately from captured turns", () => {
    const orphan = actionRecord("missing-turn", null, {
      tier_reason: "manual_demo_button",
      policy_mode: "manual_demo_intervention",
    });
    const view = buildDemoRunView({
      provider: "chatgpt",
      monitorHealth: "healthy",
      turns: [],
      orphanGovernorActions: [orphan],
      diagnostics: [],
    });

    expect(view.selectedTurn).toBeUndefined();
    expect(view.orphanReceipts.map((receipt) => receipt.actionId)).toEqual(["action-missing-turn"]);
    expect(view.orphanReceipts[0]?.source).toBe("manual_demo");
  });

  it("carries the monitor's failure reason verbatim, and only on failed turns", () => {
    const failed = buildDemoRunView(DEMO_FIXTURE_STATES.monitor_error);
    const healthy = buildDemoRunView(DEMO_FIXTURE_STATES.tier_1_notice);

    // Verbatim: normalizing it would mean pattern-matching messages that change, and would put
    // the surface's words in the monitor's mouth.
    expect(failed.selectedTurn?.monitorError).toBe("Ollama is not reachable at http://127.0.0.1:11434");
    expect(failed.monitorLastError).toBe("Ollama is not reachable at http://127.0.0.1:11434");
    expect(healthy.selectedTurn?.monitorError).toBeNull();
    expect(healthy.monitorLastError).toBeNull();
  });

  it("treats a blank or absent reason as no reason rather than as empty text", () => {
    // An errored verdict with no `error` is possible; rendering it would put an empty element on
    // the screen and imply the monitor said nothing when the field is simply missing.
    const blank = buildDemoRunView({
      ...DEMO_FIXTURE_STATES.monitor_error,
      monitorLastError: "   ",
      turns: DEMO_FIXTURE_STATES.monitor_error.turns.map((record) => ({
        ...record,
        verdict: record.verdict ? { ...record.verdict, error: "  " } : undefined,
      })),
    });

    expect(blank.selectedTurn?.monitorError).toBeNull();
    expect(blank.monitorLastError).toBeNull();
  });

  it("renders every browser rehearsal fixture into a selected view", () => {
    for (const fixture of Object.values(DEMO_FIXTURE_STATES)) {
      expect(buildDemoRunView(fixture).selectedTurn).toBeDefined();
    }
  });
});

function stateWithSignals(signals: MonitorSignal[]): HarnessState {
  return {
    provider: "chatgpt",
    monitorHealth: "healthy",
    monitorIdentity: "Sospio remote monitor",
    governorLoopEnabled: true,
    governorAllowedMechanisms: null,
    turns: [{
      turn: turn("turn-1"),
      monitorStatus: "ready",
      verdict: verdict("turn-1", signals),
    }],
    diagnostics: [],
  };
}

function turn(turn_id: string): TurnEvent {
  return {
    turn_id,
    session_id: "session-1",
    provider: "chatgpt",
    user_prompt: "user prompt",
    assistant_text: "assistant text",
    started_at: "2026-09-05T00:00:00.000Z",
    completed_at: "2026-09-05T00:00:01.000Z",
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
    latency_ms: 1,
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
      unavailable_tiers: [3],
    },
    ...patch,
  };
}

function signal(
  name: string,
  channel: MonitorSignal["channel"],
  fired: boolean,
  intensity: number | undefined,
  confidence: number,
): MonitorSignal {
  return {
    name,
    channel,
    fired,
    confidence,
    ...(intensity === undefined ? {} : { intensity }),
    rationale: `${name} rationale`,
  };
}

function actionRecord(
  turn_id: string,
  tier: GovernorActionRecord["tier"],
  patch: Partial<GovernorActionRecord> = {},
): GovernorActionRecord {
  return {
    schema_version: "rsh_browser_governor_action_v3",
    action_id: `action-${turn_id}`,
    turn_id,
    provider: "chatgpt",
    policy_version: "browser_policy_adapter_v1",
    authority_profile_id: "browser_governor_surface_v1",
    observed_at: "2026-09-05T00:00:02.000Z",
    monitor_version: "Sospio remote monitor",
    threshold: 0.7,
    tier,
    tier_reason: "persistence",
    monitor_profile_id: "quiet",
    intervention_profile_id: "observe_first",
    policy_mode: "m0_ladder",
    triggering_signals: [],
    user_visible: true,
    executions: [{
      mechanism: "display_governor_notice",
      timing: "retroactive",
      status: "applied",
      detail: "notice displayed",
    }],
    ...patch,
  };
}

import judgeSequence from "../shared/__fixtures__/noticeSequence.json";
import type { TurnRecord } from "../shared/types";

it("maps recorded per-signal acting tiers, uncertainty, and unavailable state", () => {
  const records = judgeSequence.map((v) => ({ turn: { turn_id: v.turn_id, session_id: "s", provider: "chatgpt", completed_at: "now", user_prompt: "u", assistant_text: "a" }, verdict: v as MonitorVerdict, monitorStatus: "ready" }) as TurnRecord);
  expect(buildDemoTurnView(records[0]).fundedSignals[1].ladder).toEqual({ known: true, tier: 1 });
  expect(buildDemoTurnView(records[1]).fundedSignals[1].ladder).toEqual({ known: true, tier: 2 });
  expect(buildDemoTurnView(records[5]).fundedSignals[1].reading).toBe("uncertain");
  expect(buildDemoTurnView(records[11]).fundedSignals[1].reading).toBe("monitoring_unavailable");
  expect(buildDemoTurnView(records[0]).fundedSignals[0].reading).toBe("not_covered");
  expect(buildDemoTurnView({ ...records[0], verdict: undefined }).fundedSignals[0].ladder).toBeUndefined();
});

it("keeps a tier receipt as the headline when a separate pooled notice is also shown", () => {
  const record = DEMO_FIXTURE_STATES.tier_1_notice.turns[0];
  const tierReceipt = record.governorActions![0];
  const pooled = { ...tierReceipt, action_id: "pool", tier: null, executions: [], pooled_notice: (judgeSequence[5] as MonitorVerdict).judge_ladder!.pooled[0] };
  const view = buildDemoTurnView({ ...record, governorActions: [tierReceipt, pooled] });
  expect(view.tierState).toBe(buildDemoTurnView(record).tierState);
  expect(view.receiptSummaries).toHaveLength(2);
});
