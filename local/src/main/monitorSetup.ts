import { claimMonitorToken } from "../../../shared/monitorClaim";
import type { MonitorSettings } from "../../../shared/monitorSettings";
import type { MonitorClaimRequest, MonitorClaimResult, MonitorConnection } from "../../../shared/types";

export function monitorSetupHandlers(settings: Pick<MonitorSettings, "save" | "load" | "canSaveToken">, monitor: {setConnection(connection: MonitorConnection): void}, initialize: () => Promise<void>) {
  const connect = async () => {
    monitor.setConnection(settings.load()!);
    await initialize();
  };
  return {
    saveMonitorSettings: async (value: {url: string; token: string}): Promise<void> => {
      settings.save(value);
      await connect();
    },
    claimMonitorToken: async (value: MonitorClaimRequest): Promise<MonitorClaimResult> => {
      const result = await claimMonitorToken(value, settings);
      if (result.ok) await connect();
      return result;
    },
  };
}
