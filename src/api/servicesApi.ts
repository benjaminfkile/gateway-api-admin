import apiClient from "./apiClient";
import type { ServiceSummary, ServiceUpsert } from "./types";

// Management endpoints for the service fleet. All are rooted at `/mgmt/services`.
const base = "/mgmt/services";

const servicesApi = {
  list(): Promise<ServiceSummary[]> {
    return apiClient.get<ServiceSummary[]>(base).then((res) => res.data);
  },

  stop(name: string, force?: boolean): Promise<void> {
    return apiClient
      .post(`${base}/${encodeURIComponent(name)}/stop`, undefined, {
        params: force ? { force: true } : undefined,
      })
      .then(() => undefined);
  },

  start(name: string): Promise<void> {
    return apiClient
      .post(`${base}/${encodeURIComponent(name)}/start`)
      .then(() => undefined);
  },

  restart(name: string): Promise<void> {
    return apiClient
      .post(`${base}/${encodeURIComponent(name)}/restart`)
      .then(() => undefined);
  },

  deploy(name: string, tag: string): Promise<void> {
    return apiClient
      .post(`${base}/${encodeURIComponent(name)}/deploy`, { tag })
      .then(() => undefined);
  },

  rollback(name: string, toDigest?: string): Promise<void> {
    return apiClient
      .post(
        `${base}/${encodeURIComponent(name)}/rollback`,
        toDigest ? { toDigest } : undefined,
      )
      .then(() => undefined);
  },

  upsert(service: ServiceUpsert): Promise<ServiceSummary> {
    return apiClient
      .put<ServiceSummary>(
        `${base}/${encodeURIComponent(service.name)}`,
        service,
      )
      .then((res) => res.data);
  },
};

export default servicesApi;
