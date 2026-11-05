import { expect, it, vi } from "vitest";
import { CLAUDE_BODY_QUIET_MS, ClaudeBodyDiagnostics, describeClaudeBody } from "./claudeBodyDiagnostics";

const base = "https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/";
function frame(body: Buffer, flag = 0): Buffer {
  const header = Buffer.alloc(5); header[0] = flag; header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}
function jsonFrame() { return frame(Buffer.from(JSON.stringify({message: {text: "PRIVATE_PROMPT", accountId: "PRIVATE_ACCOUNT"}, enabled: true}))); }
const request = (name = "StreamTimeline") => ({requestId: "PRIVATE_REQUEST", request: {
  url: base + name + "?token=PRIVATE_QUERY", method: "POST", headers: {"Content-Type": "application/connect+json; boundary=PRIVATE_BOUNDARY", Cookie: "PRIVATE_COOKIE"},
  postDataEntries: [{bytes: jsonFrame().toString("base64")}],
}});
const response = {requestId: "PRIVATE_REQUEST", response: {headers: {"content-type": "application/connect+json"}}};

it("describes JSON frames and Connect end frames without values", () => {
  const bytes = Buffer.concat([jsonFrame(), frame(Buffer.from('{"error":{"code":"PRIVATE_ERROR"}}'), 2)]);
  const shape = describeClaudeBody(bytes, "application/connect+json");
  expect(shape).toContain("flag=0 length="); expect(shape).toContain("message.text:str(14)");
  expect(shape).toContain("flag=2 length="); expect(shape).toContain("error.code:str(13)");
  expect(shape).not.toContain("PRIVATE");
});

it("describes only top-level protobuf field numbers and wire types", () => {
  const secret = Buffer.from("PRIVATE_PROTOBUF");
  const proto = Buffer.concat([Buffer.from([8, 127, 18, secret.length]), secret, Buffer.from([29, 1, 2, 3, 4, 33, 1, 2, 3, 4, 5, 6, 7, 8])]);
  expect(describeClaudeBody(frame(proto), "application/connect+proto")).toContain("field=1 wire=0 field=2 wire=2 len=16 field=3 wire=5 field=4 wire=1");
  expect(describeClaudeBody(frame(proto), "application/connect+proto")).not.toContain("PRIVATE");
  expect(describeClaudeBody(frame(Buffer.from([18, 120])), "application/connect+proto")).toContain("invalid-or-incomplete");
});

it("bounds malformed, truncated and compressed frames without decoding payload", () => {
  expect(describeClaudeBody(Buffer.from([0, 0]), "application/connect+json")).toContain("no-complete-frame-header");
  const header = Buffer.from([0, 0xff, 0xff, 0xff, 0xff]);
  expect(describeClaudeBody(header, "application/connect+json")).toContain("length=4294967295 incomplete");
  expect(describeClaudeBody(frame(Buffer.from("PRIVATE_COMPRESSED"), 1), "application/connect+json")).toContain("compressed");
  expect(describeClaudeBody(Buffer.alloc(0), "application/json")).toContain("non-json");
});

it("streams binary CDP data without Fetch pausing or emitting content", async () => {
  const emit = vi.fn(), diagnostics = new ClaudeBodyDiagnostics(emit);
  const target = {sendCommand: vi.fn().mockResolvedValue({bufferedData: ""})};
  await diagnostics.handle(target, "Network.requestWillBeSent", request());
  await diagnostics.handle(target, "Network.responseReceived", response);
  const bytes = jsonFrame();
  await diagnostics.handle(target, "Network.dataReceived", {requestId: "PRIVATE_REQUEST", data: bytes.subarray(0, 3).toString("base64")});
  expect(emit).toHaveBeenCalledTimes(1);
  await diagnostics.handle(target, "Network.dataReceived", {requestId: "PRIVATE_REQUEST", data: bytes.subarray(3).toString("base64")});
  await diagnostics.handle(target, "Network.loadingFinished", {requestId: "PRIVATE_REQUEST"});
  expect(emit.mock.calls[0][0].reason).toContain("direction=request content_type=application/connect+json");
  expect(emit.mock.calls[1][0].reason).toContain(`direction=response content_type=application/connect+json bytes=${bytes.length} source=streamResourceContent`);
  expect(emit.mock.calls[1][0].reason).toContain("message.text:str(14)");
  expect(JSON.stringify(emit.mock.calls)).not.toContain("PRIVATE");
  expect(target.sendCommand.mock.calls.map(([method]) => method)).toEqual(["Network.streamResourceContent"]);
});

it("uses getResponseBody fallback when streaming is unsupported", async () => {
  const emit = vi.fn(), diagnostics = new ClaudeBodyDiagnostics(emit);
  const target = {sendCommand: vi.fn(async (method: string) => {
    if (method === "Network.streamResourceContent") throw new Error("PRIVATE_ERROR");
    return {body: jsonFrame().toString("base64"), base64Encoded: true};
  })};
  await diagnostics.handle(target, "Network.requestWillBeSent", request("PerformAction"));
  await diagnostics.handle(target, "Network.responseReceived", response);
  await diagnostics.handle(target, "Network.loadingFinished", {requestId: "PRIVATE_REQUEST"});
  expect(emit.mock.calls[1][0].reason).toContain("source=getResponseBody");
  expect(JSON.stringify(emit.mock.calls)).not.toContain("PRIVATE");
});

