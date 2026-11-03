import type { MonitorHealth, MonitorVerdict, TurnEvent, VerdictIntervention } from "../shared/types";

export type MonitorConnection = {baseUrl: string; token: string};
export class MonitorClient {
  private connection: MonitorConnection;
  constructor(connection: MonitorConnection) {
    if (!connection.baseUrl || !connection.token?.trim()) throw new Error("Enter your Sospio monitor token");
    this.connection = {...connection, baseUrl: connection.baseUrl.replace(/\/$/, "")};
  }
  async dismiss(sessionId: string, signal: string): Promise<void> {
    await this.requestJson("/dismiss", {method: "POST", body: JSON.stringify({session_id: sessionId, signal})});
  }
  async health(): Promise<MonitorHealth> { return this.requestJson("/health"); }
  async reconnect(): Promise<MonitorHealth> { return this.requestJson("/reconnect", {method: "POST"}); }
  async readVerdict(turnId: string): Promise<MonitorVerdict | undefined> {
    const response = await this.request(`/verdicts/${encodeURIComponent(turnId)}`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw await this.failure(response);
    return ((await response.json()) as {verdict?: MonitorVerdict}).verdict;
  }
  async hasVerdict(turnId: string): Promise<boolean> {
    try {
      const response = await this.request(`/verdicts/${encodeURIComponent(turnId)}`, {signal: AbortSignal.timeout(1000)});
      return response.ok && Boolean((await response.json() as {verdict?:unknown}).verdict);
    } catch { return false; }
  }
  async postTurn(turn: TurnEvent): Promise<void> { await this.requestJson("/turn", {method: "POST", body: JSON.stringify(turn)}); }
  async pollVerdict(turnId: string, timeoutMs = Number(process.env.RSH_LOCAL_MONITOR_TIMEOUT_MS) || 420_000): Promise<MonitorVerdict> {
    const started = Date.now(); let retries = 0;
    while (Date.now() - started < timeoutMs) {
      const response = await this.request(`/verdicts/${encodeURIComponent(turnId)}`);
      if (response.ok) {
        retries = 0;
        const payload = await response.json() as {verdict?: MonitorVerdict};
        if (payload.verdict) {
          return normalizeVerdict(payload.verdict);
        }
      } else if (response.status === 429 || response.status >= 500) {
        if (++retries > 3) throw await this.failure(response);
        await delay(Math.min(10_000, 250 * 2 ** retries) * (.75 + Math.random() * .5));
        continue;
      } else if (response.status !== 404) throw await this.failure(response);
      await delay(250);
    }
    throw new Error(this.connection.token ? "Monitor unavailable: relay timed out" : `monitor verdict timed out after ${timeoutMs}ms`);
  }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("Content-Type", "application/json");
    if (this.connection.token) headers.set("Authorization", ["Bearer", this.connection.token].join(" "));
    try {
      return await fetch(this.connection.baseUrl + path, {...init, headers, redirect: "error", signal: init.signal ?? AbortSignal.timeout(10_000)});
    } catch {
      throw new Error("Monitor unavailable: offline");
    }
  }
  private async failure(response: Response): Promise<Error> {
    if (response.status === 401) return new Error("Monitor unavailable: unauthorized");
    let code: unknown;
    try { code = (await response.json() as {error?: unknown}).error; } catch { /* no raw server diagnostics */ }
    if (["relay_cap_turns", "relay_cap_judge_usd", "relay_cap_sessions", "relay_cap_global"].includes(String(code))) return new Error(`Monitor unavailable: cap reached (${code})`);
    return Object.assign(new Error(`Monitor unavailable: HTTP ${response.status}`), {status: response.status});
  }
  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.request(path, init);
    if (!response.ok) throw await this.failure(response);
    return response.json() as Promise<T>;
  }
}
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

/** Derive the client-side intervention view from the verdict's flat fields. */
export function normalizeVerdict(verdict: MonitorVerdict): MonitorVerdict {
  const intervention = normalizeVerdictIntervention(verdict);
  if (intervention) {
    return { ...verdict, intervention };
  }
  const { intervention: _dropped, ...rest } = verdict;
  return rest;
}

export function normalizeVerdictIntervention(value: unknown): VerdictIntervention | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const tier = raw.tier;
  if (typeof tier !== "number" || !Number.isInteger(tier) || tier < 1 || tier > 4) {
    return undefined;
  }
  const mechanisms = raw.selected_mechanisms;
  if (!Array.isArray(mechanisms) || mechanisms.some((item) => typeof item !== "string")) {
    return undefined;
  }
  const intervention: VerdictIntervention = {
    tier: tier as VerdictIntervention["tier"],
    // Absent rather than empty: a reader can tell "the ladder sent no reason"
    // from "the ladder sent an empty one". Not safety-bearing, so its absence
    // does not discard an otherwise valid decision.
    tier_reason: optionalString(raw.tier_reason) ?? "unspecified",
    selected_mechanisms: [...(mechanisms as string[])],
  };
  return intervention;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
