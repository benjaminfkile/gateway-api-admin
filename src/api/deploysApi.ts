import apiClient from "./apiClient";
import type { DeployDetail, DeploySummary } from "./types";

const deploysApi = {
  list(): Promise<DeploySummary[]> {
    return apiClient
      .get<DeploySummary[]>("/mgmt/deploys")
      .then((res) => res.data);
  },

  get(id: string): Promise<DeployDetail> {
    return apiClient
      .get<DeployDetail>(`/mgmt/deploys/${encodeURIComponent(id)}`)
      .then((res) => res.data);
  },
};

export default deploysApi;
