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

/** Lifecycle of a load run. The first six are non-terminal. */
export type LoadRunStatus =
  | "queued"
  | "fleet_up"
  | "generators_up"
  | "ramping"
  | "holding"
  | "draining"
  | "succeeded"
  | "stopped"
  | "expired"
  | "failed"
  | "lost";

/** A k6 scenario as listed by `GET /mgmt/load/scenarios`. The script body is never included. */
export interface LoadScenario {
  name: string;
  /** GitHub repository as `owner/name`. */
  repository: string;
  commitSha: string | null;
  scriptVersion: number;
  image: string;
  tag: string;
  paramsDefault: Record<string, string>;
  maxVusPerGenerator: number;
  lastValidationRunId: number | null;
  validated: boolean;
  updatedBy: string;
  updatedAt: string;
}

/** A scenario with its current script, as returned by `GET /mgmt/load/scenarios/{name}`. */
export interface LoadScenarioDetail extends LoadScenario {
  script: string;
}

/**
 * Payload accepted by `PUT /mgmt/load/scenarios/{name}`. An absent field keeps
 * the stored value; create needs repository, script and maxVusPerGenerator.
 */
export interface LoadScenarioUpsert {
  repository?: string;
  commitSha?: string;
  script?: string;
  image?: string;
  tag?: string;
  paramsDefault?: Record<string, string>;
  maxVusPerGenerator?: number;
}

export type PreflightStatus = "green" | "amber" | "red";

export interface PreflightCheck {
  name: string;
  status: PreflightStatus;
  message: string;
  fix: string | null;
}

export interface PreflightResult {
  ok?: boolean;
  checks: PreflightCheck[];
}

export interface PreflightQuery {
  scenario: string;
  target: string;
  confirm: string;
  generators: number;
  vus: number;
  fleet?: number | null;
  validation: boolean;
}

/** Body of `POST /mgmt/load/runs`. */
export interface LoadRunStart {
  scenario: string;
  target: string;
  confirm: string;
  generators: number;
  vusPerGenerator: number;
  rampSeconds: number;
  holdSeconds: number;
  params?: Record<string, string>;
  fleetSize?: number | null;
  restoreFleet: boolean;
  validation: boolean;
}

/** One load run as listed by `GET /mgmt/load/runs`, without timeline or stats. */
export interface LoadRun {
  id: number;
  scenario: string;
  scenarioVersion: number;
  target: string;
  validation: boolean;
  actor: string;
  status: LoadRunStatus;
  generators: number;
  vusPerGenerator: number;
  rampSeconds: number;
  holdSeconds: number;
  fleetSizeRequested: number | null;
  fleetSizeBefore: number | null;
  restoreFleet: boolean;
  hardStopAt: string | null;
  checkedIn: number;
  queuedAt: string;
  startedAt: string | null;
  rampStartedAt: string | null;
  finishedAt: string | null;
  stopRequestedAt: string | null;
  stopReason: string | null;
  verdict: string | null;
  detail: string | null;
  /** The maximum of every numeric stats leaf, keyed `metric.field`. */
  peaks: Record<string, number> | null;
}

export interface LoadRunTimelineEntry {
  at: string;
  status: string;
  by: string | null;
  note: string | null;
}

/** One run with its timeline, as returned by `GET /mgmt/load/runs/{id}`. */
export interface LoadRunDetail extends LoadRun {
  timeline: LoadRunTimelineEntry[];
}

/** One k6 metric in a generator stats line: its type plus numeric fields such as `count` or `p(95)`. */
export type LoadMetric = { type: string } & Record<string, number | string>;

/** A generator stats line, and the shape of the fleet-wide aggregate. */
export interface GeneratorStatsBody {
  runId?: number;
  index?: number;
  at: string;
  vus: number;
  metrics: Record<string, LoadMetric>;
}

export interface FleetInstanceSample {
  instanceId: string;
  leader: boolean;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  hubConnections: number | null;
}

/** A fleet sample written by the leader while a run is active. */
export interface FleetStatsBody {
  at: string;
  instances: FleetInstanceSample[];
  channelMembers: number | null;
}

export type LoadStatSource = "generator" | "fleet";

export interface LoadStatRow {
  id: number;
  source: LoadStatSource;
  index: number | null;
  at: string;
  body: GeneratorStatsBody | FleetStatsBody;
}

export interface LoadStatsQuery {
  from?: string;
  to?: string;
  source?: LoadStatSource;
  index?: number;
  /** Bucket width in seconds; one row per bucket with the maximum of each leaf. */
  step?: number;
}

export interface FleetResource {
  group: string;
  min: number;
  desired: number;
  max: number;
  inService: number;
  instanceClass: string | null;
  templateVersion: string | number | null;
  refreshInProgress: boolean;
  /** Allowed fleet instance types. */
  classes?: string[];
  maxSize?: number;
  error?: string | null;
}

export interface GeneratorsResource {
  group: string;
  desired: number;
  inService: number;
  max: number;
  error?: string | null;
}

export interface CacheResource {
  id: string;
  nodeType: string | null;
  status: string | null;
  /** Allowed cache node types. */
  nodeTypes?: string[];
  error?: string | null;
}

/** One allowed database class as the gateway lists it, with the connections its memory documents. */
export interface DatabaseClassOption {
  instanceClass: string;
  documentedMaxConnections?: number | null;
}

export interface DatabaseResource {
  id: string;
  instanceClass: string | null;
  status: string | null;
  maxConnections: number | null;
  connectionsInUse: number | null;
  documentedMaxConnections?: number | null;
  /** Allowed database classes: plain names, or the gateway's objects with their documented connections. */
  classes?: Array<string | DatabaseClassOption>;
  error?: string | null;
}

/** `GET /mgmt/resources`. A block is null when its configuration key is unset. */
export interface ResourcesState {
  runActive?: boolean;
  fleet: FleetResource | null;
  generators: GeneratorsResource | null;
  cache: CacheResource | null;
  database: DatabaseResource | null;
  /** Older shape of the allow lists; the per-block lists win when present. */
  allowed?: {
    fleetClasses?: string[];
    cacheNodeTypes?: string[];
    databaseClasses?: string[];
  };
}

/** The fleet group's newest instance refresh. */
export interface FleetRefresh {
  group?: string;
  refreshId?: string;
  id?: string;
  status: string;
  percentComplete: number | null;
  inProgress?: boolean;
}

export interface ResourceAuditEntry {
  id?: number;
  at: string;
  actor: string;
  resource: string;
  action: string;
  before: string | null;
  after: string | null;
  /** What the change carried: a string, or the gateway's object (for a database class change `{ id, services, note }`). */
  detail: string | Record<string, unknown> | null;
}
