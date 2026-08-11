import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("reflects a deploy event's terminal status in the open drawer without a refetch", async () => {
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
    // Drawer header shows the in_progress status chip.
    expect(within(panel).getByText("in_progress")).toBeInTheDocument();

    const detailGets = () =>
      mock.history.get.filter((g) => g.url === "/mgmt/deploys/d-2").length;
    const before = detailGets();

    // A terminal `deploy` event upserts the list row; the derived drawer summary
    // flips to done — no detail refetch is needed for the header.
    act(() =>
      hub.emit("ops:deploys", "deploy", {
        deployId: "d-2",
        service: "worker",
        action: "deploy",
        fromDigest: IN_PROGRESS.fromDigest,
        toDigest: IN_PROGRESS.toDigest,
        status: "done",
        finishedAt: "2026-08-03T00:02:00Z",
        error: null,
      }),
    );

    expect(await within(panel).findByText("done")).toBeInTheDocument();
    expect(detailGets()).toBe(before);
  });

  it("refetches the open drawer detail on a deployInstance event", async () => {
    const user = userEvent.setup();
    let detail: DeployDetail = {
      ...IN_PROGRESS,
      instances: [
        { instanceId: "i-0001", status: "converged", detail: null, updatedAt: "2026-08-03T00:00:10Z" },
        { instanceId: "i-0002", status: "converged", detail: null, updatedAt: "2026-08-03T00:00:12Z" },
        { instanceId: "i-0003", status: "updating", detail: "pulling image", updatedAt: "2026-08-03T00:00:14Z" },
      ],
    };
    mock.onGet("/mgmt/deploys").reply(200, [IN_PROGRESS]);
    mock.onGet("/mgmt/deploys/d-2").reply(() => [200, detail]);
    renderPage();

    const table = await historyTable();
    await within(table).findByText("worker");
    await user.click(within(rowFor(table, "worker")).getByText("worker"));

    const panel = await screen.findByRole("region", { name: /deploy d-2 detail/i });
    expect(within(panel).getByText("2/3 instances converged")).toBeInTheDocument();

    const detailGets = () =>
      mock.history.get.filter((g) => g.url === "/mgmt/deploys/d-2").length;
    const before = detailGets();

    // The server now reports the last instance converged; a deployInstance event
    // triggers a detail refetch that picks it up.
    detail = {
      ...IN_PROGRESS,
      instances: [
        { instanceId: "i-0001", status: "converged", detail: null, updatedAt: "2026-08-03T00:00:10Z" },
        { instanceId: "i-0002", status: "converged", detail: null, updatedAt: "2026-08-03T00:00:12Z" },
        { instanceId: "i-0003", status: "converged", detail: null, updatedAt: "2026-08-03T00:00:20Z" },
      ],
    };
    act(() =>
      hub.emit("ops:deploys", "deployInstance", {
        deployId: "d-2",
        instanceId: "i-0003",
        status: "converged",
        error: null,
      }),
    );

    await waitFor(() => expect(detailGets()).toBe(before + 1));
    expect(await within(panel).findByText("3/3 instances converged")).toBeInTheDocument();
  });

  it("ignores a deployInstance event for a different deploy", async () => {
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

    const detailGets = () =>
      mock.history.get.filter((g) => g.url === "/mgmt/deploys/d-2").length;
    const before = detailGets();

    act(() =>
      hub.emit("ops:deploys", "deployInstance", {
        deployId: "d-OTHER",
        instanceId: "i-0003",
        status: "converged",
        error: null,
      }),
    );

    // useDeployProgress filters to the selected deploy — no refetch, unchanged.
    expect(detailGets()).toBe(before);
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

  // FINDING 5: a burst of deployInstance events must coalesce into ONE trailing
  // detail GET rather than firing one GET per event (a 10-instance rollout
  // otherwise fires ~30 GETs in seconds).
  it("coalesces a burst of deployInstance events into a single detail GET", async () => {
    vi.useFakeTimers();
    const detail: DeployDetail = {
      ...IN_PROGRESS,
      instances: [
        { instanceId: "i-0001", status: "updating", detail: null, updatedAt: "2026-08-03T00:00:10Z" },
      ],
    };
    mock.onGet("/mgmt/deploys").reply(200, [IN_PROGRESS]);
    mock.onGet("/mgmt/deploys/d-2").reply(200, detail);
    renderPage();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const table = screen.getByRole("table", { name: "deploy history" });
    await act(async () => {
      fireEvent.click(within(rowFor(table, "worker")).getByText("worker"));
      await vi.advanceTimersByTimeAsync(0);
    });

    const detailGets = () =>
      mock.history.get.filter((g) => g.url === "/mgmt/deploys/d-2").length;
    // Opening fetched the detail once (immediate, not debounced).
    expect(detailGets()).toBe(1);

    // A burst of five deployInstance events within the debounce window.
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        hub.emit("ops:deploys", "deployInstance", {
          deployId: "d-2",
          instanceId: `i-000${i}`,
          status: "converged",
          error: null,
        });
      }
      // Still inside the 300ms trailing window: no new GET yet.
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(detailGets()).toBe(1);

    // Once the burst goes quiet, exactly one trailing GET fires — not five.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(detailGets()).toBe(2);
  });

  // FINDING 5: a slow, older detail GET that resolves out of order must not
  // overwrite the newer response (a sequence guard on setDetail).
  it("drops a stale out-of-order detail response", async () => {
    vi.useFakeTimers();
    const twoOfThree: DeployDetail = {
      ...IN_PROGRESS,
      instances: [
        { instanceId: "i-0001", status: "converged", detail: null, updatedAt: "2026-08-03T00:00:10Z" },
        { instanceId: "i-0002", status: "converged", detail: null, updatedAt: "2026-08-03T00:00:12Z" },
        { instanceId: "i-0003", status: "updating", detail: "pulling", updatedAt: "2026-08-03T00:00:14Z" },
      ],
    };
    const threeOfThree: DeployDetail = {
      ...IN_PROGRESS,
      instances: twoOfThree.instances.map((i) => ({ ...i, status: "converged", detail: null })),
    };

    const resolvers: Array<(v: [number, DeployDetail]) => void> = [];
    mock.onGet("/mgmt/deploys").reply(200, [IN_PROGRESS]);
    mock.onGet("/mgmt/deploys/d-2").reply(
      () => new Promise((resolve) => resolvers.push(resolve)),
    );
    renderPage();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const table = screen.getByRole("table", { name: "deploy history" });
    await act(async () => {
      fireEvent.click(within(rowFor(table, "worker")).getByText("worker"));
      await vi.advanceTimersByTimeAsync(0);
    });

    // resolvers[0] is the open fetch: resolve it with 2/3.
    await act(async () => {
      resolvers[0]([200, twoOfThree]);
      await vi.advanceTimersByTimeAsync(0);
    });
    const panel = screen.getByRole("region", { name: /deploy d-2 detail/i });
    expect(within(panel).getByText("2/3 instances converged")).toBeInTheDocument();

    // Burst A → one debounced fetch (resolvers[1]); leave it in flight (slow).
    await act(async () => {
      hub.emit("ops:deploys", "deployInstance", { deployId: "d-2", instanceId: "i-0003", status: "converged", error: null });
      await vi.advanceTimersByTimeAsync(300);
    });
    // Burst B → a newer debounced fetch (resolvers[2]).
    await act(async () => {
      hub.emit("ops:deploys", "deployInstance", { deployId: "d-2", instanceId: "i-0003", status: "converged", error: null });
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(resolvers).toHaveLength(3);

    // The NEWER fetch (B) resolves first with 3/3.
    await act(async () => {
      resolvers[2]([200, threeOfThree]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(panel).getByText("3/3 instances converged")).toBeInTheDocument();

    // The OLDER fetch (A) resolves late with the now-stale 2/3: it must be
    // discarded — the panel stays at 3/3.
    await act(async () => {
      resolvers[1]([200, twoOfThree]);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(within(panel).getByText("3/3 instances converged")).toBeInTheDocument();
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
  const list: DeploySummary[] = [DONE, IN_PROGRESS];

  it("patches the matching row's status and terminal fields", () => {
    const next = applyDeployEvent(list, {
      deployId: "d-2",
      status: "done",
      finishedAt: "2026-08-03T00:05:00Z",
      error: null,
    });
    const row = next.find((d) => d.id === "d-2");
    expect(row?.status).toBe("done");
    expect(row?.finishedAt).toBe("2026-08-03T00:05:00Z");
    expect(next).not.toBe(list);
    // Rows the event does not name keep their identity.
    expect(next.find((d) => d.id === "d-1")).toBe(DONE);
  });

  it("prepends a best-effort row for an unseen deploy", () => {
    const next = applyDeployEvent(list, {
      deployId: "d-NEW",
      service: "api",
      toDigest: "sha256:cccccccccccc",
      status: "in_progress",
      finishedAt: null,
    });
    expect(next).toHaveLength(3);
    expect(next[0].id).toBe("d-NEW");
    expect(next[0].service).toBe("api");
    expect(next[0].status).toBe("in_progress");
  });

  it("returns the same reference when the event names no deploy", () => {
    expect(applyDeployEvent(list, {})).toBe(list);
  });

  // FINDING 4: a terminal event for an unseen deploy must not borrow finishedAt
  // (or Date.now()) as a fake start — that rendered 0-second deploys whose
  // "Started" was really the finish time.
  it("does not fake startedAt from finishedAt for an unseen terminal deploy", () => {
    const next = applyDeployEvent(list, {
      deployId: "d-TERMINAL",
      service: "api",
      toDigest: "sha256:dddddddddddd",
      status: "failed",
      finishedAt: "2026-08-03T00:09:00Z",
      error: "boom",
    });
    const row = next.find((d) => d.id === "d-TERMINAL");
    expect(row).toBeDefined();
    expect(row?.startedAt).not.toBe("2026-08-03T00:09:00Z");
    // Absent start renders as a dash rather than a bogus timestamp.
    expect(row?.startedAt).toBe("");
  });

  it("uses the event's own startedAt for an unseen deploy when present", () => {
    const next = applyDeployEvent(list, {
      deployId: "d-WITHSTART",
      service: "api",
      toDigest: "sha256:eeeeeeeeeeee",
      status: "in_progress",
      startedAt: "2026-08-03T00:08:00Z",
      finishedAt: null,
    });
    expect(next.find((d) => d.id === "d-WITHSTART")?.startedAt).toBe(
      "2026-08-03T00:08:00Z",
    );
  });
});
