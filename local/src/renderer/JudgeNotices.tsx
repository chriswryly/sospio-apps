import { JUDGE_SIGNAL_LABELS, judgeLimitReached, judgeReadingLabel, judgeUnavailableText } from "../shared/judgeLadder";
import React, { useState } from "react";
import type { JudgeSignal, MonitorVerdict, TurnRecord } from "../shared/types";

export function selectCitedTurns(turns: TurnRecord[], sessionId: string, ordinals: number[]): void {
  const ids = turns.filter((r) => r.turn.session_id === sessionId && ordinals.includes(r.verdict?.judge_ladder?.turn_ordinal ?? -1)).map((r) => r.turn.turn_id);
  document.querySelectorAll<HTMLElement>("[data-turn-id]").forEach((node) => {
    const selected = ids.includes(node.dataset.turnId ?? "");
    node.classList.toggle("judge-cited", selected);
    node.style.outline = selected ? "2px solid #d89c35" : "";
    node.setAttribute("aria-selected", String(selected));
  });
  const first = [...document.querySelectorAll<HTMLElement>("[data-turn-id]")].find((n) => ids.includes(n.dataset.turnId ?? ""));
  const container = first?.closest<HTMLElement>(".operator");
  if (first && container) container.scrollTop += first.getBoundingClientRect().top - container.getBoundingClientRect().top;
}

export function JudgeDetails({ verdict }: { verdict?: MonitorVerdict }): JSX.Element | null {
  const block = verdict?.judge_ladder;
  if (!block) return null;
  return <section aria-label="Per-signal judge ladder">
    {Object.entries(block.signals).map(([signal, value]) => <div key={signal}>
      <strong>{JUDGE_SIGNAL_LABELS[signal as JudgeSignal]}</strong> · ladder tier {value.ladder.acting_tier} · {judgeReadingLabel(value)}
      {value.evidence.current && <p style={{ whiteSpace: "pre-wrap" }}>Evidence: {value.evidence.current}</p>}
      {value.evidence.counter && <p style={{ whiteSpace: "pre-wrap" }}>Counterevidence: {value.evidence.counter}</p>}
    </div>)}
  </section>;
}

export function JudgeNotices({ turns, dismissed = [], dismiss }: {
  turns: TurnRecord[]; dismissed?: string[]; dismiss(turnId: string, signal: JudgeSignal): Promise<void>;
}): JSX.Element {
  const [hidden, setHidden] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  turns = turns.filter((r) => r.turn.session_id === turns.at(-1)?.turn.session_id);
  const latest = turns.filter((r) => r.verdict?.judge_ladder).at(-1);
  return <section aria-label="Sospio conversation notices">
    {latest && Object.entries(latest.verdict!.judge_ladder!.signals).filter(([, s]) => s.monitoring_unavailable || judgeLimitReached(s)).map(([signal, s]) =>
      <aside role="status" key={signal}>{judgeUnavailableText(signal as JudgeSignal, judgeLimitReached(s))}</aside>)}
    {turns.flatMap((record) => (record.verdict?.judge_ladder?.pooled ?? []).filter((e) => e.kind !== "suppressed").map((event) => {
      const id = record.turn.turn_id + ":" + event.signal;
      if (dismissed.includes(id) || hidden.includes(id)) return null;
      const hide = async (): Promise<void> => {
        try {
          await dismiss(record.turn.turn_id, event.signal);
          const ids = turns.filter((r) => r.turn.session_id === record.turn.session_id).map((r) => r.turn.turn_id + ":" + event.signal);
          setHidden((old) => [...old, ...ids]);
          setError(null);
        } catch { setError("Could not dismiss the notice. Please try again."); }
      };
      return <aside role="status" key={id}>
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{event.text}</p>
        {event.kind === "check_in" && <button onClick={() => selectCitedTurns(turns, record.turn.session_id, event.cited.map((c) => c.ordinal))}>Look at these turns</button>}
        <button onClick={() => void hide()}>{event.kind === "check_in" ? "Continue" : "Dismiss"}</button>
      </aside>;
    }))}
    {error && <p role="alert">{error}</p>}
  </section>;
}
