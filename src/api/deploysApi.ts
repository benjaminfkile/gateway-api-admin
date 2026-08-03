import apiClient from "./apiClient";
import type { DeployDetail, DeploySummary } from "./types";

const deploysApi = {
  list(params?: { service?: string }): Promise<DeploySummary[]> {
    return apiClient
      .get<DeploySummary[]>("/mgmt/deploys", { params })
      .then((res) => res.data);
  },

  get(id: string): Promise<DeployDetail> {
    return apiClient
      .get<DeployDetail>(`/mgmt/deploys/${encodeURIComponent(id)}`)
      .then((res) => res.data);
  },
};

export default deploysApi;
