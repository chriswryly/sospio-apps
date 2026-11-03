import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { on: vi.fn() },
}));

import { CaptureService } from "./cdpClient";
import type { ParserDiagnostic } from "../../shared/types";

const GROK_COMPLETION = "https://grok.com/rest/app-chat/conversations/abc/responses";

/**
 * Two different requests can be skipped for the same reason. Keying the dedup cache on the
 * reason alone suppressed every body shape after the first, which is how the Grok blocker stayed
 * invisible: a metadata call carrying only `responseIds` was reported, and anything else skipped
 * in the same window -- possibly the real completion request -- was dropped.
 */
describe("diagnostic dedup keys on body shape", () => {
  let service: CaptureService;
  let diagnostics: ParserDiagnostic[];
  let debuggerTarget: { isAttached(): boolean; sendCommand(m: string, p?: unknown): Promise<unknown> };

  beforeEach(() => {
    service = new CaptureService();
    diagnostics = [];
    service.on("diagnostic", (d) => diagnostics.push(d));
    debuggerTarget = { isAttached: () => true, async sendCommand() { return {}; } };
  });

  async function sendRequest(requestId: string, body: unknown): Promise<void> {
    await (service as unknown as {
      handleMessage(t: unknown, m: string, p: Record<string, unknown>): Promise<void>;
    }).handleMessage(debuggerTarget, "Network.requestWillBeSent", {
      requestId,
      request: { url: GROK_COMPLETION, method: "POST", postData: JSON.stringify(body) },
    });
  }

  it("reports each distinct body shape rather than only the first", async () => {
    // Shape 1: the metadata call actually observed on Grok -- no user text, correctly skipped.
    await sendRequest("net-1", { responseIds: Array.from({ length: 12 }, () => "x".repeat(36)) });
    // Shape 2: a different envelope skipped for the same reason, in the same dedup window.
    await sendRequest("net-2", { unknownEnvelope: { payload: { body: 1 } } });

    const skipped = diagnostics.filter((d) => d.reason === "completion request was not a plain user-text turn");
    const shapes = skipped.map((d) => d.body_shape);

    expect(skipped.length).toBe(2);
    expect(shapes.some((s) => s?.includes("responseIds[12]"))).toBe(true);
    expect(shapes.some((s) => s?.includes("unknownEnvelope"))).toBe(true);
  });

  it("still suppresses a genuine repeat of the same shape", async () => {
    const body = { responseIds: ["a".repeat(36)] };
    await sendRequest("net-1", body);
    await sendRequest("net-2", body);

    const skipped = diagnostics.filter((d) => d.reason === "completion request was not a plain user-text turn");
    expect(skipped.length).toBe(1);
  });
});

it("handles rejected inspector setup commands during navigation", async () => {
  const service = new CaptureService();
  const diagnostics: ParserDiagnostic[] = [];
  service.on("diagnostic", d => diagnostics.push(d));
  service.attach({isDestroyed: () => false, getURL: () => "https://chatgpt.com/", on: vi.fn(), once: vi.fn(),
    debugger: {isAttached: () => true, on: vi.fn(), sendCommand: vi.fn().mockRejectedValue(new Error("Inspected target navigated or closed"))}} as never);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(diagnostics.some(d => d.reason === "Inspected target navigated or closed")).toBe(true);
  service.disposeRecording();
});
