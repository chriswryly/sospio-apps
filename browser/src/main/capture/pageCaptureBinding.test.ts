/**
 * The page hook reports a capture through `Runtime.addBinding`, and until now the *page* decided
 * which of (network body, rendered DOM text) became the turn — by raw byte length, the comparison
 * `chooseAssistantTextSource` was written to replace. That is how a request which produced no
 * reply of its own came to be recorded wearing the previous answer.
 * These tests drive the binding the way the page
 * does and assert on what reaches the turn stream.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { on: vi.fn() },
}));

import { CaptureService } from "./cdpClient";
import type { ParserDiagnostic, TurnEvent } from "../../shared/types";

const COMPLETION_URL = "https://chatgpt.com/backend-api/f/conversation";
const PREVIOUS_ANSWER = "a previous answer that is still on screen and long enough to win a length contest";

function chatgptRequest(prompt: string): string {
  return JSON.stringify({
    body: { input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }] },
  });
}

function chatgptResponse(text: string): string {
  return [
    `data: ${JSON.stringify({
      message: { author: { role: "assistant" }, content: { content_type: "text", parts: [text] } },
    })}`,
    "data: [DONE]",
  ].join("\n\n");
}

function harness(): { service: CaptureService; turns: TurnEvent[]; diagnostics: ParserDiagnostic[] } {
  const service = new CaptureService();
  const turns: TurnEvent[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  service.on("turn", (turn) => turns.push(turn));
  service.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
  return { service, turns, diagnostics };
}

async function pageCapture(service: CaptureService, payload: Record<string, string>): Promise<void> {
  await (service as unknown as {
    handleMessage(target: unknown, method: string, params: Record<string, unknown>): Promise<void>;
  }).handleMessage({}, "Runtime.bindingCalled", {
    name: "rshCapture",
    payload: JSON.stringify(payload),
  });
}

describe("page capture binding", () => {
  it("does not dress a request that returned no reply in whatever is on screen", async () => {
    // The pre-flight shape, generalised: the completion rule matched, the request body holds a
    // prompt, the response is a token blob the parser finds nothing in, and the previous answer
    // is still rendered. `/backend-api/f/conversation/prepare` is excluded by name now; this is
    // the class that exclusion does not cover.
    const { service, turns, diagnostics } = harness();

    await pageCapture(service, {
      url: COMPLETION_URL,
      requestBody: chatgptRequest("t"),
      responseBody: JSON.stringify({ conduit_token: "c".repeat(200) }),
      renderedText: PREVIOUS_ANSWER,
    });

    expect(turns).toEqual([]);
    expect(diagnostics).toContainEqual(expect.objectContaining({
      kind: "skipped",
      reason: "response did not contain plain assistant text",
    }));
  });

  it("captures a real completion from the network body, not the screen", async () => {
    const { service, turns } = harness();
    const reply = "the real reply, rendered in full and then some, so the stream is the fuller source";

    await pageCapture(service, {
      url: COMPLETION_URL,
      requestBody: chatgptRequest("a real question"),
      responseBody: chatgptResponse(reply),
      renderedText: reply.slice(0, 20),
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]!.user_prompt).toBe("a real question");
    // A raw-length comparison is not what decides this: the SSE envelope is bulkier than either
    // text. What the network body *extracts* is the whole reply, and it beats a DOM read caught
    // mid-stream.
    expect(turns[0]!.assistant_text).toBe(reply);
  });

  it("still falls back to the screen when the stream parses to nothing", async () => {
    // The load-bearing case: a body that carries SSE frames was a completion, so a parser that
    // recovers nothing from it must degrade to the DOM rather than to silence.
    const { service, turns } = harness();

    await pageCapture(service, {
      url: COMPLETION_URL,
      requestBody: chatgptRequest("a real question"),
      responseBody: ["data: {\"v\":{\"unknown_envelope\":1}}", "data: [DONE]"].join("\n\n"),
      renderedText: PREVIOUS_ANSWER,
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]!.assistant_text).toBe(PREVIOUS_ANSWER);
  });
});


describe("aborted ChatGPT capture", () => {
  it.each([
    ["complete abort", "net::ERR_ABORTED", true, "private answer", true],
    ["partial abort", "net::ERR_ABORTED", false, "private answer", false],
    ["other failure", "net::ERR_FAILED", true, "private answer", false],
    ["empty completion", "net::ERR_ABORTED", true, "", false],
  ])("handles %s without using stale DOM content", async (_name, errorText, done, answer, recovered) => {
    const { service, turns, diagnostics } = harness();
    const target = { sendCommand: vi.fn(async () => ({})) };
    const handle = (method: string, params: Record<string, unknown>) =>
      (service as unknown as { handleMessage(target: unknown, method: string, params: Record<string, unknown>): Promise<void> })
        .handleMessage(target, method, params);
    await handle("Network.requestWillBeSent", { requestId: "abort-test", request: {
      url: COMPLETION_URL, method: "POST", postData: chatgptRequest("private prompt"),
    } });
    const body = done ? chatgptResponse(String(answer)) : chatgptResponse(String(answer)).replace("data: [DONE]", "");
    await handle("Network.dataReceived", { requestId: "abort-test", data: Buffer.from(body).toString("base64") });
    await handle("Network.loadingFailed", { requestId: "abort-test", errorText });
    expect(turns).toHaveLength(recovered ? 1 : 0);
    if (recovered) {
      expect(turns[0]?.assistant_text).toBe(answer);
      expect(turns[0]?.user_prompt).toBe("private prompt");
      await handle("Network.loadingFinished", { requestId: "abort-test" });
      expect(turns).toHaveLength(1);
    } else {
      expect(diagnostics.at(-1)?.reason).toBe(`${errorText} buffered_chars=${body.length} done_marker=${done}`);
    }
    expect(JSON.stringify(diagnostics)).not.toContain("private");
    expect(target.sendCommand).not.toHaveBeenCalled();
  });
});
