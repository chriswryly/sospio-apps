import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CLAIM_UNAVAILABLE_MESSAGE, claimMonitorToken } from "./monitorClaim";
import { MonitorSettings, type SecureStorage } from "./monitorSettings";

const directories: string[] = [];
afterEach(() => {for (const directory of directories.splice(0)) rmSync(directory, {recursive: true, force: true});});

it("claims in the main process without credentials and encrypts the token without returning it", async () => {
  const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "monitor-claim-")); directories.push(dataDir);
  const safeStorage: SecureStorage = {
    isEncryptionAvailable: () => true,
    encryptString: vi.fn(value => Buffer.from([...value].reverse().join(""))),
    decryptString: value => [...value.toString()].reverse().join(""),
  };
  const settings = new MonitorSettings({dataDir, safeStorage, env: {}});
  const token = "private-claimed-token-fixture"; const code = "private-invite-fixture";
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({token}), {status: 200}));
  const result = await claimMonitorToken({url: "https://monitor.sosp.io/monitor/v1", code}, settings, fetch);
  expect(result).toEqual({ok: true});
  expect(fetch).toHaveBeenCalledWith("https://monitor.sosp.io/monitor/v1/claim", expect.objectContaining({
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({code}), redirect: "error", credentials: "omit",
  }));
  expect(safeStorage.encryptString).toHaveBeenCalledWith(token);
  expect(settings.load()).toEqual({baseUrl: "https://monitor.sosp.io/monitor/v1", token});
  const stored = readFileSync(join(dataDir, "monitor-settings.json"), "utf8");
  expect(stored).not.toContain(token); expect(stored).not.toContain(code);
  expect(JSON.stringify(result)).not.toContain(token);
});

it("does not issue a claim when secure token storage is unavailable", async () => {
  const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "monitor-claim-")); directories.push(dataDir);
  const safeStorage: SecureStorage = {
    isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn(),
  };
  const settings = new MonitorSettings({dataDir, safeStorage, env: {}});
  const fetch = vi.fn<typeof globalThis.fetch>();
  expect(await claimMonitorToken({url: "https://monitor.sosp.io", code: "invite-fixture"}, settings, fetch)).toEqual({ok: false, message: CLAIM_UNAVAILABLE_MESSAGE});
  expect(fetch).not.toHaveBeenCalled(); expect(safeStorage.encryptString).not.toHaveBeenCalled();
  expect(settings.view().configured).toBe(false);
});

it.each([
  [401, "relay_claim_invalid_code", "That invite code didn't work."],
  [429, "relay_claim_lockout", "Too many tries. Wait 15 minutes."],
  [429, "relay_claim_daily", "This network has reached today's limit for new tokens. Try again tomorrow."],
  [429, "relay_claim_hourly", "Lots of people are getting tokens right now. Try again in an hour."],
  [429, "relay_claim_rate", "Too many token requests. Try again later."],
  [410, "relay_claims_exhausted", "All trial tokens have been handed out. Contact the person who shared Sospio with you."],
  [404, "not_found", "This monitor server isn't giving out tokens. Ask the person who shared Sospio with you for one."],
  [404, "relay_claim_daily", CLAIM_UNAVAILABLE_MESSAGE],
  [503, "monitor_unavailable", CLAIM_UNAVAILABLE_MESSAGE],
  [200, "relay_claim_invalid_code", CLAIM_UNAVAILABLE_MESSAGE],
  [401, "relay_claim_rate", CLAIM_UNAVAILABLE_MESSAGE],
])("maps only the known status and error pair %s %s", async (status, error, message) => {
  const settings = {save: vi.fn(), canSaveToken: () => true};
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({error}), {status: Number(status)}));
  expect(await claimMonitorToken({url: "https://monitor.sosp.io", code: "invite-fixture"}, settings, fetch)).toEqual({ok: false, message});
  expect(settings.save).not.toHaveBeenCalled();
});

it.each(["http://unsafe.invalid", "https://monitor.sosp.io/?code=private", "https://user:private@monitor.sosp.io", "https://monitor.sosp.io/wrong"])("rejects an unsafe URL before making a request", async url => {
  const fetch = vi.fn<typeof globalThis.fetch>(); const settings = {save: vi.fn(), canSaveToken: () => true};
  expect(await claimMonitorToken({url, code: "invite-fixture"}, settings, fetch)).toEqual({ok: false, message: CLAIM_UNAVAILABLE_MESSAGE});
  expect(fetch).not.toHaveBeenCalled(); expect(settings.save).not.toHaveBeenCalled();
});

it.each(["", "invalid\ncode", "invalid\u0000code", "x".repeat(4097)])("rejects an invalid invite code before making a request", async code => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  expect(await claimMonitorToken({url: "https://monitor.sosp.io", code}, {save: vi.fn(), canSaveToken: () => true}, fetch)).toEqual({ok: false, message: CLAIM_UNAVAILABLE_MESSAGE});
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps arbitrary response, transport and secure storage errors out of the result and logs", async () => {
  const token = "private-claimed-token-fixture"; const code = "private-invite-fixture";
  const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
  try {
    const unsafe = JSON.stringify({error: code, token});
    const fetches = [
      vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(unsafe)),
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(unsafe, {status: 500})),
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("invalid response " + unsafe)),
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(unsafe)),
    ];
    for (const fetch of fetches) {
      const result = await claimMonitorToken({url: "https://monitor.sosp.io", code}, {save: () => {throw new Error(unsafe);}, canSaveToken: () => true}, fetch);
      expect(result).toEqual({ok: false, message: CLAIM_UNAVAILABLE_MESSAGE});
      expect(JSON.stringify(result)).not.toContain(token); expect(JSON.stringify(result)).not.toContain(code);
    }
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  } finally {for (const log of logs) log.mockRestore();}
});
