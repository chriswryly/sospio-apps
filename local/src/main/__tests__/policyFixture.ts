import { readFileSync } from "node:fs";
import type {
  LocalInterventionMechanism,
  MonitorSignal,
  MonitorVerdict,
  VerdictIntervention,
} from "../../shared/types";
import {
  createLocalInterventionPlan,
  LOCAL_POLICY_ADAPTER_VERSION,
  type LocalInterventionPlan,
} from "../localInterventionExecutor";

export const LOCAL_POLICY_FIXTURE_SCHEMA_VERSION = "rsh_local_policy_fixture_v1";
// Test-fixture-scoped default until the production policy layer owns thresholds.
export const LOCAL_SIGNAL_ACTIONABILITY_THRESHOLD = 0.7;

const LOCAL_MECHANISMS = new Set<LocalInterventionMechanism>([
  "augment_request_context",
  "display_governor_notice",
  "withhold_candidate",
  "visibly_redact_candidate",
  "replace_presentation",
  "terminate_exchange",
]);

const SIGNAL_MECHANISMS: Record<string, LocalInterventionMechanism[]> = {
  confidence_calibration: ["augment_request_context", "display_governor_notice"],
  context_injection_indicators: ["augment_request_context", "display_governor_notice"],
  retrieved_content_trust: ["augment_request_context", "display_governor_notice"],
  tool_output_integrity: ["augment_request_context", "display_governor_notice"],
  assistant_manipulation: ["replace_presentation"],
  harmful_content: ["replace_presentation"],
  overreliance_signals: ["replace_presentation"],
};

const ADVISORY_MECHANISM_MAP: Record<string, LocalInterventionMechanism | null> = {
  annotate_candidate: "display_governor_notice",
  augment_request_context: "augment_request_context",
  discard_candidate: "withhold_candidate",
  display_governor_notice: "display_governor_notice",
  release_candidate: null,
  replace_presentation: "replace_presentation",
  route_human_review: "display_governor_notice",
  show_audit_details: null,
  visibly_redact_candidate: "visibly_redact_candidate",
  withhold_candidate: "withhold_candidate",
};

export type LocalPolicyDefaults = {
  contextAddition: string;
  noticeText: string;
  withheldText: string;
  redactionText: string;
  replacementText: string;
};

export type LocalPolicyFixture = {
  schema_version: typeof LOCAL_POLICY_FIXTURE_SCHEMA_VERSION;
  source: "test_fixture";
  fixture_id?: string;
  mechanisms?: LocalInterventionMechanism[];
  monitor_verdict?: MonitorVerdict;
  advisory_result?: AdvisoryPolicyResultFixture;
  context_addition?: string;
  notice_text?: string;
  withheld_text?: string;
  redaction_text?: string;
  replacement_text?: string;
  min_confidence?: number;
};

/**
 * Turn the monitorService's ladder decision into a plan for the *next* turn.
 *
 * A mechanism this client does not implement is a loud failure rather than a
 * degradation: after terminate_exchange landed there is nothing left to degrade
 * to, so reaching that branch means the ladder changed underneath the client
 * and that should be visible.
 */
export function planFromVerdictIntervention(
  intervention: VerdictIntervention,
  defaults: LocalPolicyDefaults,
  governingTurnId: string,
): LocalInterventionPlan | null {
  const mechanisms = unique(
    intervention.selected_mechanisms.map((mechanism) => {
      if (!LOCAL_MECHANISMS.has(mechanism as LocalInterventionMechanism)) {
        throw new LocalPolicyAdapterError(
          `ladder selected a mechanism this client does not implement: ${mechanism}`,
        );
      }
      return mechanism as LocalInterventionMechanism;
    }),
  );
  return createLocalInterventionPlan(mechanisms, {
    planId: `live_verdict:${governingTurnId}:tier_${intervention.tier}`,
    policyVersion: LOCAL_POLICY_ADAPTER_VERSION,
    attribution: {
      source: "live_verdict",
      governingTurnId,
      tier: intervention.tier,
      tierReason: intervention.tier_reason,
    },
    contextAddition: defaults.contextAddition,
    noticeText: defaults.noticeText,
    withheldText: defaults.withheldText,
    redactionText: defaults.redactionText,
    replacementText: defaults.replacementText,
  });
}

export type AdvisoryPolicyResultFixture = {
  schema_version?: string;
  plans?: AdvisoryPlanFixture[];
};

export type AdvisoryPlanFixture = {
  recipe_id?: string;
  requires_approval?: boolean;
  ordered_steps?: Array<{ mechanism?: string }>;
};

export class LocalPolicyAdapterError extends Error {}

export function loadLocalPolicyFixture(path: string): LocalPolicyFixture {
  return JSON.parse(readFileSync(path, "utf8")) as LocalPolicyFixture;
}

