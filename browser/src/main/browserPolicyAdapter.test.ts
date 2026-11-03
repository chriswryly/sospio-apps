import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import {
  BROWSER_SIGNAL_ACTIONABILITY_THRESHOLD,
  mechanismTiming,
  planFromVerdict,
} from "./browserPolicyAdapter";
import type { MonitorSignal, MonitorVerdict } from "../shared/types";

function signal(name: string, confidence: number, fired = true): MonitorSignal {
  return { name, channel: "ai_system", fired, confidence, rationale: "test" };
}

function verdict(signals: MonitorSignal[], extra: Partial<MonitorVerdict> = {}): MonitorVerdict {
  return {
    turn_id: "turn-1",
    schema_version: "resilience_monitor_v1",
    signals,
    monitor_version: "test",
    latency_ms: 1,
    monitor_status: "primary",
    ...extra,
  };
}

describe("browser policy adapter", () => {
  it("returns no plan when nothing fired", () => {
    expect(planFromVerdict(verdict([signal("confidence_calibration", 0.9, false)]))).toBeNull();
  });

  it("returns no plan for an unmapped signal even at high confidence", () => {
    expect(planFromVerdict(verdict([signal("some_unmapped_signal", 0.99)]))).toBeNull();
  });

  it("never intervenes on an errored verdict", () => {
    // A monitor that failed has not said the turn is fine; it has said nothing. Intervening on
    // that would be acting on absence of evidence. 32 of the 172 recorded verdicts are errors.
    const errored = verdict([signal("harmful_content", 0.99)], { monitor_status: "error" });
    expect(planFromVerdict(errored)).toBeNull();
  });

  it("pins the confidence boundary", () => {
    const at = planFromVerdict(verdict([signal("confidence_calibration", BROWSER_SIGNAL_ACTIONABILITY_THRESHOLD)]));
    const below = planFromVerdict(verdict([signal("confidence_calibration", 0.69)]));
    expect(at).not.toBeNull();
    expect(below).toBeNull();
  });

  it("rejects an out-of-range threshold", () => {
    for (const threshold of [1.5, -0.1, Number.NaN]) {
      expect(() => planFromVerdict(verdict([signal("harmful_content", 0.9)]), { threshold })).toThrow();
    }
  });

  it("splits mechanisms by when they can act", () => {
    // confidence_calibration -> augment (next turn) + notice (retroactive).
    const plan = planFromVerdict(verdict([signal("confidence_calibration", 0.9)]));

    expect(plan?.policy_source).toBe("legacy_threshold");
    expect(plan?.tier).toBeNull();
    expect(plan?.retroactive).toEqual(["display_governor_notice"]);
    expect(plan?.next_turn).toEqual(["augment_request_context"]);
  });

  it("uses the Sospio tier instead of the signal identity when a tier is present", () => {
    const plan = planFromVerdict(verdict([signal("sycophancy", 0.1)], {
      tier: 2,
      tier_reason: "persistence",
      selected_mechanisms: ["display_governor_notice", "augment_request_context"],
      monitor_profile_id: "m0_default",
      intervention_profile_id: "m0_default",
      policy_mode: "m0_ladder",
    }));

    expect(plan?.policy_source).toBe("monitor_tier");
    expect(plan?.tier).toBe(2);
    expect(plan?.tier_reason).toBe("persistence");
    expect(plan?.retroactive).toEqual(["display_governor_notice"]);
    expect(plan?.next_turn).toEqual(["augment_request_context"]);
    expect(plan?.monitor_profile_id).toBe("m0_default");
    expect(plan?.intervention_profile_id).toBe("m0_default");
  });

  it("maps Tier 1 to notice-only and labels it as tiered", () => {
    const plan = planFromVerdict(verdict([signal("sycophancy", 0.1)], {
      tier: 1,
      tier_reason: "condition_active",
      selected_mechanisms: ["display_governor_notice"],
    }));

    expect(plan?.policy_source).toBe("monitor_tier");
    expect(plan?.retroactive).toEqual(["display_governor_notice"]);
    expect(plan?.next_turn).toEqual([]);
  });

  it("executes Tier 3 as notice plus next-turn observation", () => {
    const v = verdict([signal("sycophancy", 0.1)], {
      tier: 3, tier_reason: "persistence", selected_mechanisms: ["augment_request_context"],
    });
    const plan = planFromVerdict(v);
    expect(plan?.tier).toBe(3);
    expect(plan?.retroactive).toEqual(["display_governor_notice"]);
    expect(plan?.next_turn).toEqual(["augment_request_context"]);
    expect(plan?.capability_capped).toEqual([]);
    expect(plan?.arm_capability_limit).toEqual({ arm: "browser", status: "available" });
    const limited = planFromVerdict(v, { allowed: ["display_governor_notice"] });
    expect(limited?.retroactive).toEqual(["display_governor_notice"]);
    expect(limited?.next_turn).toEqual([]);
    expect(limited?.run_allowlist_excluded).toEqual([expect.objectContaining({
      mechanism: "augment_request_context", timing: "next_turn",
    })]);
  });

  it("maps Tier 4 to terminate_exchange now that the browser has an executor", () => {
    const plan = planFromVerdict(verdict([signal("sycophancy", 0.1)], {
      tier: 4,
      tier_reason: "persistence",
      selected_mechanisms: ["terminate_exchange"],
    }));

    expect(plan?.tier).toBe(4);
    expect(plan?.retroactive).toEqual(["terminate_exchange"]);
    expect(plan?.next_turn).toEqual([]);
    expect(plan?.capability_capped).toEqual([]);
    expect(plan?.arm_capability_limit).toEqual({ arm: "browser", status: "available" });
  });

  it("returns no tiered plan when the remote monitor selected no action", () => {
    const plan = planFromVerdict(verdict([signal("sycophancy", 0.1)], {
      tier: 1,
      tier_reason: "condition_inactive",
      selected_mechanisms: [],
    }));

    expect(plan).toBeNull();
  });

  it("lets a terminal supersede the notice, and records that it did", () => {
    // A replaced presentation has no surviving body for a notice to annotate.
    const plan = planFromVerdict(verdict([
      signal("confidence_calibration", 0.9), // -> augment + notice
      signal("harmful_content", 0.9),        // -> replace_presentation
    ]));

    expect(plan?.retroactive).toEqual(["replace_presentation"]);
    expect(plan?.superseded).toEqual([
      { mechanism: "display_governor_notice", superseded_by: "replace_presentation" },
    ]);
    // The forward-looking arm is unaffected by presentation precedence.
    expect(plan?.next_turn).toEqual(["augment_request_context"]);
  });

  it("is order-independent", () => {
    const a = planFromVerdict(verdict([signal("harmful_content", 0.9), signal("confidence_calibration", 0.9)]));
    const b = planFromVerdict(verdict([signal("confidence_calibration", 0.9), signal("harmful_content", 0.9)]));
    expect(a?.retroactive).toEqual(b?.retroactive);
    expect(a?.next_turn).toEqual(b?.next_turn);
  });

  it("honours an allowlist so the loop can be narrowed to the least restrictive mechanism", () => {
    const plan = planFromVerdict(
      verdict([signal("harmful_content", 0.9), signal("confidence_calibration", 0.9)]),
      { allowed: ["display_governor_notice"] },
    );

    expect(plan?.retroactive).toEqual(["display_governor_notice"]);
    expect(plan?.next_turn).toEqual([]);
  });

  it("records what the allowlist removed rather than dropping it silently", () => {
    const plan = planFromVerdict(
      verdict([signal("harmful_content", 0.9), signal("confidence_calibration", 0.9)]),
      { allowed: ["display_governor_notice"] },
    );

    expect(plan?.run_allowlist_excluded).toEqual([
      { mechanism: "replace_presentation", timing: "retroactive", reason: "not in this run's mechanism allowlist" },
      { mechanism: "augment_request_context", timing: "next_turn", reason: "not in this run's mechanism allowlist" },
    ]);
  });

  it("leaves the excluded list empty when no allowlist is set", () => {
    const plan = planFromVerdict(verdict([signal("harmful_content", 0.9)]));

    expect(plan?.run_allowlist_excluded).toEqual([]);
  });

  it("still plans when the allowlist excludes everything, so a receipt says why nothing ran", () => {
    // Previously this returned null: the governor selected a mechanism, the run forbade it, and
    // no record was written at all. the capture regression notes wants the
    // prevented intervention recorded as much as the executed one.
    const plan = planFromVerdict(verdict([signal("harmful_content", 0.9)]), {
      allowed: ["pause_request"],
    });

    expect(plan).not.toBeNull();
    expect(plan?.retroactive).toEqual([]);
    expect(plan?.next_turn).toEqual([]);
    expect(plan?.run_allowlist_excluded).toEqual([
      { mechanism: "replace_presentation", timing: "retroactive", reason: "not in this run's mechanism allowlist" },
    ]);
  });

  it("records an allowlist exclusion on the tiered path too", () => {
    const plan = planFromVerdict(
      verdict([signal("sycophancy", 0.9)], { tier: 2, tier_reason: "persistence" }),
      { allowed: ["display_governor_notice"] },
    );

    expect(plan?.retroactive).toEqual(["display_governor_notice"]);
    expect(plan?.run_allowlist_excluded).toEqual([
      { mechanism: "augment_request_context", timing: "next_turn", reason: "not in this run's mechanism allowlist" },
    ]);
  });

  it("records the triggering signals for the receipt", () => {
    const plan = planFromVerdict(verdict([
      signal("harmful_content", 0.91),
      signal("confidence_calibration", 0.5), // below threshold, must not appear
    ]));

    expect(plan?.triggering_signals).toEqual([{ name: "harmful_content", confidence: 0.91, intensity: null }]);
  });

  it("carries triggering signal intensity separately from confidence", () => {
    const plan = planFromVerdict(verdict([{
      ...signal("harmful_content", 0.91),
      intensity: 0.74,
    }]));

    expect(plan?.triggering_signals).toEqual([{ name: "harmful_content", confidence: 0.91, intensity: 0.74 }]);
  });

  it("classifies withhold as pre-delivery only", () => {
    // Not "the browser cannot withhold" — an earlier revision claimed that and it was wrong. The
    // CDP Response-stage hold point could support a monitor-gated withhold; this loop runs the
    // monitor after turn assembly, so it cannot reach it. See the inline-gate brief.
    expect(mechanismTiming("withhold_candidate")).toBe("pre_delivery_only");
    expect(mechanismTiming("replace_presentation")).toBe("retroactive");
    expect(mechanismTiming("augment_request_context")).toBe("next_turn");
    expect(mechanismTiming("terminate_exchange")).toBe("retroactive");
  });
});

it("notice-only observations never enter either legacy or tiered escalation", () => {
  expect(planFromVerdict(verdict([signal("harmful_content", 1)], {
    monitor_utility: { schema: "notice_utility_v1", decision: "P", authority: "notice_only" }, tier: 4, selected_mechanisms: ["terminate_exchange"],
  }))).toBeNull();
  expect(planFromVerdict(verdict([], { monitor_utility: { schema: "notice_utility_v1", decision: "P", authority: "notice_only" }, tier: 3 }))).toBeNull();
});

it("never falls back to a threshold mechanism on a judge hold", () => {
  expect(planFromVerdict(verdict([signal("overreliance_signals", 1)], { schema_version: "judge_ladder_verdict_v1" }))).toBeNull();
});
