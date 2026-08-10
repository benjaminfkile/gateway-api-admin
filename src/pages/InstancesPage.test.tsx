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
import type { InstanceInfo } from "../api/types";
import InstancesPage, { summarize } from "./InstancesPage";
import { SnackbarProvider } from "../contexts/SnackbarContext";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";
import { installHubMock, type HubMockControl } from "../test/hubClientMock";

const REFRESH_TICK = 30_000;

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

function inst(overrides: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    instanceId: "i-0abc",
    privateIp: "10.0.0.5",
    publicIp: "3.3.3.3",
    gatewayVer: "1.4.0",
    isLeader: false,
    stale: false,
    heartbeatAt: "2026-08-03T00:00:00Z",
    services: [
      {
        name: "web",
        digest: "sha256:abcdef0123456789",
        state: "running",
        startedAt: "2026-08-03T00:00:00Z",
        restarts: 0,
      },
    ],
    ...overrides,
  };
}

const LEADER = inst({ instanceId: "i-leader", isLeader: true, gatewayVer: "1.4.0" });
const FOLLOWER = inst({ instanceId: "i-follower", gatewayVer: "1.4.0" });
const STALE = inst({
  instanceId: "i-stale",
  stale: true,
  gatewayVer: "1.3.0",
  heartbeatAt: "2026-08-02T00:00:00Z",
});
const WITH_ERROR = inst({
  instanceId: "i-error",
  services: [
    {
      name: "web",
      digest: "sha256:abcdef0123456789",
      state: "error",
      startedAt: "2026-08-03T00:00:00Z",
      restarts: 3,
      lastError: "container exited: code 1",
      lastErrorAt: "2026-08-08T00:00:00Z",
    },
  ],
});

function renderPage(children: ReactNode = <InstancesPage />) {
  return render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
}

async function fleetTable(): Promise<HTMLElement> {
  return screen.findByRole("table", { name: "instance fleet" });
}

/** Wait for the table to render an actual data row (not just the skeleton). */
async function loadedTable(anyRow: string): Promise<HTMLElement> {
  const table = await fleetTable();
  await within(table).findByText(anyRow);
  return table;
}

function rowFor(table: HTMLElement, text: string): HTMLElement {
  const cell = within(table).getByText(text);
  const row = cell.closest("tr");
  if (!row) throw new Error(`no row for ${text}`);
  return row;
}

function summaryCard(label: string): HTMLElement {
  const region = screen.getByRole("region", { name: "fleet summary" });
  const heading = within(region).getByText(label);
  const card = heading.closest(".MuiPaper-root");
  if (!card) throw new Error(`no summary card for ${label}`);
  return card as HTMLElement;
}

describe("summarize", () => {
  it("counts totals, leader, stale, and distinct versions", () => {
    const s = summarize([LEADER, FOLLOWER, STALE]);
    expect(s.total).toBe(3);
    expect(s.leaderId).toBe("i-leader");
    expect(s.staleCount).toBe(1);
    expect(s.gatewayVersions).toEqual(["1.3.0", "1.4.0"]);
    expect(s.mixedVersions).toBe(true);
  });

  it("flags a single version as not mixed and reports no leader", () => {
    const s = summarize([FOLLOWER, inst({ instanceId: "i-2" })]);
    expect(s.mixedVersions).toBe(false);
    expect(s.gatewayVersions).toEqual(["1.4.0"]);
    expect(s.leaderId).toBeNull();
  });
});

