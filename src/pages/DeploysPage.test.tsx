import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import MockAdapter from "axios-mock-adapter";
import type { ReactNode } from "react";

// apiClient's request interceptor reaches into Cognito for a bearer token; there
// is no Cognito in the test container, so stub it to a no-op token source.
vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

// The SignalR hub is mocked wholesale — no real connection is made in tests.
import * as hubClient from "../lib/hubClient";
vi.mock("../lib/hubClient");

import apiClient from "../api/apiClient";
import type { DeployDetail, DeploySummary } from "../api/types";
import DeploysPage, { applyDeployEvent } from "./DeploysPage";
import { SnackbarProvider } from "../contexts/SnackbarContext";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";
import { installHubMock, type HubMockControl } from "../test/hubClientMock";

const POLL_TICK_ACTIVE = 5_000;
const POLL_TICK_IDLE = 30_000;

let mock: MockAdapter;
let hub: HubMockControl;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
  hub = installHubMock(hubClient);
});

afterEach(() => {
  mock.restore();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function summary(overrides: Partial<DeploySummary> = {}): DeploySummary {
  return {
    id: "d-1",
    service: "web",
    fromDigest: "sha256:aaaaaaaaaaaa1111",
    toDigest: "sha256:bbbbbbbbbbbb2222",
    actor: "alice",
    action: "deploy",
    status: "done",
    startedAt: "2026-08-03T00:00:00Z",
    finishedAt: "2026-08-03T00:01:30Z",
    ...overrides,
  };
}

const DONE = summary({ id: "d-1", service: "web", status: "done" });
const IN_PROGRESS = summary({
  id: "d-2",
  service: "worker",
  actor: "bob",
  status: "in_progress",
  finishedAt: null,
});
const FAILED = summary({ id: "d-3", service: "cache", status: "failed" });

function renderPage(children: ReactNode = <DeploysPage />) {
  return render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
}

async function historyTable(): Promise<HTMLElement> {
  const table = await screen.findByRole("table", { name: "deploy history" });
  // findByRole resolves as soon as the table element exists — which happens
  // while it still shows loading skeletons. Wait for those to clear so callers
  // reading data rows (rowFor) don't race the initial fetch.
  await waitFor(() =>
    expect(table.querySelector(".MuiSkeleton-root")).toBeNull(),
  );
  return table;
}

function rowFor(table: HTMLElement, text: string): HTMLElement {
  const cell = within(table).getByText(text);
  const row = cell.closest("tr");
  if (!row) throw new Error(`no row for ${text}`);
  return row;
}

function listGets(): number {
  return mock.history.get.filter((g) => g.url === "/mgmt/deploys").length;
}

describe("DeploysPage", () => {
  it("renders a row per deploy with status chips", async () => {
    mock.onGet("/mgmt/deploys").reply(200, [DONE, IN_PROGRESS, FAILED]);
    renderPage();

    const table = await historyTable();
    expect(within(table).getByText("web")).toBeInTheDocument();
    expect(within(rowFor(table, "web")).getByText("done")).toBeInTheDocument();
    expect(within(rowFor(table, "worker")).getByText("in_progress")).toBeInTheDocument();
    expect(within(rowFor(table, "cache")).getByText("failed")).toBeInTheDocument();
    // Short digests with an arrow between them.
    expect(within(rowFor(table, "web")).getByText("sha256:aaaaa")).toBeInTheDocument();
  });

  it("opens a drawer with per-instance detail and convergence math", async () => {
    const user = userEvent.setup();
    const detail: DeployDetail = {
      ...IN_PROGRESS,
      instances: [
        { instanceId: "i-0001", status: "converged", detail: null, updatedAt: "2026-08-03T00:00:10Z" },
        { instanceId: "i-0002", status: "converged", detail: null, updatedAt: "2026-08-03T00:00:12Z" },
        { instanceId: "i-0003", status: "updating", detail: "pulling image", updatedAt: "2026-08-03T00:00:14Z" },
      ],
    };
    mock.onGet("/mgmt/deploys").reply(200, [IN_PROGRESS]);
    mock.onGet("/mgmt/deploys/d-2").reply(200, detail);
    renderPage();

    const table = await historyTable();
    await within(table).findByText("worker");
    await user.click(within(rowFor(table, "worker")).getByText("worker"));

    const panel = await screen.findByRole("region", { name: /deploy d-2 detail/i });
    expect(within(panel).getByText("2/3 instances converged")).toBeInTheDocument();
    expect(within(panel).getByLabelText("convergence")).toHaveAttribute(
      "aria-valuenow",
      "67",
    );
    expect(within(panel).getByText("i-0003")).toBeInTheDocument();
    expect(within(panel).getByText("pulling image")).toBeInTheDocument();
  });

  it("applies a live deploy-progress event to the open drawer immediately", async () => {
    const user = userEvent.setup();
    const detail: DeployDetail = {
      ...IN_PROGRESS,
      instances: [
        { instanceId: "i-0001", status: "converged", detail: null, updatedAt: "2026-08-03T00:00:10Z" },
        { instanceId: "i-0002", status: "converged", detail: null, updatedAt: "2026-08-03T00:00:12Z" },
        { instanceId: "i-0003", status: "updating", detail: "pulling image", updatedAt: "2026-08-03T00:00:14Z" },
      ],
    };
    mock.onGet("/mgmt/deploys").reply(200, [IN_PROGRESS]);
    mock.onGet("/mgmt/deploys/d-2").reply(200, detail);
    renderPage();

    const table = await historyTable();
    await within(table).findByText("worker");
    await user.click(within(rowFor(table, "worker")).getByText("worker"));

    const panel = await screen.findByRole("region", { name: /deploy d-2 detail/i });
    expect(within(panel).getByText("2/3 instances converged")).toBeInTheDocument();

    // A live event converges the last instance — the drawer updates without a refetch.
    const detailGets = () =>
      mock.history.get.filter((g) => g.url === "/mgmt/deploys/d-2").length;
    const before = detailGets();

    act(() =>
      hub.emit("ops:deploys", {
        event: "progress",
        deployId: "d-2",
        instance: {
          instanceId: "i-0003",
          status: "converged",
          detail: null,
          updatedAt: "2026-08-03T00:00:20Z",
        },
        status: "done",
      }),
    );

    expect(await within(panel).findByText("3/3 instances converged")).toBeInTheDocument();
    // Status chip reflects the live status too, and no extra fetch was made.
    expect(within(panel).getByText("done")).toBeInTheDocument();
    expect(detailGets()).toBe(before);
  });

  it("ignores deploy events for a different deploy", async () => {
    const user = userEvent.setup();
    const detail: DeployDetail = {
      ...IN_PROGRESS,
      instances: [
        { instanceId: "i-0003", status: "updating", detail: "pulling image", updatedAt: "2026-08-03T00:00:14Z" },
      ],
    };
    mock.onGet("/mgmt/deploys").reply(200, [IN_PROGRESS]);
    mock.onGet("/mgmt/deploys/d-2").reply(200, detail);
    renderPage();

    const table = await historyTable();
    await user.click(within(rowFor(table, "worker")).getByText("worker"));
    const panel = await screen.findByRole("region", { name: /deploy d-2 detail/i });
    expect(within(panel).getByText("0/1 instances converged")).toBeInTheDocument();

    act(() =>
      hub.emit("ops:deploys", {
        event: "progress",
        deployId: "d-OTHER",
        instance: {
          instanceId: "i-0003",
          status: "converged",
          detail: null,
          updatedAt: "2026-08-03T00:00:20Z",
        },
      }),
    );

    // Unchanged — the event targeted a different deploy.
    expect(within(panel).getByText("0/1 instances converged")).toBeInTheDocument();
  });

  it("switches the poll interval from 5s to 30s as the rollout settles", async () => {
    vi.useFakeTimers();
    let data: DeploySummary[] = [IN_PROGRESS];
    mock.onGet("/mgmt/deploys").reply(() => [200, data]);
    renderPage();

    // Initial load.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(listGets()).toBe(1);

    // In_progress → fast 5s cadence.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_TICK_ACTIVE);
    });
    expect(listGets()).toBe(2);

    // Rollout finishes; the poll that fires at the next 5s tick sees "done".
    data = [DONE];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_TICK_ACTIVE);
    });
    expect(listGets()).toBe(3);

    // Now on the slow cadence: 5s more must NOT trigger a poll...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_TICK_ACTIVE);
    });
    expect(listGets()).toBe(3);

    // ...but reaching 30s does.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_TICK_IDLE - POLL_TICK_ACTIVE);
    });
    expect(listGets()).toBe(4);
  });

  it("filters by service and by status, client-side", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/deploys").reply(200, [DONE, IN_PROGRESS, FAILED]);
    renderPage();

    const table = await historyTable();
    await within(table).findByText("bob"); // wait for rows to load

    // Filter to a single service.
    await user.selectOptions(screen.getByLabelText("Service"), "worker");
    expect(within(table).queryByText("web")).toBeNull();
    expect(within(table).getByText("worker")).toBeInTheDocument();
    expect(within(table).queryByText("cache")).toBeNull();

    // Reset service, then filter by status.
    await user.selectOptions(screen.getByLabelText("Service"), "");
    await user.selectOptions(screen.getByLabelText("Status"), "failed");
    expect(within(table).getByText("cache")).toBeInTheDocument();
    expect(within(table).queryByText("web")).toBeNull();
    expect(within(table).queryByText("worker")).toBeNull();
  });

  it("shows an error state with retry that recovers", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/deploys").replyOnce(500);
    mock.onGet("/mgmt/deploys").reply(200, [DONE]);
    renderPage();

    const retry = await screen.findByRole("button", { name: /retry/i });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.click(retry);
    const table = await historyTable();
    await waitFor(() => expect(within(table).getByText("web")).toBeInTheDocument());
  });
});

