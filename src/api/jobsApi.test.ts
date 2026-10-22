import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import apiClient from "./apiClient";
import jobsApi, { jobsErrorMessage, parseJobsApiError } from "./jobsApi";
import type { JobDetail, JobRun, JobSummary, LogLine, ScriptVersion } from "./types";

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
});

afterEach(() => {
  mock.restore();
});

const sampleRun: JobRun = {
  id: 42,
  job: "nightly-report",
  trigger: "schedule",
  actor: "scheduler",
  status: "succeeded",
  instanceId: "i-0abc",
  imageDigest: "sha256:abc",
  scriptVersion: 3,
  exitCode: 0,
  queuedAt: "2026-08-03T00:00:00Z",
  startedAt: "2026-08-03T00:00:02Z",
  finishedAt: "2026-08-03T00:01:00Z",
  cancelRequestedAt: null,
  detail: null,
};

const sampleSummary: JobSummary = {
  name: "nightly-report",
  schedule: "0 2 * * *",
  timeZone: "UTC",
  image: "registry.example.com/jobs",
  tag: "latest",
  envSecretRef: null,
  timeoutSeconds: 3600,
  enabled: true,
  scriptVersion: 3,
  nextRunAt: "2026-08-04T02:00:00Z",
  lastRun: sampleRun,
  updatedBy: "alice",
  updatedAt: "2026-08-03T00:00:00Z",
};

const sampleDetail: JobDetail = { ...sampleSummary, script: "echo hello" };

describe("jobsApi", () => {
  it("list() GETs /mgmt/jobs and returns the array", async () => {
    mock.onGet("/mgmt/jobs").reply(200, [sampleSummary]);

    const result = await jobsApi.list();

    expect(result).toEqual([sampleSummary]);
    expect(mock.history.get[0].url).toBe("/mgmt/jobs");
  });

  it("get() GETs the job detail with an encoded name", async () => {
    mock.onGet("/mgmt/jobs/a%20b").reply(200, sampleDetail);

    const result = await jobsApi.get("a b");

    expect(result).toEqual(sampleDetail);
    expect(mock.history.get[0].url).toBe("/mgmt/jobs/a%20b");
  });

  it("upsert() PUTs the body to /mgmt/jobs/{name}", async () => {
    mock.onPut("/mgmt/jobs/nightly-report").reply(200, sampleDetail);

    const result = await jobsApi.upsert("nightly-report", { enabled: false });

    expect(result).toEqual(sampleDetail);
    expect(JSON.parse(mock.history.put[0].data)).toEqual({ enabled: false });
  });

  it("remove() DELETEs with force only when asked", async () => {
    mock.onDelete("/mgmt/jobs/nightly-report").reply(204);

    await jobsApi.remove("nightly-report");
    await jobsApi.remove("nightly-report", true);

    expect(mock.history.delete[0].params).toBeUndefined();
    expect(mock.history.delete[1].params).toEqual({ force: true });
  });

  it("run() POSTs /run and returns the run id", async () => {
    mock.onPost("/mgmt/jobs/nightly-report/run").reply(202, { runId: 43 });

    await expect(jobsApi.run("nightly-report")).resolves.toEqual({ runId: 43 });
  });

  it("enable() and disable() POST their endpoints", async () => {
    mock.onPost("/mgmt/jobs/nightly-report/enable").reply(200, sampleSummary);
    mock
      .onPost("/mgmt/jobs/nightly-report/disable")
      .reply(200, { ...sampleSummary, enabled: false });

    await expect(jobsApi.enable("nightly-report")).resolves.toEqual(sampleSummary);
    const disabled = await jobsApi.disable("nightly-report");

    expect(disabled.enabled).toBe(false);
    expect(mock.history.post.map((p) => p.url)).toEqual([
      "/mgmt/jobs/nightly-report/enable",
      "/mgmt/jobs/nightly-report/disable",
    ]);
  });

  it("runs() GETs the run history with limit and the before cursor", async () => {
    mock.onGet("/mgmt/jobs/nightly-report/runs").reply(200, [sampleRun]);

    await expect(jobsApi.runs("nightly-report")).resolves.toEqual([sampleRun]);
    await jobsApi.runs("nightly-report", { before: 42 });

    expect(mock.history.get[0].params).toEqual({ limit: 50 });
    expect(mock.history.get[1].params).toEqual({ limit: 50, before: 42 });
  });

  it("getRun() and cancelRun() address a single run", async () => {
    mock.onGet("/mgmt/jobs/nightly-report/runs/42").reply(200, sampleRun);
    mock.onPost("/mgmt/jobs/nightly-report/runs/42/cancel").reply(202);

    await expect(jobsApi.getRun("nightly-report", 42)).resolves.toEqual(sampleRun);
    await jobsApi.cancelRun("nightly-report", 42);

    expect(mock.history.post[0].url).toBe("/mgmt/jobs/nightly-report/runs/42/cancel");
  });

  it("runLog() GETs the run log with a tail param", async () => {
    const lines: LogLine[] = [{ ts: "2026-08-03T00:00:03Z", message: "hello" }];
    mock.onGet("/mgmt/jobs/nightly-report/runs/42/log").reply(200, lines);

    await expect(jobsApi.runLog("nightly-report", 42)).resolves.toEqual(lines);
    expect(mock.history.get[0].params).toEqual({ tail: 500 });
  });

  it("runLog() also accepts the wrapped { lines } shape", async () => {
    const lines: LogLine[] = [{ ts: "2026-08-03T00:00:03Z", message: "hello" }];
    mock.onGet("/mgmt/jobs/nightly-report/runs/42/log").reply(200, { lines });

    await expect(jobsApi.runLog("nightly-report", 42, 100)).resolves.toEqual(lines);
  });

  it("scriptVersions() and scriptVersion() GET the script history", async () => {
    const versions: ScriptVersion[] = [
      { version: 3, sha256: "abc", updatedBy: "alice", updatedAt: "2026-08-03T00:00:00Z" },
    ];
    mock.onGet("/mgmt/jobs/nightly-report/script/versions").reply(200, versions);
    mock
      .onGet("/mgmt/jobs/nightly-report/script/versions/2")
      .reply(200, { version: 2, script: "echo old" });

    await expect(jobsApi.scriptVersions("nightly-report")).resolves.toEqual(versions);
    await expect(jobsApi.scriptVersion("nightly-report", 2)).resolves.toEqual({
      version: 2,
      script: "echo old",
    });
  });
});

describe("parseJobsApiError", () => {
  it("reads the status, error and field of a 400", async () => {
    mock
      .onPut("/mgmt/jobs/x")
      .reply(400, { error: "invalid cron", field: "schedule" });

    const err = await jobsApi.upsert("x", {}).catch((e: unknown) => e);

    expect(parseJobsApiError(err)).toEqual({
      status: 400,
      error: "invalid cron",
      field: "schedule",
    });
  });

  it("maps run_active to a readable message", async () => {
    mock.onPost("/mgmt/jobs/x/run").reply(409, { error: "run_active" });

    const err = await jobsApi.run("x").catch((e: unknown) => e);

    expect(parseJobsApiError(err).error).toBe("run_active");
    expect(jobsErrorMessage(err, "fallback")).toBe(
      "A run is already queued or running",
    );
  });
});
