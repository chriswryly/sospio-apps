import React, { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Cockpit, ReadingChip, ReceiptChip } from "./Cockpit";
import { scenario, scenarioKeys } from "./fixtures/scenarios";
import { validateCockpitView } from "./validate";
import { READINGS, RECEIPTS } from "./vocabulary";
import type { ReceiptStatus, Reading } from "./contract";
let el: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
});
afterEach(() => {
  act(() => root.unmount());
  el.remove();
});
const mount = (node: React.ReactNode) => act(() => root.render(node));
it.each(scenarioKeys)(
  "renders and validates independent %s fixtures",
  (key) => {
    const v = scenario(key);
    validateCockpitView(v);
    mount(<Cockpit view={v} selectedOrdinals={[]} onAction={() => {}} />);
    expect(el.querySelector("[role=region]")).not.toBeNull();
    v.health.title = "changed";
    expect(scenario(key).health.title).not.toBe("changed");
    expect(JSON.stringify(v.signals)).not.toMatch(
      /\b\d+ (of|uncertain|separate)\b/,
    );
  },
);
it("rejects invalid bands, turn order and signal order", () => {
  const v = scenario("tier1");
  v.turns.reverse();
  expect(() => validateCockpitView(v)).toThrow("newest first");
  const a = scenario("tier1");
  a.signals.reverse();
  expect(() => validateCockpitView(a)).toThrow("Signals");
  const b = scenario("tier1");
  b.signals[0].reading = {
    kind: "flagged",
    strength: "emergent",
  } as unknown as Reading;
  expect(() => validateCockpitView(b)).toThrow("strength");
});
it("uses corrected fixture copy and illustrative technical data", () => {
  expect(JSON.stringify(scenario("tier1"))).not.toContain("emergent");
  expect(scenario("failclose").latest?.text).toBe("Tier 4 close · turn 8");
  expect(scenario("tier3orch").turns[0].receipts[1].technical).toContainEqual([
    "cap",
    "max_tier_by_arm",
  ]);
  expect(scenario("failclose").turns[0].receipts[0].technical).toContainEqual([
    "closed_to_further_turns",
    "unverified",
  ]);
  expect(scenario("tier3browser").turns[0].receipts[0].text?.body).toContain(
    "If this continues, Sospio may close this conversation.",
  );
  for (const k of scenarioKeys)
    for (const t of scenario(k).turns)
      for (const r of t.receipts)
        expect(r.technical[0]).toEqual(["fixture", "illustrative"]);
});
it("renders every reading and outcome", () => {
  mount(
    <>
      {Object.keys(READINGS).map((kind) => (
        <ReadingChip
          key={kind}
          signal="sycophancy"
          reading={{ kind } as Reading}
        />
      ))}
      {["present", "strong"].map((strength) => (
        <ReadingChip
          key={strength}
          signal="sycophancy"
          reading={{ kind: "flagged", strength } as Reading}
        />
      ))}
      {Object.keys(RECEIPTS).map((status) => (
        <ReceiptChip key={status} status={status as ReceiptStatus} />
      ))}
    </>,
  );
  for (const text of Object.values(READINGS))
    expect(el.textContent).toContain(text);
  for (const v of Object.values(RECEIPTS))
    expect(el.textContent).toContain(`${v.icon} ${v.label}`);
});
it("unknown ladders are never no tier reached", () => {
  const v = scenario("empty");
  v.signals.forEach((s) => (s.ladder = { known: false }));
  mount(<Cockpit view={v} selectedOrdinals={[]} onAction={() => {}} />);
  expect(el.innerHTML).not.toContain("no tier reached");
  expect(el.textContent).toContain("Ladder not reported by this app yet");
});
it("countdown displays seven then zero with no cancel", () => {
  const now = new Date();
  const v = scenario("countdown", now);
  mount(
    <Cockpit view={v} now={now} selectedOrdinals={[]} onAction={() => {}} />,
  );
  expect(el.textContent).toContain("7s");
  expect(el.textContent).toContain("close in 7 seconds");
  expect(el.querySelector("[role=status] button")).toBeNull();
  mount(
    <Cockpit
      view={v}
      now={new Date(now.getTime() + 7000)}
      selectedOrdinals={[]}
      onAction={() => {}}
    />,
  );
  expect(el.textContent).toContain("Closing now…");
});
it("selects only cited turns and opens their details", () => {
  const v = scenario("uncertainty");
  mount(<Cockpit view={v} selectedOrdinals={[2, 4]} onAction={() => {}} />);
  expect(
    [...el.querySelectorAll("[aria-current=true]")].map((n) =>
      n.getAttribute("data-ordinal"),
    ),
  ).toEqual(["4", "2"]);
  for (const n of el.querySelectorAll("[aria-current=true] details"))
    expect(n.hasAttribute("open")).toBe(true);
});
it("passes cited ordinals and dismisses locally", () => {
  const v = scenario("uncertainty"),
    fn = vi.fn();
  mount(<Cockpit view={v} selectedOrdinals={[]} onAction={fn} />);
  act(() =>
    [...el.querySelectorAll("button")]
      .find((b) => b.textContent === "Show those turns")!
      .click(),
  );
  expect(fn).toHaveBeenCalledWith("show_turns", [2, 4, 5]);
  act(() =>
    [...el.querySelectorAll("button")]
      .find((b) => b.textContent === "Dismiss")!
      .click(),
  );
  expect(fn).toHaveBeenCalledWith("dismiss");
  expect(el.querySelector("[role=status]")).toBeNull();
  expect(el.querySelectorAll("details").length).toBeGreaterThan(0);
});
it("long payload is preserved", () => {
  const r = scenario("long_payload").turns[0].receipts[0];
  expect(r.technical.at(-1)?.[1]).toHaveLength(400);
  expect(r.text?.body).toHaveLength(2000);
});

it("uses the provisional final note in orchestrator Tier 3 and no unsupported browser verification", () => {
  const local = scenario("tier3orch"),
    browser = scenario("tier3browser");
  expect(local.health.tag).toBe("Final note");
  expect(local.health.sub).toContain("A final note was added");
  const text = local.turns[0].receipts[0].text!.body;
  expect(text).toContain(
    "[Observation added by Sospio, a conversation checker, not written by the user]",
  );
  expect(text).toContain(
    "Possible agreement beyond what the evidence supports.",
  );
  expect(text).toContain(
    'From the conversation: "Yes, 40% growth is confirmed for Q3."',
  );
  expect(text).toContain(
    "If this continues, Sospio may close this conversation.\nThis may be mistaken",
  );
  const receipt = browser.turns.find((t) => t.ordinal === 6)!.receipts[0];
  expect(receipt.status).toBe("unverified");
  expect(receipt.why).not.toContain("which was checked on send");
  expect(receipt.technical).toContainEqual(["status", "unverified"]);
});

it('renders the optional ED row third with its reading and tier', () => {
  const view = scenario('emotional_dependence');
  mount(<Cockpit view={view} selectedOrdinals={[]} onAction={() => {}} />);
  expect([...el.querySelectorAll('.sospio-ck-signal')].map(n => n.getAttribute('data-signal'))).toEqual(['sycophancy', 'overreliance', 'emotional_dependence']);
  const row = el.querySelector('.sospio-ck-signal[data-signal=emotional_dependence]')!;
  expect(row.textContent).toContain('Emotional dependence'); expect(row.textContent).toContain('Final note');
  view.signals.push(view.signals[2]); expect(() => validateCockpitView(view)).toThrow('Signals');
});
