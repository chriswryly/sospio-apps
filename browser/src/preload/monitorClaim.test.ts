import { expect, it, vi } from "vitest";
import type { HarnessApi } from "../shared/types";

const bridge = vi.hoisted(() => ({exposeInMainWorld: vi.fn(), invoke: vi.fn().mockResolvedValue({ok: true})}));
vi.mock("electron", () => ({contextBridge: {exposeInMainWorld: bridge.exposeInMainWorld}, ipcRenderer: {invoke: bridge.invoke}}));

it("sends the invite code to main over the typed bridge and receives no token", async () => {
  await import("./index");
  const api = bridge.exposeInMainWorld.mock.calls[0][1] as HarnessApi;
  const value = {url: "https://monitor.example", code: "fixture-invite"};
  expect(await api.claimMonitorToken(value)).toEqual({ok: true});
  expect(bridge.invoke).toHaveBeenCalledOnce();
  expect(bridge.invoke).toHaveBeenCalledWith("harness:claim-monitor-token", value);
});