export function planFromLocalPolicyFixture(
  fixture: LocalPolicyFixture,
  defaults: LocalPolicyDefaults,
): LocalInterventionPlan | null {
  validateFixtureGate(fixture);
  const mechanisms = mechanismsFromFixture(fixture);
  const fixtureId = fixture.fixture_id?.trim() || "unnamed";
  return createLocalInterventionPlan(mechanisms, {
    planId: `local_policy_fixture:${fixtureId}`,
    policyVersion: LOCAL_POLICY_ADAPTER_VERSION,
    attribution: { source: "rehearsal_fixture" },
    contextAddition: fixture.context_addition ?? defaults.contextAddition,
    noticeText: fixture.notice_text ?? defaults.noticeText,
    withheldText: fixture.withheld_text ?? defaults.withheldText,
    redactionText: fixture.redaction_text ?? defaults.redactionText,
    replacementText: fixture.replacement_text ?? defaults.replacementText,
  });
}

function validateFixtureGate(fixture: LocalPolicyFixture): void {
  if (fixture.schema_version !== LOCAL_POLICY_FIXTURE_SCHEMA_VERSION) {
    throw new LocalPolicyAdapterError(
      `unsupported local policy fixture schema: ${String(fixture.schema_version)}`,
    );
  }
  if (fixture.source !== "test_fixture") {
    throw new LocalPolicyAdapterError("local policy adapter accepts only source=test_fixture");
  }
  if (fixture.min_confidence !== undefined) {
    validateThreshold(fixture.min_confidence);
  }
}

function mechanismsFromFixture(fixture: LocalPolicyFixture): LocalInterventionMechanism[] {
  validateSingleFixtureSource(fixture);
  if (fixture.mechanisms) {
    return unique(fixture.mechanisms.map(validateLocalMechanism));
  }
  if (fixture.advisory_result) {
    return mechanismsFromAdvisoryResult(fixture.advisory_result);
  }
  if (fixture.monitor_verdict) {
    return mechanismsFromMonitorVerdict(fixture.monitor_verdict, effectiveThreshold(fixture));
  }
  return [];
}

function validateSingleFixtureSource(fixture: LocalPolicyFixture): void {
  const present = [fixture.mechanisms, fixture.advisory_result, fixture.monitor_verdict].filter(
    (source) => source !== undefined,
  );
  if (present.length > 1) {
    throw new LocalPolicyAdapterError(
      "local policy fixture must specify exactly one of: mechanisms, advisory_result, monitor_verdict",
    );
  }
}

function effectiveThreshold(fixture: LocalPolicyFixture): number {
  const threshold = fixture.min_confidence ?? LOCAL_SIGNAL_ACTIONABILITY_THRESHOLD;
  validateThreshold(threshold);
  return threshold;
}

function validateThreshold(threshold: number): void {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new LocalPolicyAdapterError("local policy fixture min_confidence must be a finite number in [0, 1]");
  }
}

function mechanismsFromMonitorVerdict(verdict: MonitorVerdict, threshold: number): LocalInterventionMechanism[] {
  const mechanisms: LocalInterventionMechanism[] = [];
  for (const signal of verdict.signals) {
    if (!isActionableSignal(signal, threshold)) {
      continue;
    }
    mechanisms.push(...(SIGNAL_MECHANISMS[signal.name] ?? []));
  }
  return unique(mechanisms);
}

function mechanismsFromAdvisoryResult(result: AdvisoryPolicyResultFixture): LocalInterventionMechanism[] {
  const plans = result.plans ?? [];
  const selected = plans[0];
  if (!selected) {
    return [];
  }
  if (selected.requires_approval) {
    throw new LocalPolicyAdapterError("local policy fixture plan requires approval");
  }
  const mechanisms: LocalInterventionMechanism[] = [];
  for (const step of selected.ordered_steps ?? []) {
    if (!step.mechanism) {
      continue;
    }
    if (!(step.mechanism in ADVISORY_MECHANISM_MAP)) {
      throw new LocalPolicyAdapterError(`unsupported advisory mechanism for local adapter: ${step.mechanism}`);
    }
    const mapped = ADVISORY_MECHANISM_MAP[step.mechanism];
    if (mapped) {
      mechanisms.push(mapped);
    }
  }
  return unique(mechanisms);
}

function isActionableSignal(signal: MonitorSignal, threshold: number): boolean {
  return signal.fired && typeof signal.confidence === "number" && signal.confidence >= threshold && signal.name in SIGNAL_MECHANISMS;
}

function validateLocalMechanism(mechanism: LocalInterventionMechanism): LocalInterventionMechanism {
  if (!LOCAL_MECHANISMS.has(mechanism)) {
    throw new LocalPolicyAdapterError(`unsupported local intervention mechanism: ${mechanism}`);
  }
  return mechanism;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
