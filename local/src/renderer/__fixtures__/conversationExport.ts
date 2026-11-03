import type { HarnessState, LocalInterventionReceipt } from "../../shared/types";
export function exportFixture(): HarnessState {
  const detail = {category: "unavailable" as const, band: null,
    ladder: {acting_tier: 0},
    monitoring_unavailable: true, evidence: {current: null, counter: null}, text: {tier1: "notice", observation: "note", tier3: "final"}};
  const judge_ladder = {schema: "judge_ladder_verdict_v1" as const, pooled_version: "pooled_fixture", arm: "orchestrator" as const,
    turn_ordinal: 1, signals: {overreliance_signals: detail, sycophancy: detail}, acting_signals: [], pooled: []};
  const receipts: LocalInterventionReceipt[] = [1, 2, 3, 4].map((tier, i) => ({
    schema_version: "rsh_local_intervention_receipt_v2", receipt_id: `receipt-${i}`, turn_id: "turn-1", plan_id: "plan", policy_version: "policy", authority_profile_id: "local",
    created_at: "2026-09-26T00:00:01.000Z", user_visible: true, tier: tier as 1|2|3|4, plan_source: i === 0 ? "rehearsal_fixture" : "live_verdict",
    executions: [{mechanism: tier === 4 ? "terminate_exchange" : tier === 1 ? "display_governor_notice" : "augment_request_context", stage: tier === 4 ? "session" : tier === 1 ? "candidate" : "request", status: "completed", detail: "fixture"}],
    ...(tier === 2 || tier === 3 ? {context_additions: [`note-${tier}`]} : {original_candidate_text: "answer", presented_text: `${tier === 4 ? "closing" : "notice"}\n\nanswer`}),
  }));
  receipts.push({...receipts[0], receipt_id: "pooled", tier: null, pooled_notice: {kind: "uncertainty_notice", signal: "sycophancy", cited: [], text: "pooled notice"}, presented_text: "pooled notice"});
  return {sessionId: "session", turnHistory: "complete", monitorHealth: "healthy", monitorIdentity: "Sospio remote monitor",
    messages: [{id: "user", role: "user", content: "question", created_at: "now"}, {id: "assistant", role: "assistant", content: "answer", created_at: "now"}],
    turns: [{turn: {turn_id: "turn-1", session_id: "session", provider: "local", chat_provider: "openrouter", chat_model: "fixture-model", user_prompt: "question", assistant_text: "answer", started_at: "2026-09-26T00:00:00.000Z", completed_at: "2026-09-26T00:00:01.000Z", request_url: "private-path"}, monitorStatus: "ready",
      verdict: {turn_id: "turn-1", schema_version: "fixture", signals: [], monitor_version: "fixture", latency_ms: 1, judge_ladder}, interventionReceipts: receipts}],
    diagnostics: [], isGenerating: false, modelState: {chatModel: "fixture-model", monitorModel: "fixture", ollamaUrl: "private-url", ollamaHealth: "healthy", chatModelPresent: true, monitorModelPresent: true, modelWarmth: "warm"},
    termination: {session_id: "session", terminated_at: "2026-09-26T00:00:02.000Z", governing_turn_id: "turn-1", tier_reason: "fixture", notice: "closing", plan_source: "live_verdict"}};
}
