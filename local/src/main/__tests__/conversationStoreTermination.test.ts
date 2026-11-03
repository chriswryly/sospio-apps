import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationStore } from "../conversationStore";
import type { ModelState, SessionTermination } from "../../shared/types";

const modelState: ModelState = {
  monitorModel: "remote",
  chatModel: "llama3.2:3b",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaHealth: "healthy",
  chatModelPresent: true,
  monitorModelPresent: true,
  modelWarmth: "warm",
};

const termination: SessionTermination = {
  terminated_at: "2026-09-22T00:00:00.000Z",
  governing_turn_id: "turn-1",
  tier_reason: "persistence",
  notice: "Governor notice",
  plan_source: "live_verdict",
};

function records(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

describe("termination belongs to one conversation", () => {
  it("is scoped to the current session when set", () => {
    const store = new ConversationStore(mkdtempSync(join(tmpdir(), "rsh-term-")), modelState);
    store.setTermination(termination);
    expect(store.getState().termination?.session_id).toBe(store.sessionId);
  });

  it("clears on a new conversation, keeping the record in the log", () => {
    const store = new ConversationStore(mkdtempSync(join(tmpdir(), "rsh-term-")), modelState);
    store.setTermination(termination);
    store.newConversation();

    expect(store.getState().termination).toBeUndefined();
    expect(records(store.sessionFile).some((record) => record.record_type === "session_termination")).toBe(true);
  });

  it("stays closed across a relaunch, and across a second relaunch", () => {
    const dir = mkdtempSync(join(tmpdir(), "rsh-term-"));
    const first = new ConversationStore(dir, modelState);
    first.appendUser("hello");
    first.setTermination(termination);

    const second = new ConversationStore(dir, modelState);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.getState().termination?.governing_turn_id).toBe("turn-1");

    const third = new ConversationStore(dir, modelState);
    expect(third.getState().termination?.session_id).toBe(first.sessionId);

    third.newConversation();
    expect(third.getState().termination).toBeUndefined();
  });

  it("does not close a later conversation for an earlier one's termination", () => {
    const dir = mkdtempSync(join(tmpdir(), "rsh-term-"));
    const store = new ConversationStore(dir, modelState);
    store.appendUser("session A");
    store.setTermination(termination);
    store.newConversation();
    store.appendUser("session B");

    const relaunched = new ConversationStore(dir, modelState);
    expect(relaunched.sessionId).toBe(store.sessionId);
    expect(relaunched.getState().termination).toBeUndefined();
  });

  it("attributes a termination record without session_id to the session in effect", () => {
    const dir = mkdtempSync(join(tmpdir(), "rsh-term-"));
    const lines = [
      { record_type: "conversation_state", session_id: "session-a", messages: [] },
      { record_type: "session_termination", termination },
      { record_type: "session_boundary", session_id: "session-b", timestamp: "2026-09-22T00:00:01.000Z" },
      { record_type: "conversation_state", session_id: "session-b", messages: [] },
    ];
    writeFileSync(join(dir, "2026-09-22T00-00-00-000Z.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    expect(new ConversationStore(dir, modelState).getState().termination).toBeUndefined();

    const closedDir = mkdtempSync(join(tmpdir(), "rsh-term-"));
    writeFileSync(join(closedDir, "2026-09-22T00-00-00-000Z.jsonl"), lines.slice(0, 2).map((line) => JSON.stringify(line)).join("\n") + "\n");
    const restored = new ConversationStore(closedDir, modelState);
    expect(restored.getState().termination?.session_id).toBe("session-a");
  });
});

describe("turn history", () => {
  it("is partial for a conversation restored with a transcript, complete after New conversation", () => {
    const dir = mkdtempSync(join(tmpdir(), "rsh-history-"));
    expect(new ConversationStore(dir, modelState).getState().turnHistory).toBe("complete");
    const first = new ConversationStore(dir, modelState);
    first.appendUser("hello");

    const restored = new ConversationStore(dir, modelState);
    expect(restored.getState().turnHistory).toBe("partial");
    restored.newConversation();
    expect(restored.getState().turnHistory).toBe("complete");
  });
});
