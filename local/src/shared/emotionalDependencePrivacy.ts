import type { HarnessState, MonitorVerdict } from "./types";

export function emotionalNoticeTexts(verdict?: MonitorVerdict): string[] {
  const block = verdict?.judge_ladder;
  if (!block?.signals.emotional_dependence) return [];
  return [...Object.values(block.signals.emotional_dependence.text),
    ...block.pooled.filter(e => e.signal === "emotional_dependence").map(e => e.text)].filter((s): s is string => Boolean(s));
}

/** Emotional-dependence observations stay in the local trace, outside sharing projections. */
export function stateForSharing(state: HarnessState): HarnessState {
  if (!state.messages.some(m => m.sharingOmissions?.length) && !state.turns.some(r => r.verdict?.judge_ladder?.signals.emotional_dependence)) return state;
  const result = structuredClone(state);
  const notices = new Set<string>();
  for (const message of result.messages) {
    const spans = message.sharingOmissions ?? [];
    const omitted = new Set<number>();
    for (const {start, end} of spans) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > message.content.length) continue;
      for (let i = start; i < end; i++) omitted.add(i);
    }
    message.content = message.content.split("").filter((_, i) => !omitted.has(i)).join("");
    delete message.sharingOmissions;
  }
  for (const record of result.turns) {
    const verdict = record.verdict;
    const block = verdict?.judge_ladder;
    if (!block?.signals.emotional_dependence) continue;
    emotionalNoticeTexts(verdict).forEach(value => notices.add(value));
    delete block.signals.emotional_dependence;
    block.acting_signals = block.acting_signals.filter(s => s !== "emotional_dependence");
    block.pooled = block.pooled.filter(e => e.signal !== "emotional_dependence");
    verdict!.signals = verdict!.signals.filter(s => s.name !== "emotional_dependence");
  }
  for (const record of result.turns) {
    record.interventionReceipts = record.interventionReceipts?.filter(r => r.pooled_notice?.signal !== "emotional_dependence");
  }
  result.dismissedJudgeNotices = result.dismissedJudgeNotices?.filter(key => !key.endsWith(":emotional_dependence"));
  // Shared notes also ride in governor messages and receipt context additions.
  // Remove the exact generated notice, including its excerpts, from those copies.
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      for (const notice of notices) value = (value as string).split(notice).join("");
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    return value;
  };
  const shared = redact(result) as HarnessState;
  shared.messages = shared.messages.filter(m => m.role !== "governor" || m.content.trim());
  return shared;
}
