import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MonitorConnection, MonitorSettingsView } from "./types";

export type { MonitorConnection, MonitorSettingsView } from "./types";
export const DEFAULT_MONITOR_URL = "https://monitor.sosp.io";
export type SecureStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};
type StoredSettings = { version: 1; url: string; encryptedToken: string };
type SettingsOptions = { dataDir: string; safeStorage: SecureStorage; env?: NodeJS.ProcessEnv };

export function refuseMonitorEnvironment(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (/^RSH_(?:JUDGE_|HYBRID_|OLLAMA_MONITOR_|LOCAL_MONITOR_|LOCAL_MODE$|BROWSER_HARNESS_MONITOR$)/.test(key)) {
      throw new Error("remote_monitor_environment_conflict");
    }
  }
}

export function monitorUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("invalid_remote_monitor_url"); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || !["/", "/monitor/v1", "/monitor/v1/"].includes(url.pathname)) {
    throw new Error("invalid_remote_monitor_url");
  }
  return url.origin;
}

function monitorToken(raw: string): string {
  const token = raw.trim();
  if (!token || /[\x00-\x1f\x7f]/.test(raw)) throw new Error("invalid_remote_monitor_token");
  return token;
}

export class MonitorSettings {
  private readonly file: string;
  private readonly env: NodeJS.ProcessEnv;
  constructor(private readonly options: SettingsOptions) {
    this.file = join(options.dataDir, "monitor-settings.json");
    this.env = { ...(options.env ?? process.env) };
    refuseMonitorEnvironment(this.env);
  }

  private stored(): StoredSettings | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      const settings: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (!settings || typeof settings !== "object") return undefined;
      const value = settings as Partial<StoredSettings>;
      if (value.version !== 1 || typeof value.url !== "string" || typeof value.encryptedToken !== "string") return undefined;
      return { version: 1, url: monitorUrl(value.url), encryptedToken: value.encryptedToken };
    } catch { return undefined; }
  }

  load(): MonitorConnection | undefined {
    const stored = this.stored();
    const url = monitorUrl(this.env.RSH_MONITOR_REMOTE_URL?.trim() || stored?.url || DEFAULT_MONITOR_URL);
    let token = this.env.RSH_MONITOR_REMOTE_TOKEN;
    if (!token && stored) {
      if (!this.options.safeStorage.isEncryptionAvailable()) return undefined;
      try { token = this.options.safeStorage.decryptString(Buffer.from(stored.encryptedToken, "base64")); }
      catch { return undefined; }
    }
    if (!token?.trim()) return undefined;
    return { baseUrl: url + "/monitor/v1", token: monitorToken(token) };
  }

  view(): MonitorSettingsView {
    const stored = this.stored();
    return {
      url: monitorUrl(this.env.RSH_MONITOR_REMOTE_URL?.trim() || stored?.url || DEFAULT_MONITOR_URL),
      configured: Boolean(this.load()),
    };
  }

  canSaveToken(): boolean {
    return this.options.safeStorage.isEncryptionAvailable();
  }

  save(settings: { url: string; token: string }): void {
    const url = monitorUrl(settings.url);
    const token = monitorToken(settings.token);
    if (!this.options.safeStorage.isEncryptionAvailable()) throw new Error("secure_token_storage_unavailable");
    const encryptedToken = this.options.safeStorage.encryptString(token).toString("base64");
    if (!encryptedToken) throw new Error("secure_token_storage_unavailable");
    mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
    const temporary = this.file + ".tmp";
    rmSync(temporary, { force: true });
    writeFileSync(temporary, JSON.stringify({ version: 1, url, encryptedToken }), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.file);
  }

  clear(): void {
    rmSync(this.file, { force: true });
    rmSync(this.file + ".tmp", { force: true });
    delete this.env.RSH_MONITOR_REMOTE_TOKEN;
  }
}
