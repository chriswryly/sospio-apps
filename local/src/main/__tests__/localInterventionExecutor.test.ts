import { describe, expect, it } from "vitest";
import {
  createLocalInterventionPlan,
  LOCAL_POLICY_ADAPTER_VERSION,
  LOCAL_ORCHESTRATOR_AUTHORITY_PROFILE,
  LocalInterventionExecutor,
} from "../localInterventionExecutor";
import type { LocalInterventionReceipt } from "../../shared/types";

describe("local intervention executor", () => {
  it("augments request context with an auditable non-visible receipt", () => {
    const plan = createLocalInterventionPlan(["augment_request_context"], {
      planId: "local_policy_fixture:request-test",
      attribution: { source: "live_verdict" },
      contextAddition: "Check the user's stated constraints before answering.",
      noticeText: "Governor notice",
      withheldText: "Governor withheld",
      redactionText: "Governor redaction",
      replacementText: "Governor replacement",
    });
    const executor = new LocalInterventionExecutor(plan);

    const result = executor.executeBeforeChat({
      turnId: "turn-1",
      systemPrompt: "Base system prompt.",
      messages: [{ id: "m1", role: "user", content: "hello", created_at: "now" }],
    });

    expect(result.systemPrompt).toContain("Base system prompt.");
    expect(result.systemPrompt).toContain("Check the user's stated constraints");
    expect(result.receipt).toMatchObject({
      schema_version: "rsh_local_intervention_receipt_v2",
      turn_id: "turn-1",
      policy_version: LOCAL_POLICY_ADAPTER_VERSION,
      authority_profile_id: LOCAL_ORCHESTRATOR_AUTHORITY_PROFILE,
      user_visible: false,
      plan_source: "live_verdict",
      context_additions: ["Check the user's stated constraints before answering."],
    });
    expect(result.receipt?.executions).toEqual([
      {
        mechanism: "augment_request_context",
        stage: "request",
        status: "completed",
        detail: "ordinary request context appended before local model call",
      },
    ]);
  });

  it("replaces candidate presentation while preserving the original in the receipt", () => {
    const plan = createLocalInterventionPlan(["replace_presentation"], {
      planId: "local_policy_fixture:candidate-test",
      attribution: { source: "live_verdict" },
      contextAddition: "context",
      noticeText: "Governor notice",
      withheldText: "Governor withheld",
      redactionText: "Governor redaction",
      replacementText: "Governor notice: replacement surface",
    });
    const executor = new LocalInterventionExecutor(plan);

    const result = executor.executeAfterCandidate({
      turnId: "turn-2",
      candidateText: "unsupported model answer",
    });

    expect(result.presentedText).toBe("Governor notice: replacement surface");
    expect(result.receipt).toMatchObject({
      turn_id: "turn-2",
      user_visible: true,
      original_candidate_text: "unsupported model answer",
      presented_text: "Governor notice: replacement surface",
    });
    expect(result.receipt?.executions[0]).toMatchObject({
      mechanism: "replace_presentation",
      stage: "candidate",
      status: "completed",
    });
  });

  it("marks a notice as superseded when replacement owns the presentation", () => {
    const interventionPlan = candidatePlan(["display_governor_notice", "replace_presentation"]);
    const result = new LocalInterventionExecutor(interventionPlan).executeAfterCandidate({
      turnId: "turn-4",
      candidateText: "raw answer",
    });

    expect(result.presentedText).toBe("replacement surface");
    expect(result.presentedText).not.toContain("notice surface");
    expect(result.receipt?.executions).toEqual([
      {
        mechanism: "display_governor_notice",
        stage: "candidate",
        status: "superseded",
        superseded_by: "replace_presentation",
        detail: "display_governor_notice was superseded by replace_presentation.",
      },
      {
        mechanism: "replace_presentation",
        stage: "candidate",
        status: "completed",
        detail: "candidate presentation replaced by governor-owned surface",
      },
    ]);
  });

  it("uses terminal precedence independent of plan order", () => {
    const noticeThenReplace = new LocalInterventionExecutor(candidatePlan(["display_governor_notice", "replace_presentation"]))
      .executeAfterCandidate({ turnId: "turn-5", candidateText: "raw answer" });
    const replaceThenNotice = new LocalInterventionExecutor(candidatePlan(["replace_presentation", "display_governor_notice"]))
      .executeAfterCandidate({ turnId: "turn-6", candidateText: "raw answer" });

    expect(noticeThenReplace.presentedText).toBe("replacement surface");
    expect(replaceThenNotice.presentedText).toBe("replacement surface");
  });

  it("lets withhold beat replacement and uses its dedicated surface", () => {
    const result = new LocalInterventionExecutor(candidatePlan(["replace_presentation", "withhold_candidate"]))
      .executeAfterCandidate({ turnId: "turn-7", candidateText: "raw answer" });

    expect(result.presentedText).toBe("withheld surface");
    expect(result.receipt?.executions).toEqual([
      {
        mechanism: "replace_presentation",
        stage: "candidate",
        status: "superseded",
        superseded_by: "withhold_candidate",
        detail: "replace_presentation was superseded by withhold_candidate.",
      },
      {
        mechanism: "withhold_candidate",
        stage: "candidate",
        status: "completed",
        detail: "candidate withheld from presentation with governor attribution",
      },
    ]);
  });

  it("redacts with the configured redaction surface", () => {
    const result = new LocalInterventionExecutor(candidatePlan(["visibly_redact_candidate"]))
      .executeAfterCandidate({ turnId: "turn-8", candidateText: "raw answer" });

    expect(result.presentedText).toBe("redaction surface");
    expect(result.presentedText).not.toContain("visibly redacted for this test intervention");
    expect(result.receipt).toMatchObject({
      original_candidate_text: "raw answer",
      presented_text: "redaction surface",
    });
    expect(result.receipt?.presented_text).not.toBe(result.receipt?.original_candidate_text);
  });

  it("still prepends a notice when it is the only candidate-stage mechanism", () => {
    const result = new LocalInterventionExecutor(candidatePlan(["display_governor_notice"]))
      .executeAfterCandidate({ turnId: "turn-9", candidateText: "raw answer" });

    expect(result.presentedText).toBe("notice surface\n\nraw answer");
    expect(result.receipt).toMatchObject({
      original_candidate_text: "raw answer",
      presented_text: "notice surface\n\nraw answer",
    });
    expect(result.receipt?.executions[0]).toMatchObject({
      mechanism: "display_governor_notice",
      status: "completed",
    });
  });

  it("leaves the request and candidate unchanged when no plan is configured", () => {
    const executor = new LocalInterventionExecutor(null);

    expect(
      executor.executeBeforeChat({
        turnId: "turn-3",
        systemPrompt: "system",
        messages: [],
      }),
    ).toEqual({ systemPrompt: "system", messages: [] });
    expect(executor.executeAfterCandidate({ turnId: "turn-3", candidateText: "answer" })).toEqual({
      presentedText: "answer",
    });
  });

  it("keeps the tier field optional and restricted to the supported tier numbers", () => {
    const base = {
      schema_version: "rsh_local_intervention_receipt_v1" as const,
      receipt_id: "receipt-1",
      turn_id: "turn-1",
      plan_id: "plan-1",
      policy_version: LOCAL_POLICY_ADAPTER_VERSION,
      authority_profile_id: LOCAL_ORCHESTRATOR_AUTHORITY_PROFILE,
      created_at: "2026-08-18T00:00:00.000Z",
      user_visible: false,
      executions: [],
    } satisfies LocalInterventionReceipt;
    const withTier: LocalInterventionReceipt = { ...base, tier: 3 };
    const withoutTier: LocalInterventionReceipt = { ...base };

    expect(withTier.tier).toBe(3);
    expect(withoutTier.tier).toBeUndefined();
    if (false) {
      // @ts-expect-error Tier 5 must stay unavailable.
      const invalidTier: LocalInterventionReceipt = { ...base, tier: 5 };
      void invalidTier;
    }
  });
});

function candidatePlan(mechanisms: Parameters<typeof createLocalInterventionPlan>[0]) {
  return createLocalInterventionPlan(mechanisms, {
    planId: "local_policy_fixture:candidate-precedence",
    attribution: { source: "live_verdict" },
    contextAddition: "context",
    noticeText: "notice surface",
    withheldText: "withheld surface",
    redactionText: "redaction surface",
    replacementText: "replacement surface",
  });
}
