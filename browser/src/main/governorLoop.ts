import { randomUUID } from "node:crypto";
import { judgeTierText } from "../shared/monitorNotices";

import { mechanismTiming, type BrowserInterventionPlan } from "./browserPolicyAdapter";
import { REPLACE_PRESENTATION_TEXT } from "./capture/pageInterventionShim";
import type {
  GovernorActionExecution,
  GovernorActionRecord,
  MonitorVerdict,
  PooledNotice,
  TurnEvent,
  ProviderName,
  InterventionTier,
} from "../shared/types";
import type { TerminateVerification } from "./interventionExecutor";

/**
 * Execution half of the governor loop, with its surface dependencies injected.
 *
 * Kept separate from `index.ts` so it can be tested. The wire from verdict to intervention is the
 * most consequential code in the harness — it changes what a user sees on their own live account
 * with nobody watching — and it was the one part that had no coverage while the policy half had
 * twelve tests.
 */

/** What a receipt records when nothing observed the outcome. */
export const UNVERIFIED_TERMINATION = {
  closed_to_further_turns: "unverified",
  transcript_preserved: "unverified",
  verified_at: null,
} as const satisfies NonNullable<GovernorActionExecution["observed"]>;

function describeTermination(
  observed: NonNullable<GovernorActionExecution["observed"]>,
): string {
  const closed =
    observed.closed_to_further_turns === true
      ? "exchange observed closed to further turns"
      : observed.closed_to_further_turns === false
        ? "exchange NOT closed when checked after the countdown"
        : "closure unverified";
  const transcript =
    observed.transcript_preserved === true
      ? "transcript present"
      : observed.transcript_preserved === false
        ? "transcript NOT present"
        : "transcript unverified";
  return `${closed}; ${transcript}`;
}

export type GovernorSurface = {
  displayNotice(message: string, tier?: InterventionTier, hasNextTurnAugment?: boolean): Promise<void>;
  /** Act on the turn already rendered, not the next one. */
  replaceLatestPresentation(): Promise<void>;
  armRequest(mechanism: "pause_request" | "augment_request_context", context: string): Promise<void>;
  /**
   * Returns what the page was observed to be after the countdown. The result is
   * carried into the receipt rather than assumed: an earlier version discarded
   * it and recorded `closed_to_further_turns: true` unconditionally.
   */
  terminateExchange(
    message: string,
    countdownSeconds: number,
  ): Promise<TerminateVerification | void>;
};

export type GovernorExecutionOptions = {
  actionId?: string;
  provider: ProviderName;
  threshold: number;
  noticeText: string;
  augmentContext: string;
  tier3Text?: { noticeText: string; augmentContext: string };
  terminateText?: string;
  terminateCountdownSeconds?: number;
  originalCandidateText?: string;
  policyVersion?: string;
  authorityProfileId?: string;
};

export const BROWSER_GOVERNOR_POLICY_VERSION = "browser_policy_adapter_v1";
export const BROWSER_GOVERNOR_AUTHORITY_PROFILE = "browser_governor_surface_v1";
export const BROWSER_GOVERNOR_TERMINATE_EXCHANGE_TEXT =
  "Sospio is closing this conversation. The transcript will remain readable.";
export const BROWSER_GOVERNOR_TERMINATE_EXCHANGE_COUNTDOWN_SECONDS = 10;

/**
 * Apply a plan and return the receipt's executions.
 *
 * Every selected mechanism appears in the result, including the ones that were not applied, so a
 * reader can tell what the governor wanted to do from what it managed to do. A failure on one
 * mechanism never prevents the others: the monitor path must not break because a provider moved
 * a DOM node.
 */
