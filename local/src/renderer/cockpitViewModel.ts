import { CLOSED_TITLE, CLOSED_BODY } from "../shared/interventionCopy";
import {
  COCKPIT_VIEW_SCHEMA,
  PENDING_TURN_NOTE,
  RUNGS,
  SIGNALS,
  lastReadingNote,
  pendingHealth,
  validateCockpitView,
  type BannerView,
  type CockpitView,
  type Reading,
  type ReceiptView,
  type SignalKey,
  type SignalView,
  type Tier,
} from "@sospio/cockpit";
import type {
  HarnessState,
  JudgeSignal,
  JudgeSignalDetail,
  LocalInterventionReceipt,
  TurnRecord,
} from "../shared/types";
import { judgeLimitReached, judgeUnavailableText } from "../shared/judgeLadder";
export const signalKey = (key: JudgeSignal): SignalKey =>
  key === "overreliance_signals" ? "overreliance" : key;
export const judgeKey = (key: SignalKey): JudgeSignal =>
  key === "overreliance" ? "overreliance_signals" : key;
export function judgeReading(detail: JudgeSignalDetail): Reading {
  if (detail.category === "not_monitored") return { kind: "not_covered" };
  if (judgeLimitReached(detail)) return { kind: "unavailable", limit: true };
  if (detail.category === "positive")
    return { kind: "flagged", strength: detail.band as "present" | "strong" };
  return {
    kind:
      detail.category === "absent"
        ? "clear"
        : detail.category === "unjudged"
          ? "not_covered"
          : detail.category,
  };
}
export function turnReading(record: TurnRecord, key: SignalKey): Reading {
  const v = record.verdict;
  if (v?.judge_ladder)
    return v.judge_ladder.signals[judgeKey(key)] ? judgeReading(v.judge_ladder.signals[judgeKey(key)]) : {kind: 'not_covered'};
  if (record.monitorStatus === "pending" || record.monitorStatus === "queued")
    return { kind: "pending" };
  if (record.monitorStatus === "bypassed") return { kind: "not_covered" };
  if (record.monitorStatus === "error" || v?.error || !v)
    return { kind: "unavailable" };
  const s = v.signals.find((s) => s.name === judgeKey(key));
  if (!s) return { kind: "not_covered" };
  if (v.monitor_utility)
    return v.monitor_utility.decision === "P"
      ? { kind: "flagged", strength: "present" }
      : { kind: v.monitor_utility.decision === "N" ? "clear" : "unavailable" };
  if (s.intensity === null) return { kind: "unavailable" };
  return s.fired ? { kind: "flagged", strength: "present" } : { kind: "clear" };
}
// Judge mode evaluates the previous assistant reply when the next turn arrives.
function sycophancySource(
  records: TurnRecord[],
  card: TurnRecord,
): TurnRecord | undefined {
  if (!records.some((r) => r.verdict?.judge_ladder)) return card;
  const ordinal =
    displayOrdinal(records, card);
  return records.find((r) => {
    const block = r.verdict?.judge_ladder;
    const detail = block?.signals.sycophancy;
    if (
      !detail ||
      detail.category === "unjudged" ||
      r.turn.session_id !== card.turn.session_id
    )
      return false;
    return block!.turn_ordinal === ordinal + 1;
  });
}
export function pooledSelection(state: HarnessState) {
  const session = state.turns.at(-1)?.turn.session_id;
  for (const record of [...state.turns].reverse()) {
    if (record.turn.session_id !== session) continue;
    for (const event of [
      ...(record.verdict?.judge_ladder?.pooled ?? []),
    ].reverse()) {
      if (
        event.kind !== "suppressed" &&
        !state.dismissedJudgeNotices?.includes(
          record.turn.turn_id + ":" + event.signal,
        )
      )
        return { record, event };
    }
  }
  return undefined;
}
function receipts(state: HarnessState, record: TurnRecord): ReceiptView[] {
  return (record.interventionReceipts ?? []).flatMap<ReceiptView>((r) => {
    const technical: Array<[string, string]> = [
      ["receipt_id", r.receipt_id],
      ["plan_id", r.plan_id],
      ["authority_profile_id", r.authority_profile_id],
      ...r.executions.map((e, i): [string, string] => [
        `execution_${i}`,
        `${e.mechanism}: ${e.status} — ${e.detail}`,
      ]),
    ];
    if (r.pooled_notice && r.tier === null)
      return [
        {
          id: r.receipt_id,
          tier: null,
          signal: signalKey(r.pooled_notice.signal),
          title:
            r.pooled_notice.kind === "check_in"
              ? "Check-in shown"
              : "Possible-pattern notice shown",
          status: "shown",
          why: "The notice was shown; uncertainty does not move the ladder.",
          text: {
            label: "Text shown to you",
            body: r.presented_text ?? r.pooled_notice.text,
            open: false,
          },
          technical: [
            ...technical,
            ["signal", r.pooled_notice.signal],
            ["cited", r.pooled_notice.cited.map((c) => c.ordinal).join(", ")],
            [
              "pooled_version",
              record.verdict?.judge_ladder?.pooled_version ?? "unknown",
            ],
          ],
        } satisfies ReceiptView,
      ];
    if (!r.executions.some((e) => e.status === "completed")) return [];
    const governing =
      state.turns.find((t) => t.turn.turn_id === r.governing_turn_id) ?? record;
    const signal =
      governing.verdict?.judge_ladder?.acting_signals[0] ??
      (governing.verdict?.signals.find(
        (s) =>
          s.fired &&
          (s.name === "sycophancy" || s.name === "overreliance_signals"),
      )?.name as JudgeSignal | undefined);
    const body =
      governing.verdict?.utility_notice?.text ??
      r.presented_text ??
      r.context_additions?.join("\n\n");
    const tier = r.tier ?? null;
    // Say what Sospio did, not a verification claim: the orchestrator app
    // writes both the notice and the request itself.
    const notice = r.executions.some(
      (e) => e.status === "completed" && e.mechanism === "display_governor_notice",
    );
    return [
      {
        id: r.receipt_id,
        tier,
        signal: signal ? signalKey(signal) : null,
        title: tier
          ? `Tier ${tier} ${RUNGS[tier - 1].toLowerCase()}`
          : "Notice shown",
        status: notice ? "shown_with_reply" : "sent_to_assistant",
        why: notice
          ? "Sospio put this notice above the assistant's reply."
          : "Sospio added this note to the request that produced this reply. The assistant sees it; the reply is its own.",
        ...(body ? { text: { label: "Exact text", body, open: false } } : {}),
        technical,
      } satisfies ReceiptView,
    ];
  });
}
// Ordering keys for unjudged captures occupy fractional slots, never citation numbers.
function displayOrdinal(records: HarnessState["turns"], record: HarnessState["turns"][number]): number {
  if (!records.some(r => r.verdict?.judge_ladder)) return records.indexOf(record) + 1;
  const judged = record.verdict?.judge_ladder?.turn_ordinal;
  if (judged !== undefined) return judged;
  const priorOf = (i: number) => records.slice(0, i).reverse().find(r => r.verdict?.judge_ladder);
  const prior = priorOf(records.indexOf(record));
  const group = records.filter((r, i) => !r.verdict?.judge_ladder && priorOf(i) === prior);
  return (prior?.verdict?.judge_ladder?.turn_ordinal ?? 0) + (group.indexOf(record) + 1) / (group.length + 1);
}
export function cockpitViewModel(
  state: HarnessState,
  now = new Date(),
): CockpitView {
  const records = state.turns.filter(
    (r) => r.turn.session_id === state.turns.at(-1)?.turn.session_id,
  );
  const latest = records.at(-1);
  // While the latest verdict is pending, ladders and indicators hold at the last
  // settled turn; otherwise a pending turn reads like a cleared notice.
  const pending =
    latest !== undefined &&
    turnReading(latest, "overreliance").kind === "pending";
  let settledCount = records.length;
  while (
    pending &&
    settledCount > 0 &&
    turnReading(records[settledCount - 1], "overreliance").kind === "pending"
  )
    settledCount--;
  const settledRecords = records.slice(0, settledCount);
  const block = settledRecords.at(-1)?.verdict?.judge_ladder;
  const keys: SignalKey[] = ["sycophancy", "overreliance"];
  const ed = block?.signals.emotional_dependence;
  // Before the first reading, the launch flag says whether the row belongs; after it, the reading does.
  if (block ? ed && ed.category !== 'not_monitored' : state.emotionalDependenceMonitored) keys.push('emotional_dependence');
  const signals = keys.map((key): SignalView => {
    let reading: Reading = latest
      ? turnReading(latest, key)
      : { kind: state.monitorHealth === "starting" ? "starting" : "no_turns" };
    if (block && judgeLimitReached(block.signals[judgeKey(key)]))
      reading = { kind: "unavailable", limit: true };
    else if (block?.signals[judgeKey(key)].monitoring_unavailable)
      reading = { kind: "monitoring_unavailable" };
    else if (
      !block &&
      settledRecords.length >= 3 &&
      settledRecords
        .slice(-3)
        .every((r) => turnReading(r, key).kind === "unavailable")
    )
      reading = { kind: "monitoring_unavailable" };
    let ladder: SignalView["ladder"] = { known: false };
    if (block)
      ladder = {
        known: true,
        tier: block.signals[judgeKey(key)].ladder.acting_tier as 0 | Tier,
      };
    else if (state.ladder?.status === "held") {
      const held = state.ladder;
      const verdict = records.find(
        (r) => r.turn.turn_id === held.governing_turn_id,
      )?.verdict;
      if (verdict?.signals.some((s) => s.fired && s.name === judgeKey(key)))
        ladder = { known: true, tier: held.tier };
    }
    return { key, reading, ladder };
  });
  const turns = [...records].reverse().map((r) => ({
    ordinal: displayOrdinal(records, r),
    unnumbered: !r.verdict?.judge_ladder && records.some(r => r.verdict?.judge_ladder),
    time: new Date(r.turn.completed_at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    user: r.turn.user_prompt,
    assistant: r.turn.assistant_text,
    readings: {
      sycophancy: sycophancySource(records, r)
        ? turnReading(sycophancySource(records, r)!, "sycophancy")
        : { kind: "pending" as const },
      overreliance: turnReading(r, "overreliance"),
      ...(keys.includes('emotional_dependence') ? {emotional_dependence: turnReading(r, 'emotional_dependence')} : {}),
    },
    evidence: keys.flatMap((key) => {
      const source = key === "sycophancy" ? sycophancySource(records, r) : r;
      const d = source?.verdict?.judge_ladder?.signals[judgeKey(key)];
      return d?.evidence.current
        ? [
            {
              signal: key,
              reading: judgeReading(d),
              quote: d.evidence.current,
              counter: d.evidence.counter ?? "",
            },
          ]
        : [];
    }),
    receipts: receipts(state, r),
    ...(pending && r === latest
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
          !["pending", "not_covered"].includes(t.readings[signal.key]?.kind ?? "not_covered"),
      );
      if (last)
        signal.note = last.unnumbered ? "Last reading on an unnumbered capture." : lastReadingNote(last.readings[signal.key]!, last.ordinal);
    }
  let banner: BannerView | undefined;
  const pooled = pooledSelection(state);
  if (pooled) {
    const { event } = pooled;
    const [title, ...body] = event.text.split("\n");
    banner = {
      kind: event.kind === "check_in" ? "checkin" : "uncertainty",
      signal: signalKey(event.signal),
      eyebrow: event.kind === "check_in" ? "Check-in" : "Possible pattern",
      title,
      body: body.join("\n"),
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
  if (state.termination) {
    const endsAt = new Date(
      Date.parse(state.termination.terminated_at) + 10000,
    ).toISOString();
    banner =
      Date.parse(endsAt) > now.getTime()
        ? {
            kind: "countdown",
            eyebrow: "Tier 4 · closing",
            titleTemplate: "This conversation will close in {n} seconds",
            body: state.termination.notice,
            endsAt,
            totalSeconds: 10,
          }
        : {
            kind: "closed",
            eyebrow: "Tier 4 · closed",
            title: CLOSED_TITLE,
            body: CLOSED_BODY,
            buttons: [
              {
                label: "Copy transcript",
                primary: false,
                action: "copy_transcript",
              },
              {
                label: "Start a new conversation",
                primary: true,
                action: "new_conversation",
              },
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
    app: "chat",
    turnCountLabel: records.length ? `${records.length} turns` : "No turns",
    assistantModel: {
      name: state.modelState.chatModel,
      provider: state.modelState.chatProvider ?? "ollama",
      note: "Fixed for this conversation",
      known: state.modelState.chatModel !== "unknown",
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
