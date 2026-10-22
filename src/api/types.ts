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
   * This is only the reference - never the secret values.
   */
  envSecretRef?: string | null;
  /**
   * Per-service realtime hub configuration (see gateway REALTIME.md). All four
   * fields are optional/nullable; a missing/null value on the summary means the
   * feature is off. The gateway's upsert is tri-state on these fields - omit to
   * preserve, empty string to clear, non-empty to set.
   */
  realtimeAllowedOrigins?: string | null;
  realtimeAuthPath?: string | null;
  realtimeMessagePath?: string | null;
  realtimePresence?: boolean;
  /**
   * Whether the gateway has minted a publish token for this service. Read-only
   * indicator shown in the editor; absent on gateways that don't surface it.
   */
  hasPublishToken?: boolean;
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
  /**
   * Realtime hub configuration (see gateway REALTIME.md). All four fields are
   * tri-state on upsert: omit to preserve the stored value, empty string to
   * clear, non-empty to set. Presence is a boolean - omit to preserve.
   */
  realtimeAllowedOrigins?: string | null;
  realtimeAuthPath?: string | null;
  realtimeMessagePath?: string | null;
  realtimePresence?: boolean;
}

/** Lifecycle of a single job run. `queued` and `running` are the active states. */
export type JobRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "lost";

export type JobRunTrigger = "schedule" | "manual";

/** One execution of a scheduled job as a short-lived container. */
export interface JobRun {
  id: number;
  job: string;
  trigger: JobRunTrigger;
  actor: string;
  status: JobRunStatus;
  instanceId: string | null;
  imageDigest: string | null;
  scriptVersion: number;
  exitCode: number | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  detail: string | null;
}

/** A job as listed by `GET /mgmt/jobs`. The script body is never included. */
export interface JobSummary {
  name: string;
  /** Five-field cron expression, or null for a manual-only job. */
  schedule: string | null;
  /** IANA time zone the schedule is evaluated in. */
  timeZone: string;
  image: string;
  tag: string;
  /** Secrets Manager reference for the run environment. Only the reference, never values. */
  envSecretRef: string | null;
  timeoutSeconds: number;
  enabled: boolean;
  scriptVersion: number;
  nextRunAt: string | null;
  lastRun: JobRun | null;
  updatedBy: string;
  updatedAt: string;
}

/** A job with its current script body, as returned by `GET /mgmt/jobs/{name}`. */
export interface JobDetail extends JobSummary {
  script: string;
}

/**
 * Payload accepted by `PUT /mgmt/jobs/{name}`. On update an absent field
 * preserves the stored value and an empty string clears `schedule` and
 * `envSecretRef`. Create requires `timeZone` and `script`.
 */
export interface JobUpsert {
  schedule?: string;
  timeZone?: string;
  script?: string;
  image?: string;
  tag?: string;
  envSecretRef?: string;
  timeoutSeconds?: number;
  enabled?: boolean;
}

/** One stored revision of a job's script. */
export interface ScriptVersion {
  version: number;
  sha256: string;
  updatedBy: string;
  updatedAt: string;
}

/** A past script body, as returned by `GET /mgmt/jobs/{name}/script/versions/{v}`. */
export interface ScriptVersionBody {
  version: number;
  script: string;
}
