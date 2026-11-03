import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("electron", () => ({}));
import { emotionalVerdict } from "../renderer/__fixtures__/emotionalDependence";
import { judgeTierText } from "../shared/monitorNotices";
import { planFromVerdict } from "./browserPolicyAdapter";
import { executeGovernorPlan, governorTextOptions } from "./governorLoop";
import { buildGovernorNoticeScript, buildTerminateExchangeScript, buildTerminateVerifyScript, removeGovernorNoticeScript, GOVERNOR_NOTICE_MARKER } from "./interventionExecutor";
import { ClosedConversations } from "./closedConversations";
const { JSDOM } = createRequire(import.meta.url)("jsdom");

it.each([1, 2, 3] as const)("shows the ED Tier %s remote monitor text, preserving mixed acting order", tier => {
  const verdict = emotionalVerdict(tier), block = verdict.judge_ladder!;
  const kind = tier === 1 ? "tier1" : tier === 2 ? "observation" : "tier3";
  expect(governorTextOptions(verdict, {noticeText: "fallback", augmentContext: "fallback"}).noticeText).toBe(block.signals.emotional_dependence!.text[kind]);
  block.acting_signals.push("overreliance_signals");
  expect(judgeTierText(verdict, kind)).toBe(block.signals.emotional_dependence!.text[kind] + "\n\n" + block.signals.overreliance_signals.text[kind]);
  block.acting_signals.reverse();
  expect(judgeTierText(verdict, kind)).toBe(block.signals.overreliance_signals.text[kind] + "\n\n" + block.signals.emotional_dependence!.text[kind]);
});

it.each([1, 4] as const)("ED alone reaches Tier %s in the page and Close survives relaunch", async tier => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ed-close-")));
  const dom = new JSDOM('<main>Readable transcript</main><textarea></textarea>', {url: "https://chatgpt.com/c/s", runScripts: "outside-only"});
  const closed = new ClosedConversations(dir, vi.fn());
  const verdict = emotionalVerdict(tier), plan = planFromVerdict(verdict)!;
  const options = governorTextOptions(verdict, {noticeText: "fallback", augmentContext: "fallback"});
  try {
    const result = await executeGovernorPlan(plan, {
      displayNotice: async (text, rung, augment) => dom.window.eval(buildGovernorNoticeScript("chatgpt", text, rung, augment)),
      replaceLatestPresentation: vi.fn(), armRequest: vi.fn(),
      terminateExchange: async text => closed.applyClose({provider: "chatgpt", session_id: "s", turn_id: verdict.turn_id}, async () => {
        dom.window.eval(buildTerminateExchangeScript("chatgpt", text, 0));
        return dom.window.eval(buildTerminateVerifyScript());
      }),
    }, {provider: "chatgpt", threshold: 0.7, ...options});
    expect(result[0].status).toBe("applied");
    expect(plan.triggering_signals.map(s => s.name)).toEqual(["emotional_dependence"]);
    if (tier === 1) {
      expect(dom.window.document.getElementById(GOVERNOR_NOTICE_MARKER).shadowRoot.textContent).toContain(options.noticeText);
      expect(closed.has("chatgpt", "s")).toBe(false);
    } else {
      expect(dom.window.document.querySelector("textarea").disabled).toBe(true);
      expect(new ClosedConversations(dir, vi.fn()).has("chatgpt", "s")).toBe(true);
    }
    expect(dom.window.document.querySelector("main").textContent).toBe("Readable transcript");
  } finally { dom.window.eval(removeGovernorNoticeScript()); dom.window.close(); rmSync(dir, {recursive: true, force: true}); }
});
