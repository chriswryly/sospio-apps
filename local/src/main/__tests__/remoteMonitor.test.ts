import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMonitorSource } from "../remoteMonitor";
import { HarnessRuntime } from "../runtime";
import { loadRuntimeConfig } from "../config";
import { MonitorClient } from "../monitorClient";
import { PUBLIC_VERDICT_SCHEMA } from "../../../../shared/publicProjection";

afterEach(() => {vi.unstubAllGlobals(); vi.unstubAllEnvs();});

it("creates no monitor client and performs no requests without a token", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const source = createMonitorSource();
  expect(source.getClient()).toBeUndefined();
  expect(() => createMonitorSource({baseUrl: "https://monitor.sosp.io/monitor/v1", token: ""})).toThrow("Enter your Sospio monitor token");
  await expect(source.start()).rejects.toThrow("Enter your Sospio monitor token");
  const directory = mkdtempSync(join(tmpdir(), "sospio-startup-"));
  try {
    const chat = {prewarm: vi.fn(), streamChat: vi.fn()};
    const runtime = new HarnessRuntime(loadRuntimeConfig(), directory, chat, source.getClient, () => {}, () => {}, {
      startMonitor: source.start, settings: () => ({url: "https://monitor.sosp.io", configured: false}),
    });
    await runtime.initialize();
    await expect(runtime.sendMessage("hello")).rejects.toThrow("Enter your Sospio monitor token");
    expect(chat.prewarm).not.toHaveBeenCalled(); expect(chat.streamChat).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(runtime.getState().monitorSetup?.configured).toBe(false); runtime.dispose();
  } finally {rmSync(directory, {recursive: true, force: true});}
});

it("uses the remote transport and exposes a fixture verdict", async () => {
  const verdict = {turn_id: "fixture-turn", schema_version: PUBLIC_VERDICT_SCHEMA, signals: [], monitor_version: "Sospio remote monitor", monitor_status: "primary", tier: 1, tier_reason: "monitor_selected_action", selected_mechanisms: ["display_governor_notice"]};
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/health") ? {ok: true, status: "primary", monitor: "Sospio remote monitor"} : {verdict}), {headers: {"Content-Type": "application/json"}}));
  vi.stubGlobal("fetch", fetch);
  const source = createMonitorSource({baseUrl: "http://127.0.0.1:12345/monitor/v1", token: "fixture-token"});
  expect(await source.start()).toMatchObject({status: "primary"});
  const result = await source.getClient()!.pollVerdict("fixture-turn", 1000);
  expect(result.intervention).toMatchObject({tier: 1, selected_mechanisms: ["display_governor_notice"]});
  const headers = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Headers;
  expect(headers.get("Authorization")).toBe(["Bearer", "fixture-token"].join(" "));
  source.clear(); expect(source.getClient()).toBeUndefined();
});

it("reports authentication failures without repeating server diagnostics or credentials", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("private server detail", {status: 401})));
  await expect(new MonitorClient({baseUrl: "https://monitor.sosp.io/monitor/v1", token: "fixture-token"}).health()).rejects.toThrow("Monitor unavailable: unauthorized");
});
