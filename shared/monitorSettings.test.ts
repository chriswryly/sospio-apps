import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MONITOR_URL, MonitorSettings, refuseMonitorEnvironment, type SecureStorage } from "./monitorSettings";

const directories: string[] = [];
function fixture(env: NodeJS.ProcessEnv = {}) {
  const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "monitor-settings-"));
  directories.push(dataDir);
  const safeStorage: SecureStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(value => Buffer.from("encrypted:" + [...value].reverse().join(""))),
    decryptString: vi.fn(value => [...value.toString().slice("encrypted:".length)].reverse().join("")),
  };
  return { dataDir, safeStorage, settings: new MonitorSettings({ dataDir, safeStorage, env }) };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it("starts unconfigured with the public default URL and writes no settings", () => {
  const { settings, dataDir } = fixture();
  expect(settings.load()).toBeUndefined();
  expect(settings.view()).toEqual({ url: DEFAULT_MONITOR_URL, configured: false });
  expect(existsSync(join(dataDir, "monitor-settings.json"))).toBe(false);
});

it("stores the token through secure storage and restores it without plaintext on disk", () => {
  const { settings, dataDir, safeStorage } = fixture();
  const token = "private-monitor-fixture";
  settings.save({ url: "https://fixture.invalid/monitor/v1", token });
  expect(safeStorage.encryptString).toHaveBeenCalledWith(token);
  const stored = readFileSync(join(dataDir, "monitor-settings.json"), "utf8");
  expect(stored).not.toContain(token);
  expect(JSON.parse(stored)).not.toHaveProperty("token");
  expect(new MonitorSettings({ dataDir, safeStorage, env: {} }).load()).toEqual({ baseUrl: "https://fixture.invalid/monitor/v1", token });
  expect(safeStorage.decryptString).toHaveBeenCalled();
  settings.clear();
  expect(settings.load()).toBeUndefined();
  expect(existsSync(join(dataDir, "monitor-settings.json"))).toBe(false);
});

it("never writes a token when secure storage is unavailable", () => {
  const { settings, dataDir, safeStorage } = fixture();
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
  expect(() => settings.save({ url: DEFAULT_MONITOR_URL, token: "fixture-token" })).toThrow("secure_token_storage_unavailable");
  expect(safeStorage.encryptString).not.toHaveBeenCalled();
  expect(existsSync(join(dataDir, "monitor-settings.json"))).toBe(false);
});

it("keeps unreadable saved tokens unconfigured", () => {
  const { settings, safeStorage } = fixture();
  settings.save({ url: DEFAULT_MONITOR_URL, token: "fixture-token" });
  vi.mocked(safeStorage.decryptString).mockImplementation(() => { throw new Error("locked"); });
  expect(settings.load()).toBeUndefined();
  expect(settings.view().configured).toBe(false);
  vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValue(false);
  expect(settings.load()).toBeUndefined();
});

it("uses tester environment overrides and clears the in-process token", () => {
  const { settings } = fixture({ RSH_MONITOR_REMOTE_URL: "http://127.0.0.1:4321/", RSH_MONITOR_REMOTE_TOKEN: "tester-fixture" });
  settings.save({ url: DEFAULT_MONITOR_URL, token: "saved-fixture" });
  expect(settings.load()).toEqual({ baseUrl: "http://127.0.0.1:4321/monitor/v1", token: "tester-fixture" });
  settings.clear();
  expect(settings.load()).toBeUndefined();
});

it.each(["http://example.com", "https://user:pass@example.com", "https://example.com/?token=private", "https://example.com/#private", "https://example.com/wrong", "file:///tmp/test"])("rejects invalid relay URL %s without saving", url => {
  const { settings, dataDir } = fixture();
  expect(() => settings.save({ url, token: "fixture-token" })).toThrow("invalid_remote_monitor_url");
  expect(existsSync(join(dataDir, "monitor-settings.json"))).toBe(false);
});

it.each(["", "   ", "fixture\nvalue", "fixture\rvalue", "fixture\u0000value"])("rejects an invalid token", token => {
  const { settings } = fixture();
  expect(() => settings.save({ url: DEFAULT_MONITOR_URL, token })).toThrow("invalid_remote_monitor_token");
});

it("ignores malformed saved settings", () => {
  const { settings, dataDir } = fixture();
  writeFileSync(join(dataDir, "monitor-settings.json"), "{invalid");
  expect(settings.view()).toEqual({ url: DEFAULT_MONITOR_URL, configured: false });
});

it.each(["RSH_JUDGE_CONFIG", "RSH_HYBRID_LIVE", "RSH_OLLAMA_MONITOR_URL", "RSH_LOCAL_MONITOR_RUNTIME", "RSH_LOCAL_MODE", "RSH_BROWSER_HARNESS_MONITOR"])("refuses incompatible monitoring environment %s", key => {
  expect(() => refuseMonitorEnvironment({ [key]: "fixture" })).toThrow("remote_monitor_environment_conflict");
  expect(() => fixture({ [key]: "fixture" })).toThrow("remote_monitor_environment_conflict");
});

it.each(["GITHUB_TOKEN", "OPENAI_API_KEY", "HOMEBREW_GITHUB_API_TOKEN", "AWS_SECRET_ACCESS_KEY", "PROVIDER_API_KEY", "PROVIDER_KEY", "PROVIDER_TOKEN", "OPENROUTER_KEY", "RSH_LOCAL_ASSISTANT_OPENROUTER_API_KEY", "OTHER_RSH_JUDGE_CONFIG", "RSH_LOCAL_MODE_EXTRA", "RSH_BROWSER_HARNESS_MONITOR_EXTRA"])("permits unrelated environment variable %s at startup", key => {
  const { settings } = fixture({ [key]: "unrelated-fixture", RSH_MONITOR_REMOTE_TOKEN: "monitor-fixture" });
  expect(settings.load()).toEqual({ baseUrl: DEFAULT_MONITOR_URL + "/monitor/v1", token: "monitor-fixture" });
});
