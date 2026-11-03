import type { HarnessState, GovernorActionRecord } from "../../shared/types";
import { DEMO_FIXTURE_STATES } from "./demoStates";
export function exportFixture(): HarnessState {
  const detail = { category: "unavailable" as const, band: null,
    ladder: {acting_tier: 0}, monitoring_unavailable: true, evidence: {current: null, counter: null}, text: {tier1: "notice", observation: "note", tier3: "final"}};
  const judge_ladder = {schema: "judge_ladder_verdict_v1" as const, pooled_version: "sospio_remote_notices_v1", arm: "browser" as const,
    turn_ordinal: 1, signals: {overreliance_signals: detail, sycophancy: detail}, acting_signals: [], pooled: [],};
  const state = structuredClone(DEMO_FIXTURE_STATES.tier_1_notice);
  const record = state.turns[0];
  record.turn.user_prompt = "question"; record.turn.assistant_text = "answer";
  record.verdict!.judge_ladder = judge_ladder;
  const base = record.governorActions![0];
  const actions: GovernorActionRecord[] = [1,2,3,4].map(tier => ({...base, action_id: `action-${tier}`, tier: tier as 1|2|3|4,
    policy_mode: tier === 1 ? "manual_demo" : "live",
    executions: [{mechanism: tier === 4 ? "terminate_exchange" : "display_governor_notice", timing: "retroactive", status: "applied", detail: "fixture"},
      ...(tier === 2 || tier === 3 ? [{mechanism: "augment_request_context", timing: "next_turn" as const, status: "armed" as const, detail: "fixture"}] : [])],
    original_candidate_text: "answer", presented_text: `${tier === 4 ? "closing" : `notice-${tier}`}\n\nanswer`,
    ...(tier === 2 || tier === 3 ? {context_additions: [`note-${tier}`]} : {}),
    ...(tier === 4 ? {state_at_termination: {mechanism: "terminate_exchange" as const, closed_to_further_turns: true, transcript_preserved: true, verified_at: "now", countdown_seconds: 10, enforcement: "browser_composer_disabled_after_countdown" as const}} : {}),
  }));
  actions.push({...base, action_id: "pooled", tier: null, executions: [], pooled_notice: {kind: "uncertainty_notice", signal: "sycophancy", cited: [], text: "pooled notice"}, presented_text: "pooled notice"});
  record.governorActions = actions;
  return state;
}
