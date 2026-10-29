import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import * as hubClient from "../lib/hubClient";
vi.mock("../lib/hubClient");

const terminal = {
  open: vi.fn(),
  writeln: vi.fn(),
  clear: vi.fn(),
  fit: vi.fn(),
  setTheme: vi.fn(),
  dispose: vi.fn(),
};
vi.mock("../lib/terminal", () => ({
  createTerminal: vi.fn(() => terminal),
  themeFromPalette: vi.fn(() => ({})),
}));

import apiClient from "../api/apiClient";
import type { GeneratorStatsBody, LoadStatRow } from "../api/types";
import LoadRunPage from "./LoadRunPage";
import { SnackbarProvider } from "../contexts/SnackbarContext";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";
import { installHubMock, type HubMockControl } from "../test/hubClientMock";
import { loadRunDetail } from "../test/loadFixtures";

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

function generatorRow(index: number, at: string, vus: number, count: number, p95: number): LoadStatRow {
  const body: GeneratorStatsBody = {
    runId: 5,
    index,
    at,
    vus,
    metrics: {
      ws_msgs_sent: { type: "counter", count, rate: count / 5 },
      event_lag_ms: { type: "trend", avg: p95 / 2, "p(90)": p95 - 2, "p(95)": p95 },
      vus: { type: "gauge", value: vus },
    },
  };
  return { id: index + 1, source: "generator", index, at, body };
}

const GENERATOR_ROWS: LoadStatRow[] = [
  generatorRow(0, "2026-10-01T00:16:00Z", 250, 1000, 30),
  generatorRow(1, "2026-10-01T00:16:00Z", 240, 900, 45),
];

const FLEET_ROWS: LoadStatRow[] = [
  {
    id: 9,
    source: "fleet",
    index: null,
    at: "2026-10-01T00:16:00Z",
    body: {
      at: "2026-10-01T00:16:00Z",
      instances: [
        { instanceId: "node-a", leader: true, cpu: 55.5, memory: 40, disk: 20, hubConnections: 260 },
        { instanceId: "node-b", leader: false, cpu: 50, memory: 38, disk: 20, hubConnections: 230 },
      ],
      channelMembers: 490,
    },
  },
];

function mockStats() {
  mock.onGet("/mgmt/load/runs/5/stats").reply((config) => [
    200,
    config.params?.source === "fleet" ? FLEET_ROWS : GENERATOR_ROWS,
  ]);
}

function renderRun() {
  return render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <MemoryRouter initialEntries={["/load/runs/5"]}>
          <Routes>
            <Route path="/load/runs/:id" element={<LoadRunPage />} />
          </Routes>
        </MemoryRouter>
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
}

function tileValues(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tile of screen.getAllByTestId("metric-tile")) {
    const [label, value] = Array.from(tile.children).map((c) => c.textContent ?? "");
    out[label] = value;
  }
  return out;
}

