// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Cockpit, validateCockpitView } from "@sospio/cockpit";
import {
  buildDemoRunView,
  cockpitOrdinal,
  cockpitVerdict,
} from "./demoViewModel";
import { cockpitAdapter, browserPooledSelection } from "./cockpitAdapter";
import { DEMO_FIXTURE_STATES } from "./__fixtures__/demoStates";
import sequence from "../shared/__fixtures__/noticeSequence.json";
import type { HarnessState, MonitorVerdict } from "../shared/types";
it.each(Object.keys(DEMO_FIXTURE_STATES))("adapts canonical %s", (key) => {
  const view = cockpitAdapter(
    buildDemoRunView(
      DEMO_FIXTURE_STATES[key as keyof typeof DEMO_FIXTURE_STATES],
    ),
  );
  validateCockpitView(view);
  expect(view.assistantModel.known).toBe(false);
});
it("requires a check for verified, preserves queued and not permitted", () => {
  const view = (key: keyof typeof DEMO_FIXTURE_STATES) =>
    cockpitAdapter(buildDemoRunView(DEMO_FIXTURE_STATES[key]));
  expect(view("tier_1_notice").turns[0].receipts[0].status).toBe("unverified");
  expect(
    view("tier_2_dual_disclosure").turns[0].receipts.map((r) => r.status),
  ).toContain("queued");
  expect(
    view("run_allowlist_excluded").turns[0].receipts.map((r) => r.status),
  ).toContain("not_permitted");
  expect(view("tier_4_closed").turns[0].receipts[0].status).toBe("verified");
  expect(view("tier_4_not_closed").turns[0].receipts[0].status).toBe("failed");
  expect(view("tier_4_unverified").turns[0].receipts[0].status).toBe(
    "unverified",
  );
  expect(view("tier_3_dual_observation").turns[0].receipts[0].title).toContain(
    "Final observation",
  );
});
function recorded(n: number): HarnessState {
  return {
    monitorHealth: "healthy",
    diagnostics: [],
    turns: (sequence.slice(0, n) as MonitorVerdict[]).map((verdict, i) => ({
      turn: {
        turn_id: verdict.turn_id,
        session_id: "s",
        provider: "chatgpt",
        user_prompt: `user ${i + 1}`,
        assistant_text: `assistant ${i + 1}`,
        started_at: "2026-09-25T00:00:00Z",
        completed_at: "2026-09-25T00:00:01Z",
        request_url: "fixture",
      },
      monitorStatus: "ready",
      verdict,
    })),
  };
}
it.each(sequence.map((_, i) => i + 1))("maps recorded judge step %s", (n) => {
  const run = buildDemoRunView(recorded(n)),
    v = cockpitAdapter(run);
  validateCockpitView(v);
  expect(v.signals[1].ladder).toEqual({
    known: true,
    tier: sequence[n - 1].judge_ladder.signals.overreliance_signals.ladder
      .acting_tier,
  });
  expect(JSON.stringify(v.health) + JSON.stringify(v.signals)).not.toMatch(
    /\b\d+ (of|uncertain|separate)\b/,
  );
  expect(cockpitOrdinal(run, run.turns.at(-1)!)).toBe(n);
  expect(cockpitVerdict(run.turns.at(-1)!)).toEqual(sequence[n - 1]);
});
function withPendingTurn(state: HarnessState): HarnessState {
  const n = state.turns.length + 1;
  state.turns.push({
    turn: {
      ...state.turns[0].turn,
      turn_id: `pending${n}`,
      user_prompt: `user ${n}`,
      assistant_text: `assistant ${n}`,
    },
    monitorStatus: "pending",
  });
  return state;
}
it("shows a pending verdict as pending and keeps the last settled tier", () => {
  const view = cockpitAdapter(buildDemoRunView(withPendingTurn(recorded(2))));
  expect(view.health).toMatchObject({
    title: "Reading latest capture…",
    tag: "Verdict pending",
  });
  expect(view.signals[1]).toEqual({
    key: "overreliance",
    reading: { kind: "pending" },
    ladder: { known: true, tier: 2 },
    note: "Last reading: flagged (present) on turn 2.",
  });
  expect(view.signals[0]).toMatchObject({
    reading: { kind: "pending" },
    ladder: { known: true, tier: 0 },
    note: "Last reading: clear on turn 1.",
  });
  expect(view.turns[0].note?.text).toContain("isn’t clear or flagged yet");
  expect(view.turns[1].note).toBeUndefined();
  const settled = cockpitAdapter(buildDemoRunView(recorded(3)));
  expect(settled.health.tag).not.toBe("Verdict pending");
  expect(settled.signals.every((s) => s.note === undefined)).toBe(true);
});
it("keeps monitoring unavailable while the next verdict is pending", () => {
  const view = cockpitAdapter(
    buildDemoRunView(withPendingTurn(recorded(sequence.length))),
  );
  expect(view.signals[1].reading.kind).toBe("monitoring_unavailable");
  expect(view.banner?.kind).toBe("monitoring_unavailable");
});
it("maps pooled dismissal and unavailable flags", () => {
  const run = buildDemoRunView(recorded(6));
  expect(cockpitAdapter(run).banner?.kind).toBe("uncertainty");
  expect(
    browserPooledSelection(run)?.event.cited.map((c) => c.ordinal),
  ).toEqual([4, 5, 6]);
  expect(
    cockpitAdapter(run, ["s6:overreliance_signals"]).banner,
  ).toBeUndefined();
  expect(
    cockpitAdapter(buildDemoRunView(recorded(sequence.length))).signals[1]
      .reading.kind,
  ).toBe("monitoring_unavailable");
});
it("renders the shared hook component with this app React", () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const el = document.createElement("div"),
    root = createRoot(el);
  function Host() {
    const [selected] = useState<number[]>([]);
    return (
      <Cockpit
        view={cockpitAdapter(
          buildDemoRunView(DEMO_FIXTURE_STATES.tier_1_notice),
        )}
        selectedOrdinals={selected}
        onAction={() => {}}
      />
    );
  }
  expect(() => act(() => root.render(<Host />))).not.toThrow();
  expect(el.textContent).toContain("Sospio");
  act(() => root.unmount());
});

