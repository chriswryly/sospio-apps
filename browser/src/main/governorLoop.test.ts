import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import judgeSequence from "../shared/__fixtures__/noticeSequence.json";
import { judgeTierText } from "../shared/monitorNotices";
import { planFromVerdict } from "./browserPolicyAdapter";
import { REPLACE_PRESENTATION_TEXT } from "./capture/pageInterventionShim";
import {
  BROWSER_GOVERNOR_AUTHORITY_PROFILE,
  BROWSER_GOVERNOR_POLICY_VERSION,
  buildGovernorActionRecord,
  executeGovernorPlan,
  governorTextOptions,
  type GovernorSurface,
} from "./governorLoop";
import type {
  GovernorActionRecord,
  LegacyGovernorActionRecord,
  MonitorSignal,
  MonitorVerdict,
} from "../shared/types";

function signal(name: string, confidence = 0.9): MonitorSignal {
  return { name, channel: "ai_system", fired: true, confidence, rationale: "test" };
}

function verdict(signals: MonitorSignal[], extra: Partial<MonitorVerdict> = {}): MonitorVerdict {
  return {
    turn_id: "turn-1",
    schema_version: "resilience_monitor_v1",
    signals,
    monitor_version: "p1_keyword_event_monitor_v1",
    latency_ms: 1,
    monitor_status: "primary",
    ...extra,
  };
}

function recordingSurface(overrides: Partial<GovernorSurface> = {}) {
  const calls: string[] = [];
  const surface: GovernorSurface = {
    displayNotice: async (message) => { calls.push(`notice:${message}`); },
    replaceLatestPresentation: async () => { calls.push("replace"); },
    armRequest: async (mechanism, context) => { calls.push(`arm:${mechanism}:${context}`); },
    terminateExchange: async (message, countdownSeconds) => { calls.push(`terminate:${message}:${countdownSeconds}`); },
    ...overrides,
  };
  return { surface, calls };
}

const OPTIONS = {
  provider: "chatgpt" as const,
  threshold: 0.7,
  noticeText: "flagged",
  augmentContext: "protective context",
  originalCandidateText: "raw candidate text",
};

