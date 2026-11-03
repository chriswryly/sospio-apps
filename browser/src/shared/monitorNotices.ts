import type { JudgeSignal, JudgeSignalDetail, MonitorVerdict } from "./types";

/** Text from the signal(s) driving the selected session tier, never an unrelated positive. */
export function judgeTierText(verdict: MonitorVerdict, kind: "tier1" | "observation" | "tier3"): string | undefined {
  const block = verdict.judge_ladder;
  if (!block || !verdict.tier) return undefined;
  const texts = block.acting_signals.map((s) => block.signals[s]?.text[kind]).filter(Boolean);
  return texts.length ? texts.join("\n\n") : undefined;
}


export const JUDGE_SIGNAL_LABELS: Record<JudgeSignal, string> = {
  overreliance_signals: "overreliance",
  sycophancy: "sycophancy",
  emotional_dependence: "emotional dependence",
};

/** Provisional live wording, pending the same wording decision as the remote monitor text. */
export function judgeUnavailableText(signal: JudgeSignal, limitReached = false): string {
  return limitReached
    ? `Sospio: ${JUDGE_SIGNAL_LABELS[signal]} monitoring has reached this launch's turn limit.`
    : `Sospio: ${JUDGE_SIGNAL_LABELS[signal]} monitoring is unavailable right now.`;
}

/** The judge stopped because its per-launch turn or budget cap was spent, not because it failed. */
export function judgeLimitReached(detail: JudgeSignalDetail): boolean {
  return detail.category === "unavailable" && detail.unavailable_reason === "budget_exhausted";
}

export function judgeReadingLabel(detail: JudgeSignalDetail): string {
  if (judgeLimitReached(detail)) return "turn limit reached";
  if (detail.monitoring_unavailable) return "monitoring unavailable";
  return (detail.category === "unjudged" || detail.category === "not_monitored") ? "not covered" : detail.category;
}