it("places lagged sycophancy and evidence on the judged reply and keeps the latest pending", () => {
  const s = structuredClone(recorded(3));
  const d = s.turns[2].verdict!.judge_ladder!.signals.sycophancy;
  d.category = "positive";
  d.band = "present";
  d.evidence = { current: "assistant 2", counter: "counter" };
  const view = cockpitAdapter(buildDemoRunView(s));
  expect(view.turns.find((t) => t.ordinal === 2)!.readings.sycophancy).toEqual({
    kind: "flagged",
    strength: "present",
  });
  expect(view.turns.find((t) => t.ordinal === 2)!.evidence).toContainEqual({
    signal: "sycophancy",
    reading: { kind: "flagged", strength: "present" },
    quote: "assistant 2",
    counter: "counter",
  });
  expect(view.turns[0].readings.sycophancy).toEqual({ kind: "pending" });
  expect(view.turns[0].evidence.some((e) => e.signal === "sycophancy")).toBe(
    false,
  );
  expect(view.signals[0].reading).toEqual({
    kind: "flagged",
    strength: "present",
  });
  expect(view.turns.find((t) => t.ordinal === 1)!.readings.sycophancy).toEqual({
    kind: "clear",
  });
});
it("uses the relay ordinal and does not cross sessions or use the first unjudged verdict", () => {
  const s = structuredClone(recorded(3));
  const d = s.turns[2].verdict!.judge_ladder!.signals.sycophancy;
  d.category = "positive";
  d.band = "strong";
  expect(
    cockpitAdapter(buildDemoRunView(s)).turns.find((t) => t.ordinal === 2)!
      .readings.sycophancy.kind,
  ).toBe("flagged");
  s.turns[2].turn.session_id = "new-session";
  expect(cockpitAdapter(buildDemoRunView(s)).turns).toHaveLength(1);
  expect(
    cockpitAdapter(buildDemoRunView(s)).turns[0].readings.sycophancy.kind,
  ).toBe("pending");
  const first = s.turns[0];
  s.turns = [first];
  expect(
    cockpitAdapter(buildDemoRunView(s)).turns[0].readings.sycophancy.kind,
  ).toBe("pending");
  expect(cockpitAdapter(buildDemoRunView(s)).turns[0].evidence).toEqual([]);
});
it("selects the reply cards named by a sycophancy check-in", () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const s = structuredClone(recorded(4));
  for (const record of s.turns.slice(1)) {
    const d = record.verdict!.judge_ladder!.signals.sycophancy;
    d.category = "uncertain";
    d.band = "emergent";
    d.evidence.current = "judged reply";
  }
  s.turns[3].verdict!.judge_ladder!.pooled = [
    {
      kind: "check_in",
      signal: "sycophancy",
      text: "Check-in\nQuoted replies",
      cited: [1, 2, 3].map((ordinal) => ({ ordinal, excerpt: "judged reply" })),
    },
  ];
  const view = cockpitAdapter(buildDemoRunView(s));
  const cited = view.banner && "cited" in view.banner ? view.banner.cited! : [];
  const host = document.createElement("div"),
    root = createRoot(host);
  act(() =>
    root.render(
      <Cockpit view={view} selectedOrdinals={cited} onAction={() => {}} />,
    ),
  );
  expect(cited).toEqual([1, 2, 3]);
  for (const ordinal of cited) {
    expect(
      view.turns.find((t) => t.ordinal === ordinal)!.readings.sycophancy.kind,
    ).toBe("uncertain");
    expect(
      host
        .querySelector(`[data-ordinal="${ordinal}"]`)
        ?.getAttribute("aria-current"),
    ).toBe("true");
  }
  act(() => root.unmount());
});
it.each([['applied','unverified'],['failed','failed']] as const)('maps settled augment %s without implying verification', (status, expected) => {
  const state = JSON.parse(JSON.stringify(DEMO_FIXTURE_STATES.tier_2_dual_disclosure)) as HarnessState;
  for (const record of state.turns) for (const action of record.governorActions ?? []) {
    for (const execution of action.executions) if (execution.mechanism === 'augment_request_context') {
      execution.status = status; execution.detail = 'request-id or cancellation reason';
    }
  }
  const receipts = cockpitAdapter(buildDemoRunView(state)).turns.flatMap(t=>t.receipts);
  expect(receipts.some(r=>r.status===expected)).toBe(true);
  expect(receipts.some(r=>r.status==='queued')).toBe(false);
  expect(receipts.some(r=>r.status==='verified')).toBe(false);
});

