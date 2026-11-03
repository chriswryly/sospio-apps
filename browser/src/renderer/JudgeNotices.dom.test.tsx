// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { JudgeNotices, JudgeDetails } from "./JudgeNotices";
import sequence from "../shared/__fixtures__/noticeSequence.json";
import type { MonitorVerdict, TurnRecord } from "../shared/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("renders pooled quotes safely; dismiss and continue call the session dismissal; check-in selects cited cards", async () => {
  const rootNode = document.createElement("div"); document.body.append(rootNode);
  const root = createRoot(rootNode);
  const verdicts = sequence as MonitorVerdict[];
  const turns = verdicts.map((verdict) => ({ turn: { turn_id: verdict.turn_id, session_id: "s" }, verdict })) as TurnRecord[];
  const dismiss = vi.fn().mockResolvedValue(undefined);
  await act(async () => root.render(<JudgeNotices turns={turns.slice(0, 6)} dismiss={dismiss} />));
  expect(rootNode.textContent).toContain('Turn 4: "user 4"');
  expect(rootNode.textContent).toContain("Dismiss");
  await act(async () => rootNode.querySelector("button")!.click());
  expect(dismiss).toHaveBeenCalledWith("s6", "overreliance_signals");
  expect(rootNode.textContent).not.toContain('Turn 4:');
  const cards = [7, 8, 9].map((n) => { const c = document.createElement("button"); c.dataset.turnId = "s" + n; document.body.append(c); return c; });
  await act(async () => root.render(<JudgeNotices turns={turns.slice(0, 9)} dismiss={dismiss} />));
  expect(rootNode.textContent).toContain("Look at these turns");
  await act(async () => [...rootNode.querySelectorAll("button")].find((b) => b.textContent === "Look at these turns")!.click());
  expect(cards.every((c) => c.classList.contains("judge-cited"))).toBe(true);
  await act(async () => [...rootNode.querySelectorAll("button")].find((b) => b.textContent === "Continue")!.click());
  expect(dismiss).toHaveBeenLastCalledWith("s9", "overreliance_signals");
  await act(async () => root.render(<><JudgeNotices turns={turns} dismiss={dismiss} /><JudgeDetails verdict={verdicts.at(-1)} /></>));
  expect(rootNode.textContent).toContain("Sospio: overreliance monitoring is unavailable right now.");
  expect(rootNode.textContent).toContain("monitoring unavailable");
  expect(rootNode.textContent).not.toContain("_signals");
  expect(rootNode.textContent).not.toContain("monitoring_unavailable");
  expect(rootNode.textContent).toContain("ladder tier 0");
  await act(async () => root.unmount()); rootNode.remove(); cards.forEach((c) => c.remove());
});

it("renders quoted markup as text and retains a notice when dismissal fails", async () => {
  const node = document.createElement("div"); const root = createRoot(node);
  const v = structuredClone(sequence[5]) as MonitorVerdict;
  v.judge_ladder!.pooled[0].text = 'Turn 1: "<img src=x onerror=bad()>"';
  const turns = [{ turn: { turn_id: "s6", session_id: "s" }, verdict: v }] as TurnRecord[];
  await act(async () => root.render(<JudgeNotices turns={turns} dismiss={async () => { throw new Error("offline"); }} />));
  expect(node.querySelector("img")).toBeNull();
  await act(async () => node.querySelector("button")!.click());
  expect(node.textContent).toContain("Could not dismiss");
  expect(node.textContent).toContain("<img");
  await act(async () => root.unmount());
});


it("uses readable labels for unjudged signals", async () => {
  const node = document.createElement("div"); const root = createRoot(node);
  await act(async () => root.render(<JudgeDetails verdict={sequence[0] as MonitorVerdict} />));
  expect(node.textContent).toContain("sycophancy");
  expect(node.textContent).toContain("not covered");
  expect(node.textContent).not.toContain("_signals");
  expect(node.textContent).not.toContain("not_covered");
  await act(async () => root.unmount());
});

import { emotionalVerdict } from "./__fixtures__/emotionalDependence";
it("renders ED's readable label, unavailable and limit lines", async () => {
  const node = document.createElement("div"), root = createRoot(node);
  const verdict = emotionalVerdict();
  const detail = verdict.judge_ladder!.signals.emotional_dependence!;
  const turns = [{turn: {turn_id: "s1", session_id: "s"}, verdict}] as TurnRecord[];
  detail.monitoring_unavailable = true;
  await act(async () => root.render(<><JudgeDetails verdict={verdict}/><JudgeNotices turns={turns} dismiss={vi.fn()} /></>));
  expect(node.textContent).toContain("emotional dependence · ladder tier 1");
  expect(node.textContent).toContain("Sospio: emotional dependence monitoring is unavailable right now.");
  detail.category = "unavailable"; detail.unavailable_reason = "budget_exhausted";
  await act(async () => root.render(<JudgeNotices turns={turns} dismiss={vi.fn()} />));
  expect(node.textContent).toContain("emotional dependence monitoring has reached this launch's turn limit.");
  act(() => root.unmount());
});
