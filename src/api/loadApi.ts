import apiClient from "./apiClient";
import { parseJobsApiError } from "./jobsApi";
import type {
  GeneratorGroup,
  LoadRun,
  LoadRunDetail,
  LoadRunStart,
  LoadRunStatus,
  LoadScenario,
  LoadScenarioDetail,
  LoadScenarioUpsert,
  LoadStatRow,
  LoadStatsQuery,
  LogLine,
  PreflightCheck,
  PreflightQuery,
  PreflightResult,
  ScriptVersion,
  ScriptVersionBody,
} from "./types";

// Management endpoints for load scenarios and runs. All are rooted at `/mgmt/load`.
const base = "/mgmt/load";

function scenarioPath(name: string): string {
  return `${base}/scenarios/${encodeURIComponent(name)}`;
}

function runPath(runId: number | string): string {
  return `${base}/runs/${encodeURIComponent(String(runId))}`;
}

/** Statuses a run can still leave. */
export const NON_TERMINAL_STATUSES: readonly LoadRunStatus[] = [
  "queued",
  "generators_up",
  "ramping",
  "holding",
  "draining",
];

/** True while a run is in one of the non-terminal statuses. */
export function isRunActive(run: Pick<LoadRun, "status"> | null | undefined): boolean {
  return Boolean(run && NON_TERMINAL_STATUSES.includes(run.status));
}

/** The `{ error, field, checks }` body the gateway sends with 400, 409 and 503 answers. */
export interface LoadApiError {
  status: number | null;
  error: string | null;
  field: string | null;
  /** Pre-flight checks carried by `409 preflight_failed`. */
  checks: PreflightCheck[] | null;
}

/** Pull the HTTP status and the error body out of a failed load request. */
export function parseLoadApiError(err: unknown): LoadApiError {
  const parsed = parseJobsApiError(err);
  let checks: PreflightCheck[] | null = null;
  if (err && typeof err === "object" && "response" in err) {
    const data = (err as { response?: { data?: unknown } }).response?.data;
    if (data && typeof data === "object" && Array.isArray((data as { checks?: unknown }).checks)) {
      checks = (data as { checks: PreflightCheck[] }).checks;
    }
  }
  return { ...parsed, checks };
}

/** A readable message for a failed load request. */
export function loadErrorMessage(err: unknown, fallback: string): string {
  const parsed = parseLoadApiError(err);
  switch (parsed.error) {
    case "run_active":
      return "A load run is already active";
    case "preflight_failed": {
      const red = (parsed.checks ?? []).filter((c) => c.status === "red").map((c) => c.name);
      return red.length > 0
        ? `Pre-flight failed: ${red.join(", ")}`
        : "Pre-flight failed";
    }
    case "load_unconfigured":
      return "Load runs are not configured on this gateway (no generator group)";
    case "run_finished":
      return "The run has already finished";
    default:
      break;
  }
  if (parsed.error) return parsed.field ? `${parsed.error} (${parsed.field})` : parsed.error;
  if (parsed.status === null && err instanceof Error) return err.message;
  return fallback;
}

export interface ListLoadRunsOptions {
  limit?: number;
  /** Return only runs older than this run id. */
  before?: number;
}

/** Query string of the pre-flight request. */
export function preflightParams(query: PreflightQuery): Record<string, string | number | boolean> {
  return {
    scenario: query.scenario,
    target: query.target,
    confirm: query.confirm,
    generators: query.generators,
    vus: query.vus,
    validation: query.validation,
  };
}

const loadApi = {
  scenarios(): Promise<LoadScenario[]> {
    return apiClient.get<LoadScenario[]>(`${base}/scenarios`).then((res) => res.data);
  },

  scenario(name: string): Promise<LoadScenarioDetail> {
    return apiClient.get<LoadScenarioDetail>(scenarioPath(name)).then((res) => res.data);
  },

  upsertScenario(name: string, body: LoadScenarioUpsert): Promise<LoadScenarioDetail> {
    return apiClient
      .put<LoadScenarioDetail>(scenarioPath(name), body)
      .then((res) => res.data);
  },

  removeScenario(name: string): Promise<void> {
    return apiClient.delete(scenarioPath(name)).then(() => undefined);
  },

  scriptVersions(name: string): Promise<ScriptVersion[]> {
    return apiClient
      .get<ScriptVersion[]>(`${scenarioPath(name)}/script/versions`)
      .then((res) => res.data);
  },

  scriptVersion(name: string, version: number): Promise<ScriptVersionBody> {
    return apiClient
      .get<ScriptVersionBody>(
        `${scenarioPath(name)}/script/versions/${encodeURIComponent(String(version))}`,
      )
      .then((res) => res.data);
  },

  preflight(query: PreflightQuery): Promise<PreflightResult> {
    return apiClient
      .get<PreflightResult>(`${base}/preflight`, { params: preflightParams(query) })
      .then((res) => ({ ...res.data, checks: res.data?.checks ?? [] }));
  },

  /** The generator group's desired, in-service and max sizes. */
  generators(): Promise<GeneratorGroup> {
    return apiClient.get<GeneratorGroup>(`${base}/generators`).then((res) => res.data);
  },

  start(body: LoadRunStart): Promise<{ runId: number }> {
    return apiClient.post<{ runId: number }>(`${base}/runs`, body).then((res) => res.data);
  },

  runs(options: ListLoadRunsOptions = {}): Promise<LoadRun[]> {
    const params: Record<string, number> = { limit: options.limit ?? 50 };
    if (options.before !== undefined) params.before = options.before;
    return apiClient.get<LoadRun[]>(`${base}/runs`, { params }).then((res) => res.data);
  },

  run(runId: number | string): Promise<LoadRunDetail> {
    return apiClient.get<LoadRunDetail>(runPath(runId)).then((res) => res.data);
  },

  stats(runId: number | string, query: LoadStatsQuery = {}): Promise<LoadStatRow[]> {
    const params: Record<string, string | number> = {};
    if (query.from !== undefined) params.from = query.from;
    if (query.to !== undefined) params.to = query.to;
    if (query.source !== undefined) params.source = query.source;
    if (query.index !== undefined) params.index = query.index;
    if (query.step !== undefined) params.step = query.step;
    return apiClient
      .get<LoadStatRow[]>(`${runPath(runId)}/stats`, { params })
      .then((res) => res.data);
  },

  /** The stats as CSV, fetched with the bearer token and returned as a blob. */
  statsCsv(runId: number | string): Promise<Blob> {
    return apiClient
      .get<Blob>(`${runPath(runId)}/stats.csv`, { responseType: "blob" })
      .then((res) =>
        res.data instanceof Blob ? res.data : new Blob([String(res.data)], { type: "text/csv" }),
      );
  },

  stop(runId: number | string): Promise<void> {
    return apiClient.post(`${runPath(runId)}/stop`).then(() => undefined);
  },

  setVerdict(runId: number | string, verdict: string): Promise<LoadRunDetail | undefined> {
    return apiClient
      .put<LoadRunDetail | undefined>(`${runPath(runId)}/verdict`, { verdict })
      .then((res) => res.data);
  },

  removeRun(runId: number | string): Promise<void> {
    return apiClient.delete(runPath(runId)).then(() => undefined);
  },

  runLog(runId: number | string, index: number, tail = 500): Promise<LogLine[]> {
    return apiClient
      .get<LogLine[] | { lines: LogLine[] }>(`${runPath(runId)}/log`, {
        params: { index, tail },
      })
      .then((res) => (Array.isArray(res.data) ? res.data : (res.data?.lines ?? [])));
  },
};

export default loadApi;
