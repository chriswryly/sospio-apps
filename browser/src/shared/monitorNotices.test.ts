import { describe, expect, it, vi } from "vitest";
import sequence from "./__fixtures__/noticeSequence.json";
import { judgeTierText, judgeUnavailableText } from "./monitorNotices";
import type { MonitorVerdict } from "./types";
import { MonitorClient } from "../main/monitorClient";

const verdicts = sequence as MonitorVerdict[];
describe("recorded judge ladder verdicts", () => {
  it("selects the remote monitor text at tiers 1 and 2 and preserves old-mode fallback", () => {
    expect(judgeTierText(verdicts[0], "tier1")).toBe(verdicts[0].judge_ladder!.signals.overreliance_signals.text.tier1);
    expect(judgeTierText(verdicts[1], "observation")).toBe(verdicts[1].judge_ladder!.signals.overreliance_signals.text.observation);
    expect(judgeTierText({ ...verdicts[0], judge_ladder: undefined }, "tier1")).toBeUndefined();
    expect(verdicts.every((v) => !v.monitor_utility && !v.utility_notice)).toBe(true);
  });
  it("posts dismissal with the session and signal", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetcher);
    try {
      await new MonitorClient({baseUrl: "http://127.0.0.1:8799", token: "fixture-token"}).dismiss("s", "sycophancy");
      expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:8799/dismiss", expect.objectContaining({ method: "POST", body: JSON.stringify({ session_id: "s", signal: "sycophancy" }) }));
    } finally { vi.unstubAllGlobals(); }
  });
});


it("uses provisional readable unavailable wording for both signals", () => {
  expect(judgeUnavailableText("overreliance_signals")).toBe("Sospio: overreliance monitoring is unavailable right now.");
  expect(judgeUnavailableText("sycophancy")).toBe("Sospio: sycophancy monitoring is unavailable right now.");
});
