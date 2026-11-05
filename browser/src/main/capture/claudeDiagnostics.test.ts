import { afterEach, expect, it, vi } from "vitest";
import { ClaudeDiagnostics, CLAUDE_NO_REQUEST_WAIT_MS } from "./claudeDiagnostics";
import { CaptureService } from "./cdpClient";
vi.mock("electron", () => ({ ipcMain: { on: vi.fn() } }));
const RPC = "https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction";
afterEach(() => vi.useRealTimers());

it("logs PerformAction unmatched plus body shape, redacts secrets and never captures a turn", async () => {
  const service = new CaptureService();
  const emit = vi.fn(), turn = vi.fn();
  service.on("diagnostic", emit); service.on("turn", turn);
  const target = { sendCommand: vi.fn() };
  await (service as any).handleMessage(target, "Network.requestWillBeSent", {
    requestId: "private-id", request: {url: RPC + "?account=secret", method: "POST", postData: "private text"},
  });
  expect(emit).toHaveBeenCalledTimes(2);
  expect(emit.mock.calls.find(([d]) => d.reason.startsWith("Claude body"))?.[0].reason).toContain("shape=non-json body");
  expect(emit.mock.calls.find(([d]) => d.reason.startsWith("unmatched"))?.[0].reason).toBe("unmatched Claude endpoint: method=POST host=claude.ai path=/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction streaming=false");
  expect(JSON.stringify(emit.mock.calls)).not.toMatch(/secret|private/);
  expect(turn).not.toHaveBeenCalled(); expect(target.sendCommand).not.toHaveBeenCalled();
  service.disposeRecording();
});

it("redacts unknown path segments and bounds each type across the session", () => {
  const emit = vi.fn(), diagnostics = new ClaudeDiagnostics(emit);
  for (let i = 0; i < 20; i++) diagnostics.unmatched(`https://claude.ai/api/organizations/org${i}/chat_conversations/conv${i}/secret${i}?token=private`, "POST");
  expect(emit).toHaveBeenCalledTimes(3);
  expect(emit.mock.calls[0][0].reason).toContain("/api/organizations/[redacted]/chat_conversations/[redacted]/[redacted]");
  expect(JSON.stringify(emit.mock.calls)).not.toMatch(/org0|conv0|secret|private|token/);
  diagnostics.unmatched("https://example.com/private", "POST"); diagnostics.unmatched(RPC, "GET");
  expect(emit).toHaveBeenCalledTimes(3);
});

it("logs streaming GET responses with their method without reading bodies", async () => {
  const service = new CaptureService(), emit = vi.fn(); service.on("diagnostic", emit);
  const target = {sendCommand: vi.fn()};
  await (service as any).handleMessage(target, "Network.requestWillBeSent", {requestId: "stream", request: {url: RPC, method: "GET"}});
  await (service as any).handleMessage(target, "Network.responseReceived", {requestId: "stream", response: {url: RPC, mimeType: "text/event-stream"}});
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit.mock.calls[0][0].reason).toContain("method=GET host=claude.ai");
  expect(emit.mock.calls[0][0].reason).toContain("streaming=true");
  expect(target.sendCommand).not.toHaveBeenCalled(); service.disposeRecording();
});

it("reports silence once per session after a send and cancels on any request", () => {
  vi.useFakeTimers(); const emit = vi.fn(), diagnostics = new ClaudeDiagnostics(emit), target = {};
  diagnostics.userSend(target, () => true); diagnostics.request(target, RPC, "POST");
  vi.advanceTimersByTime(CLAUDE_NO_REQUEST_WAIT_MS); expect(emit).not.toHaveBeenCalled();
  diagnostics.userSend(target, () => true); vi.advanceTimersByTime(CLAUDE_NO_REQUEST_WAIT_MS);
  expect(emit.mock.calls[0][0].reason).toBe("Claude page target saw no request within 5000ms after user send");
  diagnostics.userSend(target, () => true); vi.advanceTimersByTime(CLAUDE_NO_REQUEST_WAIT_MS);
  expect(emit).toHaveBeenCalledTimes(1);
});

it("uses the existing send binding and actual window location", async () => {
  vi.useFakeTimers(); const service = new CaptureService(), emit = vi.fn(); service.on("diagnostic", emit);
  const target = {isAttached: () => true, on: vi.fn(), sendCommand: vi.fn().mockResolvedValue({})};
  const send = vi.fn();
  service.attach({isDestroyed: () => false, getURL: () => "https://claude.ai/new", send, on: vi.fn(), once: vi.fn(), debugger: target} as never);
  await (service as any).handleMessage(target, "Runtime.bindingCalled", {name: "rshUserSend", payload: JSON.stringify({provider: "claudeai", at: Date.now()})});
  expect(send).toHaveBeenCalledWith("harness:dom-user-send");
  vi.advanceTimersByTime(CLAUDE_NO_REQUEST_WAIT_MS);
  expect(emit.mock.calls.some(([d]) => d.reason.includes("saw no request"))).toBe(true); service.disposeRecording();
});

it("suppresses silence after navigation, on other providers and after disposal", () => {
  vi.useFakeTimers(); const emit = vi.fn(), diagnostics = new ClaudeDiagnostics(emit); let onClaude = true;
  diagnostics.userSend({}, () => false); diagnostics.userSend({}, () => onClaude); onClaude = false;
  vi.advanceTimersByTime(CLAUDE_NO_REQUEST_WAIT_MS);
  diagnostics.userSend({}, () => true); diagnostics.dispose(); vi.advanceTimersByTime(CLAUDE_NO_REQUEST_WAIT_MS);
  expect(emit).not.toHaveBeenCalled();
});

it("keeps endpoint and RPC names readable while ids stay redacted", () => {
  const emit = vi.fn(), diagnostics = new ClaudeDiagnostics(emit);
  diagnostics.unmatched("https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/SendMessage", "POST");
  diagnostics.unmatched("https://claude.ai/api/organizations/0f3c2a91-77aa-4b1e-9c2d-1a2b3c4d5e6f/chat_conversations/9e8d7c6b-5a49-4382-9172-635445362718/completion_stream", "POST");
  expect(emit.mock.calls[0][0].reason).toContain("path=/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/SendMessage ");
  expect(emit.mock.calls[1][0].reason).toContain("path=/api/organizations/[redacted]/chat_conversations/[redacted]/completion_stream ");
  expect(JSON.stringify(emit.mock.calls)).not.toMatch(/0f3c2a91|9e8d7c6b/);
});

it("does not let analytics or claude.ai GETs cancel the silence report", () => {
  vi.useFakeTimers(); const emit = vi.fn(), diagnostics = new ClaudeDiagnostics(emit), target = {};
  diagnostics.userSend(target, () => true);
  diagnostics.request(target, "https://browser-intake-datadoghq.com/api/v2/rum?ddsource=browser", "POST");
  diagnostics.request(target, "https://claude.ai/api/organizations", "GET");
  diagnostics.request(target, "not a url", "POST");
  vi.advanceTimersByTime(CLAUDE_NO_REQUEST_WAIT_MS);
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit.mock.calls[0][0].reason).toContain("saw no request");
});

it("lets a claude.ai streaming response cancel the silence report", () => {
  vi.useFakeTimers(); const emit = vi.fn(), diagnostics = new ClaudeDiagnostics(emit), target = {};
  diagnostics.userSend(target, () => true);
  diagnostics.request(target, RPC, "GET", true);
  vi.advanceTimersByTime(CLAUDE_NO_REQUEST_WAIT_MS);
  expect(emit).not.toHaveBeenCalled();
});
