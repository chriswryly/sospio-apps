// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { UtilityNotice } from "./UtilityNotice";
import type { MonitorVerdict } from "../shared/types";

it("dismisses presentation without mutating evidence, and shows a new turn's notice", async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); const root = createRoot(host);
  const verdict = { turn_id: "one", monitor_utility: { decision: "P", schema: "notice_utility_v1", authority: "notice_only" }, utility_notice: { notice_id: "one", text: "Exact evidence for one", dismissible: true } } as MonitorVerdict;
  await act(async () => root.render(<UtilityNotice verdict={verdict} />));
  await act(async () => host.querySelector("button")!.click());
  expect(host.textContent).not.toContain("Exact evidence for one");
  expect(verdict.utility_notice?.text).toBe("Exact evidence for one");
  await act(async () => root.render(<UtilityNotice verdict={{ ...verdict, turn_id: "two", utility_notice: { ...verdict.utility_notice!, notice_id: "two", text: "Exact evidence for two" } }} />));
  expect(host.textContent).toContain("Exact evidence for two");
  await act(async () => root.unmount());
});
