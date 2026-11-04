import type { ChatModelChoice } from "../../shared/types";
import { CLEAR_TOKEN_CONFIRM, CLEAR_TOKEN_LABEL } from "../../../../shared/clearToken";
import { Markdown } from "./Markdown";
import { HOSTED_COPY } from "../../shared/hostedCopy";
import { CLOSED_TITLE, CLOSED_BODY } from "../../shared/interventionCopy";
import React, { useEffect, useRef, useState } from "react";
import { useCountdown } from "@sospio/cockpit";
import type {
  HarnessState,
  JudgeSignal,
  LocalInterventionReceipt,
  TurnRecord,
} from "../../shared/types";
import { judgeSignalLabel, judgeUnavailableText } from "../../shared/judgeLadder";
import { ModelPicker } from "./ModelPicker";
import { StatusLight } from "./StatusLight";
import "./chat.css";
export function conversationTitle(state: HarnessState): string {
  const first = state.messages.find((m) => m.role === "user")?.content;
  if (!first) return "New conversation";
  if (first.length <= 60) return first;
  const short = first.slice(0, 60);
  return (
    short.slice(0, short.lastIndexOf(" ") > 0 ? short.lastIndexOf(" ") : 60) +
    "…"
  );
}
export function copyTranscriptText(state: HarnessState): string {
  const entries: string[] = [];
  let ordinal = 0;
  const restored =
    state.turnHistory === "partial"
      ? Math.max(
          0,
          state.messages.filter((m) => m.role === "user").length -
            state.turns.length -
            (state.isGenerating ? 1 : 0),
        )
      : 0;
  for (const message of state.messages) {
    if (message.role === "user") ordinal++;
    const record = state.turns[ordinal - restored - 1];
    if (message.role === "user" && record)
      for (const receipt of record.interventionReceipts ?? []) {
        if (
          receipt.tier === 3 &&
          receipt.executions.some(
            (e) =>
              e.mechanism === "augment_request_context" &&
              e.status === "completed",
          )
        )
          for (const text of receipt.context_additions ?? [])
            entries.push(`Sospio: ${text}`);
      }
    const notice =
      message.role === "assistant"
        ? record?.interventionReceipts?.find((r) =>
            r.executions.some(
              (e) =>
                e.mechanism === "display_governor_notice" &&
                e.status === "completed",
            ),
          )
        : undefined;
    entries.push(
      `${message.role === "user" ? "You" : message.role === "assistant" ? "Assistant" : "Sospio"}: ${notice?.original_candidate_text ?? message.content}`,
    );
    if (message.role === "assistant" && record) {
      for (const receipt of attachedReceipts(state, record)) {
        const text = receiptNoticeText(receipt, record);
        if (text) entries.push(`Sospio: ${text}`);
      }
      for (const event of record.verdict?.judge_ladder?.pooled ?? [])
        if (event.kind !== "suppressed") entries.push(`Sospio: ${event.text}`);
    }
  }
  return entries.join("\n\n");
}
export function receiptNoticeText(
  receipt: LocalInterventionReceipt,
  governing: TurnRecord,
): string | undefined {
  if (governing.verdict?.utility_notice)
    return governing.verdict.utility_notice.text;
  const text = receipt.presented_text,
    original = receipt.original_candidate_text;
  if (text && original && text.endsWith("\n\n" + original))
    return text.slice(0, -original.length - 2);
  return text;
}
function Tier3Divider({
  record,
  state,
  ordinal,
}: {
  record: TurnRecord;
  state: HarnessState;
  ordinal: number;
}) {
  return (
    <>
      {(record.interventionReceipts ?? [])
        .filter(
          (r) =>
            r.tier === 3 &&
            r.context_additions?.length &&
            r.executions.some(
              (e) =>
                e.mechanism === "augment_request_context" &&
                e.status === "completed",
            ),
        )
        .map((r) => {
          const governing = state.turns.find((t) => t.turn.turn_id === r.governing_turn_id) ?? record;
          const judge = !!governing.verdict?.judge_ladder;
          if (judge) return null;
          return (
            <div className="sospio-chat-divider" key={r.receipt_id}>
              <strong>
                Sospio added an instruction for the
                assistant · Tier 3
              </strong>
              <details>
                <summary>
                  For turn {ordinal}, Sospio added this instruction to the assistant's context. Show instruction
                </summary>
                <p>{r.context_additions!.join("\n\n")}</p>
              </details>
            </div>
          );
        })}
    </>
  );
}

