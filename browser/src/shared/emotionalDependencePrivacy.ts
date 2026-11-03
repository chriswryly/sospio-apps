import type { HarnessState } from "./types";

/** Keep ED readings and attributed observations in the private trace only. */
export function stateForSharing(state: HarnessState): HarnessState {
  const result = structuredClone(state);
  const notices = new Set<string>();
  for (const record of result.turns) {
    const verdict = record.verdict;
    const block = verdict?.judge_ladder;
    const detail = block?.signals.emotional_dependence;
    if (detail) Object.values(detail.text).forEach(text => { if (text) notices.add(text); });
    for (const event of block?.pooled ?? []) if (event.signal === "emotional_dependence") notices.add(event.text);
    if (block) {
      delete block.signals.emotional_dependence;
      block.acting_signals = block.acting_signals.filter(s => s !== "emotional_dependence");
      block.pooled = block.pooled.filter(e => e.signal !== "emotional_dependence");
    }
    if (verdict) verdict.signals = verdict.signals.filter(s => s.name !== "emotional_dependence");
    record.governorActions = record.governorActions?.filter(r => r.pooled_notice?.signal !== "emotional_dependence");
  }
  // Notes may be copied into mixed-signal receipts or outgoing captured requests.
  // Strip the exact generated observations while preserving ordinary conversation text.
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      for (const notice of notices) value = (value as string).split(notice).join("");
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    return value;
  };
  for (const record of result.turns) for (const receipt of record.governorActions ?? []) {
    receipt.triggering_signals = receipt.triggering_signals.filter(s => s.name !== "emotional_dependence");
  }
  return redact(result) as HarnessState;
}
