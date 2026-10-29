import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import * as hubClient from "../lib/hubClient";
vi.mock("../lib/hubClient");

import apiClient from "../api/apiClient";
import LoadBanner, { bannerText } from "./LoadBanner";
import { SnackbarProvider } from "../contexts/SnackbarContext";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";
import { installHubMock, type HubMockControl } from "../test/hubClientMock";
import { loadRun } from "../test/loadFixtures";

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

function generators(desired: number) {
  return { fleet: null, cache: null, database: null, generators: { group: "g", desired, inService: desired, max: 2 } };
}

function renderBanner() {
  return render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <LoadBanner />
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
}

const ACTIVE = loadRun({ id: 6, status: "ramping", finishedAt: null });

describe("LoadBanner", () => {
  it("is hidden when no run is active and the generators are at zero", async () => {
    mock.onGet("/mgmt/load/runs").reply(200, [loadRun()]);
    mock.onGet("/mgmt/resources").reply(200, generators(0));
    renderBanner();
    await waitFor(() => expect(mock.history.get).toHaveLength(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows an active run with Stop, which confirms and posts", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/load/runs").reply(200, [ACTIVE]);
    mock.onGet("/mgmt/resources").reply(200, generators(2));
    mock.onPost("/mgmt/load/runs/6/stop").reply(202);
    renderBanner();
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(bannerText(ACTIVE));
    expect(banner).toHaveTextContent(/Load run 6 ramping, generators 2, hard stop/);
    await user.click(within(banner).getByRole("button", { name: "Stop" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Stop run" }));
    await waitFor(() => expect(mock.history.post).toHaveLength(1));
  });

  it("warns about generators above zero with no run", async () => {
    mock.onGet("/mgmt/load/runs").reply(200, []);
    mock.onGet("/mgmt/resources").reply(200, generators(1));
    renderBanner();
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("Generators above zero with no run");
    expect(within(banner).queryByRole("button")).toBeNull();
  });

  it("appears on a run event and hides when the run ends", async () => {
    let runs = [loadRun()];
    mock.onGet("/mgmt/load/runs").reply(() => [200, runs]);
    mock.onGet("/mgmt/resources").reply(200, generators(0));
    renderBanner();
    await waitFor(() => expect(hubClient.joinChannel).toHaveBeenCalledWith("ops:load"));
    runs = [ACTIVE];
    act(() => hub.emit("ops:load", "run", { runId: 6, status: "ramping" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Load run 6 ramping");
    runs = [{ ...ACTIVE, status: "succeeded" }];
    act(() => hub.emit("ops:load", "run", { runId: 6, status: "succeeded" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
