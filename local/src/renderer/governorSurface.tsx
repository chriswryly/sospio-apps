import React from "react";
import type { HarnessState, LadderState, LocalInterventionReceipt, TurnRecord } from "../shared/types";

export function shortTurn(turnId: string): string {
  return turnId.slice(0, 8);
}

/**
 * "turn 2 (3f2a91c0)" for a turn in this conversation; the short id alone for
 * one that is not, or whenever earlier turn records are missing (a conversation
 * restored on relaunch), since the ordinal cannot then be known. Never invents one.
 */
export function turnLabel(turnId: string, turns: TurnRecord[], history: HarnessState["turnHistory"] = "complete"): string {
  const index = turns.findIndex((record) => record.turn.turn_id === turnId);
  return index < 0 || history === "partial" ? shortTurn(turnId) : `turn ${index + 1} (${shortTurn(turnId)})`;
}

const NONE_TEXT: Record<Extract<LadderState, { status: "none" }>["reason"], string | null> = {
  no_verdict_yet: null,
  terminated: null,
  session_terminated: null,
  consumed: "no active decision · the last one applied to the turn after it",
  shown_on_turn: "no active decision · the last notice was shown on the turn that caused it",
  no_ladder_decision: "no active decision",
  utility_no_notice: "no active decision",
  superseded_by_later_turn: "no active decision",
  no_applicable_mechanisms: "no active decision · the last decision could not be applied",
  monitor_unavailable: "monitor unavailable · no active decision",
};

/** The ladder decision in force for the next turn, from state rather than past verdicts. */
export function LadderStatus({ state }: { state: HarnessState }): JSX.Element | null {
  const ladder = state.ladder;
  if (!ladder) return null;
  if (ladder.status === "override") {
    return (
      <section className="ladder">
        <span className="plan-source rehearsal_fixture">REHEARSAL</span>
        <span className="muted">override on · live decisions are not applied</span>
      </section>
    );
  }
  if (ladder.status === "none") {
    const text = NONE_TEXT[ladder.reason];
    return text ? <section className="ladder"><span className="muted">{text}</span></section> : null;
  }
  return (
    <section className="ladder">
      <span className={`tier tier-${ladder.tier}`}>tier {ladder.tier}</span>
      <span className="muted">{ladder.tier_reason}</span>
      <span className="muted">
        from {turnLabel(ladder.governing_turn_id, state.turns, state.turnHistory)}, for the next turn ·{" "}
        {ladder.mechanisms.length === 0 ? "no mechanism selected" : ladder.mechanisms.join(", ")}
      </span>
    </section>
  );
}

export function TerminationBanner({ state }: { state: HarnessState }): JSX.Element | null {
  const termination = state.termination;
  if (!termination) return null;
  return (
    <section className="banner terminated">
      <strong>CONVERSATION CLOSED</strong> by Sospio after{" "}
      <code>{turnLabel(termination.governing_turn_id, state.turns, state.turnHistory)}</code> — {termination.tier_reason}
      {termination.plan_source === "rehearsal_fixture" && " · REHEARSAL"}
      <div className="muted">{termination.notice}</div>
      <div className="muted">Start a new conversation to continue.</div>
    </section>
  );
}

export function ReceiptInspector({
  receipts,
  turns,
  history,
}: {
  receipts: LocalInterventionReceipt[];
  turns: TurnRecord[];
  history?: HarnessState["turnHistory"];
}): JSX.Element {
  return (
    <div className="window receipts">
      <h3>Sospio receipts</h3>
      {receipts.length === 0 ? (
        <p className="muted">Sospio did not execute an intervention for this turn.</p>
      ) : (
        receipts.map((receipt) => (
          <article key={receipt.receipt_id} className="receipt">
            <div className="receipt-heading">
              <strong>{receipt.plan_id}</strong>
              <span>{receipt.user_visible ? "user-visible" : "request-stage"}</span>
            </div>
            <div className="receipt-meta">
              <span>{receipt.policy_version}</span>
              <span>{receipt.authority_profile_id}</span>
              {receipt.plan_source && (
                <span className={`plan-source ${receipt.plan_source}`}>
                  {receipt.plan_source === "rehearsal_fixture" ? "REHEARSAL" : "live verdict"}
                </span>
              )}
              {typeof receipt.tier === "number" && <span>tier {receipt.tier}</span>}
              {receipt.tier_reason && <span>{receipt.tier_reason}</span>}
            </div>
            {receipt.governing_turn_id && (
              // The whole point of this line: the intervention shown here was
              // caused by an earlier turn, and a governor that appears to react
              // to the wrong message is not contestable.
              <div className="receipt-cause">
                caused by <code>{turnLabel(receipt.governing_turn_id, turns, history)}</code>, applied to{" "}
                <code>{turnLabel(receipt.turn_id, turns, history)}</code>
              </div>
            )}
            {receipt.utility_notice_id && (
              <div className="receipt-cause">
                notice utility observation <code>{receipt.utility_notice_id}</code>
                {receipt.user_visible ? " · shown" : " · superseded on screen by a later turn"}
              </div>
            )}
            {receipt.no_intervention_reason && (
              <div className="receipt-cause muted">
                no intervention — {receipt.no_intervention_reason.replace(/_/g, " ")}
              </div>
            )}
            <div className="execution-list">
              {receipt.executions.map((execution) => (
                <div key={`${receipt.receipt_id}-${execution.stage}-${execution.mechanism}`} className={`execution ${execution.status}`}>
                  <span>{execution.stage}</span>
                  <strong>{execution.mechanism}</strong>
                  <em>{execution.status}{execution.superseded_by ? ` by ${execution.superseded_by}` : ""}</em>
                </div>
              ))}
            </div>
            {receipt.original_candidate_text && receipt.presented_text && (
              <details>
                <summary>Presentation diff</summary>
                <p><strong>Original</strong> {receipt.original_candidate_text}</p>
                <p><strong>Presented</strong> {receipt.presented_text}</p>
              </details>
            )}
          </article>
        ))
      )}
    </div>
  );
}