describe("InstancesPage", () => {
  it("renders a row per instance with the leader badge", async () => {
    mock.onGet("/mgmt/instances").reply(200, [LEADER, FOLLOWER]);
    renderPage();

    const table = await loadedTable("i-leader");
    expect(within(table).getByText("i-follower")).toBeInTheDocument();
    // Only the leader row carries the star badge.
    expect(within(rowFor(table, "i-leader")).getByLabelText("leader")).toBeInTheDocument();
    expect(within(rowFor(table, "i-follower")).queryByLabelText("leader")).toBeNull();
  });

  it("highlights stale instances with a chip", async () => {
    mock.onGet("/mgmt/instances").reply(200, [FOLLOWER, STALE]);
    renderPage();

    const table = await loadedTable("i-stale");
    expect(within(rowFor(table, "i-stale")).getByText("stale")).toBeInTheDocument();
    expect(within(rowFor(table, "i-follower")).queryByText("stale")).toBeNull();
  });

  it("lists services name@digest in the count tooltip", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/instances").reply(200, [FOLLOWER]);
    renderPage();

    const table = await loadedTable("i-follower");
    await user.hover(within(rowFor(table, "i-follower")).getByText("1"));
    expect(await screen.findByText("web@sha256:abcde")).toBeInTheDocument();
  });

  it("surfaces a service's lastError with an icon and in the tooltip", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/instances").reply(200, [WITH_ERROR]);
    renderPage();

    const table = await loadedTable("i-error");
    const row = rowFor(table, "i-error");
    expect(
      within(row).getByLabelText(/1 service with a reconcile error/i),
    ).toBeInTheDocument();

    await user.hover(within(row).getByText("1"));
    expect(
      await screen.findByText(/container exited: code 1/),
    ).toBeInTheDocument();
  });

  it("renders cleanly when services carry no lastError (old gateway)", async () => {
    mock.onGet("/mgmt/instances").reply(200, [FOLLOWER]);
    renderPage();

    const table = await loadedTable("i-follower");
    expect(
      within(rowFor(table, "i-follower")).queryByLabelText(/reconcile error/i),
    ).toBeNull();
  });

  it("computes summary math and warns on mixed gateway versions", async () => {
    mock.onGet("/mgmt/instances").reply(200, [LEADER, FOLLOWER, STALE]);
    renderPage();

    await loadedTable("i-leader");
    expect(within(summaryCard("Instances")).getByText("3")).toBeInTheDocument();
    expect(within(summaryCard("Leader")).getByText("i-leader")).toBeInTheDocument();
    expect(within(summaryCard("Stale")).getByText("1")).toBeInTheDocument();

    const versionsCard = summaryCard("Gateway versions");
    expect(within(versionsCard).getByText("2")).toBeInTheDocument();
    expect(within(versionsCard).getByLabelText("mixed gateway versions")).toBeInTheDocument();
  });

  it("does not warn when all instances share one gateway version", async () => {
    mock.onGet("/mgmt/instances").reply(200, [LEADER, FOLLOWER]);
    renderPage();

    await loadedTable("i-leader");
    const versionsCard = summaryCard("Gateway versions");
    expect(within(versionsCard).getByText("1")).toBeInTheDocument();
    expect(within(versionsCard).queryByLabelText("mixed gateway versions")).toBeNull();
  });

  it("auto-refreshes on a 30s interval", async () => {
    vi.useFakeTimers();
    mock.onGet("/mgmt/instances").reply(200, [FOLLOWER]);
    renderPage();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const listGets = () =>
      mock.history.get.filter((g) => g.url === "/mgmt/instances").length;
    expect(listGets()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_TICK);
    });
    expect(listGets()).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_TICK);
    });
    expect(listGets()).toBe(3);
  });

  it("refetches when a live fleet event arrives and lights the live dot", async () => {
    mock.onGet("/mgmt/instances").reply(200, [FOLLOWER]);
    renderPage();

    await loadedTable("i-follower");
    // Connected but deaf: honest liveness reads offline until an event lands.
    expect(screen.getByLabelText("offline")).toBeInTheDocument();

    const gets = () =>
      mock.history.get.filter((g) => g.url === "/mgmt/instances").length;
    const before = gets();

    // An "instances" (joined/pruned) event refetches — instance rows are too
    // composite to patch — and proves delivery, lighting the dot.
    act(() => hub.emit("ops:fleet", "instances", { joined: [], pruned: [] }));
    await waitFor(() => expect(gets()).toBe(before + 1));
    await screen.findByLabelText("live");
  });

  it("refetches on leaderChange and serviceError, but not on a heartbeat", async () => {
    mock.onGet("/mgmt/instances").reply(200, [FOLLOWER]);
    renderPage();

    await loadedTable("i-follower");
    const gets = () =>
      mock.history.get.filter((g) => g.url === "/mgmt/instances").length;

    let before = gets();
    act(() => hub.emit("ops:fleet", "leaderChange", { instanceId: "i-x" }));
    await waitFor(() => expect(gets()).toBe(before + 1));

    before = gets();
    act(() =>
      hub.emit("ops:fleet", "serviceError", {
        service: "web",
        instanceId: "i-follower",
        lastError: "boom",
        lastErrorAt: null,
      }),
    );
    await waitFor(() => expect(gets()).toBe(before + 1));

    // A heartbeat only proves liveness — it must not trigger a refetch.
    before = gets();
    act(() =>
      hub.emit("ops:fleet", "heartbeat", {
        ts: "2026-08-10T00:00:00Z",
        leaderInstanceId: "i-follower",
        instanceCount: 1,
      }),
    );
    expect(gets()).toBe(before);
    await screen.findByLabelText("live");
  });

  it("shows an error state with retry that recovers", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/instances").replyOnce(500);
    mock.onGet("/mgmt/instances").reply(200, [FOLLOWER]);
    renderPage();

    const retry = await screen.findByRole("button", { name: /retry/i });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.click(retry);
    const table = await fleetTable();
    await waitFor(() =>
      expect(within(table).getByText("i-follower")).toBeInTheDocument(),
    );
  });
});
