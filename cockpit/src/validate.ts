import type { CockpitView, Reading } from "./contract";
import { COCKPIT_VIEW_SCHEMA } from "./contract";
export function validateCockpitView(view: CockpitView): void {
  if (view.schema !== COCKPIT_VIEW_SCHEMA)
    throw new Error("Unknown cockpit schema");
  if (
    ![2, 3].includes(view.signals.length) ||
    view.signals[0].key !== "sycophancy" ||
    view.signals[1].key !== "overreliance" ||
    (view.signals.length === 3 && view.signals[2].key !== "emotional_dependence")
  )
    throw new Error("Signals must be ordered sycophancy, overreliance, then optional emotional dependence");
  const check = (r: Reading) => {
    if (r.kind === "flagged" && !["present", "strong"].includes(r.strength))
      throw new Error("Invalid flagged strength");
  };
  view.signals.forEach((s) => {
    check(s.reading);
    if (
      s.ladder.known &&
      (!Number.isInteger(s.ladder.tier) ||
        s.ladder.tier < 0 ||
        s.ladder.tier > 4)
    )
      throw new Error("Invalid ladder tier");
  });
  view.turns.forEach((t, i) => {
    if (i && t.ordinal >= view.turns[i - 1].ordinal)
      throw new Error("Turns must be newest first");
    Object.values(t.readings).forEach(check);
    if (view.signals.some(s => !t.readings[s.key])) throw new Error('Missing signal reading');
    t.evidence.forEach((e) => check(e.reading));
  });
}
