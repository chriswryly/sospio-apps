import { afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { MonitorClient } from "./monitorClient";
import { createMonitorSource } from "./remoteMonitor";
import sequence from "../shared/__fixtures__/noticeSequence.json";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const connection = {baseUrl: "https://fixture.invalid/monitor/v1", token: "fixture-token"};

it("requires a token before constructing a client or making a request", () => {
  const request = vi.spyOn(globalThis, "fetch");
  expect(() => createMonitorSource(undefined)).toThrow("remote_monitor_token_required");
  expect(() => createMonitorSource({...connection, token: ""})).toThrow("remote_monitor_token_required");
  expect(request).not.toHaveBeenCalled();
});

it("starts only the remote monitor client", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ok: true, status: "primary", monitor: "Sospio remote monitor"})));
  const source = createMonitorSource(connection);
  expect((await source.start()).monitor).toBe("Sospio remote monitor");
  expect(source.getClient()).toBeInstanceOf(MonitorClient);
  await source.stop();
});

it("authenticates all routes without putting the token in URLs", async () => {
  const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe(["Bearer", "fixture-token"].join(" "));
    expect(init?.redirect).toBe("error");
    return new Response(JSON.stringify(String(url).includes("/verdicts/") ? {verdict: sequence[0]} : {ok: true, status: "primary"}));
  });
  const client = new MonitorClient(connection);
  await client.health(); await client.reconnect(); await client.dismiss("session", "sycophancy");
  await client.postTurn({turn_id: "one"} as any);
  await client.pollVerdict("one"); await client.hasVerdict("one");
  for (const [url] of request.mock.calls) expect(String(url)).not.toContain(connection.token);
});

it.each([[401, "unauthorized"], [429, "relay_cap_turns"], [503, "HTTP 503"]])("reports HTTP %s as unavailable", async (status, code) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({error: code}), {status: Number(status)}));
  await expect(new MonitorClient(connection).postTurn({} as any)).rejects.toThrow(String(code));
});

it("discards raw network and server diagnostics", async () => {
  const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fixture-token raw request"));
  await expect(new MonitorClient(connection).health()).rejects.toThrow("Monitor unavailable: offline");
  request.mockResolvedValue(new Response('{"error":"fixture-token raw diagnostics"}', {status: 500}));
  await expect(new MonitorClient(connection).health()).rejects.toThrow("Monitor unavailable: HTTP 500");
});

it("stops pending polling and aborts its active request when a token is cleared", async () => {
  vi.useFakeTimers();
  const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", {status: 404}));
  const source = createMonitorSource(connection);
  const pending = source.getClient().pollVerdict("one");
  const stopped = expect(pending).rejects.toThrow("Monitor stopped");
  await vi.advanceTimersByTimeAsync(0);
  const signal = request.mock.calls[0][1]?.signal;
  await source.stop();
  await stopped;
  expect(signal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request).toHaveBeenCalledOnce();
});

it("receives a verdict, evidence and citations from a fixture relay", async () => {
  const server = createServer((request, response) => {
    expect(request.headers.authorization).toBe(["Bearer", "fixture-token"].join(" "));
    response.writeHead(200, {"Content-Type": "application/json"});
    response.end(JSON.stringify(request.url?.includes("/verdicts/") ? {verdict: sequence[0]} : {ok: true, status: "primary"}));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture relay did not listen");
    const client = new MonitorClient({baseUrl: `http://127.0.0.1:${address.port}/monitor/v1`, token: "fixture-token"});
    await client.postTurn({turn_id: "one"} as any);
    const verdict = await client.pollVerdict("one");
    expect(verdict.judge_ladder?.pooled).toEqual(sequence[0].judge_ladder.pooled);
    expect(verdict.monitor_version).toBe("Sospio remote monitor");
  } finally { await new Promise<void>(done => server.close(() => done())); }
});
