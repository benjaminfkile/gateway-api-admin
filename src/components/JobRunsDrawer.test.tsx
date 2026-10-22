import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import * as hubClient from "../lib/hubClient";
vi.mock("../lib/hubClient");

// jsdom cannot render a real xterm canvas, so the terminal wrapper is mocked
// wholesale. A single shared handle lets tests assert against its methods.
const term = vi.hoisted(() => {
  const handle = {
    open: vi.fn(),
    writeln: vi.fn(),
    clear: vi.fn(),
    fit: vi.fn(),
    setTheme: vi.fn(),
    dispose: vi.fn(),
  };
  return { handle, createTerminal: vi.fn(() => handle) };
});

vi.mock("../lib/terminal", () => ({
  createTerminal: term.createTerminal,
  themeFromPalette: vi.fn(() => ({})),
}));

import apiClient from "../api/apiClient";
import type { JobRun, LogLine } from "../api/types";
import JobRunsDrawer, {
  applyRunEventToRuns,
  LOG_POLL_MS,
  mergeRuns,
  RUNS_PAGE_SIZE,
} from "./JobRunsDrawer";
import { SnackbarProvider } from "../contexts/SnackbarContext";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";
import { installHubMock, type HubMockControl } from "../test/hubClientMock";

let mock: MockAdapter;
let hub: HubMockControl;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
  hub = installHubMock(hubClient);
  vi.clearAllMocks();
});

afterEach(() => {
  mock.restore();
  vi.useRealTimers();
});

function run(id: number, overrides: Partial<JobRun> = {}): JobRun {
  return {
    id,
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
    finishedAt: "2026-08-03T00:00:31Z",
    cancelRequestedAt: null,
    detail: null,
    ...overrides,
  };
}

const RUNS_URL = "/mgmt/jobs/nightly-report/runs";

function renderDrawer() {
  return render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <JobRunsDrawer open jobName="nightly-report" onClose={vi.fn()} />
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
}

function writtenLines(): string[] {
  return term.handle.writeln.mock.calls.map((c) => c[0] as string);
}

