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
import NodeStatsPage, { serviceStateColor } from "./NodeStatsPage";
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
const CRASHY = inst({
  instanceId: "i-crashy",
  gatewayVer: "1.3.0",
  stale: true,
  heartbeatAt: "2026-08-02T00:00:00Z",
  services: [
    {
      name: "worker",
      digest: "sha256:deadbeefcafe0000",
      state: "restarting",
      startedAt: "2026-08-03T00:00:00Z",
      restarts: 4,
    },
    {
      name: "web",
      digest: "sha256:abcdef0123456789",
      state: "running",
      startedAt: "2026-08-03T00:00:00Z",
      restarts: 0,
    },
  ],
});

function renderPage(children: ReactNode = <NodeStatsPage />) {
  return render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
}

/** Wait for the card grid to render an instance card (past the skeleton). */
async function loadedGrid(anyInstance: string): Promise<HTMLElement> {
  const grid = await screen.findByRole("list", { name: "instance node stats" });
  await within(grid).findByLabelText(`instance ${anyInstance}`);
  return grid;
}

function cardFor(grid: HTMLElement, instanceId: string): HTMLElement {
  return within(grid).getByLabelText(`instance ${instanceId}`);
}

function summaryCard(label: string): HTMLElement {
  const region = screen.getByRole("region", { name: "fleet summary" });
  const heading = within(region).getByText(label);
  const card = heading.closest(".MuiPaper-root");
  if (!card) throw new Error(`no summary card for ${label}`);
  return card as HTMLElement;
}

describe("serviceStateColor", () => {
  it("maps container states onto chip colours", () => {
    expect(serviceStateColor("running")).toBe("success");
    expect(serviceStateColor("restarting")).toBe("warning");
    expect(serviceStateColor("exited")).toBe("error");
    expect(serviceStateColor("something-else")).toBe("default");
  });
});

describe("NodeStatsPage", () => {
  it("renders one card per instance with a leader badge", async () => {
    mock.onGet("/mgmt/instances").reply(200, [LEADER, FOLLOWER]);
    renderPage();

    const grid = await loadedGrid("i-leader");
    expect(cardFor(grid, "i-follower")).toBeInTheDocument();
    // Only the leader card carries the star badge.
    expect(within(cardFor(grid, "i-leader")).getByLabelText("leader")).toBeInTheDocument();
    expect(within(cardFor(grid, "i-follower")).queryByLabelText("leader")).toBeNull();
  });

  it("shows the gateway version and per-service detail on each card", async () => {
    mock.onGet("/mgmt/instances").reply(200, [FOLLOWER]);
    renderPage();

    const grid = await loadedGrid("i-follower");
    const card = cardFor(grid, "i-follower");
    expect(within(card).getByText("gw 1.4.0")).toBeInTheDocument();
    expect(within(card).getByLabelText("service web")).toBeInTheDocument();
    expect(within(card).getByText("running")).toBeInTheDocument();
    expect(within(card).getByText("sha256:abcde")).toBeInTheDocument();
  });

  it("highlights services with a positive restart count", async () => {
    mock.onGet("/mgmt/instances").reply(200, [CRASHY]);
    renderPage();

    const grid = await loadedGrid("i-crashy");
    const card = cardFor(grid, "i-crashy");

    const crashed = within(card).getByLabelText("restarts 4");
    const healthy = within(card).getByLabelText("restarts 0");
    expect(crashed).toHaveTextContent("↻4");
    // The crashy service is emphasised (amber); the healthy one is not.
    expect(crashed).toHaveClass("restart-warn");
    expect(healthy).not.toHaveClass("restart-warn");
  });

  it("marks a stale instance and renders a responsive grid", async () => {
    mock.onGet("/mgmt/instances").reply(200, [FOLLOWER, CRASHY]);
    renderPage();

    const grid = await loadedGrid("i-crashy");
    expect(grid).toHaveClass("node-stats-grid");
    expect(within(cardFor(grid, "i-crashy")).getByText("stale")).toBeInTheDocument();
    expect(within(cardFor(grid, "i-follower")).queryByText("stale")).toBeNull();
  });

  it("reuses the fleet totals in the summary row", async () => {
    mock.onGet("/mgmt/instances").reply(200, [LEADER, FOLLOWER, CRASHY]);
    renderPage();

    await loadedGrid("i-leader");
    expect(within(summaryCard("Instances")).getByText("3")).toBeInTheDocument();
    expect(within(summaryCard("Stale")).getByText("1")).toBeInTheDocument();

    const versionsCard = summaryCard("Gateway versions");
    expect(within(versionsCard).getByText("2")).toBeInTheDocument();
    expect(within(versionsCard).getByLabelText("mixed gateway versions")).toBeInTheDocument();
  });

  it("auto-refreshes on a 30s interval", async () => {
    vi.useFakeTimers();
    mock.onGet("/mgmt/instances").reply(200, [FOLLOWER]);
    renderPage();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const gets = () =>
      mock.history.get.filter((g) => g.url === "/mgmt/instances").length;
    expect(gets()).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_TICK);
    });
    expect(gets()).toBe(2);
  });

  it("refetches when a live fleet event arrives and lights the live dot", async () => {
    mock.onGet("/mgmt/instances").reply(200, [FOLLOWER]);
    renderPage();

    await loadedGrid("i-follower");
    // Connected but deaf: honest liveness reads offline until an event lands.
    expect(screen.getByLabelText("offline")).toBeInTheDocument();

    const gets = () =>
      mock.history.get.filter((g) => g.url === "/mgmt/instances").length;
    const before = gets();

    act(() => hub.emit("ops:fleet", "instances", { joined: [], pruned: [] }));
    await waitFor(() => expect(gets()).toBe(before + 1));
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
    const grid = await screen.findByRole("list", { name: "instance node stats" });
    await waitFor(() =>
      expect(within(grid).getByLabelText("instance i-follower")).toBeInTheDocument(),
    );
  });
});
