import { expect, it } from "vitest";
import { exportFixture } from "../renderer/__fixtures__/conversationExport";
import { buildConversationExport } from "../renderer/conversationExport";

it("keeps emotional observations and notice excerpts out of conversation exports", () => {
  const state = exportFixture();
  const record = state.turns[0];
  const block = record.verdict!.judge_ladder!;
  const notice = "Sensitive emotional notice: PRIVATE-JUDGE-EXCERPT";
  block.signals.emotional_dependence = { ...block.signals.overreliance_signals,
    evidence: {current: "PRIVATE-JUDGE-EXCERPT", counter: null},
    text: {tier1: notice, observation: notice, tier3: notice} };
  block.acting_signals.push("emotional_dependence");
  block.pooled.push({kind: "uncertainty_notice", signal: "emotional_dependence", cited: [{ordinal: 1, excerpt: "PRIVATE-JUDGE-EXCERPT"}], text: notice});
  record.verdict!.signals.push({name: "emotional_dependence", channel: "user", fired: true, confidence: null, intensity: .7, rationale: notice});
  state.messages.push({id: "private-note", role: "governor", content: notice, created_at: "now"});
  record.interventionReceipts![0].context_additions = [notice];
  record.interventionReceipts![0].presented_text = notice + "\nordinary reply";
  const before = JSON.stringify(state);
  const exported = buildConversationExport(state, {exported_at: "now", surface: "web", app_version: "test"});
  for (const shared of [exported]) expect(JSON.stringify(shared)).not.toContain("PRIVATE-JUDGE-EXCERPT");
  expect(exported.turns[0].judge_ladder!.signals.overreliance_signals).toEqual(block.signals.overreliance_signals);
  expect(JSON.stringify(state)).toBe(before);
});


it("redacts restored presentation notices without retaining data across conversations", async () => {
  const {ConversationStore} = await import("../main/conversationStore");
  const {mkdtempSync, rmSync} = await import("node:fs");
  const {tmpdir} = await import("node:os");
  const {join} = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "emotional-privacy-"));
  try {
    const fixture = exportFixture();
    const store = new ConversationStore(dir, fixture.modelState);
    const notice = "private restored notice with RESTORED-EXCERPT";
    const verdict = structuredClone(fixture.turns[0].verdict!);
    store.addTurn({...fixture.turns[0].turn, session_id: store.sessionId});
    verdict.judge_ladder!.signals.emotional_dependence = {...verdict.judge_ladder!.signals.overreliance_signals,
      text: {tier1: notice, observation: notice, tier3: notice}};
    store.appendUser("question");
    const assistant = store.beginAssistant();
    store.addVerdict(verdict);
    store.finalizeAssistant(assistant.id, notice + "\n\nordinary reply");
    const restored = new ConversationStore(dir, fixture.modelState);
    // A second restart has no prior verdict in its latest recording.
    const twiceRestored = new ConversationStore(dir, fixture.modelState);
    const state = twiceRestored.getState();
    expect(state.turns).toEqual([]);
    expect(state.messages[1].content).toContain("RESTORED-EXCERPT");
    const exported = buildConversationExport(state, {exported_at: "now", surface: "electron", app_version: "test"});
    expect(JSON.stringify(exported)).not.toContain("RESTORED-EXCERPT");
    expect(exported.transcript_text).toContain("ordinary reply");
    twiceRestored.newConversation();
    expect(twiceRestored.getState().messages).toEqual([]);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
