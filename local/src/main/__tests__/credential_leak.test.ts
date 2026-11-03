import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HarnessRuntime } from "../runtime";
import { createMonitorSource } from "../remoteMonitor";
import { loadRuntimeConfig } from "../config";
import { PUBLIC_VERDICT_SCHEMA } from "../../../../shared/publicProjection";
import { buildConversationExport } from "../../renderer/conversationExport";
import { exportFixture } from "../../renderer/__fixtures__/conversationExport";

afterEach(() => {vi.unstubAllEnvs(); vi.unstubAllGlobals();});

it("keeps configured credentials out of runtime state and conversation records", async () => {
  const token = "fixture-private-monitor-credential";
  const assistantKey = "fixture-private-assistant-credential";
  vi.stubEnv("RSH_LOCAL_HOSTED_ASSISTANT", "1"); vi.stubEnv("RSH_LOCAL_ASSISTANT_OPENROUTER_API_KEY", assistantKey);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/health")) return new Response(JSON.stringify({ok: true, status: "primary", monitor: "Sospio remote monitor"}));
    if (url.endsWith("/api/tags")) return new Response(JSON.stringify({models: [{name: "llama3.2:3b"}]}));
    if (url.endsWith("/turn")) return new Response(JSON.stringify({ok: true}));
    return new Response(JSON.stringify({verdict: {turn_id: decodeURIComponent(url.split("/").at(-1)!), schema_version: PUBLIC_VERDICT_SCHEMA, signals: [], monitor_version: "Sospio remote monitor", monitor_status: "primary"}}));
  }));
  const directory = mkdtempSync(join(tmpdir(), "sospio-credential-check-")); const states: string[] = [];
  try {
    const config = {...loadRuntimeConfig(), chatModel: "llama3.2:3b"};
    const source = createMonitorSource({baseUrl: "http://127.0.0.1:12345/monitor/v1", token});
    const chat = {prewarm: async () => {}, streamChat: async () => ({text: "synthetic reply", completed: true as const})};
    const runtime = new HarnessRuntime(config, directory, chat, source.getClient, state => states.push(JSON.stringify(state)), message => states.push(message),
      {startMonitor: source.start, settings: () => ({url: "http://127.0.0.1:12345", configured: true})});
    await runtime.initialize(); await runtime.sendMessage("synthetic message");
    states.push(JSON.stringify(runtime.getState()));
    for (const name of readdirSync(directory)) states.push(readFileSync(join(directory, name), "utf8"));
    for (const state of states) for (const secret of [token, assistantKey]) expect(state).not.toContain(secret);
    runtime.dispose();
  } finally {rmSync(directory, {recursive: true, force: true});}
});

it("exports only sharing fields when an internal state contains credential fields", () => {
  const secret = "fixture-private-export-credential";
  const state = exportFixture(); Object.assign(state, {apiKey: secret, token: secret, recordingPath: "private-recording", rawResponse: secret});
  const result = JSON.stringify(buildConversationExport(state, {exported_at: "now", surface: "electron", app_version: "test"}));
  for (const value of [secret, "private-recording", "apiKey", "rawResponse"]) expect(result).not.toContain(value);
});
