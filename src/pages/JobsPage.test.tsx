import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import MockAdapter from "axios-mock-adapter";

// No Cognito in the test container; stub the token source.
vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

// The SignalR hub is mocked wholesale; no real connection is made in tests.
import * as hubClient from "../lib/hubClient";
vi.mock("../lib/hubClient");

// jsdom cannot render a real xterm canvas.
vi.mock("../lib/terminal", () => ({
  createTerminal: vi.fn(() => ({
    open: vi.fn(),
    writeln: vi.fn(),
    clear: vi.fn(),
    fit: vi.fn(),
    setTheme: vi.fn(),
    dispose: vi.fn(),
  })),
  themeFromPalette: vi.fn(() => ({})),
}));

import apiClient from "../api/apiClient";
import type { JobRun, JobSummary } from "../api/types";
import JobsPage, { applyRunEvent, formatFromNow } from "./JobsPage";
import { SnackbarProvider } from "../contexts/SnackbarContext";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";
import { installHubMock, type HubMockControl } from "../test/hubClientMock";

let mock: MockAdapter;
let hub: HubMockControl;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
  hub = installHubMock(hubClient);
});

afterEach(() => {
  mock.restore();
  vi.clearAllMocks();
});

function run(overrides: Partial<JobRun> = {}): JobRun {
  return {
    id: 10,
    job: "nightly-report",
    trigger: "schedule",
    actor: "scheduler",
    status: "succeeded",
    instanceId: "i-0abc",
    imageDigest: "sha256:abc",
    scriptVersion: 2,
    exitCode: 0,
    queuedAt: "2026-08-03T00:00:00Z",
    startedAt: "2026-08-03T00:00:01Z",
    finishedAt: "2026-08-03T00:01:06Z",
    cancelRequestedAt: null,
    detail: null,
    ...overrides,
  };
}

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    name: "nightly-report",
    schedule: "0 2 * * *",
    timeZone: "Europe/Berlin",
    image: "registry.example.com/jobs",
    tag: "latest",
    envSecretRef: null,
    timeoutSeconds: 3600,
    enabled: true,
    scriptVersion: 2,
    nextRunAt: "2099-01-01T02:00:00Z",
    lastRun: run(),
    updatedBy: "alice",
    updatedAt: "2026-08-03T00:00:00Z",
    ...overrides,
  };
}

const NIGHTLY = job();
const MANUAL = job({
  name: "cleanup",
  schedule: null,
  nextRunAt: null,
  lastRun: null,
  enabled: false,
});

function renderPage() {
  return render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <MemoryRouter>
          <JobsPage />
        </MemoryRouter>
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
}

async function jobsTable(): Promise<HTMLElement> {
  const table = await screen.findByRole("table", { name: "jobs" });
  await waitFor(() => expect(table.querySelector(".MuiSkeleton-root")).toBeNull());
  return table;
}

