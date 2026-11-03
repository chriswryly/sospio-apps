import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationStore } from "../conversationStore";
import type { LocalInterventionReceipt, ModelState, TurnEvent } from "../../shared/types";

const modelState: ModelState = {
  monitorModel: "remote",
  chatModel: "llama3.2:3b",
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaHealth: "healthy",
  chatModelPresent: true,
  monitorModelPresent: true,
  modelWarmth: "warm",
};

describe("conversation store", () => {
  it("persists TurnEvents with Form B system prompt and tool calls fields", () => {
    const store = new ConversationStore(tempSessionsDir(), modelState);
    const turn: TurnEvent = {
      turn_id: "turn-1",
      session_id: store.sessionId,
      provider: "local",
      user_prompt: "hello",
      assistant_text: "hi",
      started_at: "2026-05-24T00:00:00.000Z",
      completed_at: "2026-05-24T00:00:01.000Z",
      request_url: "ollama://llama3.2:3b",
      system_prompt: "demo system",
      tool_calls: [],
    };

    store.addTurn(turn);

    const records = readFileSync(store.sessionFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(records).toContainEqual({ record_type: "turn_event", turn: {...turn, chat_model:modelState.chatModel,chat_provider:"ollama"} });
  });

  it("restores the latest conversation_state record from the latest session file", () => {
    const sessionsDir = tempSessionsDir();
    writeFileSync(
      join(sessionsDir, "2026-05-23T00-00-00-000Z.jsonl"),
      `${JSON.stringify({
        record_type: "conversation_state",
        session_id: "old-session",
        messages: [{ id: "old", role: "user", content: "old", created_at: "old" }],
      })}\n`,
    );
    writeFileSync(
      join(sessionsDir, "2026-05-24T00-00-00-000Z.jsonl"),
      `${JSON.stringify({
        record_type: "conversation_state",
        session_id: "new-session",
        messages: [{ id: "new", role: "assistant", content: "new", created_at: "new" }],
      })}\n`,
    );

    const store = new ConversationStore(sessionsDir, modelState);

    expect(store.sessionId).toBe("new-session");
    expect(store.getMessages()).toEqual([{ id: "new", role: "assistant", content: "new", created_at: "new" }]);
  });

  it("persists intervention receipts and attaches them to the turn record", () => {
    const store = new ConversationStore(tempSessionsDir(), modelState);
    const turn: TurnEvent = {
      turn_id: "turn-receipt",
      session_id: store.sessionId,
      provider: "local",
      user_prompt: "hello",
      assistant_text: "Governor notice",
      started_at: "2026-05-24T00:00:00.000Z",
      completed_at: "2026-05-24T00:00:01.000Z",
      request_url: "ollama://llama3.2:3b",
      system_prompt: "demo system",
      tool_calls: [],
    };
    const receipt: LocalInterventionReceipt = {
      schema_version: "rsh_local_intervention_receipt_v1",
      receipt_id: "receipt-1",
      turn_id: "turn-receipt",
      plan_id: "local_scripted:replace_presentation",
      policy_version: "local_scripted_intervention_v1",
      authority_profile_id: "local_orchestrator_full_v1",
      created_at: "2026-05-24T00:00:01.000Z",
      user_visible: true,
      executions: [
        {
          mechanism: "replace_presentation",
          stage: "candidate",
          status: "completed",
          detail: "candidate presentation replaced by governor-owned surface",
        },
      ],
      original_candidate_text: "raw candidate",
      presented_text: "Governor notice",
    };

    store.addTurn(turn);
    store.addInterventionReceipt(turn.turn_id, receipt);

    expect(store.getState().turns[0].interventionReceipts).toEqual([{...receipt,chat_model:modelState.chatModel,chat_provider:"ollama"}]);
    const records = readFileSync(store.sessionFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(records).toContainEqual({ record_type: "intervention_receipt", receipt:{...receipt,chat_model:modelState.chatModel,chat_provider:"ollama"} });
  });
});

function tempSessionsDir(): string {
  return mkdtempSync(join(tmpdir(), "rsh-local-harness-"));
}

it("persists the selected model across reload and refuses a mid-conversation change",()=>{
 const dir=tempSessionsDir();const store=new ConversationStore(dir,modelState);store.setConversationModel("hf.co/org/model:tag");store.appendUser("hello");expect(()=>store.setConversationModel("other")).toThrow("fixed");const restored=new ConversationStore(dir,modelState);expect(restored.getState().modelState.chatModel).toBe("hf.co/org/model:tag");expect(()=>restored.setConversationModel("other")).toThrow("fixed");restored.newConversation();expect(()=>restored.setConversationModel("other")).not.toThrow();
});

it("links both streaming messages, completed turns and failed replies, and persists additive IDs", () => {
  const dir = tempSessionsDir(), store = new ConversationStore(dir, modelState);
  store.appendUser("question", "t1"); const assistant = store.beginAssistant("t1");
  expect(store.getState().messages.map(m => m.turn_id)).toEqual(["t1", "t1"]);
  expect(store.getState().turns).toHaveLength(0); expect(store.getState().messages[1].streaming).toBe(true);
  store.finalizeAssistant(assistant.id, "answer");
  store.addTurn({turn_id:"t1",session_id:store.sessionId,provider:"local",user_prompt:"question",assistant_text:"answer",started_at:"now",completed_at:"now",request_url:"local"});
  expect(store.getState().turns[0].turn.turn_id).toBe(store.getState().messages[0].turn_id);
  const restored = new ConversationStore(dir, modelState);
  expect(restored.getMessages().map(m => m.turn_id)).toEqual(["t1", "t1"]);
  store.appendUser("next", "t2"); const failed = store.beginAssistant("t2"); store.finalizeAssistantFailure(failed.id, "failed");
  expect(store.getMessages().slice(-2).map(m => [m.turn_id, Boolean(m.failed)])).toEqual([["t2",false],["t2",true]]);
});