describe("governor loop execution", () => {
  it("acts on the flagged turn and arms the next one from a single verdict", async () => {
    // The loop that had never run: a verdict alone drives interventions, with nobody clicking.
    const plan = planFromVerdict(verdict([signal("confidence_calibration")]))!;
    const { surface, calls } = recordingSurface();

    const executions = await executeGovernorPlan(plan, surface, OPTIONS);

    expect(calls).toEqual(["notice:flagged", "arm:augment_request_context:protective context"]);
    expect(executions.map((e) => [e.mechanism, e.status])).toEqual([
      ["display_governor_notice", "applied"],
      ["augment_request_context", "armed"],
    ]);
  });

  it("replaces the flagged turn rather than arming for the next one", async () => {
    // The retroactive path must reach the turn that triggered the verdict. Arming would target a
    // turn the user has not sent yet, so the flagged answer would stay on screen untouched.
    const plan = planFromVerdict(verdict([signal("harmful_content")]))!;
    const { surface, calls } = recordingSurface();

    await executeGovernorPlan(plan, surface, OPTIONS);

    expect(calls).toEqual(["replace"]);
  });

  it("records a superseded mechanism instead of silently dropping it", async () => {
    const plan = planFromVerdict(verdict([signal("confidence_calibration"), signal("harmful_content")]))!;
    const { surface, calls } = recordingSurface();

    const executions = await executeGovernorPlan(plan, surface, OPTIONS);

    // The notice is never displayed — a replaced presentation has no body to annotate — but it is
    // still on the receipt, so "what was requested" stays traceable.
    expect(calls).not.toContain("notice:flagged");
    const notice = executions.find((e) => e.mechanism === "display_governor_notice");
    expect(notice?.status).toBe("superseded");
    expect(notice?.superseded_by).toBe("replace_presentation");
  });

  it("continues after one mechanism throws, and records the failure", async () => {
    // A provider moving a DOM node must not take the monitor path down with it.
    const plan = planFromVerdict(verdict([signal("confidence_calibration")]))!;
    const { surface, calls } = recordingSurface({
      displayNotice: async () => { throw new Error("assistant turn not found"); },
    });

    const executions = await executeGovernorPlan(plan, surface, OPTIONS);

    expect(executions[0]).toMatchObject({
      mechanism: "display_governor_notice",
      status: "failed",
      detail: "assistant turn not found",
    });
    // The forward-looking arm still happened.
    expect(calls).toContain("arm:augment_request_context:protective context");
    expect(executions.some((e) => e.status === "armed")).toBe(true);
  });

  it("does not inject the capability probe's effect sentinel", async () => {
    // The probe asks the model to end its reply with a sentinel glyph in order to measure
    // steering. A governor-driven augment must not do that: it would put a stray character in the
    // user's actual reply.
    const plan = planFromVerdict(verdict([signal("confidence_calibration")]))!;
    const { surface, calls } = recordingSurface();

    await executeGovernorPlan(plan, surface, OPTIONS);

    expect(calls.join(" ")).not.toContain("⟂");
    expect(calls.join(" ")).not.toMatch(/end your reply with/i);
  });

  it("builds a receipt carrying the signals, threshold and monitor identity", async () => {
    const v = verdict([signal("harmful_content", 0.93)]);
    const plan = planFromVerdict(v)!;
    const { surface } = recordingSurface();

    const executions = await executeGovernorPlan(plan, surface, OPTIONS);
    const record = buildGovernorActionRecord(plan, executions, v, OPTIONS);

    expect(record).toMatchObject({
      schema_version: "rsh_browser_governor_action_v3",
      turn_id: "turn-1",
      provider: "chatgpt",
      policy_version: BROWSER_GOVERNOR_POLICY_VERSION,
      authority_profile_id: BROWSER_GOVERNOR_AUTHORITY_PROFILE,
      threshold: 0.7,
      tier: null,
      tier_reason: "legacy_threshold_path",
      monitor_profile_id: null,
      intervention_profile_id: null,
      policy_mode: "legacy_threshold",
      monitor_version: "p1_keyword_event_monitor_v1",
      triggering_signals: [{ name: "harmful_content", confidence: 0.93, intensity: null }],
    });
    expect(record.action_id).toMatch(/[0-9a-f-]{36}/);
  });

  it("records the exact browser augmentation payload", async () => {
    const v = verdict([signal("confidence_calibration")]);
    const plan = planFromVerdict(v)!;
    const { surface } = recordingSurface();

    const executions = await executeGovernorPlan(plan, surface, OPTIONS);
    const record = buildGovernorActionRecord(plan, executions, v, OPTIONS);

    expect(record.context_additions).toEqual(["protective context"]);
  });

  it("does not record context additions when request arming fails", async () => {
    const v = verdict([signal("confidence_calibration")]);
    const plan = planFromVerdict(v, { allowed: ["augment_request_context"] })!;
    const { surface } = recordingSurface({
      armRequest: async () => { throw new Error("debugger detached"); },
    });

    const executions = await executeGovernorPlan(plan, surface, OPTIONS);
    const record = buildGovernorActionRecord(plan, executions, v, OPTIONS);

    expect(executions).toContainEqual(expect.objectContaining({
      mechanism: "augment_request_context",
      status: "failed",
      detail: "debugger detached",
    }));
    expect(record).not.toHaveProperty("context_additions");
  });

  it("writes an execution for a mechanism the run allowlist excluded", async () => {
    const v = verdict([signal("confidence_calibration")]);
    const plan = planFromVerdict(v, { allowed: ["display_governor_notice"] })!;
    const { surface } = recordingSurface();

    const executions = await executeGovernorPlan(plan, surface, OPTIONS);

    expect(executions).toContainEqual(expect.objectContaining({
      mechanism: "augment_request_context",
      timing: "next_turn",
      status: "not_permitted",
      detail: "not in this run's mechanism allowlist",
    }));
  });

  it("emits a receipt with no executed mechanism when the allowlist excludes them all", async () => {
    const v = verdict([signal("harmful_content")]);
    const plan = planFromVerdict(v, { allowed: ["pause_request"] })!;
    const { surface, calls } = recordingSurface();

    const executions = await executeGovernorPlan(plan, surface, OPTIONS);
    const record = buildGovernorActionRecord(plan, executions, v, OPTIONS);

    expect(calls).toEqual([]);
    expect(record.user_visible).toBe(false);
    expect(record.executions).toEqual([
      expect.objectContaining({ mechanism: "replace_presentation", status: "not_permitted" }),
    ]);
  });

  it("records notice presentation text and the original candidate text", async () => {
    const v = verdict([signal("confidence_calibration")]);
    const plan = planFromVerdict(v, { allowed: ["display_governor_notice"] })!;
    const { surface } = recordingSurface();

    const executions = await executeGovernorPlan(plan, surface, OPTIONS);
    const record = buildGovernorActionRecord(plan, executions, v, OPTIONS);

    expect(record.original_candidate_text).toBe("raw candidate text");
    expect(record.presented_text).toBe("flagged\n\nraw candidate text");
    expect(record.presented_text).not.toBe(record.original_candidate_text);
    expect(record.user_visible).toBe(true);
  });

  it("records a visible notice even when candidate text is unavailable", async () => {
    const v = verdict([signal("confidence_calibration")]);
    const plan = planFromVerdict(v, { allowed: ["display_governor_notice"] })!;
    const { surface } = recordingSurface();
    const options = { ...OPTIONS };
    delete (options as Partial<typeof OPTIONS>).originalCandidateText;

    const executions = await executeGovernorPlan(plan, surface, options);
    const record = buildGovernorActionRecord(plan, executions, v, options);

    expect(record.user_visible).toBe(true);
    expect(record).not.toHaveProperty("original_candidate_text");
    expect(record).not.toHaveProperty("presented_text");
  });

  it("records replacement presentation text and the original candidate text", async () => {
    const v = verdict([signal("harmful_content")]);
    const plan = planFromVerdict(v)!;
    const { surface } = recordingSurface();

    const executions = await executeGovernorPlan(plan, surface, OPTIONS);
    const record = buildGovernorActionRecord(plan, executions, v, OPTIONS);

    expect(record.original_candidate_text).toBe("raw candidate text");
    expect(record.presented_text).toBe(REPLACE_PRESENTATION_TEXT);
    expect(record.presented_text).not.toBe(record.original_candidate_text);
    expect(record.user_visible).toBe(true);
  });

  it("builds a tiered receipt carrying tier reason and profile ids", async () => {
    const v = verdict([signal("sycophancy", 0.2)], {
      tier: 2,
      tier_reason: "persistence",
      selected_mechanisms: ["display_governor_notice", "augment_request_context"],
      monitor_profile_id: "m0_default",
      monitor_profile_version: "m0_default_v1",
      intervention_profile_id: "m0_default",
      intervention_profile_version: "m0_default_v1",
      policy_mode: "m0_ladder",
    });
    const plan = planFromVerdict(v)!;
    const { surface } = recordingSurface();

    const executions = await executeGovernorPlan(plan, surface, OPTIONS);
    const record = buildGovernorActionRecord(plan, executions, v, OPTIONS);

    expect(record).toMatchObject({
      schema_version: "rsh_browser_governor_action_v3",
      tier: 2,
      tier_reason: "persistence",
      monitor_profile_id: "m0_default",
      monitor_profile_version: "m0_default_v1",
      intervention_profile_id: "m0_default",
      intervention_profile_version: "m0_default_v1",
      policy_mode: "m0_ladder",
    });
  });

  it.each([2, 3] as const)("uses tier %s text for execution and receipts", async (tier) => {
    // Read production placeholders without importing Electron's main-process entry point.
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const noticeText = source.match(/const GOVERNOR_TIER_3_NOTICE = "([^"\n]+)";/)![1];
    const augmentContext = source.match(/const GOVERNOR_TIER_3_CONTEXT = "([^"\n]+)";/)![1];
    expect(noticeText).toBe("Sospio observation: the possible concern noted on earlier turns is still present. If it continues, Sospio may close this conversation. You can hide this notice and continue.");
    expect(augmentContext).toBe("Sospio observation (not the user's words): a possible concern noted on earlier turns is still present in this message. If it continues, Sospio may close this conversation.");
    for (const text of [noticeText, augmentContext]) {
      expect(text).toContain("Sospio observation");
      expect(text).not.toMatch(/\byou must\b|\bstop\b|\bdo not\b|\bdon't\b|\btreat\b|\brequire|\bauthori[sz]/i);
    }
    const v = verdict([signal("sycophancy", 0.2)], { tier });
    const options = { ...OPTIONS, ...governorTextOptions(v, { ...OPTIONS, tier3Text: { noticeText, augmentContext } }) };
    const plan = planFromVerdict(v)!;
    const { surface, calls } = recordingSurface();
    const executions = await executeGovernorPlan(plan, surface, options);
    const record = buildGovernorActionRecord(plan, executions, v, options);
    const text = tier === 3 ? options.tier3Text! : OPTIONS;
    expect(calls).toEqual([`notice:${text.noticeText}`, `arm:augment_request_context:${text.augmentContext}`]);
    expect(executions).toMatchObject([
      { mechanism: "display_governor_notice", status: "applied" },
      { mechanism: "augment_request_context", status: "armed" },
    ]);
    expect(record.tier).toBe(tier);
    expect(record.context_additions).toEqual([text.augmentContext]);
    expect(record.presented_text).toBe(`${text.noticeText}\n\n${OPTIONS.originalCandidateText}`);
    expect(record.arm_capability_limit).toEqual({ arm: "browser", status: "available" });
  });

  it.each([2, 3] as const)("uses judge-ladder Tier %s text in both mechanisms and the receipt", async (tier) => {
    const v = structuredClone(judgeSequence[1]) as MonitorVerdict;
    v.tier = tier;
    const observation = judgeTierText(v, tier === 3 ? "tier3" : "observation")!;
    if (tier === 3) expect(observation).toContain("If this continues, Sospio may close this conversation.");
    else expect(observation).not.toContain("If this continues");
    expect(observation).toContain("Sospio");
    const options = {
      ...OPTIONS,
      ...governorTextOptions(v, {
        ...OPTIONS,
        tier3Text: { noticeText: "fallback notice", augmentContext: "fallback context" },
      }),
    };
    expect(options.tier3Text).toBeUndefined();
    const plan = planFromVerdict(v)!;
    const { surface, calls } = recordingSurface();
    const executions = await executeGovernorPlan(plan, surface, options);
    const record = buildGovernorActionRecord(plan, executions, v, options);
    expect(calls).toEqual([`notice:${observation}`, `arm:augment_request_context:${observation}`]);
    expect(record.tier).toBe(tier);
    expect(record.context_additions).toEqual([observation]);
    expect(record.presented_text).toBe(`${observation}\n\n${OPTIONS.originalCandidateText}`);
  });

  it("executes Tier 4 as terminate_exchange on the browser surface", async () => {
    const v = verdict([signal("sycophancy", 0.2)], {
      tier: 4,
      tier_reason: "persistence",
      selected_mechanisms: ["terminate_exchange"],
      monitor_profile_id: "m0_default",
      intervention_profile_id: "m0_default",
      policy_mode: "m0_ladder",
    });
    const plan = planFromVerdict(v)!;
    const { surface, calls } = recordingSurface();

    const executions = await executeGovernorPlan(plan, surface, {
      ...OPTIONS,
      terminateText: "close it",
      terminateCountdownSeconds: 3,
    });

    expect(calls).toEqual(["terminate:close it:3"]);
    // The stub surface reports nothing back, so the receipt says so rather than
    // claiming a closure. The detail string previously asserted the outcome in
    // prose regardless of what happened.
    expect(executions).toEqual([
      {
        mechanism: "terminate_exchange",
        timing: "retroactive",
        status: "applied",
        detail: "closure unverified; transcript unverified",
        observed: {
          closed_to_further_turns: "unverified",
          transcript_preserved: "unverified",
          verified_at: null,
        },
      },
    ]);
  });

  it("carries an observed termination outcome into the execution and receipt", async () => {
    const v = verdict([signal("sycophancy", 0.2)], {
      tier: 4,
      tier_reason: "persistence",
      selected_mechanisms: ["terminate_exchange"],
      monitor_profile_id: "m0_default",
      intervention_profile_id: "m0_default",
      policy_mode: "m0_ladder",
    });
    const plan = planFromVerdict(v)!;
    const { surface } = recordingSurface();
    const observing = {
      ...surface,
      terminateExchange: async () => ({
        closed_to_further_turns: true as const,
        transcript_preserved: true as const,
        verified_at: "2026-09-05T00:00:00.000Z",
      }),
    };

    const executions = await executeGovernorPlan(plan, observing, OPTIONS);
    const record = buildGovernorActionRecord(plan, executions, v, OPTIONS);

    expect(executions[0].detail).toBe(
      "exchange observed closed to further turns; transcript present",
    );
    expect(record.state_at_termination?.closed_to_further_turns).toBe(true);
    expect(record.state_at_termination?.verified_at).toBe("2026-09-05T00:00:00.000Z");
  });

  it("records a termination that did not hold as false, not as closed", async () => {
    // A composer that comes back after the countdown is the failure mode the
    // MutationObserver exists to prevent. If it happens anyway, the receipt has
    // to say so — this is the rung where being wrong costs most.
    const v = verdict([signal("sycophancy", 0.2)], {
      tier: 4,
      tier_reason: "persistence",
      selected_mechanisms: ["terminate_exchange"],
      monitor_profile_id: "m0_default",
      intervention_profile_id: "m0_default",
      policy_mode: "m0_ladder",
    });
    const plan = planFromVerdict(v)!;
    const { surface } = recordingSurface();
    const observing = {
      ...surface,
      terminateExchange: async () => ({
        closed_to_further_turns: false as const,
        transcript_preserved: true as const,
        verified_at: "2026-09-05T00:00:00.000Z",
      }),
    };

    const executions = await executeGovernorPlan(plan, observing, OPTIONS);
    const record = buildGovernorActionRecord(plan, executions, v, OPTIONS);

    expect(executions[0].detail).toContain("NOT closed");
    expect(record.state_at_termination?.closed_to_further_turns).toBe(false);
  });

  it("records termination state without claiming the transcript was replaced", async () => {
    const v = verdict([signal("sycophancy", 0.2)], {
      tier: 4,
      tier_reason: "persistence",
      selected_mechanisms: ["terminate_exchange"],
      policy_mode: "m0_ladder",
    });
    const plan = planFromVerdict(v)!;
    const { surface } = recordingSurface();

    const executions = await executeGovernorPlan(plan, surface, {
      ...OPTIONS,
      terminateText: "close it",
      terminateCountdownSeconds: 3,
    });
    const record = buildGovernorActionRecord(plan, executions, v, {
      ...OPTIONS,
      terminateText: "close it",
      terminateCountdownSeconds: 3,
    });

    expect(record.user_visible).toBe(true);
    expect(record.state_at_termination).toEqual({
      mechanism: "terminate_exchange",
      closed_to_further_turns: "unverified",
      transcript_preserved: "unverified",
      verified_at: null,
      countdown_seconds: 3,
      enforcement: "browser_composer_disabled_after_countdown",
    });
    expect(record.original_candidate_text).toBe("raw candidate text");
    expect(record.presented_text).toBe("close it\n\nraw candidate text");
  });

  it("keeps v3 tiers explicit and lets legacy v2 records stay parseable", () => {
    const base = {
      schema_version: "rsh_browser_governor_action_v3" as const,
      action_id: "action-1",
      turn_id: "turn-1",
      provider: "chatgpt" as const,
      policy_version: BROWSER_GOVERNOR_POLICY_VERSION,
      authority_profile_id: BROWSER_GOVERNOR_AUTHORITY_PROFILE,
      observed_at: "2026-08-18T00:00:00.000Z",
      monitor_version: "p1_keyword_event_monitor_v1",
      threshold: 0.7,
      tier: null,
      tier_reason: "legacy_threshold_path",
      monitor_profile_id: null,
      intervention_profile_id: null,
      policy_mode: "legacy_threshold",
      triggering_signals: [{ name: "harmful_content", confidence: 0.93, intensity: 0.74 }],
      user_visible: true,
      executions: [],
    } satisfies GovernorActionRecord;
    const withTier: GovernorActionRecord = { ...base, tier: 4 };
    const {
      tier: _tier,
      tier_reason: _tierReason,
      monitor_profile_id: _monitorProfileId,
      intervention_profile_id: _interventionProfileId,
      policy_mode: _policyMode,
      ...legacyBase
    } = base;
    const legacy: LegacyGovernorActionRecord = {
      ...legacyBase,
      schema_version: "rsh_browser_governor_action_v2",
    };

    expect(withTier.tier).toBe(4);
    expect(base.tier).toBeNull();
    expect(legacy.tier).toBeUndefined();
    if (false) {
      // @ts-expect-error Tier 5 must stay unavailable; the browser arm skips Tier 3, not renumbering 4.
      const invalidTier: GovernorActionRecord = { ...base, tier: 5 };
      void invalidTier;
    }
  });
});