export function attachedReceipts(
  state: HarnessState,
  record: TurnRecord,
): LocalInterventionReceipt[] {
  return state.turns
    .flatMap((r) => r.interventionReceipts ?? [])
    .filter(
      (r) =>
        (r.governing_turn_id ?? r.turn_id) === record.turn.turn_id &&
        r.executions.some(
          (e) =>
            e.mechanism === "display_governor_notice" &&
            e.status === "completed",
        ),
    );
}
export function ChatPane({
  state,
  onShowTurns,
  onShowTurn,
  models,
  onSelectModel,
  onClearToken,
}: {
  state: HarnessState;
  onShowTurns: (ordinals: number[]) => void;
  onShowTurn: (ordinal: number) => void;
  models: ChatModelChoice[];
  onSelectModel: (name: string) => void;
  onClearToken?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [hidden, setHidden] = useState<string[]>([]);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = state.termination
    ? new Date(
        Date.parse(state.termination.terminated_at) + 10000,
      ).toISOString()
    : undefined;
  const n = useCountdown(end);
  const closing = !!end && n > 0,
    closed = !!end && !closing;
  const disabled = state.isGenerating || !!state.setupMessage || !!end;
  useEffect(() => {
    // Braces matter: some Chromium builds (Arc) return a Promise from scrollTo, and React
    // would call an effect's non-undefined return value as its cleanup, blanking the app.
    log.current?.scrollTo?.({ top: log.current.scrollHeight });
  }, [state.messages]);
  const notices = state.turns.flatMap((r) => attachedReceipts(state, r));
  const latestNotice = notices.filter((receipt) => {
    const governing = state.turns.find(r => r.turn.turn_id === (receipt.governing_turn_id ?? receipt.turn_id));
    return governing && !isRepeatFinalNote(state, governing, receipt);
  }).at(-1)?.receipt_id;
  let ordinal = 0;
  const send = async () => {
    if (disabled || !draft.trim()) return;
    const text = draft;
    setDraft("");
    input.current?.focus();
    try {
      await window.harness!.sendMessage(text);
    } catch (e) {
      setError(String(e));
    }
  };
  const dismiss = async (id: string, signal: JudgeSignal) => {
    try {
      await window.harness!.dismissJudgeNotice(id, signal);
      setHidden((prev) => [
        ...prev,
        ...state.turns.map((r) => r.turn.turn_id + ":" + signal),
      ]);
    } catch {
      setError("Could not dismiss the notice. Please try again.");
    }
  };
  return (
    <section className="sospio-chat">
      <header>
        <div className="sospio-chat-heading">
          <strong title={conversationTitle(state)}>{conversationTitle(state)}</strong>
          <div className="sospio-chat-status">
            <StatusLight state={state} onShowTurn={onShowTurn} />
            {closed && <small>Closed</small>}
          </div>
        </div>
        <div className="sospio-chat-actions">
          <button className="sospio-chat-new" onClick={() => void window.harness!.newConversation()}>
            New conversation
          </button>
          {onClearToken && (
            <button
              className="sospio-clear-token"
              onClick={() => { if (window.confirm(CLEAR_TOKEN_CONFIRM)) onClearToken(); }}
            >
              {CLEAR_TOKEN_LABEL}
            </button>
          )}
        </div>
        <div className="sospio-chat-utilities">
          <details className="sospio-chat-session">
            <summary>Session details</summary>
            <div className="sospio-chat-session-panel">
              <p>Sospio chat · checking {state.monitorHealth === "bypassed" ? "off" : "on"}</p>
              {state.messages.length > 0 && (
                <div className="sospio-chat-model">
                  <span>Assistant model <strong>{state.modelState.chatModel}{state.modelState.chatProvider === "openrouter" ? HOSTED_COPY.hostedSuffix : ""}</strong></span>
                  <small>Fixed for this conversation</small>
                </div>
              )}
              {state.hostedSpend && <p>{HOSTED_COPY.spend(state.hostedSpend.spent_usd, state.hostedSpend.cap_usd)}</p>}
            </div>
          </details>
        </div>
      </header>
      {state.setupMessage && (
        <aside className="setup">{state.setupMessage}</aside>
      )}
      {error && <p role="alert">{error}</p>}
      <div
        role="log"
        aria-label="Conversation"
        className="sospio-chat-log"
        ref={log}
      >
        <div className="sospio-chat-content">
          {!state.messages.length && (
            <ModelPicker
              capReason={state.hostedSpend?.exhausted ? HOSTED_COPY.cap(state.hostedSpend.cap_usd) : undefined}
              models={models}
              selected={state.modelState.chatModel}
              onSelect={onSelectModel}
            />
          )}
          {state.messages.map((message) => {
            if (message.role === "user") ordinal++;
            const current = ordinal;
            const restored =
              state.turnHistory === "partial"
                ? Math.max(
                    0,
                    state.messages.filter((m) => m.role === "user").length -
                      state.turns.length -
                      (state.isGenerating ? 1 : 0),
                  )
                : 0;
            const record = state.turns[current - restored - 1];
            if (message.role === "governor")
              return (
                <aside key={message.id} className="sospio-chat-notice">
                  <strong>Sospio</strong>
                  <p>{message.content}</p>
                </aside>
              );
            const candidate =
              message.role === "assistant"
                ? record?.interventionReceipts?.find((r) =>
                    r.executions.some(
                      (e) =>
                        e.mechanism === "display_governor_notice" &&
                        e.status === "completed",
                    ),
                  )
                : undefined;
            return (
              <React.Fragment key={message.id}>
                {message.role === "user" &&
                  record &&
                   (
                    <Tier3Divider
                      record={record}
                      state={state}
                      ordinal={current}
                    />
                  )}
                <article
                  className={`sospio-chat-message sospio-chat-${message.role}${message.failed ? " sospio-chat-error" : ""}`}
                >
                  <small>
                    {message.failed
                      ? "harness error"
                      : message.role === "user"
                        ? `Turn ${current} · You`
                        : "Assistant"}
                  </small>
                  {message.role === "assistant" && !message.failed ? (
                    <Markdown text={candidate?.original_candidate_text ??
                      (message.content || (message.streaming ? "…" : ""))} />
                  ) : (
                    <div>
                      {candidate?.original_candidate_text ??
                        (message.content || (message.streaming ? "…" : ""))}
                    </div>
                  )}
                </article>
                {message.role === "assistant" &&
                  record &&
                   (
                    <>
                      {attachedReceipts(state, record).map((r) => {
                        const body = receiptNoticeText(r, record);
                        const deliveredOrdinal = r.tier === 2 || (r.tier === 3 && record.verdict?.judge_ladder)
                          ? noteDeliveryOrdinal(state, r) : undefined;
                        const repeat = isRepeatFinalNote(state, record, r);
                        const labels = record.verdict?.judge_ladder?.acting_signals.map(judgeSignalLabel).join(', ') ||
                          record.verdict?.signals.filter(s => s.fired).map(s => judgeSignalLabel(s.name)).join(', ');
                        return body ? (
                          <details
                            className={`sospio-chat-notice${repeat ? ' sospio-chat-repeat' : ''}`}
                            key={r.receipt_id}
                            open={repeat ? undefined : r.receipt_id === latestNotice}
                          >
                            <summary>
                              {repeat ? <>
                                Sospio repeated its final note · {labels} · turn {current} <span>Show note</span>
                              </> : <>
                                Sospio {r.tier === 2 ? 'observation' : r.tier === 3 ? 'note' : 'notice'} · Tier {r.tier ?? 1}
                                <span>Possible {labels} · turn {current}</span>
                              </>}
                            </summary>
                            <div>
                              <p>{body}</p>
                              {r.tier === 1 &&
                                !body.includes("Only you see this") && (
                                  <p>
                                    Only you see this. The assistant doesn't receive
                                    it.
                                  </p>
                                )}
                              {deliveredOrdinal !== undefined && (
                                <p>{r.tier === 2
                                  ? `Sospio added this same observation to the assistant's context for turn ${deliveredOrdinal}, marked as Sospio's.`
                                  : `Sospio added this same note to the assistant's context for turn ${deliveredOrdinal}.`}</p>
                              )}
                              <button
                                onClick={(e) => {
                                  e.currentTarget.closest("details")!.open =
                                    false;
                                }}
                              >
                                Hide
                              </button>
                              <button
                                onClick={() =>
                                  onShowTurn(
                                    record.verdict?.judge_ladder
                                      ?.turn_ordinal ?? current,
                                  )
                                }
                              >
                                Why this may be mistaken
                              </button>
                            </div>
                          </details>
                        ) : null;
                      })}
                      {(record.verdict?.judge_ladder?.pooled ?? [])
                        .filter((e) => e.kind !== "suppressed")
                        .map((event) => {
                          const id = record.turn.turn_id + ":" + event.signal;
                          if (
                            hidden.includes(id) ||
                            state.dismissedJudgeNotices?.includes(id)
                          )
                            return null;
                          return (
                            <aside
                              className="sospio-chat-notice"
                              role="status"
                              key={id}
                            >
                              <strong>
                                Sospio ·{" "}
                                {event.kind === "check_in"
                                  ? "check-in"
                                  : "possible pattern"}
                              </strong>
                              <p>{event.text}</p>
                              {event.kind === "check_in" && (
                                <button
                                  onClick={() =>
                                    onShowTurns(
                                      event.cited.map((c) => c.ordinal),
                                    )
                                  }
                                >
                                  Look at these turns
                                </button>
                              )}
                              <button
                                onClick={() =>
                                  void dismiss(
                                    record.turn.turn_id,
                                    event.signal,
                                  )
                                }
                              >
                                {event.kind === "check_in"
                                  ? "Continue"
                                  : "Dismiss"}
                              </button>
                            </aside>
                          );
                        })}
                    </>
                  )}
              </React.Fragment>
            );
          })}
          {
            Object.entries(
              state.turns.at(-1)?.verdict?.judge_ladder?.signals ?? {},
            )
              .filter(([, s]) => s.monitoring_unavailable)
              .map(([s]) => (
                <aside role="status" key={s}>
                  {judgeUnavailableText(s as JudgeSignal)}
                </aside>
              ))}
          {closing && (
            <aside role="status" className="sospio-chat-close">
              <small>Sospio · Tier 4</small>
              <strong>This conversation will close in {n} seconds</strong>
              <p>{state.termination?.notice}</p>
            </aside>
          )}
        </div>
      </div>
      <footer>
        {closed ? (
          <div className="sospio-chat-close">
            <strong>{CLOSED_TITLE}</strong>
            <p>{CLOSED_BODY}</p>
            <button
              onClick={() =>
                void navigator.clipboard.writeText(copyTranscriptText(state))
              }
            >
              Copy transcript
            </button>
            <button onClick={() => void window.harness!.newConversation()}>
              Start a new conversation
            </button>
          </div>
        ) : (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <textarea
                aria-label="Message"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void send();
                  }
                }}
                ref={input}
                // Stay editable while a reply generates: disabling the box drops keyboard focus.
                // send() still refuses until the turn is done, and the Send button stays disabled.
                disabled={!!state.setupMessage || !!end}
                placeholder={
                  closing
                    ? "Closing…"
                    : state.setupMessage
                      ? "Complete setup first"
                      : "Message"
                }
              />
              <button disabled={disabled || !draft.trim()}>Send</button>
            </form>
            {closing && (
              <p>
                Closing in {n} s. This can't be cancelled. The transcript remains readable.
              </p>
            )}
          </>
        )}
      </footer>
    </section>
  );
}