function rowFor(table: HTMLElement, name: string): HTMLElement {
  const row = within(table).getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("pure helpers", () => {
  it("formatFromNow reads future and past instants", () => {
    const now = Date.parse("2026-08-03T00:00:00Z");
    expect(formatFromNow("2026-08-03T00:10:00Z", now)).toBe("in 10m");
    expect(formatFromNow("2026-08-03T03:00:00Z", now)).toBe("in 3h");
    expect(formatFromNow("2026-08-02T23:50:00Z", now)).toBe("10m ago");
  });

  it("applyRunEvent patches the matching lastRun in place", () => {
    const next = applyRunEvent([NIGHTLY], {
      runId: 10,
      job: "nightly-report",
      status: "failed",
      exitCode: 2,
    });
    expect(next[0].lastRun).toMatchObject({ id: 10, status: "failed", exitCode: 2 });
  });

  it("applyRunEvent replaces lastRun with a newer run and ignores older ones", () => {
    const newer = applyRunEvent([NIGHTLY], {
      runId: 11,
      job: "nightly-report",
      status: "queued",
      trigger: "manual",
      actor: "bob",
      instanceId: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
    });
    expect(newer[0].lastRun).toMatchObject({ id: 11, status: "queued", actor: "bob" });

    const older = [NIGHTLY];
    expect(applyRunEvent(older, { runId: 9, job: "nightly-report", status: "failed" })).toBe(
      older,
    );
    expect(applyRunEvent(older, { runId: 12, job: "other", status: "failed" })).toBe(older);
  });
});

describe("JobsPage", () => {
  it("renders a row per job with schedule, next run and last run", async () => {
    mock.onGet("/mgmt/jobs").reply(200, [NIGHTLY, MANUAL]);
    renderPage();

    const table = await jobsTable();
    const nightly = rowFor(table, "nightly-report");
    expect(within(nightly).getByText("0 2 * * *")).toBeInTheDocument();
    expect(within(nightly).getByText("Europe/Berlin")).toBeInTheDocument();
    expect(within(nightly).getByText(/^in \d+d$/)).toBeInTheDocument();
    expect(within(nightly).getByText("succeeded")).toBeInTheDocument();
    expect(within(nightly).getByText("1m 5s")).toBeInTheDocument();
    expect(within(nightly).getByRole("switch", { name: "enabled nightly-report" })).toBeChecked();

    const cleanup = rowFor(table, "cleanup");
    expect(within(cleanup).getByText("manual only")).toBeInTheDocument();
    expect(within(cleanup).getByText("never")).toBeInTheDocument();
    expect(within(cleanup).getByRole("switch", { name: "enabled cleanup" })).not.toBeChecked();
  });

  it("shows the empty state when there are no jobs", async () => {
    mock.onGet("/mgmt/jobs").reply(200, []);
    renderPage();

    expect(await screen.findByText(/No jobs defined yet/)).toBeInTheDocument();
  });

  it("the enabled switch calls disable and enable", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/jobs").reply(200, [NIGHTLY, MANUAL]);
    mock
      .onPost("/mgmt/jobs/nightly-report/disable")
      .reply(200, { ...NIGHTLY, enabled: false, nextRunAt: null });
    mock.onPost("/mgmt/jobs/cleanup/enable").reply(200, { ...MANUAL, enabled: true });
    renderPage();

    const table = await jobsTable();
    await user.click(within(table).getByRole("switch", { name: "enabled nightly-report" }));
    await waitFor(() =>
      expect(mock.history.post.map((p) => p.url)).toEqual([
        "/mgmt/jobs/nightly-report/disable",
      ]),
    );
    expect(await screen.findByText("Disabled nightly-report")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        within(table).getByRole("switch", { name: "enabled nightly-report" }),
      ).not.toBeChecked(),
    );

    await user.click(within(table).getByRole("switch", { name: "enabled cleanup" }));
    await waitFor(() =>
      expect(mock.history.post.map((p) => p.url)).toContain("/mgmt/jobs/cleanup/enable"),
    );
  });

  it("Run now confirms, then posts", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/jobs").reply(200, [NIGHTLY]);
    mock.onPost("/mgmt/jobs/nightly-report/run").reply(202, { runId: 11 });
    renderPage();

    const table = await jobsTable();
    await user.click(within(table).getByRole("button", { name: "run nightly-report now" }));

    // Nothing is posted until the dialog is confirmed.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Run nightly-report now?")).toBeInTheDocument();
    expect(mock.history.post).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Run now" }));
    await waitFor(() => expect(mock.history.post).toHaveLength(1));
    expect(mock.history.post[0].url).toBe("/mgmt/jobs/nightly-report/run");
    expect(await screen.findByText("Queued run #11 of nightly-report")).toBeInTheDocument();
  });

  it("Run now shows the 409 run_active message", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/jobs").reply(200, [NIGHTLY]);
    mock.onPost("/mgmt/jobs/nightly-report/run").reply(409, { error: "run_active" });
    renderPage();

    const table = await jobsTable();
    await user.click(within(table).getByRole("button", { name: "run nightly-report now" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Run now" }),
    );

    expect(
      await screen.findByText(
        "Failed to run nightly-report: A run is already queued or running",
      ),
    ).toBeInTheDocument();
  });

  it("a queued or running last run shows progress and disables Run now", async () => {
    mock
      .onGet("/mgmt/jobs")
      .reply(200, [job({ lastRun: run({ status: "running", finishedAt: null }) })]);
    renderPage();

    const table = await jobsTable();
    const row = rowFor(table, "nightly-report");
    expect(within(row).getByLabelText("run in progress")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "run nightly-report now" })).toBeDisabled();
  });

  it("Delete confirms, and offers force when the API answers run_active", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/jobs").reply(200, [NIGHTLY]);
    mock.onDelete("/mgmt/jobs/nightly-report").replyOnce(409, { error: "run_active" });
    mock.onDelete("/mgmt/jobs/nightly-report").replyOnce(204);
    renderPage();

    const table = await jobsTable();
    await user.click(within(table).getByRole("button", { name: "delete nightly-report" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await within(dialog).findByText("Force delete nightly-report?")).toBeInTheDocument();
    expect(mock.history.delete[0].params).toBeUndefined();

    await user.click(within(dialog).getByRole("button", { name: "Force delete" }));
    await waitFor(() => expect(mock.history.delete).toHaveLength(2));
    expect(mock.history.delete[1].params).toEqual({ force: true });
    expect(await screen.findByText("Deleted nightly-report")).toBeInTheDocument();
  });

  it("patches the last run from a live run event", async () => {
    mock.onGet("/mgmt/jobs").reply(200, [NIGHTLY]);
    renderPage();

    const table = await jobsTable();
    act(() =>
      hub.emit("ops:jobs", "run", {
        runId: 11,
        job: "nightly-report",
        status: "running",
        trigger: "manual",
        actor: "bob",
        instanceId: "i-0def",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
      }),
    );

    const row = rowFor(table, "nightly-report");
    expect(await within(row).findByText("running")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "run nightly-report now" })).toBeDisabled();
  });

  it("refetches the list on a live job event", async () => {
    let jobs = [NIGHTLY];
    mock.onGet("/mgmt/jobs").reply(() => [200, jobs]);
    renderPage();

    const table = await jobsTable();
    jobs = [NIGHTLY, MANUAL];
    act(() => hub.emit("ops:jobs", "job", { name: "cleanup", action: "upserted", by: "alice" }));

    expect(await within(table).findByText("cleanup")).toBeInTheDocument();
  });

  it("opens the runs drawer from the row", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/jobs").reply(200, [NIGHTLY]);
    mock.onGet("/mgmt/jobs/nightly-report/runs").reply(200, [run()]);
    renderPage();

    const table = await jobsTable();
    await user.click(within(table).getByRole("button", { name: "runs of nightly-report" }));

    const drawer = await screen.findByRole("region", { name: "runs of nightly-report" });
    expect(await within(drawer).findByTestId("run-10")).toBeInTheDocument();
  });
});
