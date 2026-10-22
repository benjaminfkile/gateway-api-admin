import apiClient from "./apiClient";
import type {
  JobDetail,
  JobRun,
  JobSummary,
  JobUpsert,
  LogLine,
  ScriptVersion,
  ScriptVersionBody,
} from "./types";

// Management endpoints for scheduled jobs. All are rooted at `/mgmt/jobs`.
const base = "/mgmt/jobs";

function jobPath(name: string): string {
  return `${base}/${encodeURIComponent(name)}`;
}

function runPath(name: string, runId: number): string {
  return `${jobPath(name)}/runs/${encodeURIComponent(String(runId))}`;
}

/** The `{ error, field }` body the gateway sends with 400 and 409 answers. */
export interface JobsApiError {
  status: number | null;
  error: string | null;
  field: string | null;
}

/** Pull the HTTP status and the `{ error, field }` body out of a failed request. */
export function parseJobsApiError(err: unknown): JobsApiError {
  const result: JobsApiError = { status: null, error: null, field: null };
  if (err && typeof err === "object" && "response" in err) {
    const response = (err as { response?: { status?: number; data?: unknown } })
      .response;
    result.status = response?.status ?? null;
    const data = response?.data;
    if (typeof data === "string" && data) {
      result.error = data;
    } else if (data && typeof data === "object") {
      const { error, field } = data as { error?: unknown; field?: unknown };
      if (typeof error === "string" && error) result.error = error;
      if (typeof field === "string" && field) result.field = field;
    }
  }
  return result;
}

/** A readable message for a failed jobs request. */
export function jobsErrorMessage(err: unknown, fallback: string): string {
  const parsed = parseJobsApiError(err);
  if (parsed.error === "run_active") return "A run is already queued or running";
  if (parsed.error) return parsed.error;
  if (parsed.status === null && err instanceof Error) return err.message;
  return fallback;
}

export interface ListRunsOptions {
  limit?: number;
  /** Return only runs older than this run id (the "Load more" cursor). */
  before?: number;
}

const jobsApi = {
  list(): Promise<JobSummary[]> {
    return apiClient.get<JobSummary[]>(base).then((res) => res.data);
  },

  get(name: string): Promise<JobDetail> {
    return apiClient.get<JobDetail>(jobPath(name)).then((res) => res.data);
  },

  upsert(name: string, body: JobUpsert): Promise<JobDetail> {
    return apiClient
      .put<JobDetail>(jobPath(name), body)
      .then((res) => res.data);
  },

  remove(name: string, force?: boolean): Promise<void> {
    return apiClient
      .delete(jobPath(name), {
        params: force ? { force: true } : undefined,
      })
      .then(() => undefined);
  },

  run(name: string): Promise<{ runId: number }> {
    return apiClient
      .post<{ runId: number }>(`${jobPath(name)}/run`)
      .then((res) => res.data);
  },

  enable(name: string): Promise<JobSummary> {
    return apiClient
      .post<JobSummary>(`${jobPath(name)}/enable`)
      .then((res) => res.data);
  },

  disable(name: string): Promise<JobSummary> {
    return apiClient
      .post<JobSummary>(`${jobPath(name)}/disable`)
      .then((res) => res.data);
  },

  runs(name: string, options: ListRunsOptions = {}): Promise<JobRun[]> {
    const params: Record<string, number> = { limit: options.limit ?? 50 };
    if (options.before !== undefined) params.before = options.before;
    return apiClient
      .get<JobRun[]>(`${jobPath(name)}/runs`, { params })
      .then((res) => res.data);
  },

  getRun(name: string, runId: number): Promise<JobRun> {
    return apiClient.get<JobRun>(runPath(name, runId)).then((res) => res.data);
  },

  cancelRun(name: string, runId: number): Promise<void> {
    return apiClient
      .post(`${runPath(name, runId)}/cancel`)
      .then(() => undefined);
  },

  runLog(name: string, runId: number, tail = 500): Promise<LogLine[]> {
    // The contract answers a bare LogLine[]; the service log endpoint wraps the
    // same lines as { lines }, so both shapes are accepted.
    return apiClient
      .get<LogLine[] | { lines: LogLine[] }>(`${runPath(name, runId)}/log`, {
        params: { tail },
      })
      .then((res) => (Array.isArray(res.data) ? res.data : (res.data?.lines ?? [])));
  },

  scriptVersions(name: string): Promise<ScriptVersion[]> {
    return apiClient
      .get<ScriptVersion[]>(`${jobPath(name)}/script/versions`)
      .then((res) => res.data);
  },

  scriptVersion(name: string, version: number): Promise<ScriptVersionBody> {
    return apiClient
      .get<ScriptVersionBody>(
        `${jobPath(name)}/script/versions/${encodeURIComponent(String(version))}`,
      )
      .then((res) => res.data);
  },
};

export default jobsApi;