/**
 * Candidate and request receipts are separate; pair by carrier and governing turn.
 * A note shown with its own turn's reply rides the next turn's request, so the
 * carrier is the notice's turn (held for N+1) or the one after it (same-turn).
 */
export function noteDeliveryOrdinal(state: HarnessState, notice: LocalInterventionReceipt): number | undefined {
  const index = state.turns.findIndex((r) => r.turn.turn_id === notice.turn_id);
  if (index < 0 || state.turnHistory === "partial") return undefined;
  for (const carrier of [index, index + 1]) {
    const record = state.turns[carrier];
    const delivered = record?.interventionReceipts?.some((r) =>
      r.turn_id === record.turn.turn_id && r.governing_turn_id === notice.governing_turn_id &&
      r.executions.some((e) => e.mechanism === "augment_request_context" && e.status === "completed"));
    if (delivered) return carrier + 1;
  }
  return undefined;
}

// Keep the existing helper name for consumers of Tier 2 delivery pairing.
export const tier2DeliveryOrdinal = noteDeliveryOrdinal;

function noticeCount(record: TurnRecord, phase: 'policy_before' | 'policy_after'): number | undefined {
  const ladder = record.verdict?.judge_ladder?.signals.emotional_dependence?.ladder as
    {policy_before?: {notice_count: number}; policy_after?: {notice_count: number}; notice_seen_before?: boolean; notice_seen_after?: boolean} | undefined;
  const seen = phase === 'policy_before' ? ladder?.notice_seen_before : ladder?.notice_seen_after;
  return seen === undefined ? ladder?.[phase]?.notice_count : Number(seen);
}