it("reads post data fallback and reports fixed unavailable markers without error content", async () => {
  const emit = vi.fn(), diagnostics = new ClaudeBodyDiagnostics(emit);
  const target = {sendCommand: vi.fn().mockRejectedValue(new Error("PRIVATE_ERROR"))};
  const sent = request();
  delete (sent.request as any).postDataEntries; (sent.request as any).hasPostData = true;
  await diagnostics.handle(target, "Network.requestWillBeSent", sent);
  await diagnostics.handle(target, "Network.responseReceived", response);
  await diagnostics.handle(target, "Network.loadingFailed", {requestId: "PRIVATE_REQUEST", errorText: "PRIVATE_ERROR"});
  expect(emit.mock.calls[0][0].reason).toContain("source=unavailable");
  expect(emit.mock.calls[1][0].reason).toContain("source=unavailable");
  expect(JSON.stringify(emit.mock.calls)).not.toContain("PRIVATE");
});

it("limits logs per endpoint/direction per session and isolates targets", async () => {
  const emit = vi.fn(), diagnostics = new ClaudeBodyDiagnostics(emit);
  const target = {sendCommand: vi.fn().mockResolvedValue({bufferedData: jsonFrame().toString("base64")})};
  const other = {sendCommand: vi.fn()};
  for (let i = 0; i < 8; i++) {
    await diagnostics.handle(target, "Network.requestWillBeSent", request());
    await diagnostics.handle(other, "Network.responseReceived", response);
    await diagnostics.handle(target, "Network.responseReceived", response);
    await diagnostics.handle(target, "Network.loadingFinished", {requestId: "PRIVATE_REQUEST"});
  }
  expect(emit.mock.calls.filter(([d]) => d.reason.includes("direction=request"))).toHaveLength(6);
  expect(emit.mock.calls.filter(([d]) => d.reason.includes("direction=response"))).toHaveLength(6);
  expect(other.sendCommand).not.toHaveBeenCalled();
  await diagnostics.handle(target, "Network.requestWillBeSent", {...request(), request: {...request().request, url: "https://chatgpt.com/anything"}});
  diagnostics.dispose();
  await diagnostics.handle(target, "Network.requestWillBeSent", request("PerformAction"));
  expect(emit).toHaveBeenCalledTimes(12);
});

it("captures shapes through CaptureService without emitting turns or fetching/intercepting", async () => {
  vi.useFakeTimers();
  const { CaptureService } = await import("./cdpClient");
  const service = new CaptureService(), emit = vi.fn(), turns = vi.fn();
  service.on("diagnostic", emit); service.on("turn", turns);
  const target = {sendCommand: vi.fn().mockResolvedValue({bufferedData: jsonFrame().toString("base64")})};
  await (service as any).handleMessage(target, "Network.requestWillBeSent", request());
  await (service as any).handleMessage(target, "Network.responseReceived", response);
  await Promise.resolve(); await Promise.resolve();
  expect(emit.mock.calls.some(([d]) => d.reason.includes("direction=response"))).toBe(false);
  vi.advanceTimersByTime(CLAUDE_BODY_QUIET_MS);
  expect(emit.mock.calls.some(([d]) => d.reason.includes("direction=response"))).toBe(true);
  expect(JSON.stringify(emit.mock.calls)).not.toContain("PRIVATE");
  expect(turns).not.toHaveBeenCalled();
  expect(target.sendCommand.mock.calls.map(([method]) => method)).toEqual(["Network.streamResourceContent"]);
  service.disposeRecording();
});

it("reports an open stream once after it goes quiet, with repeated frames collapsed", async () => {
  vi.useFakeTimers();
  try {
    const emit = vi.fn(), diagnostics = new ClaudeBodyDiagnostics(emit);
    const target = {sendCommand: vi.fn().mockResolvedValue({bufferedData: ""})};
    await diagnostics.handle(target, "Network.requestWillBeSent", request());
    await diagnostics.handle(target, "Network.responseReceived", response);
    const delta = (text: string) => frame(Buffer.from(JSON.stringify({delta: {text}})));
    for (const piece of ["PRIVATE_A", "PRIVATE_BB", "PRIVATE_CCC"]) {
      await diagnostics.handle(target, "Network.dataReceived", {requestId: "PRIVATE_REQUEST", data: delta(piece).toString("base64")});
      vi.advanceTimersByTime(CLAUDE_BODY_QUIET_MS - 1);
    }
    await diagnostics.handle(target, "Network.dataReceived", {requestId: "PRIVATE_REQUEST", data: frame(Buffer.from(JSON.stringify({done: true}))).toString("base64")});
    expect(emit.mock.calls.filter(([d]) => d.reason.includes("direction=response"))).toHaveLength(0);
    vi.advanceTimersByTime(CLAUDE_BODY_QUIET_MS);
    const responses = emit.mock.calls.filter(([d]) => d.reason.includes("direction=response"));
    expect(responses).toHaveLength(1);
    expect(responses[0][0].reason).toContain("source=streamResourceContent_quiet");
    expect(responses[0][0].reason).toMatch(/frames=4 flag=0 length=\d+ \{delta\.text:str\(9\)\} x3 flag=0 length=\d+ \{done:boolean\}/);
    // Nothing new arrived, so finishing does not log the same body again.
    await diagnostics.handle(target, "Network.loadingFinished", {requestId: "PRIVATE_REQUEST"});
    expect(emit.mock.calls.filter(([d]) => d.reason.includes("direction=response"))).toHaveLength(1);
    expect(JSON.stringify(emit.mock.calls)).not.toContain("PRIVATE");
  } finally {
    vi.useRealTimers();
  }
});
