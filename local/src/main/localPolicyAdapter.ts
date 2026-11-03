import type {LocalInterventionMechanism, VerdictIntervention} from "../shared/types";
import {createLocalInterventionPlan, LOCAL_POLICY_ADAPTER_VERSION, type LocalInterventionPlan} from "./localInterventionExecutor";
const LOCAL_MECHANISMS = new Set<LocalInterventionMechanism>([
  "augment_request_context",
  "display_governor_notice",
  "withhold_candidate",
  "visibly_redact_candidate",
  "replace_presentation",
  "terminate_exchange",
]);

export type LocalPolicyDefaults = {
  contextAddition: string;
  noticeText: string;
  withheldText: string;
  redactionText: string;
  replacementText: string;
};

export class LocalPolicyAdapterError extends Error {}

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

function unique<Value>(items: Value[]): Value[] {return Array.from(new Set(items));}