describe("applyDeployEvent", () => {
  const base: DeployDetail = {
    ...IN_PROGRESS,
    instances: [
      { instanceId: "i-1", status: "updating", detail: null, updatedAt: "2026-08-03T00:00:00Z" },
    ],
  };

  it("upserts an existing instance by id", () => {
    const next = applyDeployEvent(base, {
      channel: "ops:deploys",
      event: "progress",
      instance: { instanceId: "i-1", status: "converged", detail: null, updatedAt: "t" },
    });
    expect(next.instances).toHaveLength(1);
    expect(next.instances[0].status).toBe("converged");
    expect(next).not.toBe(base);
  });

  it("appends a new instance not yet present", () => {
    const next = applyDeployEvent(base, {
      channel: "ops:deploys",
      event: "progress",
      instance: { instanceId: "i-2", status: "updating", detail: null, updatedAt: "t" },
    });
    expect(next.instances.map((i) => i.instanceId)).toEqual(["i-1", "i-2"]);
  });

  it("updates the overall status", () => {
    const next = applyDeployEvent(base, {
      channel: "ops:deploys",
      event: "progress",
      status: "done",
    });
    expect(next.status).toBe("done");
  });

  it("returns the same reference when nothing applies", () => {
    const next = applyDeployEvent(base, { channel: "ops:deploys", event: "heartbeat" });
    expect(next).toBe(base);
  });
});
