import { describe, expect, it } from "vitest";
import { conversationChanged, conversationIdFromUrl, governorSurfaceBlock, providerFromNavigation } from "./conversationSurface";
import { chatgptSpec } from "./capture/providers/chatgpt";
import { claudeaiSpec } from "./capture/providers/claudeai";
import type { TurnEvent } from "../shared/types";
import { blockedGovernorExecutions } from "./governorLoop";
import { planFromVerdict } from "./browserPolicyAdapter";

describe("governor conversation surface", () => {
  const turn = { provider: "chatgpt", session_id: "X" } as TurnEvent;
  it("activates through navigation and clears at the landing page", () => {
    expect(providerFromNavigation("https://chatgpt.com/c/X")).toBe("chatgpt");
    expect(providerFromNavigation("data:text/html,landing")).toBeUndefined();
    expect(conversationIdFromUrl("https://chatgpt.com/c/X")).toBe("X");
    expect(conversationIdFromUrl("https://claude.ai/chat/Y")).toBe("Y");
  });
  it("uses the same provider conversation IDs as capture", () => {
    expect(chatgptSpec.networkParser!.extractConversationId("", "", 'data: {"conversation_id":"X"}\n\n')).toBe(conversationIdFromUrl("https://chatgpt.com/c/X"));
    expect(claudeaiSpec.networkParser!.extractConversationId("https://claude.ai/api/organizations/org/chat_conversations/Y/completion", "", "")).toBe(conversationIdFromUrl("https://claude.ai/chat/Y"));
  });
  it("records no provider and mismatched provider as failures", () => {
    for (const p of [undefined, "claudeai"] as const) {
      expect(governorSurfaceBlock(p, "X", turn)).toEqual({ status: "failed", detail: "no active provider surface for this turn" });
    }
  });
  it("supersedes late turns but allows the matching conversation", () => {
    expect(governorSurfaceBlock("chatgpt", "Y", turn)?.status).toBe("superseded");
    expect(governorSurfaceBlock("chatgpt", "X", turn)).toBeNull();
  });
  it("distinguishes switching conversations from assigning the first ID", () => {
    expect(conversationIdFromUrl("https://chatgpt.com/c/local-chatgpt%3Adraft")).toBeNull();
    expect(conversationChanged("https://chatgpt.com/c/local-chatgpt%3Adraft", "https://chatgpt.com/c/X")).toBe(false);
    expect(conversationChanged("https://chatgpt.com/", "https://chatgpt.com/c/X")).toBe(false);
    expect(conversationChanged("https://chatgpt.com/c/X", "https://chatgpt.com/c/X?q=1")).toBe(false);
    expect(conversationChanged("https://chatgpt.com/c/X", "https://chatgpt.com/c/Y")).toBe(true);
    expect(conversationChanged("https://chatgpt.com/c/X", "https://chatgpt.com/")).toBe(true);
    expect(conversationChanged("https://chatgpt.com/c/X", "data:text/html,landing")).toBe(true);
  });
  it("records each selected mechanism without executing it", () => {
    const plan = planFromVerdict({ turn_id: "t", schema_version: "resilience_monitor_v1", monitor_version: "m", latency_ms: 1, signals: [{ name: "confidence_calibration", fired: true, confidence: 1, channel: "ai_system", rationale: "test" }] });
    expect(plan).not.toBeNull();
    const executions = blockedGovernorExecutions(plan!, {status:"failed",detail:"no active provider surface for this turn"});
    expect(executions.length).toBeGreaterThan(0);
    expect(executions.every(e => e.status === "failed")).toBe(true);
  });
});
