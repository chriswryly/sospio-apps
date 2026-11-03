import { MonitorClient, type MonitorConnection } from "./monitorClient";

export function createMonitorSource(connection: MonitorConnection | undefined) {
  if (!connection?.token.trim()) throw new Error("remote_monitor_token_required");
  const client = new MonitorClient(connection);
  return {
    getClient: () => client,
    start: async () => {
      const health = await client.health();
      if (!health.ok || health.status === "error" || health.status === "disabled") throw new Error("Monitor unavailable");
      return {status: health.status, monitor: health.monitor};
    },
    stop: async () => { client.stop(); },
  };
}
