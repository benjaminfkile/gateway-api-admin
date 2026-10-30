import apiClient from "./apiClient";
import { parseJobsApiError } from "./jobsApi";
import type { FleetRefresh, ResourceAuditEntry, ResourcesState } from "./types";

// Management endpoints for the scalable resources. All are rooted at `/mgmt/resources`.
const base = "/mgmt/resources";

/** A readable message for a failed resources request. */
export function resourcesErrorMessage(err: unknown, fallback: string): string {
  const parsed = parseJobsApiError(err);
  switch (parsed.error) {
    case "class_not_allowed":
      return "That class is not in the allowed list";
    case "confirm_mismatch":
      return "The typed identifier does not match the database instance";
    case "run_active":
      return "A load run is active; resources cannot change until it ends";
    case "refresh_in_progress":
      return "A fleet instance refresh is in progress";
    case "downgrade_unsafe":
      return "Downgrade refused: the smaller class would not leave enough connection headroom";
    case "resource_unconfigured":
      return "This resource is not configured on the gateway";
    case "version_not_found":
      return "That launch template version does not exist";
    default:
      break;
  }
  if (parsed.error) return parsed.error;
  if (parsed.status === null && err instanceof Error) return err.message;
  return fallback;
}

/** Fleet instance types the operator may pick from. */
export function fleetClasses(state: ResourcesState): string[] {
  return state.fleet?.classes ?? state.allowed?.fleetClasses ?? [];
}

/** Cache node types the operator may pick from. */
export function cacheNodeTypes(state: ResourcesState): string[] {
  return state.cache?.nodeTypes ?? state.allowed?.cacheNodeTypes ?? [];
}

/** A database class as a menu entry: its name, and the documented connections when the gateway gave them. */
export interface ClassOption {
  value: string;
  label: string;
}

/** Database classes the operator may pick from, as menu entries. The gateway lists each class as an object
 * with its documented max connections; an older gateway lists plain names. */
export function databaseClassOptions(state: ResourcesState): ClassOption[] {
  const raw = state.database?.classes ?? state.allowed?.databaseClasses ?? [];
  return raw.map((c) => {
    if (typeof c === "string") return { value: c, label: c };
    const max = c.documentedMaxConnections;
    return { value: c.instanceClass, label: max ? `${c.instanceClass} (${max.toLocaleString()} connections documented)` : c.instanceClass };
  });
}

/** Database class names the operator may pick from. */
export function databaseClasses(state: ResourcesState): string[] {
  return databaseClassOptions(state).map((o) => o.value);
}

/** A change's detail as one line: a string as is; the gateway's object as its note, then its
 * services and other fields, so an audit row never hands React an object. */
export function formatAuditDetail(detail: unknown): string {
  if (detail === null || detail === undefined) return "";
  if (typeof detail === "string") return detail;
  if (typeof detail !== "object") return String(detail);
  const d = detail as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof d.note === "string" && d.note) parts.push(d.note);
  if (Array.isArray(d.services) && d.services.length) parts.push(`Services: ${d.services.map(String).join(", ")}`);
  for (const [k, v] of Object.entries(d)) {
    if (k === "note" || k === "services" || v === null || v === undefined) continue;
    parts.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  return parts.join(" ");
}

/** True while the refresh is still running. */
export function isRefreshInFlight(refresh: FleetRefresh | null | undefined): boolean {
  if (!refresh) return false;
  if (typeof refresh.inProgress === "boolean") return refresh.inProgress;
  return ["Pending", "InProgress", "Cancelling", "RollbackInProgress", "Baking"].includes(
    refresh.status,
  );
}

const resourcesApi = {
  get(): Promise<ResourcesState> {
    return apiClient.get<ResourcesState>(base).then((res) => res.data);
  },

  setFleetSize(size: number): Promise<unknown> {
    return apiClient.put(`${base}/fleet/size`, { size }).then((res) => res.data);
  },

  setFleetClass(instanceClass: string): Promise<{ templateVersion: string | number; refreshId: string }> {
    return apiClient
      .put<{ templateVersion: string | number; refreshId: string }>(`${base}/fleet/class`, {
        instanceClass,
      })
      .then((res) => res.data);
  },

  rollbackFleetClass(templateVersion: string | number): Promise<unknown> {
    return apiClient
      .put(`${base}/fleet/class/rollback`, { templateVersion })
      .then((res) => res.data);
  },

  fleetRefresh(): Promise<FleetRefresh | null> {
    return apiClient
      .get<FleetRefresh | null>(`${base}/fleet/refresh`)
      .then((res) => res.data ?? null);
  },

  setCacheNodeType(nodeType: string): Promise<{ note?: string }> {
    return apiClient
      .put<{ note?: string }>(`${base}/cache/node-type`, { nodeType })
      .then((res) => res.data ?? {});
  },

  setDatabaseClass(
    instanceClass: string,
    confirm: string,
  ): Promise<{ services?: string[]; note?: string }> {
    return apiClient
      .put<{ services?: string[]; note?: string }>(`${base}/database/class`, {
        instanceClass,
        confirm,
      })
      .then((res) => res.data ?? {});
  },

  audit(limit = 50): Promise<ResourceAuditEntry[]> {
    return apiClient
      .get<ResourceAuditEntry[]>(`${base}/audit`, { params: { limit } })
      .then((res) => res.data);
  },
};

export default resourcesApi;