describe("LoadRunPage", () => {
  it("renders tiles from the newest line per generator, the fleet panel and the timeline", async () => {
    mock.onGet("/mgmt/load/runs/5").reply(200, loadRunDetail());
    mockStats();
    renderRun();
    await waitFor(() => expect(screen.getAllByTestId("metric-tile").length).toBe(3));
    expect(tileValues()).toEqual({
      "total users": "490",
      "ws_msgs_sent count": "1,900",
      "event_lag_ms p(95)": "45",
    });
    const fleet = screen.getByRole("region", { name: "fleet" });
    expect(within(fleet).getByText("node-a")).toBeInTheDocument();
    expect(within(fleet).getByText("leader")).toBeInTheDocument();
    expect(within(fleet).getByText("55.5%")).toBeInTheDocument();
    expect(within(fleet).getByText(/channel members 490/)).toBeInTheDocument();
    const timeline = screen.getByRole("region", { name: "timeline" });
    expect(within(timeline).getByText("queued by alice")).toBeInTheDocument();
    expect(within(timeline).getByText(/hold complete/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Users" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "event_lag_ms p(95)" })).toBeInTheDocument();
    // The chart read is downsampled with a step.
    const chartRead = mock.history.get.find((r) => r.params?.step !== undefined);
    expect(chartRead?.params).toMatchObject({ source: "generator", step: 5 });
    // A terminal run has no Stop button.
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
  });

  it("builds tiles for whatever metric names arrive in a live stats event", async () => {
    mock.onGet("/mgmt/load/runs/5").reply(
      200,
      loadRunDetail({ status: "holding", finishedAt: null, verdict: null }),
    );
    mock.onGet("/mgmt/load/runs/5/stats").reply(200, []);
    renderRun();
    await screen.findByText(/Load run 5/);
    await waitFor(() => expect(hubClient.joinChannel).toHaveBeenCalledWith("ops:load"));
    act(() =>
      hub.emit("ops:load", "stats", {
        runId: 5,
        at: "2026-10-01T00:10:00Z",
        aggregate: {
          at: "2026-10-01T00:10:00Z",
          vus: 120,
          metrics: {
            custom_events: { type: "counter", count: 77 },
            join_ms: { type: "trend", "p(90)": 8, "p(95)": 9.25 },
          },
        },
      }),
    );
    await waitFor(() =>
      expect(tileValues()).toEqual({
        "total users": "120",
        "custom_events count": "77",
        "join_ms p(95)": "9.25",
      }),
    );
    // Events for another run are ignored.
    act(() => hub.emit("ops:load", "stats", { runId: 99, aggregate: { at: "x", vus: 1, metrics: {} } }));
    expect(tileValues()["total users"]).toBe("120");
  });

  it("shows the checked-in count during generators_up and stops after confirming", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/load/runs/5").reply(
      200,
      loadRunDetail({ status: "generators_up", checkedIn: 1, finishedAt: null }),
    );
    mock.onGet("/mgmt/load/runs/5/stats").reply(200, []);
    mock.onPost("/mgmt/load/runs/5/stop").reply(202);
    renderRun();
    expect(await screen.findByTestId("checked-in")).toHaveTextContent("checked in 1 of 2");
    expect(screen.queryByLabelText("Verdict")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Stop" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop run" }));
    await waitFor(() => expect(mock.history.post).toHaveLength(1));
  });

  it("saves the verdict of a terminal run", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/load/runs/5").reply(200, loadRunDetail());
    mockStats();
    mock.onPut("/mgmt/load/runs/5/verdict").reply(200, loadRunDetail());
    renderRun();
    const field = await screen.findByLabelText("Verdict");
    expect(field).toHaveValue("held fine");
    await user.clear(field);
    await user.type(field, "lag stayed low");
    await user.click(screen.getByRole("button", { name: "Save verdict" }));
    await waitFor(() => expect(mock.history.put).toHaveLength(1));
    expect(JSON.parse(mock.history.put[0].data)).toEqual({ verdict: "lag stayed low" });
  });

  it("opens a generator log in the terminal and exports the CSV", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => "blob:placeholder");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    mock.onGet("/mgmt/load/runs/5").reply(200, loadRunDetail());
    mockStats();
    mock.onGet("/mgmt/load/runs/5/log").reply(200, [{ ts: "2026-10-01T00:00:01Z", message: "k6 started" }]);
    mock.onGet("/mgmt/load/runs/5/stats.csv").reply(200, "at,vus\n");
    renderRun();

    await user.click(await screen.findByRole("button", { name: "Logs 1" }));
    await waitFor(() =>
      expect(terminal.writeln).toHaveBeenCalledWith("2026-10-01T00:00:01Z k6 started"),
    );
    const logRead = mock.history.get.find((r) => r.url === "/mgmt/load/runs/5/log");
    expect(logRead?.params).toEqual({ index: 1, tail: 500 });
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(createObjectURL).toHaveBeenCalled();
    click.mockRestore();
  });
});
