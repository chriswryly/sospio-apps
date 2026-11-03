import { randomUUID } from "node:crypto";
import { REHEARSAL_NOTICE_PREFIX } from "./config";
import type {
  ConversationMessage,
  InterventionTier,
  LocalInterventionExecution,
  LocalInterventionMechanism,
  LocalInterventionPlanSource,
  LocalInterventionReceipt,
  NoInterventionReason,
} from "../shared/types";

export const LOCAL_POLICY_ADAPTER_VERSION = "local_policy_adapter_v1";
export const LOCAL_ORCHESTRATOR_AUTHORITY_PROFILE = "local_orchestrator_full_v1";

const REQUEST_MECHANISMS = new Set<LocalInterventionMechanism>(["augment_request_context"]);
const CANDIDATE_MECHANISMS = new Set<LocalInterventionMechanism>([
  "display_governor_notice",
  "withhold_candidate",
  "visibly_redact_candidate",
  "replace_presentation",
]);
// Tier 4 acts on the session after delivery, so it is neither a request nor a
// candidate mechanism: the delivered turn is not touched.
const SESSION_MECHANISMS = new Set<LocalInterventionMechanism>(["terminate_exchange"]);
const TERMINAL_PRECEDENCE: LocalInterventionMechanism[] = [
  "withhold_candidate",
  "visibly_redact_candidate",
  "replace_presentation",
];

export type PlanAttribution = {
  source: LocalInterventionPlanSource;
  /** The turn whose verdict produced this plan, absent for rehearsal plans. */
  governingTurnId?: string;
  tier?: InterventionTier;
  tierReason?: string;
};

export type LocalInterventionPlan = {
  planId: string;
  policyVersion: string;
  attribution: PlanAttribution;
  mechanisms: LocalInterventionMechanism[];
  contextAddition: string;
  noticeText: string;
  withheldText: string;
  redactionText: string;
  replacementText: string;
};

export type RequestInterventionInput = {
  turnId: string;
  systemPrompt: string;
  messages: ConversationMessage[];
};

export type RequestInterventionResult = {
  systemPrompt: string;
  messages: ConversationMessage[];
  receipt?: LocalInterventionReceipt;
};

export type CandidateInterventionInput = {
  turnId: string;
  candidateText: string;
};

export type CandidateInterventionResult = {
  presentedText: string;
  receipt?: LocalInterventionReceipt;
};

export type SessionControlResult = {
  terminated: boolean;
  notice?: string;
  receipt?: LocalInterventionReceipt;
};

export class LocalInterventionExecutor {
  constructor(private readonly plan: LocalInterventionPlan | null) {}

  executeBeforeChat(input: RequestInterventionInput): RequestInterventionResult {
    const mechanisms = this.mechanismsFor(REQUEST_MECHANISMS);
    if (!this.plan || mechanisms.length === 0) {
      return { systemPrompt: input.systemPrompt, messages: input.messages };
    }

    let systemPrompt = input.systemPrompt;
    const contextAdditions: string[] = [];
    const executions: LocalInterventionExecution[] = [];
    for (const mechanism of mechanisms) {
      if (mechanism === "augment_request_context") {
        systemPrompt = appendSystemContext(systemPrompt, this.plan.contextAddition);
        contextAdditions.push(this.plan.contextAddition);
        executions.push({
          mechanism,
          stage: "request",
          status: "completed",
          detail: "ordinary request context appended before local model call",
        });
      }
    }

    return {
      systemPrompt,
      messages: input.messages,
      receipt: this.receipt(input.turnId, false, executions, { context_additions: contextAdditions }),
    };
  }

  executeAfterCandidate(input: CandidateInterventionInput): CandidateInterventionResult {
    const mechanisms = this.mechanismsFor(CANDIDATE_MECHANISMS);
    if (!this.plan || mechanisms.length === 0) {
      return { presentedText: input.candidateText };
    }

    const terminalWinner = TERMINAL_PRECEDENCE.find((mechanism) => mechanisms.includes(mechanism));
    const completedMechanism = terminalWinner ?? (mechanisms.includes("display_governor_notice") ? "display_governor_notice" : undefined);
    const presentedText = this.presentedCandidateText(input.candidateText, completedMechanism);
    const executions = mechanisms.map((mechanism): LocalInterventionExecution => {
      if (mechanism === completedMechanism) {
        return {
          mechanism,
          stage: "candidate",
          status: "completed",
          detail: completedCandidateDetail(mechanism),
        };
      }
      return {
        mechanism,
        stage: "candidate",
        status: "superseded",
        superseded_by: completedMechanism,
        detail: `${mechanism} was superseded by ${completedMechanism}.`,
      };
    });

    return {
      presentedText,
      receipt: this.receipt(input.turnId, true, executions, {
        original_candidate_text: input.candidateText,
        presented_text: presentedText,
      }),
    };
  }

  /**
   * Tier 4. Ends the exchange without retracting the delivered turn.
   * Called when the governing verdict lands, not on a later turn: the
   * message it responded to has already reached the user by then.
   */
  executeSessionControl(governingTurnId: string): SessionControlResult {
    const mechanisms = this.mechanismsFor(SESSION_MECHANISMS);
    if (!this.plan || mechanisms.length === 0) {
      return { terminated: false };
    }
    const executions = mechanisms.map((mechanism): LocalInterventionExecution => ({
      mechanism,
      stage: "session",
      status: "completed",
      detail:
        "exchange closed to further turns after delivery; the delivered turn was not retracted",
    }));
    return {
      terminated: true,
      notice: this.plan.noticeText,
      receipt: this.receipt(governingTurnId, true, executions, {}),
    };
  }

