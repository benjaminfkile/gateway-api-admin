import apiClient from "./apiClient";
import type { InstanceInfo } from "./types";

const instancesApi = {
  list(): Promise<InstanceInfo[]> {
    return apiClient
      .get<InstanceInfo[]>("/mgmt/instances")
      .then((res) => res.data);
  },
};

export default instancesApi;
