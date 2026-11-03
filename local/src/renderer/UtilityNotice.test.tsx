import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { UtilityNotice } from "./UtilityNotice";
import type { MonitorVerdict } from "../shared/types";
it("renders quoted text safely and makes continuation and hidden state explicit", () => {
  const verdict = { turn_id: "turn-1", monitor_utility: { decision: "P", schema: "sospio_notice_utility_v1", authority: "notice_only" }, utility_notice: { notice_id: "id", text: "Evidence: <script>quoted</script>", dismissible: true } } as MonitorVerdict;
  const html = renderToStaticMarkup(<UtilityNotice verdict={verdict} />);
  expect(html).toContain("Hide notice and continue");
  expect(html).toContain("turn-1");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  const unavailable = renderToStaticMarkup(<UtilityNotice verdict={{ ...verdict, monitor_utility: { ...verdict.monitor_utility!, decision: "U" }, utility_notice: null }} />);
  expect(unavailable).toContain("not a clear result");
});
