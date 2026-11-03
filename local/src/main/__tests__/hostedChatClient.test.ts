import { afterEach, expect, it, vi } from "vitest";
import { HostedChatClient, HostedChatError } from "../hostedChatClient";
import { HostedSpend } from "../hostedSpend";
import { assistantKey, hostedConfig, model, streamResponse, delta, finish, done } from "./hostedFixtures";
afterEach(() => {vi.unstubAllEnvs(); vi.unstubAllGlobals();});
const request = {model: model.id, systemPrompt: "system", messages: [
  {id: "1", role: "user" as const, content: "hello", created_at: "now"},
  {id: "2", role: "governor" as const, content: "private notice", created_at: "now"},
]};
function client(cap = 1) {
  const ledger = new HostedSpend(cap);
  const log = vi.fn();
  return {chat: new HostedChatClient(hostedConfig().hosted!, ledger, log), ledger, log};
}
it("streams split UTF8/data lines, comments, DONE and trailing usage, with privacy and price ceilings", async () => {
  const fetch = vi.fn(async () => streamResponse([": keepalive\n\n", delta("hé😸"), delta("llo"), finish,
    {choices: [], usage: {prompt_tokens: 100, completion_tokens: 5, cost: 0.002}}, done], 1));
  vi.stubGlobal("fetch", fetch);
  const {chat, log} = client(); const chunks = vi.fn();
  const result = await chat.streamChat(request, chunks);
  expect(result.text).toBe("hé😸llo");
  expect(chunks.mock.calls).toEqual([["hé😸"], ["hé😸llo"]]);
  expect(result.hosted).toMatchObject({generation_id: "gen-test", upstream_provider: "Google", prompt_tokens: 100, completion_tokens: 5, settled_usd: 0.002, basis: "reported_cost"});
  const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(options.headers).toEqual({"Content-Type": "application/json", Authorization: ["Bearer", assistantKey].join(" ")});
  expect(JSON.parse(options.body as string)).toEqual({model: model.id, messages: [{role: "system", content: "system"}, {role: "user", content: "hello"}], stream: true, max_tokens: 1024,
    reasoning: {effort: "minimal"}, provider: {data_collection: "deny", zdr: true, require_parameters: true, allow_fallbacks: false, sort: "throughput", max_price: {prompt: 0.25, completion: 1.5, request: 0}}});
  expect(log).toHaveBeenCalledOnce();
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/sk\x2d|Authorization|Bearer/);
});
it.each([
  [[delta("part"), {error: {message: assistantKey}}], "chat_stream_error"],
  [[{choices: [{delta: {tool_calls: []}}]}], "chat_stream_error"],
  [[{choices: [{delta: {function_call: {}}}]}], "chat_stream_error"],
  [["data: not-json\n\n"], "chat_stream_malformed"],
  [[{choices: [{delta: {content: 4}}]}], "chat_stream_malformed"],
  [[delta("partial"), done], "chat_stream_incomplete"],
  [[delta("partial")], "chat_stream_incomplete"],
] as const)("fails visibly and charges incomplete streams %#", async (events, reason) => {
  const fetch = vi.fn(async () => streamResponse([...events])); vi.stubGlobal("fetch", fetch);
  const {chat, ledger, log} = client();
  await expect(chat.streamChat(request, () => {})).rejects.toThrow(reason);
  expect(fetch).toHaveBeenCalledOnce(); expect(log).toHaveBeenCalledOnce();
  expect(ledger.state().spent_usd).toBeGreaterThan(0);
});
it("retains authoritative usage even when a later stream error occurs", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => streamResponse([delta("partial"), {choices: [], usage: {cost: 0.001}}, {error: {message: "failed"}}])));
  const {chat, log} = client();
  try { await chat.streamChat(request, () => {}); throw new Error("expected failure"); }
  catch (e) { expect(e).toBeInstanceOf(HostedChatError); expect((e as HostedChatError).hosted?.settled_usd).toBe(0.001); }
  expect(log.mock.calls[0][0].basis).toBe("reported_cost");
});
it("scrubs 401 errors and clamps the detail to 300 chars", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(`${assistantKey} sk\x2dother-key ${"x".repeat(500)}`, {status: 401})));
  const {chat} = client();
  const error = await chat.streamChat(request, () => {}).catch(e => e as Error);
  expect((error as Error).message).toContain("Hosted chat failed: HTTP 401");
  expect((error as Error).message).not.toMatch(/sk\x2d/);
  expect((error as Error).message.split(" - ")[1].length).toBeLessThanOrEqual(300);
});
it("charges aborted transport and hides credential-bearing exception details", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => {throw new Error(["Bearer", assistantKey].join(" "));}));
  const {chat, ledger} = client();
  await expect(chat.streamChat(request, () => {})).rejects.toThrow("Hosted chat transport failed");
  expect(ledger.state().spent_usd).toBeGreaterThan(0);
});
it("never fetches on cap refusal, unknown model or prewarm", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const {chat} = client(0.0001);
  await chat.prewarm();
  await expect(chat.streamChat(request, () => {})).rejects.toThrow("hosted_cap_reached");
  await expect(chat.streamChat({...request, model: "unknown"}, () => {})).rejects.toThrow("unavailable");
  expect(fetch).not.toHaveBeenCalled();
});
it("maps each model's reasoning setting onto the request", async () => {
  const fetch = vi.fn(async () => streamResponse([delta("ok"), finish, {choices: [], usage: {cost: 0.0001}}, done]));
  vi.stubGlobal("fetch", fetch);
  const hosted = hostedConfig().hosted!;
  const variants: Array<[Partial<typeof model>, unknown]> = [
    [{disable_reasoning: true, reasoning_effort: undefined}, {effort: "none"}],
    [{disable_reasoning: undefined, reasoning_effort: "minimal"}, {effort: "minimal"}],
    [{disable_reasoning: undefined, reasoning_effort: undefined}, undefined],
  ];
  for (const [patch, expected] of variants) {
    const variant = {...model, ...patch};
    const chat = new HostedChatClient({...hosted, models: [variant]}, new HostedSpend(1), vi.fn());
    await chat.streamChat({...request, model: variant.id}, () => {});
    const body = JSON.parse((fetch.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body as string);
    expect(body.reasoning).toEqual(expected);
  }
});
