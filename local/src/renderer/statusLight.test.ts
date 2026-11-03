import { expect, it } from "vitest";
import { statusLight } from "./chat/statusLightState";
import { exportFixture } from "./__fixtures__/conversationExport";
import type { JudgeSignalDetail } from "../shared/types";

function state(category: JudgeSignalDetail["category"] = "absent", tier = 0) {
  const s = exportFixture();
  delete s.termination;
  s.turns[0].interventionReceipts = [];
  const block = s.turns[0].verdict!.judge_ladder!;
  for (const signal of ["overreliance_signals", "sycophancy"] as const) {
    block.signals[signal] = { ...block.signals[signal], category: "absent", monitoring_unavailable: false,
      ladder: { ...block.signals[signal].ladder, acting_tier: 0 } };
  }
  block.signals.overreliance_signals.category = category;
  block.signals.overreliance_signals.ladder.acting_tier = tier;
  return s;
}

it("has no reading initially or while the first reading is pending", () => {
  const s = state(); s.turns = [];
  expect(statusLight(s)).toEqual({level:"none", checking:false, basisOrdinal:undefined, signals:[]});
  for (const monitorStatus of ["pending", "queued"] as const) {
    s.turns = [{...state().turns[0], verdict:undefined, monitorStatus}];
    expect(statusLight(s)).toMatchObject({level:"none", checking:true, basisOrdinal:undefined});
  }
});
it.each(["absent", "unjudged", "not_monitored", "uncertain"] as const)("%s alone stays green", (category) => {
  const s = state(); s.turns[0].verdict!.judge_ladder!.signals.sycophancy.category = category;
  expect(statusLight(s).level).toBe("green");
});
it.each([[1,"amber"], [2,"amber"], [3,"red"], [4,"red"]] as const)("acting tier %s yields %s", (tier, level) => {
  expect(statusLight(state("absent", tier)).level).toBe(level);
});
it("uses the latest ready reading and clears a held tier on none", () => {
  const s = state("positive", 2);
  s.turns[0].verdict!.judge_ladder!.turn_ordinal = 4;
  const next = state().turns[0];
  next.verdict!.judge_ladder!.turn_ordinal = 5;
  s.turns.push(next);
  expect(statusLight(s)).toMatchObject({level:"green", basisOrdinal:5, checking:false});
  s.turns.push({...state("positive",3).turns[0], monitorStatus:"pending"});
  expect(statusLight(s)).toMatchObject({level:"green", basisOrdinal:5, checking:true});
  s.turns.push({...state("positive",3).turns[0], verdict:undefined});
  expect(statusLight(s)).toMatchObject({level:"green", basisOrdinal:5});
});
it("shows a positive before intervention, but waits for pooling on uncertainty", () => {
  expect(statusLight(state("positive")).level).toBe("amber");
  expect(statusLight(state("uncertain")).level).toBe("green");
});
it.each([["uncertainty_notice","amber"], ["check_in","amber"], ["suppressed","green"]] as const)("pooled %s yields %s", (kind, level) => {
  const s=state("uncertain");
  s.turns[0].verdict!.judge_ladder!.pooled=[{kind,signal:"overreliance_signals",text:"notice",cited:[]}];
  expect(statusLight(s).level).toBe(level);
});
it("termination outranks all other states, even without a reading", () => {
  const s=state(); s.termination=exportFixture().termination;
  s.monitorHealth="error"; s.turns=[];
  expect(statusLight(s).level).toBe("red");
});
it.each(["bypassed", "error"] as const)("monitor health %s makes a nonacting light grey", monitorHealth => {
  const s=state(); s.monitorHealth=monitorHealth;
  expect(statusLight(s).level).toBe("grey");
  s.turns=[]; expect(statusLight(s).level).toBe("grey");
});
it("shows unavailability including budget limits, below amber and red in priority", () => {
  const s=state(); const detail=s.turns[0].verdict!.judge_ladder!.signals.sycophancy;
  detail.category="unavailable"; detail.monitoring_unavailable=true;
  expect(statusLight(s).level).toBe("grey");
  detail.unavailable_reason="budget_exhausted";
  expect(statusLight(s)).toMatchObject({level:"grey", signals:expect.arrayContaining([
    {signal:"sycophancy", reading:"turn limit reached", tier:0},
  ])});
  s.turns[0].verdict!.judge_ladder!.signals.overreliance_signals.ladder.acting_tier=2;
  s.monitorHealth="error";
  expect(statusLight(s).level).toBe("amber");
  s.turns[0].verdict!.judge_ladder!.signals.overreliance_signals.ladder.acting_tier=3;
  expect(statusLight(s).level).toBe("red");
});
it("a failed last turn greys a green reading without losing its basis", () => {
  const s=state(); s.turns.push({...state().turns[0], verdict:undefined, monitorStatus:"error"});
  expect(statusLight(s)).toMatchObject({level:"grey", basisOrdinal:1, checking:false});
});
it.each(["queued", "pending"] as const)("holds amber during %s and reports both signal labels and tiers", monitorStatus => {
  const s=state("positive",2);
  s.turns.push({...state().turns[0], verdict:undefined, monitorStatus});
  expect(statusLight(s)).toEqual({level:"amber", checking:true, basisOrdinal:1, signals:[
    {signal:"overreliance_signals",reading:"positive",tier:2},
    {signal:"sycophancy",reading:"absent",tier:0},
  ]});
});