  /**
   * A receipt for a turn that produced no intervention. Keeps "nothing fired"
   * and "the monitor failed" distinguishable in the log, where they are
   * identical on screen.
   */
  static noInterventionReceipt(
    turnId: string,
    reason: NoInterventionReason,
  ): LocalInterventionReceipt {
    return {
      schema_version: "rsh_local_intervention_receipt_v2",
      receipt_id: randomUUID(),
      turn_id: turnId,
      plan_id: "none",
      policy_version: LOCAL_POLICY_ADAPTER_VERSION,
      authority_profile_id: LOCAL_ORCHESTRATOR_AUTHORITY_PROFILE,
      created_at: new Date().toISOString(),
      user_visible: false,
      no_intervention_reason: reason,
      executions: [],
    };
  }

  /**
   * A receipt for a notice-utility notice. The utility shows it outside the
   * executor, so nothing executed here; the receipt records that a notice
   * exists for this turn and whether it was the one on screen.
   */
  static utilityNoticeReceipt(
    turnId: string,
    noticeId: string,
    userVisible: boolean,
  ): LocalInterventionReceipt {
    return {
      schema_version: "rsh_local_intervention_receipt_v2",
      receipt_id: randomUUID(),
      turn_id: turnId,
      plan_id: "notice_utility",
      policy_version: LOCAL_POLICY_ADAPTER_VERSION,
      authority_profile_id: LOCAL_ORCHESTRATOR_AUTHORITY_PROFILE,
      created_at: new Date().toISOString(),
      user_visible: userVisible,
      utility_notice_id: noticeId,
      executions: [],
    };
  }

  private mechanismsFor(allowed: Set<LocalInterventionMechanism>): LocalInterventionMechanism[] {
    return this.plan?.mechanisms.filter((mechanism) => allowed.has(mechanism)) ?? [];
  }

  private presentedCandidateText(
    candidateText: string,
    completedMechanism: LocalInterventionMechanism | undefined,
  ): string {
    if (!this.plan || !completedMechanism) {
      return candidateText;
    }
    if (completedMechanism === "display_governor_notice") {
      return `${this.governorText(this.plan.noticeText)}\n\n${candidateText}`;
    }
    if (completedMechanism === "withhold_candidate") {
      return this.governorText(this.plan.withheldText);
    }
    if (completedMechanism === "visibly_redact_candidate") {
      return this.governorText(this.plan.redactionText);
    }
    if (completedMechanism === "replace_presentation") {
      return this.governorText(this.plan.replacementText);
    }
    return candidateText;
  }

  /**
   * A rehearsed intervention must be distinguishable from a live one wherever
   * it appears, not only in the receipt (plan section 3.4). The screen is the
   * surface where mistaking one for the other actually misleads someone.
   */
  private governorText(text: string): string {
    return this.plan?.attribution.source === "rehearsal_fixture"
      ? `${REHEARSAL_NOTICE_PREFIX} ${text}`
      : text;
  }

  private receipt(
    turnId: string,
    userVisible: boolean,
    executions: LocalInterventionExecution[],
    patch: Partial<LocalInterventionReceipt>,
  ): LocalInterventionReceipt {
    if (!this.plan) {
      throw new Error("cannot create an intervention receipt without a plan");
    }
    const attribution = this.plan.attribution;
    return {
      schema_version: "rsh_local_intervention_receipt_v2",
      receipt_id: randomUUID(),
      turn_id: turnId,
      plan_id: this.plan.planId,
      policy_version: this.plan.policyVersion,
      authority_profile_id: LOCAL_ORCHESTRATOR_AUTHORITY_PROFILE,
      created_at: new Date().toISOString(),
      user_visible: userVisible,
      plan_source: attribution.source,
      ...(attribution.governingTurnId ? { governing_turn_id: attribution.governingTurnId } : {}),
      ...(attribution.tier ? { tier: attribution.tier } : {}),
      ...(attribution.tierReason ? { tier_reason: attribution.tierReason } : {}),
      executions,
      ...patch,
    };
  }
}

export function createLocalInterventionPlan(
  mechanisms: LocalInterventionMechanism[],
  params: {
    planId: string;
    policyVersion?: string;
    attribution: PlanAttribution;
    contextAddition: string;
    noticeText: string;
    withheldText: string;
    redactionText: string;
    replacementText: string;
  },
): LocalInterventionPlan | null {
  if (mechanisms.length === 0) {
    return null;
  }
  return {
    planId: params.planId,
    policyVersion: params.policyVersion ?? LOCAL_POLICY_ADAPTER_VERSION,
    attribution: params.attribution,
    mechanisms,
    contextAddition: params.contextAddition,
    noticeText: params.noticeText,
    withheldText: params.withheldText,
    redactionText: params.redactionText,
    replacementText: params.replacementText,
  };
}

function completedCandidateDetail(mechanism: LocalInterventionMechanism): string {
  if (mechanism === "display_governor_notice") {
    return "governor-attributed notice displayed with candidate";
  }
  if (mechanism === "withhold_candidate") {
    return "candidate withheld from presentation with governor attribution";
  }
  if (mechanism === "visibly_redact_candidate") {
    return "candidate replaced by a visible redaction surface";
  }
  if (mechanism === "replace_presentation") {
    return "candidate presentation replaced by governor-owned surface";
  }
  if (mechanism === "terminate_exchange") {
    return "exchange closed to further turns after delivery";
  }
  return "candidate mechanism completed";
}

function appendSystemContext(systemPrompt: string, addition: string): string {
  const trimmedPrompt = systemPrompt.trim();
  const trimmedAddition = addition.trim();
  if (!trimmedAddition) {
    return trimmedPrompt;
  }
  return trimmedPrompt ? `${trimmedPrompt}\n\n${trimmedAddition}` : trimmedAddition;
}
