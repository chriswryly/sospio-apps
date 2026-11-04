import { expect, it, vi } from "vitest";
const handlers = vi.hoisted(() => new Map<string, (...arguments_: any[]) => any>());
vi.mock("electron", () => ({ipcMain: {handle: (name: string, handler: (...arguments_: any[]) => any) => handlers.set(name, handler)}}));
import { installIpc } from "../ipc";

it("allows only a trusted settings source to claim, and returns no token", async () => {
  const claimMonitorToken = vi.fn(async () => ({ok: true as const}));
  installIpc({openProvider: vi.fn(), reloadChat: vi.fn(), openDevTools: vi.fn(), restartMonitor: vi.fn(), getState: vi.fn(),
    claimMonitorToken, isTrusted: event => event === "trusted" as unknown});
  const claim = handlers.get("harness:claim-monitor-token")!;
  const value = {url: "https://monitor.example", code: "fixture-invite"};
  await expect(claim("foreign", value)).rejects.toThrow("untrusted settings source");
  expect(claimMonitorToken).not.toHaveBeenCalled();
  for (const invalid of [null, "invite", {}, {url: 2, code: "code"}, {url: value.url, code: 3}])
    await expect(claim("trusted", invalid)).rejects.toThrow("invalid_monitor_claim");
  expect(claimMonitorToken).not.toHaveBeenCalled();
  expect(await claim("trusted", value)).toEqual({ok: true});
  expect(claimMonitorToken).toHaveBeenCalledOnce();
  expect(claimMonitorToken).toHaveBeenCalledWith(value);
});

it("rejects claims when no trust check is installed", async () => {
  const claimMonitorToken = vi.fn();
  installIpc({openProvider: vi.fn(), reloadChat: vi.fn(), openDevTools: vi.fn(), restartMonitor: vi.fn(), getState: vi.fn(), claimMonitorToken});
  await expect(handlers.get("harness:claim-monitor-token")!({}, {url: "https://monitor.example", code: "fixture"})).rejects.toThrow("untrusted settings source");
  expect(claimMonitorToken).not.toHaveBeenCalled();
});
