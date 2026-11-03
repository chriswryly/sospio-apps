import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MonitorVerdict } from "../../shared/types";
import {
  LOCAL_SIGNAL_ACTIONABILITY_THRESHOLD,
  loadLocalPolicyFixture,
  LocalPolicyAdapterError,
  planFromLocalPolicyFixture,
} from "./policyFixture";
import { LOCAL_POLICY_ADAPTER_VERSION } from "../localInterventionExecutor";

const defaults = {
  contextAddition: "Check the user's stated constraints before answering.",
  noticeText: "Governor notice",
  withheldText: "Governor withheld",
  redactionText: "Governor redaction",
  replacementText: "Governor replacement",
};

describe("local policy adapter", () => {
  it("maps an actionable monitor verdict fixture to a local executor plan", () => {
    const plan = planFromLocalPolicyFixture({
      schema_version: "rsh_local_policy_fixture_v1",
      source: "test_fixture",
      fixture_id: "confidence-calibration-fixture",
      monitor_verdict: verdict([
        { name: "confidence_calibration", fired: true, confidence: 0.82 },
        { name: "sycophancy", fired: true, confidence: 0.85 },
      ]),
    }, defaults);

    expect(plan).toMatchObject({
      planId: "local_policy_fixture:confidence-calibration-fixture",
      policyVersion: LOCAL_POLICY_ADAPTER_VERSION,
      mechanisms: ["augment_request_context", "display_governor_notice"],
    });
  });

  it("maps a fixture advisory plan through the local capability subset", () => {
    const plan = planFromLocalPolicyFixture({
      schema_version: "rsh_local_policy_fixture_v1",
      source: "test_fixture",
      fixture_id: "advisory-plan-fixture",
      advisory_result: {
        schema_version: "rsh_advisory_policy_v1",
        plans: [
          {
            recipe_id: "local_candidate_boundary",
            requires_approval: false,
            ordered_steps: [
              { mechanism: "annotate_candidate" },
              { mechanism: "replace_presentation" },
              { mechanism: "show_audit_details" },
            ],
          },
        ],
      },
    }, defaults);

    expect(plan?.mechanisms).toEqual(["display_governor_notice", "replace_presentation"]);
  });

  it("rejects non-fixture sources so live monitor verdicts cannot execute yet", () => {
    expect(() =>
      planFromLocalPolicyFixture({
        schema_version: "rsh_local_policy_fixture_v1",
        source: "live_monitor" as "test_fixture",
        monitor_verdict: verdict([{ name: "confidence_calibration", fired: true, confidence: 0.9 }]),
      }, defaults),
    ).toThrow(LocalPolicyAdapterError);
  });

  it("rejects approval-required advisory plans", () => {
    expect(() =>
      planFromLocalPolicyFixture({
        schema_version: "rsh_local_policy_fixture_v1",
        source: "test_fixture",
        advisory_result: {
          plans: [
            {
              requires_approval: true,
              ordered_steps: [{ mechanism: "withhold_candidate" }],
            },
          ],
        },
      }, defaults),
    ).toThrow("requires approval");
  });

  it("loads fixture JSON from disk", () => {
    const path = join(mkdtempSync(join(tmpdir(), "rsh-local-policy-")), "fixture.json");
    writeFileSync(
      path,
      JSON.stringify({
        schema_version: "rsh_local_policy_fixture_v1",
        source: "test_fixture",
        fixture_id: "file-fixture",
        mechanisms: ["replace_presentation"],
      }),
    );

    expect(loadLocalPolicyFixture(path).fixture_id).toBe("file-fixture");
  });

  it("pins the default monitor confidence threshold boundary", () => {
    expect(LOCAL_SIGNAL_ACTIONABILITY_THRESHOLD).toBe(0.7);

    const atThreshold = planFromLocalPolicyFixture({
      schema_version: "rsh_local_policy_fixture_v1",
      source: "test_fixture",
      monitor_verdict: verdict([{ name: "confidence_calibration", fired: true, confidence: 0.7 }]),
    }, defaults);
    const belowThreshold = planFromLocalPolicyFixture({
      schema_version: "rsh_local_policy_fixture_v1",
      source: "test_fixture",
      monitor_verdict: verdict([{ name: "confidence_calibration", fired: true, confidence: 0.69 }]),
    }, defaults);

    expect(atThreshold?.mechanisms).toEqual(["augment_request_context", "display_governor_notice"]);
    expect(belowThreshold).toBeNull();
  });

  it("allows fixture-specific confidence thresholds", () => {
    const plan = planFromLocalPolicyFixture({
      schema_version: "rsh_local_policy_fixture_v1",
      source: "test_fixture",
      min_confidence: 0.9,
      monitor_verdict: verdict([{ name: "confidence_calibration", fired: true, confidence: 0.82 }]),
    }, defaults);

    expect(plan).toBeNull();
  });

  it("rejects invalid fixture confidence thresholds", () => {
    for (const min_confidence of [-0.1, 1.5, Number.NaN]) {
      expect(() =>
        planFromLocalPolicyFixture({
          schema_version: "rsh_local_policy_fixture_v1",
          source: "test_fixture",
          min_confidence,
          monitor_verdict: verdict([{ name: "confidence_calibration", fired: true, confidence: 0.82 }]),
        }, defaults),
      ).toThrow("min_confidence");
    }
  });

  it("allows fixture text to override withhold and redaction surfaces", () => {
    const plan = planFromLocalPolicyFixture({
      schema_version: "rsh_local_policy_fixture_v1",
      source: "test_fixture",
      mechanisms: ["withhold_candidate", "visibly_redact_candidate"],
      withheld_text: "fixture withheld",
      redaction_text: "fixture redaction",
    }, defaults);

    expect(plan?.withheldText).toBe("fixture withheld");
    expect(plan?.redactionText).toBe("fixture redaction");
  });

  it("rejects ambiguous fixtures with multiple policy sources", () => {
    expect(() =>
      planFromLocalPolicyFixture({
        schema_version: "rsh_local_policy_fixture_v1",
        source: "test_fixture",
        mechanisms: ["replace_presentation"],
        monitor_verdict: verdict([{ name: "confidence_calibration", fired: true, confidence: 0.82 }]),
      }, defaults),
    ).toThrow("exactly one");
    expect(() =>
      planFromLocalPolicyFixture({
        schema_version: "rsh_local_policy_fixture_v1",
        source: "test_fixture",
        mechanisms: ["replace_presentation"],
        advisory_result: { plans: [] },
        monitor_verdict: verdict([{ name: "confidence_calibration", fired: true, confidence: 0.82 }]),
      }, defaults),
    ).toThrow("exactly one");
  });

  it("allows an explicit no-op fixture", () => {
    expect(planFromLocalPolicyFixture({
      schema_version: "rsh_local_policy_fixture_v1",
      source: "test_fixture",
      fixture_id: "noop",
    }, defaults)).toBeNull();
  });
});

function verdict(signals: Array<{ name: string; fired: boolean; confidence: number }>): MonitorVerdict {
  return {
    turn_id: "turn-1",
    schema_version: "resilience_monitor_v1",
    monitor_version: "fixture-monitor",
    latency_ms: 1,
    signals: signals.map((signal) => ({
      channel: "ai_system",
      rationale: "fixture",
      ...signal,
    })),
  };
}