describe("helpers", () => {
  it("mergeRuns dedupes by id, newest first", () => {
    const merged = mergeRuns([run(3), run(2)], [run(2, { status: "failed" }), run(1)]);
    expect(merged.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(merged[1].status).toBe("failed");
  });

  it("applyRunEventToRuns patches a shown run", () => {
    const runs = [run(5, { status: "running", finishedAt: null })];
    const next = applyRunEventToRuns(runs, { runId: 5, status: "failed", exitCode: 1 });
    expect(next[0]).toMatchObject({ status: "failed", exitCode: 1 });
    expect(applyRunEventToRuns(runs, { runId: 6, status: "failed" })).toBe(runs);
  });
});

describe("JobRunsDrawer", () => {
  it("lists runs newest first with their columns and finished detail", async () => {
    mock.onGet(RUNS_URL).reply(200, [
      run(12, { trigger: "manual", actor: "alice", status: "failed", exitCode: 2, detail: "exit status 2" }),
      run(11),
    ]);
    renderDrawer();

    const table = await screen.findByRole("table", { name: "job runs" });
    const first = await within(table).findByTestId("run-12");
    expect(within(first).getByText("failed")).toBeInTheDocument();
    expect(within(first).getByText("manual")).toBeInTheDocument();
    expect(within(first).getByText("alice")).toBeInTheDocument();
    expect(within(first).getByText("2")).toBeInTheDocument();
    expect(within(first).getByText("30s")).toBeInTheDocument();
    expect(within(table).getByText("exit status 2")).toBeInTheDocument();

    const rows = within(table).getAllByTestId(/^run-/);
    expect(rows.map((r) => r.dataset.testid)).toEqual(["run-12", "run-11"]);
    expect(mock.history.get[0].params).toEqual({ limit: 50 });
    // A short page means no older runs.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("Load more pages back with the before cursor", async () => {
    const user = userEvent.setup();
    const page = Array.from({ length: RUNS_PAGE_SIZE }, (_, i) => run(200 - i));
    mock.onGet(RUNS_URL, { params: { limit: 50 } }).reply(200, page);
    mock.onGet(RUNS_URL, { params: { limit: 50, before: 151 } }).reply(200, [run(150)]);
    renderDrawer();

    await screen.findByTestId("run-200");
    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByTestId("run-150")).toBeInTheDocument();
    expect(mock.history.get[1].params).toEqual({ limit: 50, before: 151 });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Load more" })).toBeNull());
  });

  it("cancels an active run after confirmation", async () => {
    const user = userEvent.setup();
    mock.onGet(RUNS_URL).reply(200, [run(7, { status: "running", finishedAt: null, exitCode: null })]);
    mock.onPost(`${RUNS_URL}/7/cancel`).reply(202);
    renderDrawer();

    const row = await screen.findByTestId("run-7");
    await user.click(within(row).getByRole("button", { name: "cancel run 7" }));

    const dialog = await screen.findByRole("dialog");
    expect(mock.history.post).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Cancel run" }));

    await waitFor(() => expect(mock.history.post).toHaveLength(1));
    expect(mock.history.post[0].url).toBe(`${RUNS_URL}/7/cancel`);
    expect(await screen.findByText("Cancel requested for run #7")).toBeInTheDocument();
  });

  it("offers Cancel only while a run is queued or running", async () => {
    mock.onGet(RUNS_URL).reply(200, [run(8, { status: "queued", startedAt: null, finishedAt: null }), run(7)]);
    renderDrawer();

    const queued = await screen.findByTestId("run-8");
    expect(within(queued).getByRole("button", { name: "cancel run 8" })).toBeInTheDocument();
    expect(within(screen.getByTestId("run-7")).queryByRole("button", { name: "cancel run 7" })).toBeNull();
  });

  it("patches a shown run from a live run event", async () => {
    mock.onGet(RUNS_URL).reply(200, [run(7, { status: "running", finishedAt: null, exitCode: null })]);
    renderDrawer();

    const row = await screen.findByTestId("run-7");
    act(() =>
      hub.emit("ops:jobs", "run", {
        runId: 7,
        job: "nightly-report",
        status: "succeeded",
        finishedAt: "2026-08-03T00:00:31Z",
        exitCode: 0,
      }),
    );
    expect(await within(row).findByText("succeeded")).toBeInTheDocument();
  });

  it("the log panel polls every 2 s while the run is running", async () => {
    vi.useFakeTimers();
    const lineA: LogLine = { ts: "2026-08-03T00:00:02Z", message: "starting" };
    const lineB: LogLine = { ts: "2026-08-03T00:00:04Z", message: "working" };
    let lines: LogLine[] = [lineA];
    let current = run(7, { status: "running", finishedAt: null, exitCode: null });
    mock.onGet(RUNS_URL).reply(() => [200, [current]]);
    mock.onGet(`${RUNS_URL}/7`).reply(() => [200, current]);
    mock.onGet(`${RUNS_URL}/7/log`).reply(() => [200, lines]);
    renderDrawer();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "log of run 7" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const logGets = () => mock.history.get.filter((g) => g.url === `${RUNS_URL}/7/log`).length;
    expect(term.createTerminal).toHaveBeenCalledTimes(1);
    expect(logGets()).toBe(1);
    expect(mock.history.get.find((g) => g.url === `${RUNS_URL}/7/log`)?.params).toEqual({
      tail: 500,
    });
    expect(writtenLines()).toEqual(["2026-08-03T00:00:02Z starting"]);

    lines = [lineA, lineB];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    });
    expect(logGets()).toBe(2);
    // Only the new line is appended.
    expect(writtenLines()).toEqual([
      "2026-08-03T00:00:02Z starting",
      "2026-08-03T00:00:04Z working",
    ]);

    // The run finishes: the next poll reads it, one final log read follows,
    // and polling stops.
    current = { ...current, status: "succeeded", finishedAt: "2026-08-03T00:00:05Z", exitCode: 0 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOG_POLL_MS);
    });
    const afterFinish = logGets();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOG_POLL_MS * 5);
    });
    expect(logGets()).toBe(afterFinish);
    expect(within(screen.getByRole("dialog")).getByText("succeeded")).toBeInTheDocument();
  });

  it("the log panel reads a finished run's log once", async () => {
    vi.useFakeTimers();
    mock.onGet(RUNS_URL).reply(200, [run(7)]);
    mock.onGet(`${RUNS_URL}/7/log`).reply(200, [{ ts: "2026-08-03T00:00:02Z", message: "done" }]);
    renderDrawer();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "log of run 7" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LOG_POLL_MS * 5);
    });

    expect(mock.history.get.filter((g) => g.url === `${RUNS_URL}/7/log`)).toHaveLength(1);
    expect(writtenLines()).toEqual(["2026-08-03T00:00:02Z done"]);
  });
});