import { buildPooledNoticeReceipt } from "./governorLoop";
import type { TurnEvent } from "../shared/types";

it("preserves unknown confidence in judge tier plans and pooled receipts", () => {
  const tierVerdict = judgeSequence[0] as MonitorVerdict;
  expect(planFromVerdict(tierVerdict)?.triggering_signals).toEqual([
    { name: "overreliance_signals", confidence: null, intensity: 0.7 },
  ]);
  const pooledVerdict = judgeSequence[5] as MonitorVerdict;
  const notice = pooledVerdict.judge_ladder!.pooled[0];
  const receipt = buildPooledNoticeReceipt({ turn_id: pooledVerdict.turn_id, provider: "chatgpt" } as TurnEvent, pooledVerdict, notice, 0.7);
  expect(receipt.triggering_signals).toEqual([{ name: "overreliance_signals", confidence: null }]);
  expect(receipt.tier).toBeNull();
});

it('passes the planned tier to the page notice',async()=>{
 const displayNotice=vi.fn().mockResolvedValue(undefined);
 const {surface}=recordingSurface({displayNotice});
 const plan=planFromVerdict(verdict([signal('sycophancy')],{tier:3,selected_mechanisms:['display_governor_notice']}),{threshold:0.7});
 await executeGovernorPlan(plan!,surface,{...OPTIONS,noticeText:'recorded notice'});
 expect(displayNotice).toHaveBeenCalledWith('recorded notice',3,true);
});

it.each([true,false])("passes planned augmentation to the notice (allowed=%s)",async allowed=>{
 const displayNotice=vi.fn().mockResolvedValue(undefined);
 const {surface}=recordingSurface({displayNotice});
 const plan=planFromVerdict(verdict([signal("confidence_calibration")],{tier:2,selected_mechanisms:["display_governor_notice","augment_request_context"]}),{allowed:allowed?["display_governor_notice","augment_request_context"]:["display_governor_notice"]})!;
 await executeGovernorPlan(plan,surface,OPTIONS);
 expect(displayNotice).toHaveBeenCalledWith(OPTIONS.noticeText,2,allowed);
});
