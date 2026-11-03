import type { MonitorHealth, MonitorVerdict, TurnEvent } from "../shared/types";

export type MonitorConnection = {baseUrl: string; token: string};
export class MonitorClient {
  private connection: MonitorConnection;
  private controller = new AbortController();
  constructor(connection: MonitorConnection) {
    if (!connection.token.trim()) throw new Error("remote_monitor_token_required");
    this.connection = {...connection, baseUrl: connection.baseUrl.replace(/\/$/, "")};
  }
  stop(): void { this.controller.abort(); }
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
  async pollVerdict(turnId: string, timeoutMs = 420_000): Promise<MonitorVerdict> {
    const started = Date.now(); let retries = 0;
    while (Date.now() - started < timeoutMs) {
      this.controller.signal.throwIfAborted();
      const response = await this.request(`/verdicts/${encodeURIComponent(turnId)}`);
      if (response.ok) {
        retries = 0;
        const payload = await response.json() as {verdict?: MonitorVerdict};
        if (payload.verdict) {
          return payload.verdict;
        }
      } else if (response.status === 429 || response.status >= 500) {
        if (++retries > 3) throw await this.failure(response);
        await delay(Math.min(10_000, 500 * 2 ** retries) * (.75 + Math.random() * .5), this.controller.signal);
        continue;
      } else if (response.status !== 404) throw await this.failure(response);
      await delay(500, this.controller.signal);
    }
    throw new Error(this.connection.token ? "Monitor unavailable: relay timed out" : `monitor verdict timed out after ${timeoutMs}ms`);
  }
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("Content-Type", "application/json");
    headers.set("Authorization", ["Bearer", this.connection.token].join(" "));
    try {
      return await fetch(this.connection.baseUrl + path, {...init, headers, redirect: "error", signal: AbortSignal.any([this.controller.signal, init.signal ?? AbortSignal.timeout(10_000)])});
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
function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = (): void => { clearTimeout(timer); reject(new Error("Monitor stopped")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
    signal.addEventListener("abort", aborted, {once: true});
  });
}
