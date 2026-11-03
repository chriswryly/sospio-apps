import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { buildConversationExport, browserTranscriptText } from "./conversationExport";
import { exportFixture } from "./__fixtures__/conversationExport";
const meta = {exported_at: "2026-09-26T00:00:00.000Z", surface: "electron" as const, app_version: "0.1.0"};
it("preserves every receipt and judge verdict verbatim, including unavailable readings and source labels", () => {
  const state = exportFixture(), before = JSON.stringify(state);
  const result = buildConversationExport(state, meta);
  expect(JSON.stringify(result.receipts)).toBe(JSON.stringify(state.turns.flatMap(r => r.governorActions ?? [])));
  expect(result.turns[0].judge_ladder).toEqual(state.turns[0].verdict!.judge_ladder);
  expect(Object.keys(result.monitor)).toEqual(["monitorIdentity", "pooled_version"]);
  expect(JSON.stringify(result)).toContain("manual_demo");
  expect(JSON.stringify(state)).toBe(before);
  if (process.env.EXPORT_FIXTURE_DIR) writeFileSync(`${process.env.EXPORT_FIXTURE_DIR}/browser-export.json`, JSON.stringify(result, null, 2));
});
it("excludes other conversations, diagnostics, ports, paths and absent verdicts are explicit", () => {
  const state = exportFixture();
  const old = structuredClone(state.turns[0]); old.turn.session_id = "old"; old.turn.turn_id = "old";
  old.turn.user_prompt = "excluded-question"; state.turns.unshift(old);
  state.diagnostics = [{reason: "private-diagnostic"} as any];
  delete state.turns[1].verdict;
  const result = buildConversationExport(state, meta);
  expect(result.turns).toHaveLength(1); expect(result.turns[0].verdict_present).toBe(false);
  expect(result.turns[0].judge_ladder).toBeNull();
  for (const text of ["excluded-question", "private-diagnostic", "private-path", "private-url", "9876"]) expect(JSON.stringify(result)).not.toContain(text);
});
it.each([1,4])("prints actual tier %s presentation shapes once in order", tier => {
  const state = exportFixture(); state.turns[0].governorActions = state.turns[0].governorActions!.filter(r => r.tier === tier);
  expect(browserTranscriptText(state)).toBe(`You: question\n\nAssistant: answer\n\nSospio: ${tier === 4 ? "closing" : "notice-1"}`);
  state.turns[0].governorActions[0].presented_text = "standalone";
  expect(browserTranscriptText(state)).toContain("Sospio: standalone");
});
it.each([["applied","added"],["armed","queued"],["failed","not added"]] as const)("keeps %s notes at the trigger despite delayed or failed receiving requests", (status, label) => {
  const state = exportFixture(); const trigger = state.turns[0];
  trigger.governorActions = trigger.governorActions!.filter(r => r.tier === 2);
  trigger.governorActions[0].executions[1].status = status;
  for (let i=0; i<3; i++) {const later = structuredClone(trigger); later.governorActions = []; later.turn.turn_id = `later-${i}`; later.turn.user_prompt = `later question ${i}`; state.turns.push(later);}
  const text = browserTranscriptText(state), note = `Sospio (note for your next message, ${label}): note-2`;
  expect(text).toContain(`Assistant: answer\n\nSospio: notice-2\n\n${note}\n\nYou: later question 0`);
  expect(text.split(note)).toHaveLength(2);
  state.turns.at(-1)!.turn.user_prompt += " note-2"; expect(browserTranscriptText(state)).toContain("You: later question 2 note-2");
  state.turns.at(-1)!.turn.session_id = "new-chat"; expect(browserTranscriptText(state)).not.toContain("Sospio");
});
it("omits suppressed pooled events and preserves the old no-action transcript format", () => {
  const state = exportFixture(); const record = state.turns[0];
  record.governorActions = record.governorActions!.filter(r => r.pooled_notice);
  record.governorActions[0].pooled_notice!.kind = "suppressed";
  expect(browserTranscriptText(state)).toBe("You: question\n\nAssistant: answer");
  record.governorActions = []; expect(browserTranscriptText(state)).toBe("You: question\n\nAssistant: answer");
});
it("exports captured turns during an in-flight response and excludes orphan actions", () => {
  const state = exportFixture(); state.orphanGovernorActions = state.turns[0].governorActions;
  state.turns[0].monitorStatus = "pending";
  const result = buildConversationExport(state, meta);
  expect(result.captured_turns_only).toBe(true); expect(result.turns).toHaveLength(1);
  expect(result.scope).toBe("latest_captured_conversation"); expect(result.orphan_actions_excluded).toBe(5);
  expect(result.receipts).toHaveLength(5); expect(result.termination).toHaveLength(1);
  // New chat / a streaming reply has no TurnRecord until capture completes.
  expect(result.session_id).toBe(state.turns[0].turn.session_id);
});

import { emotionalVerdict } from "./__fixtures__/emotionalDependence";
it("strips ED readings, quotes, pooled notices and copied notice text from sharing", () => {
  const state = exportFixture(), record = state.turns[0];
  record.verdict = emotionalVerdict(2);
  const block = record.verdict.judge_ladder!, ed = block.signals.emotional_dependence!;
  block.pooled.push({signal: "emotional_dependence", kind: "check_in", text: "private ED pooled", cited: [{ordinal: 1, excerpt: "private ED pooled quote"}]});
  const receipt = record.governorActions![1];
  receipt.presented_text = ed.text.observation + "\n\nanswer";
  receipt.context_additions = [ed.text.observation];
  receipt.triggering_signals = [{name: "emotional_dependence", confidence: null}];
  record.governorActions!.push({...receipt, pooled_notice: block.pooled[0]});
  const later = structuredClone(record); later.turn.turn_id = "later";
  later.turn.user_prompt = "next message\n\n" + ed.text.observation;
  later.governorActions = []; delete later.verdict; state.turns.push(later);
  const before = JSON.stringify(state), result = buildConversationExport(state, meta);
  for (const text of ["private ED", "ED notice", "ED observation", "ED final", "emotional_dependence"]) {
    expect(JSON.stringify(result)).not.toContain(text);
    expect(browserTranscriptText(state)).not.toContain(text);
  }
  expect(result.transcript_text).toContain("next message");
  expect(JSON.stringify(state)).toBe(before);
});
