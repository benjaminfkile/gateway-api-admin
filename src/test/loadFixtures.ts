import type { LoadRun, LoadRunDetail, LoadScenario } from "../api/types";

// Placeholder load fixtures shared by the Load, run view and banner tests.

export function loadRun(overrides: Partial<LoadRun> = {}): LoadRun {
  return {
    id: 5,
    scenario: "sample-scenario",
    scenarioVersion: 2,
    target: "sample-service",
    validation: false,
    actor: "alice",
    status: "succeeded",
    generators: 2,
    vusPerGenerator: 250,
    rampSeconds: 300,
    holdSeconds: 600,
    hardStopAt: "2026-10-01T01:00:00Z",
    checkedIn: 2,
    queuedAt: "2026-10-01T00:00:00Z",
    startedAt: "2026-10-01T00:00:10Z",
    rampStartedAt: "2026-10-01T00:01:00Z",
    finishedAt: "2026-10-01T00:16:10Z",
    stopRequestedAt: null,
    stopReason: null,
    verdict: "held fine",
    detail: null,
    peaks: { "event_lag_ms.p(95)": 42.5, "event_lag_ms.p(90)": 30 },
    ...overrides,
  };
}

export function loadRunDetail(overrides: Partial<LoadRunDetail> = {}): LoadRunDetail {
  return {
    ...loadRun(),
    timeline: [
      { at: "2026-10-01T00:00:00Z", status: "queued", by: "alice", note: null },
      { at: "2026-10-01T00:16:10Z", status: "succeeded", by: null, note: "hold complete" },
    ],
    ...overrides,
  };
}

export function loadScenario(overrides: Partial<LoadScenario> = {}): LoadScenario {
  return {
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
    ...overrides,
  };
}
