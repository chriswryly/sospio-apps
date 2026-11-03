import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HarnessState, InterventionTier, LocalInterventionReceipt, TurnRecord } from "../shared/types";
import { LadderStatus, ReceiptInspector, TerminationBanner, turnLabel } from "./governorSurface";

const TURN_1 = "11111111-aaaa-4000-8000-000000000001";
const TURN_2 = "22222222-bbbb-4000-8000-000000000002";

function turn(turnId: string): TurnRecord {
  return {
    turn: {
      turn_id: turnId,
      session_id: "session",
      provider: "local",
      user_prompt: "prompt",
      assistant_text: "answer",
      started_at: "2026-09-22T00:00:00.000Z",
      completed_at: "2026-09-22T00:00:01.000Z",
      request_url: "ollama://model",
    },
    monitorStatus: "ready",
  };
}

function state(extra: Partial<HarnessState>): HarnessState {
  return {
    sessionId: "session",
    monitorHealth: "healthy",
    messages: [],
    turns: [turn(TURN_1), turn(TURN_2)],
    diagnostics: [],
    isGenerating: false,
    modelState: {
      chatModel: "m",
      monitorModel: "m",
      ollamaUrl: "http://127.0.0.1:11434",
      ollamaHealth: "healthy",
      chatModelPresent: true,
      monitorModelPresent: true,
      modelWarmth: "warm",
    },
    ...extra,
  };
}

function receipt(extra: Partial<LocalInterventionReceipt>): LocalInterventionReceipt {
  return {
    schema_version: "rsh_local_intervention_receipt_v2",
    receipt_id: `r-${Math.random()}`,
    turn_id: TURN_2,
    plan_id: "plan",
    policy_version: "local_policy_adapter_v1",
    authority_profile_id: "local_orchestrator_full_v1",
    created_at: "2026-09-22T00:00:02.000Z",
    user_visible: true,
    executions: [{ mechanism: "display_governor_notice", stage: "candidate", status: "completed", detail: "notice" }],
    ...extra,
  };
}

describe("ladder status", () => {
  it.each([1, 2, 3, 4] as InterventionTier[])("renders tier %i with its reason and governing turn", (tier) => {
    const html = renderToStaticMarkup(
      <LadderStatus
        state={state({ ladder: { status: "held", tier, tier_reason: `reason-${tier}`, governing_turn_id: TURN_1, mechanisms: ["x"] } })}
      />,
    );
    expect(html).toContain(`tier ${tier}`);
    expect(html).toContain(`reason-${tier}`);
    expect(html).toContain("turn 1 (11111111)");
  });

  it("shows no tier once the decision is no longer in force", () => {
    const html = renderToStaticMarkup(<LadderStatus state={state({ ladder: { status: "none", reason: "no_ladder_decision" } })} />);
    expect(html).not.toContain("tier ");
    expect(html).toContain("no active decision");
  });

  it("says the monitor is unavailable", () => {
    const html = renderToStaticMarkup(<LadderStatus state={state({ ladder: { status: "none", reason: "monitor_unavailable" } })} />);
    expect(html).toContain("monitor unavailable");
  });

  it("shows the rehearsal override as an override, not a tier", () => {
    const html = renderToStaticMarkup(<LadderStatus state={state({ ladder: { status: "override" } })} />);
    expect(html).toContain("REHEARSAL");
    expect(html).not.toContain("tier ");
  });

  it("renders nothing before any verdict", () => {
    expect(renderToStaticMarkup(<LadderStatus state={state({ ladder: { status: "none", reason: "no_verdict_yet" } })} />)).toBe("");
  });
});

describe("receipts", () => {
  it("name the governing turn, and it differs from the turn the receipt is attached to", () => {
    const html = renderToStaticMarkup(
      <ReceiptInspector receipts={[receipt({ governing_turn_id: TURN_1, plan_source: "live_verdict" })]} turns={state({}).turns} />,
    );
    expect(html).toContain("caused by <code>turn 1 (11111111)</code>, applied to <code>turn 2 (22222222)</code>");
  });

  it("mark a rehearsal plan distinctly from a live one", () => {
    const turns = state({}).turns;
    const live = renderToStaticMarkup(<ReceiptInspector receipts={[receipt({ plan_source: "live_verdict" })]} turns={turns} />);
    const rehearsal = renderToStaticMarkup(<ReceiptInspector receipts={[receipt({ plan_source: "rehearsal_fixture" })]} turns={turns} />);
    expect(live).toContain('class="plan-source live_verdict"');
    expect(live).not.toContain("REHEARSAL");
    expect(rehearsal).toContain('class="plan-source rehearsal_fixture"');
    expect(rehearsal).toContain("REHEARSAL");
  });

  it("show a notice-utility observation as user-visible", () => {
    const html = renderToStaticMarkup(
      <ReceiptInspector
        receipts={[receipt({ plan_id: "notice_utility", utility_notice_id: "notice-1", executions: [] })]}
        turns={state({}).turns}
      />,
    );
    expect(html).toContain("user-visible");
    expect(html).toContain("notice-1");
  });
});

describe("termination banner", () => {
  it("names its governing turn, not the latest turn", () => {
    const html = renderToStaticMarkup(
      <TerminationBanner
        state={state({
          termination: {
            session_id: "session",
            terminated_at: "2026-09-22T00:00:03.000Z",
            governing_turn_id: TURN_1,
            tier_reason: "persistence",
            notice: "Governor notice",
            plan_source: "live_verdict",
          },
        })}
      />,
    );
    expect(html).toContain("CONVERSATION CLOSED");
    expect(html).toContain("persistence");
    expect(html).toContain("turn 1 (11111111)");
    expect(html).not.toContain("turn 2");
    expect(html).toContain("Start a new conversation");
  });
});

describe("turn labels", () => {
  it("use the short id alone when earlier turn records are missing after a relaunch", () => {
    expect(turnLabel(TURN_2, state({}).turns, "partial")).toBe("22222222");
    const html = renderToStaticMarkup(
      <ReceiptInspector receipts={[receipt({ governing_turn_id: TURN_1 })]} turns={state({}).turns} history="partial" />,
    );
    expect(html).not.toContain("turn 1");
    expect(html).toContain("caused by <code>11111111</code>");
  });

  it("use the short id alone for a turn outside this conversation", () => {
    expect(turnLabel("99999999-cccc-4000-8000-000000000009", state({}).turns)).toBe("99999999");
  });
});
