import apiClient from "./apiClient";
import type { LogLine } from "./types";

const logsApi = {
  tail(name: string, instanceId: string, tail: number): Promise<LogLine[]> {
    return apiClient
      .get<LogLine[]>(
        `/mgmt/services/${encodeURIComponent(name)}/logs`,
        { params: { instance: instanceId, tail } },
      )
      .then((res) => res.data);
  },
};

export default logsApi;
