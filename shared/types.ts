export type MonitorConnection = { baseUrl: string; token: string };
export type MonitorSettingsView = { url: string; configured: boolean };
export type MonitorClaimRequest = { url: string; code: string };
export type MonitorClaimResult = { ok: true } | { ok: false; message: string };