export async function executeGovernorPlan(
  plan: BrowserInterventionPlan,
  surface: GovernorSurface,
  options: GovernorExecutionOptions,
): Promise<GovernorActionRecord["executions"]> {
  options = textForTier(plan, options);
  const executions: GovernorActionRecord["executions"] = [];

  for (const mechanism of plan.retroactive) {
    try {
      if (mechanism === "display_governor_notice") {
        await surface.displayNotice(options.noticeText, plan.tier ?? undefined, plan.next_turn.includes("augment_request_context"));
        executions.push({
          mechanism,
          timing: "retroactive",
          status: "applied",
          detail: "attributed notice displayed over the flagged turn",
        });
      } else if (mechanism === "replace_presentation") {
        await surface.replaceLatestPresentation();
        executions.push({
          mechanism,
          timing: "retroactive",
          status: "applied",
          detail: "flagged turn hidden behind a governor surface with a restore handle",
        });
      } else if (mechanism === "terminate_exchange") {
        const observed = await surface.terminateExchange(
          options.terminateText ?? BROWSER_GOVERNOR_TERMINATE_EXCHANGE_TEXT,
          terminationCountdownSeconds(options),
        );
        const outcome = observed ?? UNVERIFIED_TERMINATION;
        executions.push({
          mechanism,
          timing: "retroactive",
          status: "applied",
          // Describes what was seen, never what was intended.
          detail: describeTermination(outcome),
          observed: outcome,
        });
      } else {
        executions.push({
          mechanism,
          timing: "retroactive",
          status: "failed",
          detail: "no retroactive executor for this mechanism; policy timing table and executor disagree",
        });
      }
    } catch (error) {
      executions.push({
        mechanism,
        timing: "retroactive",
        status: "failed",
        detail: error instanceof Error ? error.message : "intervention failed",
      });
    }
  }

  for (const mechanism of plan.next_turn) {
    // Narrow explicitly. The plan's timing partition should guarantee these are request-side, but
    // an unchecked cast would hide a disagreement between the policy table and this executor.
    if (mechanism !== "pause_request" && mechanism !== "augment_request_context") {
      executions.push({
        mechanism,
        timing: "next_turn",
        status: "failed",
        detail: "not a request-side mechanism; policy timing table and executor disagree",
      });
      continue;
    }
    try {
      await surface.armRequest(mechanism, options.augmentContext);
      executions.push({
        mechanism,
        timing: "next_turn",
        status: "armed",
        armed_at: new Date().toISOString(),
        detail: "armed for the next outgoing request",
      });
    } catch (error) {
      executions.push({
        mechanism,
        timing: "next_turn",
        status: "failed",
        detail: error instanceof Error ? error.message : "arming failed",
      });
    }
  }

  for (const { mechanism, superseded_by } of plan.superseded) {
    executions.push({
      mechanism,
      timing: mechanismTiming(mechanism),
      status: "superseded",
      detail: `not applied; ${superseded_by} owns the presentation`,
      superseded_by,
    });
  }

  for (const { mechanism, reason } of plan.pre_delivery_only) {
    executions.push({ mechanism, timing: "pre_delivery_only", status: "pre_delivery_only", detail: reason });
  }

  for (const { mechanism, timing, reason } of plan.run_allowlist_excluded) {
    executions.push({
      mechanism,
      timing,
      status: "not_permitted",
      detail: reason,
    });
  }

  for (const { mechanism, timing, reason } of plan.capability_capped) {
    executions.push({
      mechanism,
      timing,
      status: "capability_capped",
      detail: reason,
    });
  }

  return executions;
}

export function buildGovernorActionRecord(
  plan: BrowserInterventionPlan,
  executions: GovernorActionRecord["executions"],
  verdict: MonitorVerdict,
  options: GovernorExecutionOptions,
): GovernorActionRecord {
  options = textForTier(plan, options);
  const presentation = presentationFields(executions, options);
  return {
    schema_version: "rsh_browser_governor_action_v3",
    action_id: options.actionId ?? randomUUID(),
    turn_id: plan.turn_id,
    provider: options.provider,
    policy_version: options.policyVersion ?? BROWSER_GOVERNOR_POLICY_VERSION,
    authority_profile_id: options.authorityProfileId ?? BROWSER_GOVERNOR_AUTHORITY_PROFILE,
    observed_at: new Date().toISOString(),
    monitor_version: verdict.monitor_version,
    threshold: options.threshold,
    tier: plan.tier,
    tier_reason: plan.tier_reason,
    monitor_profile_id: plan.monitor_profile_id ?? null,
    monitor_profile_version: plan.monitor_profile_version,
    intervention_profile_id: plan.intervention_profile_id ?? null,
    intervention_profile_version: plan.intervention_profile_version,
    policy_mode: plan.policy_mode,
    arm_capability_limit: plan.arm_capability_limit,
    triggering_signals: plan.triggering_signals,
    user_visible: userVisible(executions),
    executions,
    ...contextAdditionFields(executions, options),
    ...presentation,
    ...terminationStateFields(executions, options),
  };
}

function contextAdditionFields(
  executions: GovernorActionRecord["executions"],
  options: GovernorExecutionOptions,
): Pick<GovernorActionRecord, "context_additions"> {
  const augmented = executions.some((execution) =>
    execution.mechanism === "augment_request_context" && execution.status === "armed"
  );
  if (!augmented) {
    return {};
  }
  return { context_additions: [options.augmentContext] };
}

function userVisible(executions: GovernorActionRecord["executions"]): boolean {
  return executions.some((execution) =>
    (execution.mechanism === "display_governor_notice" ||
      execution.mechanism === "replace_presentation" ||
      execution.mechanism === "terminate_exchange") &&
    execution.status === "applied"
  );
}

