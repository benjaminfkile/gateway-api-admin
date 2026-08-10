// Shapes returned by the gateway management API (`/mgmt/*`). See the gateway's
// `docs/tech-spec.md` §4.6 for the authoritative contract.

export type DesiredStatus = "running" | "stopped";

/** The most recent reconcile error surfaced by the fleet rollup. */
export interface ServiceLatestError {
  instanceId: string;
  message: string;
  at: string;
}

export interface ServiceRollup {
  runningOn: number;
  totalInstances: number;
  /** Map of image digest -> number of instances currently running it. */
  digests: Record<string, number>;
  /** Number of instances currently reporting a reconcile error. Absent on older gateways. */
  errorOn?: number;
  /** Details of the most recent reconcile error across the fleet. Absent on older gateways. */
  latestError?: ServiceLatestError;
}

export interface ServiceSummary {
  name: string;
  image: string;
  tag: string;
  digest: string | null;
  port: number;
  /** Docker-assigned (ephemeral) host port the container is bound to, or null when no container is running. */
  hostPort: number | null;
  desiredStatus: DesiredStatus;
  includeInHealth: boolean;
  /**
   * AWS Secrets Manager secret name or ARN whose flat JSON keys become the
   * container environment. Null/absent when the service has no injected env.
   * This is only the reference — never the secret values.
   */
  envSecretRef?: string | null;
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
  /** Latest reconcile error for this service on this instance. Absent on older gateways or when healthy. */
  lastError?: string;
  /** When the last error was recorded. Absent on older gateways or when healthy. */
  lastErrorAt?: string;
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
  /**
   * Terminal error message once a deploy has failed (or null/absent while it is
   * still in progress or succeeded). Carried by the "deploy" wire event.
   */
  error?: string | null;
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
  /**
   * AWS Secrets Manager secret name or ARN for injected container env. Omit to
   * leave an existing ref untouched; only the reference is sent, never values.
   */
  envSecretRef?: string | null;
}
