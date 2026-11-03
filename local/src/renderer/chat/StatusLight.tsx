import React, { useEffect, useId, useRef, useState } from "react";
import type { HarnessState } from "../../shared/types";
import { JUDGE_SIGNAL_LABELS } from "../../shared/judgeLadder";
import { STATUS_LIGHT_COPY as copy } from "../../shared/statusLightCopy";
import { latestStatusReading, statusLight } from "./statusLightState";

const glyphs = { none: "○", green: "✓", amber: "!", red: "!!", grey: "–" };

export function StatusLight({ state, onShowTurn }: {
  state: HarnessState;
  onShowTurn: (ordinal: number) => void;
}) {
  return (
    <VisibleStatusLight key={state.sessionId} state={state} onShowTurn={onShowTurn} />
  );
}

function VisibleStatusLight({ state, onShowTurn }: {
  state: HarnessState;
  onShowTurn: (ordinal: number) => void;
}) {
  const light = statusLight(state);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("click", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("click", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const basis = latestStatusReading(state);
  const block = basis?.verdict?.judge_ladder;
  const hasNotice = !!basis && (
    state.turns.some((turn) => turn.interventionReceipts?.some((receipt) =>
      (receipt.governing_turn_id ?? receipt.turn_id) === basis.turn.turn_id &&
      receipt.executions.some((e) => e.mechanism === "display_governor_notice" && e.status === "completed"),
    )) ||
    block?.pooled.some((event) => event.kind !== "suppressed" &&
      !state.dismissedJudgeNotices?.includes(`${basis.turn.turn_id}:${event.signal}`)) ||
    (basis === state.turns.at(-1) && light.signals.some((s) => block?.signals[s.signal].monitoring_unavailable))
  );
  return (
    <div className="sospio-status-light" ref={container} data-level={light.level}>
      <button type="button" ref={trigger} aria-expanded={open} aria-controls={panelId}
        onClick={() => setOpen((previous) => !previous)}>
        <span aria-hidden="true" className={`sospio-status-glyph${light.checking ? " is-checking" : ""}`}>
          {glyphs[light.level]}
        </span>
        <span aria-live="polite" aria-atomic="true">{copy[light.level].label}</span>
      </button>
      {open && (
        <div className="sospio-status-popover" id={panelId}>
          <p>{copy[light.level].description}</p>
          {state.monitorRemote && state.monitorHealth === "error" && <p>{state.monitorLastError ?? "Monitor unavailable"}</p>}
          {light.basisOrdinal !== undefined && <p>{copy.basis(light.basisOrdinal)}</p>}
          {light.signals.length > 0 && <ul>{light.signals.map((signal) => (
            <li key={signal.signal}>
              {JUDGE_SIGNAL_LABELS[signal.signal]}: {signal.reading}
              {signal.tier > 0 && ` · ${copy.tier(signal.tier)}`}
            </li>
          ))}</ul>}
          {light.checking && <p>{copy.checking}</p>}
          <p>{copy.disclaimer}</p>
          {hasNotice && light.basisOrdinal !== undefined && (
            <button type="button" onClick={() => {
              setOpen(false);
              onShowTurn(light.basisOrdinal!);
            }}>{copy.showTurn(light.basisOrdinal)}</button>
          )}
        </div>
      )}
    </div>
  );
}
