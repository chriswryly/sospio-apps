import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { buildConversationExport } from "./conversationExport";
import { exportFixture } from "./__fixtures__/conversationExport";
const meta = {exported_at: "2026-09-26T00:00:00.000Z", surface: "electron" as const, app_version: "0.1.0"};
it("preserves every receipt and judge verdict verbatim, including unavailable readings and source labels", () => {
  const state = exportFixture(), before = JSON.stringify(state);
  const result = buildConversationExport(state, meta);
  expect(JSON.stringify(result.receipts)).toBe(JSON.stringify(state.turns.flatMap(r => r.interventionReceipts ?? [])));
  expect(result.turns[0].judge_ladder).toEqual(state.turns[0].verdict!.judge_ladder);
  expect(result.monitor.monitorIdentity).toBe("Sospio remote monitor");
  expect(JSON.stringify(result)).toContain("rehearsal_fixture");
  expect(JSON.stringify(state)).toBe(before);
  if (process.env.EXPORT_FIXTURE_DIR) writeFileSync(`${process.env.EXPORT_FIXTURE_DIR}/orchestrator-export.json`, JSON.stringify(result, null, 2));
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
it("exports restored session identity and partial transcript before any new turn", async () => {
  const {ConversationStore} = await import("../main/conversationStore");
  const {mkdtempSync, rmSync} = await import("node:fs"); const {tmpdir} = await import("node:os"); const {join} = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "export-restore-"));
  try {
    const original = new ConversationStore(dir, exportFixture().modelState); original.appendUser("restored question");
    const restored = new ConversationStore(dir, exportFixture().modelState);
    const result = buildConversationExport(restored.getState(), meta);
    expect(result.session_id).toBe(original.sessionId); expect(result.turn_history).toBe("partial");
    expect(result.transcript_text).toBe("You: restored question"); expect(result.turns).toEqual([]); expect(result.receipts).toEqual([]);
    restored.newConversation(); expect(restored.getState().sessionId).not.toBe(result.session_id);
  } finally {rmSync(dir, {recursive: true, force: true});}
});
it("omits termination from another session", () => {
  const state = exportFixture(); state.termination!.session_id = "old";
  expect(buildConversationExport(state, meta).termination).toBeNull();
});