function presentationFields(
  executions: GovernorActionRecord["executions"],
  options: GovernorExecutionOptions,
): Pick<GovernorActionRecord, "original_candidate_text" | "presented_text"> {
  const original = options.originalCandidateText;
  if (original === undefined) {
    return {};
  }
  const terminated = executions.some((execution) =>
    execution.mechanism === "terminate_exchange" && execution.status === "applied"
  );
  if (terminated) {
    return {
      original_candidate_text: original,
      presented_text: `${options.terminateText ?? BROWSER_GOVERNOR_TERMINATE_EXCHANGE_TEXT}\n\n${original}`,
    };
  }
  const replaced = executions.some((execution) =>
    execution.mechanism === "replace_presentation" && execution.status === "applied"
  );
  if (replaced) {
    return {
      original_candidate_text: original,
      presented_text: REPLACE_PRESENTATION_TEXT,
    };
  }
  const noticed = executions.some((execution) =>
    execution.mechanism === "display_governor_notice" && execution.status === "applied"
  );
  if (noticed) {
    return {
      original_candidate_text: original,
      presented_text: `${options.noticeText}\n\n${original}`,
    };
  }
  return {};
}

function terminationStateFields(
  executions: GovernorActionRecord["executions"],
  options: GovernorExecutionOptions,
): Pick<GovernorActionRecord, "state_at_termination"> {
  const terminated = executions.some((execution) =>
    execution.mechanism === "terminate_exchange" && execution.status === "applied"
  );
  if (!terminated) {
    return {};
  }
  // Read the outcome off the execution rather than restating it. This block
  // previously hardcoded `true` for both fields, so the persisted receipt
  // asserted a closure nobody had looked for.
  const observed =
    executions.find(
      (execution) =>
        execution.mechanism === "terminate_exchange" && execution.status === "applied",
    )?.observed ?? UNVERIFIED_TERMINATION;
  return {
    state_at_termination: {
      mechanism: "terminate_exchange",
      closed_to_further_turns: observed.closed_to_further_turns,
      transcript_preserved: observed.transcript_preserved,
      verified_at: observed.verified_at,
      countdown_seconds: terminationCountdownSeconds(options),
      enforcement: "browser_composer_disabled_after_countdown",
    },
  };
}

function terminationCountdownSeconds(options: GovernorExecutionOptions): number {
  return Math.max(
    0,
    Math.floor(options.terminateCountdownSeconds ?? BROWSER_GOVERNOR_TERMINATE_EXCHANGE_COUNTDOWN_SECONDS),
  );
}


export function buildPooledNoticeReceipt(
  turn: TurnEvent, verdict: MonitorVerdict, notice: PooledNotice, threshold: number,
): GovernorActionRecord {
  return {
    schema_version: "rsh_browser_governor_action_v3", action_id: randomUUID(), turn_id: turn.turn_id,
    provider: turn.provider, policy_version: verdict.judge_ladder!.pooled_version,
    authority_profile_id: "notice_only", observed_at: new Date().toISOString(), monitor_version: verdict.monitor_version,
    threshold, tier: null, tier_reason: notice.kind, monitor_profile_id: null,
    intervention_profile_id: null, policy_mode: "pooled_uncertainty", triggering_signals: [{ name: notice.signal, confidence: null }],
    user_visible: true, executions: [], pooled_notice: notice, presented_text: notice.text,
  };
}

function textForTier(plan: BrowserInterventionPlan, options: GovernorExecutionOptions): GovernorExecutionOptions {
  return plan.tier === 3 && options.tier3Text ? { ...options, ...options.tier3Text } : options;
}

/** Keep the remote monitor's attributed observations ahead of provisional fallback copy. */
export function governorTextOptions(
  verdict: MonitorVerdict,
  fallback: Pick<GovernorExecutionOptions, "noticeText" | "augmentContext" | "tier3Text">,
): Pick<GovernorExecutionOptions, "noticeText" | "augmentContext" | "tier3Text"> {
  const kind = verdict.tier === 1 ? "tier1" : verdict.tier === 3 ? "tier3" : "observation";
  const observation = judgeTierText(verdict, kind);
  return {
    noticeText: observation ?? fallback.noticeText,
    augmentContext: observation ?? fallback.augmentContext,
    tier3Text: observation ? undefined : fallback.tier3Text,
  };
}

/** Persist every planned mechanism even when the live surface cannot receive it. */
export function blockedGovernorExecutions(plan: BrowserInterventionPlan, block: {
  status: "failed" | "superseded"; detail: string;
}): GovernorActionExecution[] {
  const mechanisms = new Set([
    ...plan.retroactive, ...plan.next_turn, ...plan.superseded.map(x => x.mechanism),
    ...plan.pre_delivery_only.map(x => x.mechanism),
    ...plan.run_allowlist_excluded.map(x => x.mechanism), ...plan.capability_capped.map(x => x.mechanism),
  ]);
  return [...mechanisms].map(mechanism => ({ mechanism, timing: plan.next_turn.includes(mechanism as never) ? "next_turn" : "retroactive", ...block }));
}