/** Compact only with ED monitored; require a prior displayed Final note and no reset. */
export function isRepeatFinalNote(state: HarnessState, record: TurnRecord, receipt: LocalInterventionReceipt): boolean {
  const block = record.verdict?.judge_ladder;
  if (receipt.tier !== 3 || !block?.acting_signals.length ||
      !block.signals.emotional_dependence || block.signals.emotional_dependence.category === 'not_monitored') return false;
  const index = state.turns.indexOf(record);
  return block.acting_signals.every(signal => {
    if (signal === 'emotional_dependence' && !(Number(noticeCount(record, 'policy_before')) > 0)) return false;
    for (let i = index - 1; i >= 0; i--) {
      const earlier = state.turns[i];
      if (earlier.turn.session_id !== record.turn.session_id) return false;
      const detail = earlier.verdict?.judge_ladder?.signals[signal];
      if (!detail || (signal === 'emotional_dependence'
        ? !(Number(noticeCount(earlier, 'policy_after')) > 0)
        : detail.ladder.acting_tier < 3)) return false;
      if (detail.ladder.acting_tier === 3 && earlier.verdict?.judge_ladder?.acting_signals.includes(signal) &&
          attachedReceipts(state, earlier).some(r => r.tier === 3 && receiptNoticeText(r, earlier))) return true;
      if (signal === 'emotional_dependence' && noticeCount(earlier, 'policy_before') === 0) return false;
    }
    return false;
  });
}
