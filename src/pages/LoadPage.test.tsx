import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import * as hubClient from "../lib/hubClient";
vi.mock("../lib/hubClient");

import apiClient from "../api/apiClient";
import LoadPage, { applyLoadRunEvent, newRunPath } from "./LoadPage";
import { SnackbarProvider } from "../contexts/SnackbarContext";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";
import { installHubMock, type HubMockControl } from "../test/hubClientMock";
import { loadRun, loadScenario } from "../test/loadFixtures";

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

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderPage(path = "/load") {
  return render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/load" element={<LoadPage />} />
            <Route path="/load/scenarios" element={<LoadPage />} />
            <Route path="*" element={<div />} />
          </Routes>
          <LocationProbe />
        </MemoryRouter>
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
}

const FINISHED = loadRun();
const ACTIVE = loadRun({
  id: 6,
  status: "holding",
  finishedAt: null,
  verdict: null,
  peaks: {},
});

describe("helpers", () => {
  it("newRunPath prefills a validation run", () => {
    expect(newRunPath()).toBe("/load/runs/new");
    expect(newRunPath({ scenario: "sample-scenario", validation: true })).toBe(
      "/load/runs/new?scenario=sample-scenario&validation=1",
    );
  });

  it("applyLoadRunEvent patches a listed run and adds a newer one", () => {
    const patched = applyLoadRunEvent([ACTIVE, FINISHED], { runId: 6, status: "draining" });
    expect(patched[0].status).toBe("draining");
    const added = applyLoadRunEvent([ACTIVE], { runId: 8, status: "queued", scenario: "s" });
    expect(added.map((r) => r.id)).toEqual([8, 6]);
  });
});

describe("LoadPage runs", () => {
  it("lists runs with totals, peak event lag p(95) and verdict", async () => {
    mock.onGet("/mgmt/load/runs").reply(200, [ACTIVE, FINISHED]);
    renderPage();
    const table = await screen.findByRole("table", { name: "load runs" });
    const finished = await within(table).findByTestId("load-run-5");
    expect(within(finished).getByText("2 x 250 = 500")).toBeInTheDocument();
    expect(within(finished).getByText("42.5 ms")).toBeInTheDocument();
    expect(within(finished).getByText("held fine")).toBeInTheDocument();
    expect(within(finished).getByText("16m 0s")).toBeInTheDocument();
    const active = within(table).getByTestId("load-run-6");
    expect(within(active).getByLabelText("run in progress")).toBeInTheDocument();
    expect(within(active).getByLabelText("stop run 6")).toBeInTheDocument();
    expect(within(active).queryByLabelText("delete run 6")).toBeNull();
    expect(within(finished).getByLabelText("delete run 5")).toBeInTheDocument();
  });

  it("applies live run events", async () => {
    mock.onGet("/mgmt/load/runs").reply(200, [ACTIVE]);
    renderPage();
    const row = await screen.findByTestId("load-run-6");
    await waitFor(() => expect(hubClient.joinChannel).toHaveBeenCalledWith("ops:load"));
    act(() => hub.emit("ops:load", "run", { runId: 6, status: "succeeded", finishedAt: "2026-10-01T00:20:00Z" }));
    await waitFor(() => expect(within(row).getByText("succeeded")).toBeInTheDocument());
  });

  it("stops an active run after confirming", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/load/runs").reply(200, [ACTIVE]);
    mock.onPost("/mgmt/load/runs/6/stop").reply(202);
    renderPage();
    await user.click(await screen.findByLabelText("stop run 6"));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Stop run" }));
    await waitFor(() => expect(mock.history.post).toHaveLength(1));
  });

  it("deletes a terminal run after confirming", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/load/runs").reply(200, [FINISHED]);
    mock.onDelete("/mgmt/load/runs/5").reply(204);
    renderPage();
    await user.click(await screen.findByLabelText("delete run 5"));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mock.history.delete).toHaveLength(1));
  });

  it("Validate opens the run form prefilled for a validation run", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/load/runs").reply(200, []);
    renderPage();
    await screen.findByText(/No load runs yet/);
    await user.click(screen.getByRole("button", { name: "Validate" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/load/runs/new?validation=1");
  });
});

describe("LoadPage scenarios", () => {
  it("lists scenarios with commit short and validated chip", async () => {
    mock.onGet("/mgmt/load/scenarios").reply(200, [
      loadScenario(),
      loadScenario({ name: "other-scenario", validated: false, commitSha: null }),
    ]);
    renderPage("/load/scenarios");
    const table = await screen.findByRole("table", { name: "load scenarios" });
    await within(table).findByText("other-scenario");
    expect(within(table).getByText("0123456")).toBeInTheDocument();
    expect(within(table).getByText("validated")).toBeInTheDocument();
    expect(within(table).getByText("not validated")).toBeInTheDocument();
  });

  it("edits a scenario and sends only the changed fields", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/load/scenarios").reply(200, [loadScenario()]);
    mock.onGet("/mgmt/load/scenarios/sample-scenario").reply(200, { ...loadScenario(), script: "export default function () {}" });
    mock.onPut("/mgmt/load/scenarios/sample-scenario").reply(200, loadScenario());
    renderPage("/load/scenarios");
    await user.click(await screen.findByLabelText("edit sample-scenario"));
    const dialog = await screen.findByRole("dialog");
    const max = await within(dialog).findByLabelText("Max users per generator");
    await user.clear(max);
    await user.type(max, "800");
    await user.type(within(dialog).getByLabelText("Params default value 1"), "0");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mock.history.put).toHaveLength(1));
    expect(JSON.parse(mock.history.put[0].data)).toEqual({
      maxVusPerGenerator: 800,
      paramsDefault: { rate: "100" },
    });
  });

  it("Validate on a scenario opens the prefilled form and Delete confirms", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/load/scenarios").reply(200, [loadScenario()]);
    mock.onDelete("/mgmt/load/scenarios/sample-scenario").reply(204);
    renderPage("/load/scenarios");
    await user.click(await screen.findByLabelText("delete sample-scenario"));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mock.history.delete).toHaveLength(1));
    await user.click(screen.getByLabelText("validate sample-scenario"));
    expect(screen.getByTestId("location")).toHaveTextContent(
      "/load/runs/new?scenario=sample-scenario&validation=1",
    );
  });
});
