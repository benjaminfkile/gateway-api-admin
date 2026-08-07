import apiClient from "./apiClient";
import type { DeployDetail, DeploySummary } from "./types";

const deploysApi = {
  list(params?: { service?: string }): Promise<DeploySummary[]> {
    return apiClient
      .get<DeploySummary[]>("/mgmt/deploys", { params })
      .then((res) => res.data);
  },

  get(id: string): Promise<DeployDetail> {
    // The gateway nests the summary under `deploy` with `instances` alongside;
    // flatten to the DeployDetail shape the pages consume.
    return apiClient
      .get<{ deploy: DeploySummary; instances: DeployDetail["instances"] }>(
        `/mgmt/deploys/${encodeURIComponent(id)}`,
      )
      .then((res) => ({ ...res.data.deploy, instances: res.data.instances }));
  },
};

export default deploysApi;
