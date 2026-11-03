import { judgeUnavailableText } from "../shared/monitorNotices";
import {
  COCKPIT_VIEW_SCHEMA,
  PENDING_TURN_NOTE,
  RUNGS,
  SIGNALS,
  lastReadingNote,
  pendingHealth,
  validateCockpitView,
  type CockpitView,
  type Reading,
  type SignalKey,
  type SignalView,
  type Tier,
  type ReceiptView,
  type BannerView,
  type ReceiptStatus,
} from "@sospio/cockpit";
import {
  cockpitVerdict,
  cockpitActions,
  cockpitOrdinal,
  type DemoRunView,
  type DemoTurnView,
} from "./demoViewModel";
import type { JudgeSignal } from "../shared/types";
const baseKeys: SignalKey[] = ["sycophancy", "overreliance"];
const judgeKey = (k: SignalKey): JudgeSignal =>
  k === "overreliance" ? "overreliance_signals" : k;
const signalKey = (k: string): SignalKey =>
  k === "sycophancy" || k === "emotional_dependence" ? k : "overreliance";
function reading(turn: DemoTurnView, key: SignalKey): Reading {
  const v = cockpitVerdict(turn);
  const detail = v?.judge_ladder?.signals[judgeKey(key)];
  if (detail)
    return detail.category === "positive"
      ? { kind: "flagged", strength: detail.band as "present" | "strong" }
      : {
          kind:
            detail.category === "absent"
              ? "clear"
              : (detail.category === "unjudged" || detail.category === "not_monitored")
                ? "not_covered"
                : detail.category,
        };
  if (["pending", "queued"].includes(turn.monitorStatus))
    return { kind: "pending" };
  const s = turn.fundedSignals.find((s) => s.name === judgeKey(key));
  if (turn.monitorError || s?.intensity === "unavailable")
    return { kind: "unavailable" };
  if (!s) return { kind: "not_covered" };
  if (v?.monitor_utility)
    return v.monitor_utility.decision === "P"
      ? { kind: "flagged", strength: "present" }
      : { kind: v.monitor_utility.decision === "N" ? "clear" : "unavailable" };
  return s.fired ? { kind: "flagged", strength: "present" } : { kind: "clear" };
}
function sycophancySource(
  run: DemoRunView,
  records: DemoTurnView[],
  card: DemoTurnView,
): DemoTurnView | undefined {
  if (!records.some((t) => cockpitVerdict(t)?.judge_ladder)) return card;
  return records.find((t) => {
    const block = cockpitVerdict(t)?.judge_ladder;
    const detail = block?.signals.sycophancy;
    if (
      !detail ||
      (detail.category === "unjudged" || detail.category === "not_monitored") ||
      t.auditDetails.captureProvenance.sessionId !==
        card.auditDetails.captureProvenance.sessionId
    )
      return false;
    return block!.turn_ordinal === cockpitOrdinal(run, card) + 1;
  });
}
export function browserPooledSelection(
  run: DemoRunView,
  dismissed: string[] = [],
) {
  const session = run.turns.at(-1)?.auditDetails.captureProvenance.sessionId;
  for (const turn of [...run.turns].reverse()) {
    if (turn.auditDetails.captureProvenance.sessionId !== session) continue;
    for (const event of [
      ...(cockpitVerdict(turn)?.judge_ladder?.pooled ?? []),
    ].reverse()) {
      if (
        event.kind !== "suppressed" &&
        !dismissed.includes(turn.turnId + ":" + event.signal)
      )
        return { turn, event };
    }
  }
  return undefined;
}
function receipts(turn: DemoTurnView): ReceiptView[] {
  return cockpitActions(turn).flatMap<ReceiptView>((a) => {
    const technical: Array<[string, string]> = [
      ["action_id", a.action_id],
      ["policy_mode", a.policy_mode],
      ["monitor_profile_id", a.monitor_profile_id ?? "unknown"],
      ["intervention_profile_id", a.intervention_profile_id ?? "unknown"],
      ...a.executions.map((e, i): [string, string] => [
        `execution_${i}`,
        `${e.mechanism}: ${e.status} — ${e.detail}`,
      ]),
    ];
    if (a.tier === null && a.pooled_notice)
      return [
        {
          id: a.action_id,
          tier: null,
          signal: signalKey(a.pooled_notice.signal),
          title:
            a.pooled_notice.kind === "check_in"
              ? "Check-in shown"
              : "Possible-pattern notice shown",
          status: "shown",
          why: "The notice was shown; uncertainty does not move the ladder.",
          text: {
            label: "Text shown to you",
            body: a.presented_text ?? a.pooled_notice.text,
            open: false,
          },
          technical: [
            ...technical,
            ["signal", a.pooled_notice.signal],
            ["cited", a.pooled_notice.cited.map((c) => c.ordinal).join(", ")],
            [
              "pooled_version",
              cockpitVerdict(turn)?.judge_ladder?.pooled_version ?? "unknown",
            ],
          ],
        } satisfies ReceiptView,
      ];
    return a.executions.flatMap((e, i) => {
      if (e.status === "superseded" || e.status === "pre_delivery_only")
        return [];
      const check =
        e.mechanism === "terminate_exchange"
          ? (e.observed?.closed_to_further_turns ??
            a.state_at_termination?.closed_to_further_turns)
          : undefined;
      const status: ReceiptStatus =
        check === true
          ? "verified"
          : check === false
            ? "failed"
            : e.status === "applied"
              ? "unverified"
              : e.status === "armed"
                ? "queued"
                : e.status === "capability_capped"
                  ? "capped"
                  : e.status;
      const text =
        e.mechanism === "augment_request_context"
          ? a.context_additions?.join("\n\n")
          : a.presented_text;
      const trigger = a.triggering_signals.find((s) =>
        ["sycophancy", "overreliance_signals", "emotional_dependence"].includes(s.name),
      );
      return [
        {
          id: a.action_id + ":" + i,
          tier: a.tier,
          signal: trigger ? signalKey(trigger.name) : null,
          title:
            e.mechanism === "augment_request_context"
              ? a.tier === 3
                ? "Final observation added to your next message"
                : "Observation added to your next message"
              : e.mechanism === "display_governor_notice"
                ? a.tier === 3
                  ? "Final observation shown to you"
                  : "Notice shown to you"
                : e.mechanism === "terminate_exchange"
                  ? "Close conversation"
                  : e.mechanism.replaceAll("_", " "),
          status,
          why:
            check === true
              ? "Reading the page confirmed it was closed to further turns."
              : check === false
                ? "Reading the page showed it was still open to further turns."
                : status === "unverified"
                  ? "The action was applied; its result was not verified afterwards."
                  : e.detail,
          ...(text
            ? { text: { label: "Exact text", body: text, open: false } }
            : {}),
          technical,
        } satisfies ReceiptView,
      ];
    });
  });
}
export function cockpitAdapter(
  run: DemoRunView,
  dismissed: string[] = [],
): CockpitView {
  const session = run.turns.at(-1)?.auditDetails.captureProvenance.sessionId;
  const records = run.turns.filter(
    (t) => t.auditDetails.captureProvenance.sessionId === session,
  );
  const latest = records.at(-1);
  // While the latest verdict is pending, ladders and indicators hold at the last
  // settled turn; otherwise a pending turn reads like a cleared notice.
  const pending =
    latest !== undefined && reading(latest, "overreliance").kind === "pending";
  let settledCount = records.length;
  while (
    pending &&
    settledCount > 0 &&
    reading(records[settledCount - 1], "overreliance").kind === "pending"
  )
    settledCount--;
  const settledRecords = records.slice(0, settledCount);
  const settled = settledRecords.at(-1);
  const block = settled && cockpitVerdict(settled)?.judge_ladder;
  const keys = [...baseKeys];
  const ed = block?.signals.emotional_dependence;
  if (block ? ed && ed.category !== "not_monitored" : run.emotionalDependenceMonitored) keys.push("emotional_dependence");
  const signals = keys.map((key): SignalView => {
    let r: Reading = latest
      ? reading(latest, key)
      : { kind: run.monitorHealth === "starting" ? "starting" : "no_turns" };
    const detail = block?.signals[judgeKey(key)];
    if (detail?.monitoring_unavailable) r = { kind: "monitoring_unavailable" };
    else if (
      !block &&
      settledRecords.length >= 3 &&
      settledRecords
        .slice(-3)
        .every((t) => reading(t, key).kind === "unavailable")
    )
      r = { kind: "monitoring_unavailable" };
    let ladder: SignalView["ladder"] = { known: false };
    if (detail)
      ladder = { known: true, tier: detail.ladder.acting_tier as 0 | Tier };
    else if (
      settled &&
      /^tier_[1-4]$/.test(settled.tierState) &&
      cockpitActions(settled).some((a) =>
        a.triggering_signals.some((s) => s.name === judgeKey(key)),
      )
    )
      ladder = {
        known: true,
        tier: Number(settled.tierState.slice(-1)) as Tier,
      };
    return { key, reading: r, ladder };
  });
  const turns = [...records].reverse().map((t) => ({
    ordinal: cockpitOrdinal(run, t),
    unnumbered: !cockpitVerdict(t)?.judge_ladder && records.some(r => cockpitVerdict(r)?.judge_ladder),
    time: new Date(t.completedAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    user: t.userExcerpt,
    assistant: t.assistantExcerpt,
    readings: {
      sycophancy: sycophancySource(run, records, t)
        ? reading(sycophancySource(run, records, t)!, "sycophancy")
        : { kind: "pending" as const },
      overreliance: reading(t, "overreliance"),
      ...(keys.includes("emotional_dependence") ? { emotional_dependence: reading(t, "emotional_dependence") } : {}),
    },
    evidence: keys.flatMap((key) => {
      const source =
        key === "sycophancy" ? sycophancySource(run, records, t) : t;
      const d =
        source && cockpitVerdict(source)?.judge_ladder?.signals[judgeKey(key)];
      return d?.evidence.current
        ? [
            {
              signal: key,
              reading: reading(source!, key),
              quote: d.evidence.current,
              counter: d.evidence.counter ?? "",
            },
          ]
        : [];
    }),
    receipts: receipts(t),
    ...(pending && t === latest
      ? { note: { text: PENDING_TURN_NOTE, hatched: false } }
      : {}),
  }));
  turns.sort((a, b) => b.ordinal - a.ordinal);
  // Repeated records for one judge number share its card and citation target.
  for (let i = turns.length - 1; i > 0; i--) {
    const card = turns[i - 1], duplicate = turns[i];
    if (card.ordinal !== duplicate.ordinal) continue;
    card.user = `${duplicate.user}\n\n${card.user}`;
    card.assistant = `${duplicate.assistant}\n\n${card.assistant}`;
    card.receipts.push(...duplicate.receipts);
    card.evidence.push(...duplicate.evidence);
    turns.splice(i, 1);
  }
  if (pending)
    for (const signal of signals) {
      const last = turns.find(
        (t) =>
          !["pending", "not_covered"].includes(t.readings[signal.key as keyof typeof t.readings]?.kind ?? "not_covered"),
      );
      if (last)
        signal.note = last.unnumbered ? "Last reading on an unnumbered capture." : lastReadingNote(last.readings[signal.key as keyof typeof last.readings]!, last.ordinal);
    }
  let banner: BannerView | undefined;
  const pooled = browserPooledSelection(run, dismissed);
  if (pooled) {
    const { event } = pooled;
    const [title, ...body] = event.text.split("\n");
    banner = {
      kind: event.kind === "check_in" ? "checkin" : "uncertainty",
      eyebrow: event.kind === "check_in" ? "Check-in" : "Possible pattern",
      title,
      body: body.join("\n"),
      signal: signalKey(event.signal),
      cited: event.cited.map((c) => c.ordinal),
      buttons:
        event.kind === "check_in"
          ? [
              {
                label: "Look at these turns",
                primary: true,
                action: "look_together",
              },
              { label: "Continue", primary: false, action: "carry_on" },
            ]
          : [
              { label: "Dismiss", primary: true, action: "dismiss" },
              {
                label: "Show those turns",
                primary: false,
                action: "show_turns",
              },
            ],
    };
  }
  const missing = signals.find(
    (s) => s.reading.kind === "monitoring_unavailable",
  );
  if (missing)
    banner = {
      kind: "monitoring_unavailable",
      eyebrow: "Monitoring unavailable",
      title: `${SIGNALS[missing.key].name} monitoring unavailable`,
      body: judgeUnavailableText(judgeKey(missing.key)),
      buttons: [],
    };
  const termination = [...records]
    .reverse()
    .find((t) => t.terminationOutcome !== "not_applicable");
  if (termination) {
    const closed = termination.terminationOutcome === "closed";
    banner = {
      kind: closed ? "closed" : "failed_close",
      eyebrow: closed ? "Tier 4 · closed" : "Tier 4 · close failed",
      title: closed
        ? "This conversation is closed"
        : "The conversation may still be open",
      body: closed
        ? "No further messages can be sent here. The transcript remains readable."
        : "Sospio could not confirm that the page stopped accepting input. The conversation may still be open. The transcript remains readable.",
      buttons: [
        { label: "Copy transcript", primary: false, action: "copy_transcript" },
      ],
    };
  }
  const tier = Math.max(
    ...signals.map((s) => (s.ladder.known ? s.ladder.tier : 0)),
  );
  const acting = block?.acting_signals
    .map((s) => SIGNALS[signalKey(s)].name)
    .join(", ");
  const receipt = turns.flatMap((t) => t.receipts)[0];
  const view: CockpitView = {
    schema: COCKPIT_VIEW_SCHEMA,
    app: "browser",
    turnCountLabel: records.length ? `${records.length} turns` : "No turns",
    assistantModel: {
      name: "Not shown on the page",
      note: "Unknown",
      known: false,
    },
    health: pending
      ? turns[0].unnumbered
        ? {title: "Reading latest capture…", tag: "Verdict pending", sub: PENDING_TURN_NOTE}
        : pendingHealth(turns[0].ordinal)
      : {
          title:
            acting ||
            (tier
              ? `Session at Tier ${tier}`
              : pooled
                ? "A possible pattern"
                : latest
                  ? "Conversation readings"
                  : "No turns yet"),
          tag: tier ? RUNGS[tier - 1] : pooled ? "Uncertain · no tier" : "",
          sub: latest
            ? turns[0].unnumbered ? "Readings for the latest capture." : `Readings for turn ${turns[0].ordinal}.`
            : "Readings appear here after the first turn.",
        },
    signals,
    banner,
    turns,
    ...(receipt
      ? { latest: { text: receipt.title, status: receipt.status } }
      : {}),
  };
  validateCockpitView(view);
  return view;
}
