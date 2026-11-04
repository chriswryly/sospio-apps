import { monitorUrl, type MonitorSettings } from "./monitorSettings";
import type { MonitorClaimRequest, MonitorClaimResult } from "./types";

export const CLAIM_UNAVAILABLE_MESSAGE = "Could not get a token. Try again later.";

export async function claimMonitorToken(value: MonitorClaimRequest, settings: Pick<MonitorSettings, "save" | "canSaveToken">, fetchImpl: typeof fetch = globalThis.fetch): Promise<MonitorClaimResult> {
  try {
    const url = monitorUrl(value.url);
    if (!value.code || value.code.length > 4096 || /[\x00-\x1f\x7f]/.test(value.code)) return {ok: false, message: CLAIM_UNAVAILABLE_MESSAGE};
    if (!settings.canSaveToken()) return {ok: false, message: CLAIM_UNAVAILABLE_MESSAGE};
    const response = await fetchImpl(url + "/monitor/v1/claim", {
      method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({code: value.code}),
      redirect: "error", credentials: "omit", signal: AbortSignal.timeout(15_000),
    });
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") return {ok: false, message: CLAIM_UNAVAILABLE_MESSAGE};
    const result = body as {token?: unknown; error?: unknown};
    if (response.status === 200 && typeof result.token === "string") {
      settings.save({url, token: result.token});
      return {ok: true};
    }
    const message = response.status === 401 && result.error === "relay_claim_invalid_code" ? "That invite code didn't work." :
      response.status === 429 && result.error === "relay_claim_lockout" ? "Too many tries. Wait 15 minutes." :
      response.status === 429 && result.error === "relay_claim_daily" ? "This network has reached today's limit for new tokens. Try again tomorrow." :
      response.status === 429 && result.error === "relay_claim_hourly" ? "Lots of people are getting tokens right now. Try again in an hour." :
      response.status === 429 && result.error === "relay_claim_rate" ? "Too many token requests. Try again later." :
      response.status === 404 && result.error === "not_found" ? "This monitor server isn't giving out tokens. Ask the person who shared Sospio with you for one." :
      response.status === 410 && result.error === "relay_claims_exhausted" ? "All trial tokens have been handed out. Contact the person who shared Sospio with you." : CLAIM_UNAVAILABLE_MESSAGE;
    return {ok: false, message};
  } catch {
    return {ok: false, message: CLAIM_UNAVAILABLE_MESSAGE};
  }
}
