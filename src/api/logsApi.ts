import apiClient from "./apiClient";
import type { LogLine } from "./types";

const logsApi = {
  tail(name: string, instanceId: string, tail: number): Promise<LogLine[]> {
    // The gateway wraps the lines: { lines: [{ ts, message }] }.
    return apiClient
      .get<{ lines: LogLine[] }>(
        `/mgmt/services/${encodeURIComponent(name)}/logs`,
        { params: { instance: instanceId, tail } },
      )
      .then((res) => res.data.lines);
  },
};

export default logsApi;
