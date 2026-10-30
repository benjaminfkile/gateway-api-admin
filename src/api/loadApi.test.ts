import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import apiClient from "./apiClient";
import loadApi, {
  isRunActive,
  loadErrorMessage,
  parseLoadApiError,
  preflightParams,
} from "./loadApi";
import type { LoadRun, LoadScenario } from "./types";

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
});

afterEach(() => {
  mock.restore();
});

const scenario: LoadScenario = {
  name: "sample-scenario",
  repository: "example-org/example-repo",
  commitSha: "0123456789abcdef",
  scriptVersion: 2,
  image: "registry.example.com/k6",
  tag: "latest",
  paramsDefault: { rate: "10" },
  maxVusPerGenerator: 500,
  lastValidationRunId: 3,
  validated: true,
  updatedBy: "alice",
  updatedAt: "2026-10-01T00:00:00Z",
};

const run = { id: 7, status: "ramping" } as LoadRun;

function axiosError(status: number, data: unknown) {
  return { response: { status, data } };
}

describe("loadApi", () => {
  it("lists scenarios and reads one with its script", async () => {
    mock.onGet("/mgmt/load/scenarios").reply(200, [scenario]);
    mock.onGet("/mgmt/load/scenarios/sample-scenario").reply(200, { ...scenario, script: "x" });
    expect(await loadApi.scenarios()).toEqual([scenario]);
    expect((await loadApi.scenario("sample-scenario")).script).toBe("x");
  });

  it("PUTs a scenario body and DELETEs a scenario", async () => {
    mock.onPut("/mgmt/load/scenarios/sample-scenario").reply(201, scenario);
    mock.onDelete("/mgmt/load/scenarios/sample-scenario").reply(204);
    await loadApi.upsertScenario("sample-scenario", { maxVusPerGenerator: 10 });
    expect(JSON.parse(mock.history.put[0].data)).toEqual({ maxVusPerGenerator: 10 });
    await loadApi.removeScenario("sample-scenario");
    expect(mock.history.delete).toHaveLength(1);
  });

  it("reads script versions and one version body", async () => {
    mock.onGet("/mgmt/load/scenarios/sample-scenario/script/versions").reply(200, []);
    mock
      .onGet("/mgmt/load/scenarios/sample-scenario/script/versions/2")
      .reply(200, { version: 2, script: "y" });
    expect(await loadApi.scriptVersions("sample-scenario")).toEqual([]);
    expect(await loadApi.scriptVersion("sample-scenario", 2)).toEqual({ version: 2, script: "y" });
  });

  it("sends the pre-flight query without any fleet field", async () => {
    mock.onGet("/mgmt/load/preflight").reply(200, { ok: true, checks: [] });
    await loadApi.preflight({
      scenario: "sample-scenario",
      target: "sample-service",
      confirm: "sample-service",
      generators: 2,
      vus: 50,
      validation: false,
    });
    expect(mock.history.get[0].params).toEqual({
      scenario: "sample-scenario",
      target: "sample-service",
      confirm: "sample-service",
      generators: 2,
      vus: 50,
      validation: false,
    });
    expect(Object.keys(preflightParams(mock.history.get[0].params))).not.toContain("fleet");
  });

  it("reads the generator group", async () => {
    const group = { group: "sample-generators", desired: 1, inService: 1, max: 4 };
    mock.onGet("/mgmt/load/generators").reply(200, group);
    expect(await loadApi.generators()).toEqual(group);
  });

  it("starts a run and returns its id", async () => {
    mock.onPost("/mgmt/load/runs").reply(202, { runId: 9 });
    const body = {
      scenario: "sample-scenario",
      target: "sample-service",
      confirm: "sample-service",
      generators: 1,
      vusPerGenerator: 1,
      rampSeconds: 0,
      holdSeconds: 60,
      validation: true,
    };
    expect(await loadApi.start(body)).toEqual({ runId: 9 });
    expect(JSON.parse(mock.history.post[0].data)).toEqual(body);
  });

  it("lists runs with limit and before", async () => {
    mock.onGet("/mgmt/load/runs").reply(200, [run]);
    await loadApi.runs({ before: 7 });
    expect(mock.history.get[0].params).toEqual({ limit: 50, before: 7 });
  });

  it("reads a run, its stats, stops it, sets a verdict and deletes it", async () => {
    mock.onGet("/mgmt/load/runs/7").reply(200, { ...run, timeline: [] });
    mock.onGet("/mgmt/load/runs/7/stats").reply(200, []);
    mock.onPost("/mgmt/load/runs/7/stop").reply(202);
    mock.onPut("/mgmt/load/runs/7/verdict").reply(200, run);
    mock.onDelete("/mgmt/load/runs/7").reply(204);
    expect((await loadApi.run(7)).timeline).toEqual([]);
    await loadApi.stats(7, { source: "generator", step: 10 });
    expect(mock.history.get[1].params).toEqual({ source: "generator", step: 10 });
    await loadApi.stop(7);
    await loadApi.setVerdict(7, "held at target");
    expect(JSON.parse(mock.history.put[0].data)).toEqual({ verdict: "held at target" });
    await loadApi.removeRun(7);
    expect(mock.history.delete).toHaveLength(1);
  });

  it("fetches stats.csv as a blob", async () => {
    mock.onGet("/mgmt/load/runs/7/stats.csv").reply(200, "at,vus\n");
    const blob = await loadApi.statsCsv(7);
    expect(blob).toBeInstanceOf(Blob);
    expect(mock.history.get[0].responseType).toBe("blob");
  });

  it("reads a generator log with index and tail", async () => {
    mock.onGet("/mgmt/load/runs/7/log").reply(200, [{ ts: "t", message: "m" }]);
    expect(await loadApi.runLog(7, 1)).toEqual([{ ts: "t", message: "m" }]);
    expect(mock.history.get[0].params).toEqual({ index: 1, tail: 500 });
  });
});

describe("load errors", () => {
  it("maps run_active, preflight_failed and load_unconfigured", () => {
    expect(loadErrorMessage(axiosError(409, { error: "run_active" }), "x")).toBe(
      "A load run is already active",
    );
    expect(
      loadErrorMessage(
        axiosError(409, {
          error: "preflight_failed",
          checks: [
            { name: "target_confirmed", status: "red", message: "", fix: null },
            { name: "presence_off", status: "amber", message: "", fix: null },
          ],
        }),
        "x",
      ),
    ).toBe("Pre-flight failed: target_confirmed");
    expect(loadErrorMessage(axiosError(503, { error: "load_unconfigured" }), "x")).toMatch(
      /not configured/,
    );
  });

  it("keeps the checks of a preflight_failed answer and the field of a 400", () => {
    const parsed = parseLoadApiError(
      axiosError(409, { error: "preflight_failed", checks: [{ name: "a", status: "red" }] }),
    );
    expect(parsed.checks).toHaveLength(1);
    expect(loadErrorMessage(axiosError(400, { error: "invalid", field: "target" }), "x")).toBe(
      "invalid (target)",
    );
    expect(loadErrorMessage({}, "fallback")).toBe("fallback");
  });

  it("isRunActive is true only for the non-terminal statuses", () => {
    expect(isRunActive({ status: "queued" })).toBe(true);
    expect(isRunActive({ status: "draining" })).toBe(true);
    expect(isRunActive({ status: "succeeded" })).toBe(false);
    expect(isRunActive({ status: "lost" })).toBe(false);
    expect(isRunActive(null)).toBe(false);
  });
});
