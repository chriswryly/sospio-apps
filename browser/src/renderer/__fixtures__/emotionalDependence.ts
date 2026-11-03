import sequence from "../../shared/__fixtures__/noticeSequence.json";
import type { MonitorVerdict } from "../../shared/types";

export function emotionalVerdict(tier: 1 | 2 | 3 | 4 = 1): MonitorVerdict {
  const verdict = structuredClone(sequence[tier === 4 ? 2 : tier - 1]) as MonitorVerdict;
  const block = verdict.judge_ladder!;
  const ed = structuredClone(block.signals.overreliance_signals);
  ed.evidence = { current: "private ED quote", counter: "private ED counter" };
  ed.text = { tier1: 'ED notice: "private ED quote"', observation: 'ED observation: "private ED quote"', tier3: 'ED final: "private ED quote"' };
  ed.ladder.acting_tier = tier;
  ed.category = "positive"; ed.band = "present";
  block.signals.emotional_dependence = ed;
  block.signals.overreliance_signals.ladder.acting_tier = 0;
  block.acting_signals = ["emotional_dependence"];
  block.arm = "browser";
  verdict.tier = tier;
  verdict.signals = [{ ...verdict.signals[0], name: "emotional_dependence", fired: true, intensity: 0.7 }];
  verdict.selected_mechanisms = tier === 4 ? ["terminate_exchange"] : tier === 1 ? ["display_governor_notice"] : ["display_governor_notice", "augment_request_context"];
  return verdict;
}