it.each([true, false, "unverified"] as const)("close banner copy reflects observed outcome %s", (outcome) => {
  const state = structuredClone(DEMO_FIXTURE_STATES.tier_4_closed);
  const action = state.turns[0].governorActions![0];
  const execution = action.executions.find((e) => e.mechanism === "terminate_exchange")!;
  execution.observed = { transcript_preserved: true, verified_at: null, closed_to_further_turns: outcome };
  action.state_at_termination!.closed_to_further_turns = outcome;
  const view = cockpitAdapter(buildDemoRunView(state));
  expect(view.banner).toMatchObject(outcome === true ? {
    title: "This conversation is closed", body: "No further messages can be sent here. The transcript remains readable.",
  } : {
    title: "The conversation may still be open", body: "Sospio could not confirm that the page stopped accepting input. The conversation may still be open. The transcript remains readable.",
  });
});

import { emotionalVerdict } from "./__fixtures__/emotionalDependence";
it("keeps ED-off views identical and shows the third row before the first reading", () => {
  const state = recorded(0);
  const off = cockpitAdapter(buildDemoRunView(state));
  state.emotionalDependenceMonitored = false;
  expect(JSON.stringify(cockpitAdapter(buildDemoRunView(state)))).toBe(JSON.stringify(off));
  state.emotionalDependenceMonitored = true;
  let view = cockpitAdapter(buildDemoRunView(state));
  expect(view.signals.map(s => s.key)).toEqual(["sycophancy", "overreliance", "emotional_dependence"]);
  expect(view.signals[2].reading.kind).toBe("no_turns");
  state.turns = recorded(1).turns;
  state.turns[0].verdict = emotionalVerdict();
  view = cockpitAdapter(buildDemoRunView(state));
  expect(view.signals[2].ladder).toEqual({known: true, tier: 1});
  expect(view.turns[0].readings.emotional_dependence).toEqual({kind: "flagged", strength: "present"});
  expect(view.turns[0].evidence.at(-1)?.quote).toBe("private ED quote");
  state.turns[0].verdict!.judge_ladder!.signals.emotional_dependence!.category = "not_monitored";
  expect(cockpitAdapter(buildDemoRunView(state)).signals).toHaveLength(2);
});
it("keeps citation numbers when an unjudged capture lies between judged turns", () => {
  const state = recorded(2);
  const first = state.turns[0], last = state.turns[1];
  const missing = {...first, turn: {...first.turn, turn_id: "unjudged"}, verdict: undefined, monitorStatus: "error" as const};
  state.turns = [first, missing, last];
  const view = cockpitAdapter(buildDemoRunView(state));
  expect(view.turns.map(t => t.ordinal)).toEqual([2, 1.5, 1]);
  expect(view.turns[1].unnumbered).toBe(true);
});
it("orders unjudged captures around late and reordered verdicts without printing fractional numbers", () => {
  const state = recorded(2);
  const missing = (id: string) => ({...state.turns[0], turn: {...state.turns[0].turn, turn_id: id}, verdict: undefined, monitorStatus: "pending" as const});
  state.turns = [missing("before"), state.turns[1], missing("middle"), state.turns[0], missing("after"), missing("after2")];
  const view = cockpitAdapter(buildDemoRunView(state));
  validateCockpitView(view);
  expect(view.turns.filter(t => !t.unnumbered).map(t => t.ordinal)).toEqual([2, 1]);
  const host = document.createElement("div"), root = createRoot(host);
  try {
    act(() => root.render(<Cockpit view={view} selectedOrdinals={[]} onAction={() => {}}/>));
    expect(host.textContent).not.toMatch(/Turn \d+\.\d+/);
    expect(host.textContent).toContain("Unnumbered capture");
  } finally { act(() => root.unmount()); }
});
it("attaches repeated judge numbers to one citation card", () => {
  const state = recorded(1);
  state.turns.push({...state.turns[0], turn: {...state.turns[0].turn, turn_id: "repeat", assistant_text: "second capture"}});
  const view = cockpitAdapter(buildDemoRunView(state));
  expect(view.turns).toHaveLength(1);
  expect(view.turns[0].ordinal).toBe(1);
  expect(view.turns[0].assistant).toContain("second capture");
});
