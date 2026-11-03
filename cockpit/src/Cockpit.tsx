import React, { useEffect, useRef, useState } from "react";
import type {
  BannerAction,
  CockpitView,
  Reading,
  ReceiptStatus,
  SignalKey,
} from "./contract";
import { SIGNALS, RUNGS, readingLabel, RECEIPTS } from "./vocabulary";
import { useCountdown } from "./countdown";
export function ReadingChip({
  reading,
  signal,
  compact = false,
}: {
  reading: Reading;
  signal: SignalKey;
  compact?: boolean;
}) {
  return (
    <span
      className={`sospio-ck-reading sospio-ck-${reading.kind}`}
      data-signal={signal}
    >
      {compact && `${SIGNALS[signal].icon} · `}
      {readingLabel(reading)}
    </span>
  );
}
export function ReceiptChip({ status }: { status: ReceiptStatus }) {
  const s = RECEIPTS[status];
  return (
    <span
      className={`sospio-ck-outcome sospio-ck-${status}`}
      style={{
        color: `var(--${s.fg})`,
        background: `var(--${s.bg})`,
        borderStyle: s.border,
      }}
    >
      {s.icon} {s.label}
    </span>
  );
}
export function Cockpit({
  view,
  now,
  selectedOrdinals,
  onAction,
}: {
  view: CockpitView;
  now?: Date;
  selectedOrdinals: number[];
  onAction: (action: BannerAction, ordinals?: number[]) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [dismissed, setDismissed] = useState<string>();
  const bannerId = JSON.stringify(view.banner);
  const b = dismissed === bannerId ? undefined : view.banner;
  const n = useCountdown(b?.kind === "countdown" ? b.endsAt : undefined, now);
  const selection = selectedOrdinals.join(",");
  useEffect(() => {
    if (!selectedOrdinals.length) return;
    const card = root.current?.querySelector<HTMLElement>(
      `[data-ordinal="${Math.max(...selectedOrdinals)}"]`,
    );
    card?.querySelectorAll("details").forEach((d) => (d.open = true));
    root.current
      ?.querySelectorAll<HTMLElement>('[aria-current="true"] details')
      .forEach((d) => ((d as HTMLDetailsElement).open = true));
    const scroll = root.current?.querySelector<HTMLElement>(".sospio-ck-scroll");
    if (card && scroll) {
      const bounds = scroll.getBoundingClientRect(), target = card.getBoundingClientRect();
      if (target.top < bounds.top) scroll.scrollTop += target.top - bounds.top;
      else if (target.bottom > bounds.bottom) scroll.scrollTop += Math.min(target.top - bounds.top, target.bottom - bounds.bottom);
    }
  }, [selection]);
  return (
    <div
      ref={root}
      className="sospio-ck"
      role="region"
      aria-label="Sospio conversation checker cockpit"
    >
      <header className="sospio-ck-header">
        <strong>Sospio</strong>
        <span className="sospio-ck-app">
          {view.app === "chat" ? "Chat app" : "Browser app"}
        </span>
        <span className="sospio-ck-count">{view.turnCountLabel}</span>
      </header>
      <div className="sospio-ck-model" aria-label="Assistant model in use">
        <span>Assistant model</span>
        <strong>{view.assistantModel.name}</strong>
        <small>{view.assistantModel.note}</small>
      </div>
      <div className="sospio-ck-scroll">
        <section className="sospio-ck-health" aria-label="Session status">
          <div className="sospio-ck-row">
            <h2>{view.health.title}</h2>
            <span>{view.health.tag}</span>
          </div>
          <p>{view.health.sub}</p>
          {view.latest && (
            <div className="sospio-ck-latest">
              <span>Latest action</span>
              <strong>{view.latest.text}</strong>
              <ReceiptChip status={view.latest.status} />
            </div>
          )}
        </section>
        <section className="sospio-ck-signals" aria-label="Signals">
          {view.signals.map((s) => (
            <div className="sospio-ck-signal" data-signal={s.key} key={s.key}>
              <div className="sospio-ck-row">
                <span className="sospio-ck-glyph" aria-hidden="true">
                  {SIGNALS[s.key].icon}
                </span>
                <div className="sospio-ck-signal-name">
                  <strong>{SIGNALS[s.key].name}</strong>
                  <small>{SIGNALS[s.key].side}</small>
                </div>
                <ReadingChip signal={s.key} reading={s.reading} />
              </div>
              <ol
                className="sospio-ck-ladder"
                aria-label={`${SIGNALS[s.key].name} ladder: ${!s.ladder.known ? "not reported" : s.ladder.tier ? `at Tier ${s.ladder.tier} of 4` : "no tier reached"}`}
              >
                {RUNGS.map((label, i) => (
                  <li
                    key={label}
                    className={
                      s.ladder.known && s.ladder.tier === i + 1
                        ? "sospio-ck-current"
                        : s.ladder.known && s.ladder.tier > i + 1
                          ? "sospio-ck-reached"
                          : ""
                    }
                  >
                    <strong>
                      {i + 1}
                      {s.ladder.known && s.ladder.tier === i + 1
                        ? " · now"
                        : ""}
                    </strong>
                    <span>{label}</span>
                  </li>
                ))}
              </ol>
              {!s.ladder.known && <p>Ladder not reported by this app yet</p>}
              {s.note && <p>{s.note}</p>}
            </div>
          ))}
        </section>
        {b && (
          <section
            className={`sospio-ck-banner sospio-ck-banner-${b.kind}`}
            data-signal={"signal" in b ? b.signal : undefined}
            role="status"
            aria-live="polite"
            aria-label={b.eyebrow}
          >
            <div className="sospio-ck-banner-main">
              {(b.kind === "countdown" || b.kind === "closed") && (
                <div className="sospio-ck-ring">
                  <svg
                    width="46"
                    height="46"
                    viewBox="0 0 46 46"
                    aria-hidden="true"
                  >
                    <circle
                      cx="23"
                      cy="23"
                      r="19"
                      fill="none"
                      stroke="var(--ring-track)"
                      strokeWidth="3"
                    />
                    <circle
                      cx="23"
                      cy="23"
                      r="19"
                      fill="none"
                      stroke="var(--ink)"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeDasharray="119.4"
                      strokeDashoffset={
                        b.kind === "countdown"
                          ? 119.4 * (1 - Math.min(n / b.totalSeconds, 1))
                          : 119.4
                      }
                      transform="rotate(-90 23 23)"
                    />
                  </svg>
                  <span>{b.kind === "closed" ? "✓" : n ? `${n}s` : "…"}</span>
                </div>
              )}
              <div>
                <small>{b.eyebrow}</small>
                <strong>
                  {b.kind === "countdown"
                    ? n
                      ? b.titleTemplate.replace("{n}", String(n))
                      : "Closing now…"
                    : b.title}
                </strong>
                <p>{b.body}</p>
              </div>
            </div>
            {b.kind !== "countdown" && b.buttons.length > 0 && (
              <div className="sospio-ck-buttons">
                {b.buttons.map((button) => (
                  <button
                    type="button"
                    className={button.primary ? "sospio-ck-primary" : ""}
                    key={button.action}
                    onClick={() => {
                      if (button.action === "dismiss") setDismissed(bannerId);
                      if (
                        button.action === "show_turns" ||
                        button.action === "look_together"
                      )
                        onAction(button.action, b.cited);
                      else onAction(button.action);
                    }}
                  >
                    {button.label}
                  </button>
                ))}
              </div>
            )}
          </section>
        )}
        <section className="sospio-ck-turns" aria-label="Turns and receipts">
          <div className="sospio-ck-row">
            <h3>Turns and receipts</h3>
            <small>Newest first</small>
          </div>
          {!view.turns.length && (
            <div className="sospio-ck-empty">
              Nothing yet. Each turn appears here with both readings, the
              evidence behind them, and a receipt for anything Sospio did.
            </div>
          )}
          {view.turns.map((t) => (
            <article
              key={t.ordinal}
              data-ordinal={t.ordinal}
              aria-label={t.unnumbered ? "Unnumbered capture" : `Turn ${t.ordinal}`}
              aria-current={
                selectedOrdinals.includes(t.ordinal) ? "true" : undefined
              }
              className="sospio-ck-turn"
            >
              <div className="sospio-ck-turn-head">
                <strong>{t.unnumbered ? "Unnumbered capture" : `Turn ${t.ordinal}`}</strong>
                <small>{t.time}</small>
                <div>
                  {view.signals.map((s) => (
                    <ReadingChip
                      key={s.key}
                      signal={s.key}
                      reading={t.readings[s.key] ?? {kind: "not_covered"}}
                      compact
                    />
                  ))}
                </div>
              </div>
              <div className="sospio-ck-transcript">
                <div>
                  <span>You: </span>
                  {t.user}
                </div>
                <div>
                  <span>Assistant: </span>
                  {t.assistant}
                </div>
              </div>
              {t.note && (
                <div
                  className={`sospio-ck-note ${t.note.hatched ? "sospio-ck-hatched" : ""}`}
                >
                  {t.note.text}
                </div>
              )}
              {t.evidence.map((e) => (
                <div
                  key={e.signal}
                  className="sospio-ck-evidence"
                  data-signal={e.signal}
                >
                  <strong>
                    {SIGNALS[e.signal].name} · {readingLabel(e.reading).toLowerCase()}
                  </strong>
                  <blockquote>{e.quote}</blockquote>
                  <div>
                    <strong>Why this may be mistaken: </strong>
                    {e.counter}
                  </div>
                </div>
              ))}
              {t.receipts.map((r) => (
                <div
                  className="sospio-ck-receipt"
                  key={r.id}
                  data-signal={r.signal ?? undefined}
                >
                  <div className="sospio-ck-row">
                    <span className="sospio-ck-tier">
                      {r.tier ? `Tier ${r.tier}` : "Notice"}
                    </span>
                    <strong>{r.title}</strong>
                    <ReceiptChip status={r.status} />
                  </div>
                  <p>{r.why}</p>
                  {r.text && (
                    <details
                      open={selectedOrdinals.includes(t.ordinal) || r.text.open}
                    >
                      <summary>{r.text.label}</summary>
                      <div className="sospio-ck-exact">{r.text.body}</div>
                    </details>
                  )}
                  <details open={selectedOrdinals.includes(t.ordinal)}>
                    <summary>Technical detail</summary>
                    <pre>
                      {r.technical.map(([k, v]) => `${k}: ${v}`).join("\n")}
                    </pre>
                  </details>
                </div>
              ))}
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}
