import { MonitorClient, type MonitorConnection } from "./monitorClient";

export type MonitorStatus = {status?: string; monitor?: string};
export function createMonitorSource(connection?: MonitorConnection) {
  let client = connection ? new MonitorClient(connection) : undefined;
  return {
    getClient: () => client,
    clear: () => {client = undefined;},
    setConnection: (next: MonitorConnection) => {client = new MonitorClient(next);},
    start: async (): Promise<MonitorStatus> => {
      if (!client) throw new Error("Enter your Sospio monitor token");
      const health = await client.health();
      if (!health.ok || health.status === "error" || health.status === "disabled") throw new Error("Monitor unavailable");
      return {status: health.status, monitor: health.monitor};
    },
  };
}
