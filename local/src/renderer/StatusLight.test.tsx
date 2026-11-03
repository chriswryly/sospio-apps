// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StatusLight } from "./chat/StatusLight";
import { ChatPane } from "./chat/ChatPane";
import { exportFixture } from "./__fixtures__/conversationExport";
import { STATUS_LIGHT_COPY as copy } from "../shared/statusLightCopy";
import { CLOSED_TITLE, CLOSED_BODY } from "../shared/interventionCopy";
import type { HarnessState } from "../shared/types";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  container=document.createElement("div"); document.body.appendChild(container); root=createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks();
});
function state(level="green") {
  const s=exportFixture(); delete s.termination; s.turns[0].interventionReceipts=[];
  const block=s.turns[0].verdict!.judge_ladder!;
  for (const signal of ["overreliance_signals", "sycophancy"] as const)
    block.signals[signal]={...block.signals[signal], category:"absent", monitoring_unavailable:false,
      ladder:{...block.signals[signal].ladder,acting_tier:0}};
  if(level==="none") s.turns=[];
  if(level==="amber") block.signals.overreliance_signals.ladder.acting_tier=2;
  if(level==="red") s.termination=exportFixture().termination;
  if(level==="grey") s.monitorHealth="error";
  return s;
}
async function render(s:HarnessState, onShowTurn=vi.fn()) {
  await act(async () => root.render(<StatusLight state={s} onShowTurn={onShowTurn}/>));
}
const trigger=() => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const panel=() => container.querySelector(".sospio-status-popover");
async function click() { await act(async () => trigger().click()); }

it.each([["none","○"],["green","✓"],["amber","!"],["red","!!"],["grey","–"]] as const)("renders %s with text and a distinct glyph", async (level,glyph) => {
  await render(state(level));
  expect(trigger().textContent).toContain(copy[level].label);
  expect(container.querySelector(".sospio-status-glyph")?.textContent).toBe(glyph);
  expect(container.querySelector(".sospio-status-glyph")?.getAttribute("aria-hidden")).toBe("true");
  await click(); expect(panel()?.textContent).toContain(copy[level].description);
});
it("resets its popover across sessions",async () => {
  await render(state()); await click();
  await render({...state(),sessionId:"new"}); expect(panel()).toBeNull();
});
it("opens an associated panel with readings, basis, tiers and disclaimer; Escape restores focus",async () => {
  await render(state("amber")); expect(trigger().getAttribute("aria-expanded")).toBe("false");
  await click(); expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(panel()?.id).toBe(trigger().getAttribute("aria-controls"));
  expect(panel()?.textContent).toContain("Based on turn 1.");
  expect(panel()?.textContent).toContain("overreliance: absent · Tier 2 in force");
  expect(panel()?.textContent).toContain("sycophancy: absent");
  expect(panel()?.textContent).toContain(copy.disclaimer);
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true})));
  expect(panel()).toBeNull(); expect(document.activeElement).toBe(trigger());
});
it("closes on second click or outside click, but not a click inside the panel",async () => {
  await render(state()); await click();
  await act(async () => panel()!.dispatchEvent(new MouseEvent("click",{bubbles:true})));
  expect(panel()).not.toBeNull(); await click(); expect(panel()).toBeNull(); await click();
  await act(async () => document.body.click()); expect(panel()).toBeNull();
});
it("changes the existing live label once for amber and keeps checking out of that region",async () => {
  await render(state()); const live=container.querySelector('[aria-live="polite"]')!;
  expect(live.textContent).toBe(copy.green.label);
  const s=state("amber"); await render(s);
  expect(container.querySelector('[aria-live="polite"]')).toBe(live);
  expect(live.textContent).toBe(copy.amber.label); await click();
  s.turns.push({...state().turns[0],verdict:undefined,monitorStatus:"pending"}); await render(s);
  expect(live.textContent).toBe(copy.amber.label);
  expect(container.querySelectorAll("[aria-live]")).toHaveLength(1);
  expect(panel()?.textContent).toContain(copy.checking);
  expect(container.querySelector(".is-checking")).not.toBeNull();
});
it("shows turn navigation only for a basis notice and follows cross-turn governing receipts",async () => {
  const s=state(), show=vi.fn(); await render(s,show); await click();
  expect(panel()?.querySelector("button")).toBeNull();
  const later={...state().turns[0], verdict:undefined, monitorStatus:"pending" as const,
    interventionReceipts:[{...exportFixture().turns[0].interventionReceipts![0],turn_id:"later",governing_turn_id:"turn-1"}]};
  s.turns.push(later); await render(s,show);
  expect(panel()?.querySelector("button")?.textContent).toBe("Show turn 1");
  await act(async () => panel()!.querySelector("button")!.click());
  expect(show).toHaveBeenCalledWith(1); expect(panel()).toBeNull();
});
it("offers pooled and unavailable basis notices but not suppressed events",async () => {
  const s=state(); const block=s.turns[0].verdict!.judge_ladder!;
  block.pooled=[{kind:"uncertainty_notice",signal:"sycophancy",text:"notice",cited:[]}];
  await render(s); await click(); expect(panel()?.querySelector("button")).not.toBeNull();
  block.pooled[0].kind="suppressed"; await render(s); expect(panel()?.querySelector("button")).toBeNull();
  block.signals.sycophancy.monitoring_unavailable=true;
  await render(s); expect(panel()?.querySelector("button")).not.toBeNull();
});
it("adds a red light in the header without changing the closing countdown or closed footer",async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-09T00:00:00Z"));
  const s=state(); s.termination={...exportFixture().termination!,terminated_at:new Date().toISOString()};
  await act(async () => root.render(<ChatPane state={s} onShowTurn={vi.fn()} onShowTurns={vi.fn()} models={[]} onSelectModel={vi.fn()}/>));
  const header=container.querySelector("header")!;
  expect(header.querySelector(".sospio-chat-heading .sospio-status-light")).not.toBeNull();
  expect(trigger().textContent).toContain(copy.red.label);
  expect(container.textContent).toContain("This conversation will close in 10 seconds");
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(container.textContent).not.toContain("This conversation will close in");
  expect(container.querySelector("footer")?.textContent).toContain(CLOSED_TITLE);
  expect(container.querySelector("footer")?.textContent).toContain(CLOSED_BODY);
  expect(trigger().textContent).toContain(copy.red.label);
});
