import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { on: vi.fn() },
}));

import {
  RENDERED_TEXT_SAMPLE_INTERVAL_MS,
  RENDERED_TEXT_STABLE_SAMPLES,
  RENDERED_TEXT_SETTLE_TIMEOUT_MS,
  settleVisibleAssistantText,
} from "./cdpClient";
import { REQUEST_CONTEXT_EFFECT_SIGNATURE } from "./requestMediation";

/** Repeat a value enough times to satisfy the stability window. */
function held(value: string): string[] {
  return Array.from({ length: RENDERED_TEXT_STABLE_SAMPLES }, () => value);
}

/**
 * Debugger stub whose `Runtime.evaluate` returns the next scripted rendered-text sample on each
 * call, holding the final value once exhausted — a reply that streams in and then stops.
 */
function scriptedRenderer(samples: string[]) {
  let calls = 0;
  return {
    isAttached: () => true,
    async sendCommand(method: string) {
      if (method !== "Runtime.evaluate") return {};
      const value = samples[Math.min(calls, samples.length - 1)];
      calls += 1;
      return { result: { value } };
    },
    get callCount() {
      return calls;
    },
  };
}

async function settle(dbg: unknown, provider: string, ms: number) {
  const pending = settleVisibleAssistantText(dbg as never, provider);
  await vi.advanceTimersByTimeAsync(ms);
  return pending;
}

const generous = RENDERED_TEXT_SAMPLE_INTERVAL_MS * (RENDERED_TEXT_STABLE_SAMPLES + 12);

describe("rendered assistant text settling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for a late-arriving trailing sentinel instead of truncating the reply", async () => {
    // The original regression. The browser probe asks the model to END its reply with the
    // sentinel, so it is painted last; a fixed-delay sample returned the reply mid-render and
    // reported the effect absent — 2/6 detected while the operator saw it 6/6.
    vi.useFakeTimers();
    const dbg = scriptedRenderer([
      "Here is",
      "Here is a qualified",
      "Here is a qualified answer",
      ...held(`Here is a qualified answer ${REQUEST_CONTEXT_EFFECT_SIGNATURE}`),
    ]);

    const result = await settle(dbg, "chatgpt", generous);

    expect(result.text).toContain(REQUEST_CONTEXT_EFFECT_SIGNATURE);
    expect(result.settled).toBe(true);
    expect(result.reason).toBe("stable");
  });

  it("does not mistake a mid-generation pause for a finished reply", async () => {
    // The second defect found on 2026-07-29: a 2-sample window meant any pause between
    // paragraphs looked stable, returning a partial reply whose trailing sentinel was absent.
    vi.useFakeTimers();
    const paused = "First paragraph complete.";
    const dbg = scriptedRenderer([
      "First",
      paused,
      paused, // pause — must NOT settle here
      `${paused} And the rest ${REQUEST_CONTEXT_EFFECT_SIGNATURE}`,
      ...held(`${paused} And the rest ${REQUEST_CONTEXT_EFFECT_SIGNATURE}`),
    ]);

    const result = await settle(dbg, "chatgpt", generous);

    expect(result.text).toContain(REQUEST_CONTEXT_EFFECT_SIGNATURE);
    expect(result.settled).toBe(true);
  });

  it("returns once the text holds still for the stability window", async () => {
    vi.useFakeTimers();
    const dbg = scriptedRenderer(held("stable answer"));

    const result = await settle(dbg, "chatgpt", generous);

    expect(result.text).toBe("stable answer");
    expect(result.reason).toBe("stable");
    // Must stop at the window rather than polling to the timeout.
    expect(dbg.callCount).toBeLessThanOrEqual(RENDERED_TEXT_STABLE_SAMPLES + 2);
  });

  it("does not settle on the empty pre-render state", async () => {
    // Repeated empty reads must not count as settled, or every slow reply returns "".
    vi.useFakeTimers();
    const dbg = scriptedRenderer(["", "", "", "", "", ...held("late answer")]);

    const result = await settle(dbg, "chatgpt", generous);

    expect(result.text).toBe("late answer");
    expect(result.settled).toBe(true);
  });

  it("reports a timeout instead of silently returning a partial reply", async () => {
    // This is what a still-streaming long reply looks like. The caller needs to know the read
    // was cut short, so a failed effect check can say why rather than reporting a bare negative.
    vi.useFakeTimers();
    let n = 0;
    const dbg = {
      isAttached: () => true,
      async sendCommand(method: string) {
        if (method !== "Runtime.evaluate") return {};
        n += 1;
        return { result: { value: `growing ${n}` } };
      },
    };

    const result = await settle(
      dbg,
      "chatgpt",
      RENDERED_TEXT_SETTLE_TIMEOUT_MS + RENDERED_TEXT_SAMPLE_INTERVAL_MS * 4,
    );

    expect(result.settled).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.text).toMatch(/^growing \d+$/);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(RENDERED_TEXT_SETTLE_TIMEOUT_MS);
  });

  it("preserves text already read when an evaluate fails mid-stream", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const dbg = {
      isAttached: () => true,
      async sendCommand(method: string) {
        if (method !== "Runtime.evaluate") return {};
        calls += 1;
        if (calls === 1) return { result: { value: "partial answer" } };
        throw new Error("target detached");
      },
    };

    const result = await settle(dbg, "chatgpt", RENDERED_TEXT_SAMPLE_INTERVAL_MS * 6);

    expect(result.text).toBe("partial answer");
    expect(result.reason).toBe("evaluate_failed");
    expect(result.settled).toBe(false);
  });

  it("still requires substantive text for pi.ai", async () => {
    vi.useFakeTimers();
    // "Copy" is UI chrome, not an answer; it must not settle even when repeated.
    const dbg = scriptedRenderer(["Copy", "Copy", "Copy", "Copy", "Copy", ...held("real pi answer")]);

    const result = await settle(dbg, "piai", generous);

    expect(result.text).toBe("real pi answer");
  });

  it("waits long enough for a slow reply to finish", async () => {
    // The 12s cap set on the first pass was too short: three of five trials ran past it.
    expect(RENDERED_TEXT_SETTLE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});
