import type { HarnessState, JudgeSignal } from "../../shared/types";
import { judgeReadingLabel } from "../../shared/judgeLadder";

export type StatusLight = {
  level: "none" | "green" | "amber" | "red" | "grey";
  checking: boolean;
  basisOrdinal?: number;
  signals: Array<{ signal: JudgeSignal; reading: string; tier: number }>;
};

export function latestStatusReading(state: HarnessState) {
  return [...state.turns].reverse().find(
    (turn) => turn.monitorStatus === "ready" && turn.verdict?.judge_ladder,
  );
}

/** Display only: the ladder remains the authority for interventions. */
export function statusLight(state: HarnessState): StatusLight {
  const block = latestStatusReading(state)?.verdict?.judge_ladder;
  const last = state.turns.at(-1);
  const signals = (Object.keys(block?.signals ?? {}) as JudgeSignal[]).map((signal) => ({
    signal,
    reading: judgeReadingLabel(block!.signals[signal]),
    tier: block!.signals[signal].ladder.acting_tier,
  }));
  const maxTier = Math.max(0, ...signals.map((signal) => signal.tier));
  const details = Object.values(block?.signals ?? {});
  const level = state.termination || maxTier >= 3 ? "red"
    : maxTier >= 1 || details.some((s) => s.category === "positive") ||
      block?.pooled.some((event) => event.kind !== "suppressed") ? "amber"
    : state.monitorHealth === "bypassed" || state.monitorHealth === "error" ||
      details.some((s) => s.monitoring_unavailable) || last?.monitorStatus === "error" ? "grey"
    : !block ? "none" : "green";
  return {
    level,
    checking: last?.monitorStatus === "queued" || last?.monitorStatus === "pending",
    basisOrdinal: block?.turn_ordinal,
    signals,
  };
}
