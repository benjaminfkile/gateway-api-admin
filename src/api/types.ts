// Shapes returned by the gateway management API (`/mgmt/*`). See the gateway's
// `docs/tech-spec.md` §4.6 for the authoritative contract.

export type DesiredStatus = "running" | "stopped";

export interface ServiceRollup {
  runningOn: number;
  totalInstances: number;
  /** Map of image digest -> number of instances currently running it. */
  digests: Record<string, number>;
}

export interface ServiceSummary {
  name: string;
  image: string;
  tag: string;
  digest: string | null;
  port: number;
  desiredStatus: DesiredStatus;
  includeInHealth: boolean;
  updatedBy: string;
  updatedAt: string;
  fleet: ServiceRollup;
}

export interface InstanceServiceState {
  name: string;
  digest: string;
  state: string;
  startedAt: string;
  restarts: number;
}

export interface InstanceInfo {
  instanceId: string;
  privateIp: string;
  publicIp: string;
  gatewayVer: string;
  isLeader: boolean;
  stale: boolean;
  heartbeatAt: string;
  services: InstanceServiceState[];
}

export type DeployStatus = "in_progress" | "done" | "partial" | "failed";

export interface DeploySummary {
  id: string;
  service: string;
  fromDigest: string | null;
  toDigest: string;
  actor: string;
  action: string;
  status: DeployStatus;
  startedAt: string;
  finishedAt: string | null;
}

export interface DeployInstanceResult {
  instanceId: string;
  status: string;
  detail: string | null;
  updatedAt: string;
}

export interface DeployDetail extends DeploySummary {
  instances: DeployInstanceResult[];
}

export interface LogLine {
  ts: string;
  message: string;
}

/** Payload accepted by `PUT /mgmt/services/{name}` to create/update a service. */
export interface ServiceUpsert {
  name: string;
  image: string;
  tag: string;
  port: number;
  desiredStatus?: DesiredStatus;
  includeInHealth?: boolean;
}
