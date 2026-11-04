import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MonitorSettings } from "../../../../shared/monitorSettings";
import { monitorSetupHandlers } from "../monitorSetup";
import { installIpc, type IpcHandlers } from "../ipc";

const registrations = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>());
vi.mock("electron", () => ({ipcMain: {handle: (name: string, handler: (...args: unknown[]) => unknown) => registrations.set(name, handler)}}));

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals(); registrations.clear();
  for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

it("uses the normal connection startup after a claim without returning the saved token", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "sospio-local-claim-")); directories.push(dataDir);
  const encryptString = vi.fn((value: string) => Buffer.from([...value].reverse().join("")));
  const settings = new MonitorSettings({dataDir, env: {}, safeStorage: {
    isEncryptionAvailable: () => true, encryptString, decryptString: value => [...value.toString()].reverse().join(""),
  }});
  const token = "private-claimed-token-fixture"; const code = "private-invite-fixture";
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({token}))); vi.stubGlobal("fetch", fetch);
  const monitor = {setConnection: vi.fn()}; const initialize = vi.fn().mockResolvedValue(undefined);
  const handlers = monitorSetupHandlers(settings, monitor, initialize);
  expect(await handlers.claimMonitorToken({url: "https://monitor.sosp.io", code})).toEqual({ok: true});
  expect(fetch).toHaveBeenCalledOnce(); expect(encryptString).toHaveBeenCalledWith(token);
  expect(monitor.setConnection).toHaveBeenCalledWith({baseUrl: "https://monitor.sosp.io/monitor/v1", token});
  expect(initialize).toHaveBeenCalledOnce();
  const stored = readFileSync(join(dataDir, "monitor-settings.json"), "utf8");
  for (const secret of [token, code]) expect(stored).not.toContain(secret);
  await handlers.saveMonitorSettings({url: "https://monitor.sosp.io", token: "pasted-token-fixture"});
  expect(monitor.setConnection).toHaveBeenLastCalledWith({baseUrl: "https://monitor.sosp.io/monitor/v1", token: "pasted-token-fixture"});
  expect(initialize).toHaveBeenCalledTimes(2);
});

it("does not start the monitor or save settings after a failed claim", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({error: "relay_claim_invalid_code"}), {status: 401})); vi.stubGlobal("fetch", fetch);
  const settings = {load: vi.fn(), save: vi.fn(), canSaveToken: () => true}; const monitor = {setConnection: vi.fn()}; const initialize = vi.fn();
  const result = await monitorSetupHandlers(settings, monitor, initialize).claimMonitorToken({url: "https://monitor.sosp.io", code: "wrong-invite-fixture"});
  expect(result).toEqual({ok: false, message: "That invite code didn't work."});
  expect(settings.save).not.toHaveBeenCalled(); expect(monitor.setConnection).not.toHaveBeenCalled(); expect(initialize).not.toHaveBeenCalled();
});

function installClaimIpc(trusted: boolean) {
  const claimMonitorToken = vi.fn().mockResolvedValue({ok: true});
  installIpc({isTrusted: () => trusted, claimMonitorToken} as unknown as IpcHandlers);
  return {claimMonitorToken, invoke: registrations.get("harness:claim-monitor-token")!};
}

it("rejects an untrusted claim IPC before calling the main handler", () => {
  const {claimMonitorToken, invoke} = installClaimIpc(false);
  expect(() => invoke({}, {url: "https://monitor.sosp.io", code: "invite-fixture"})).toThrow("untrusted source");
  expect(claimMonitorToken).not.toHaveBeenCalled();
});

it.each([undefined, null, "invite-fixture", {}, {url: 12, code: "invite-fixture"}, {url: "https://monitor.sosp.io", code: 12}])("rejects malformed claim IPC input", value => {
  const {claimMonitorToken, invoke} = installClaimIpc(true);
  expect(() => invoke({}, value)).toThrow("invalid_monitor_claim");
  expect(claimMonitorToken).not.toHaveBeenCalled();
});

it("passes a validated trusted claim to the main handler and returns only its result", async () => {
  const {claimMonitorToken, invoke} = installClaimIpc(true);
  const value = {url: "https://monitor.sosp.io", code: "invite-fixture"};
  expect(await invoke({}, value)).toEqual({ok: true});
  expect(claimMonitorToken).toHaveBeenCalledWith(value);
});
