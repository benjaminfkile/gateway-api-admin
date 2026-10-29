import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import * as hubClient from "../lib/hubClient";
vi.mock("../lib/hubClient");

import apiClient from "../api/apiClient";
import type { ResourceAuditEntry, ResourcesState } from "../api/types";
import ResourcesPage, {
  lockReason,
  previousTemplateVersion,
  templateVersionFrom,
} from "./ResourcesPage";
import { SnackbarProvider } from "../contexts/SnackbarContext";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";
import { installHubMock, type HubMockControl } from "../test/hubClientMock";
import { loadRun } from "../test/loadFixtures";

let mock: MockAdapter;
let hub: HubMockControl;

function resources(overrides: Partial<ResourcesState> = {}): ResourcesState {
  return {
    runActive: false,
    fleet: {
      group: "fleet-group",
      min: 2,
      desired: 2,
      max: 4,
      inService: 2,
      instanceClass: "class-small",
      templateVersion: "7",
      refreshInProgress: false,
      classes: ["class-small", "class-large"],
      maxSize: 50,
      error: null,
    },
    generators: { group: "generator-group", desired: 0, inService: 0, max: 2, error: null },
    cache: {
      id: "sample-cache",
      nodeType: "cache-small",
      status: "available",
      nodeTypes: ["cache-small", "cache-large"],
      error: null,
    },
    database: null,
    ...overrides,
  };
}

const DATABASE: ResourcesState["database"] = {
  id: "sample-db",
  instanceClass: "db-small",
  status: "available",
  maxConnections: 400,
  connectionsInUse: 50,
  documentedMaxConnections: 400,
  classes: ["db-small", "db-large"],
  error: null,
};

const AUDIT: ResourceAuditEntry[] = [
  {
    id: 3,
    at: "2026-10-01T00:00:00Z",
    actor: "alice",
    resource: "fleet",
    action: "class",
    before: "6",
    after: "7",
    detail: null,
  },
];

function setup(state: ResourcesState, options: { runs?: unknown[]; refresh?: unknown } = {}) {
  mock.onGet("/mgmt/resources").reply(200, state);
  mock.onGet("/mgmt/load/runs").reply(200, options.runs ?? []);
  mock.onGet("/mgmt/resources/fleet/refresh").reply(200, options.refresh ?? null);
  mock.onGet("/mgmt/resources/audit").reply(200, AUDIT);
}

beforeEach(() => {
  mock = new MockAdapter(apiClient);
  hub = installHubMock(hubClient);
});

afterEach(() => {
  mock.restore();
  vi.clearAllMocks();
});

function renderPage() {
  return render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <MemoryRouter>
          <ResourcesPage />
        </MemoryRouter>
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
}

async function chooseOption(user: ReturnType<typeof userEvent.setup>, label: string, option: string) {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("helpers", () => {
  it("reads a template version from plain, JSON or text values", () => {
    expect(templateVersionFrom("6")).toBe("6");
    expect(templateVersionFrom('{"templateVersion":"5"}')).toBe("5");
    expect(templateVersionFrom("class-small (template version 4)")).toBe("4");
    expect(templateVersionFrom(null)).toBeNull();
    expect(previousTemplateVersion(AUDIT)).toBe("6");
    expect(previousTemplateVersion([])).toBeNull();
  });

  it("locks on an active run or a refresh in flight", () => {
    expect(lockReason(resources(), [loadRun({ id: 4, status: "ramping" })], null)).toBe(
      "Load run 4 is ramping",
    );
    expect(lockReason(resources(), [], { status: "InProgress", percentComplete: 10 })).toMatch(
      /refresh/,
    );
    expect(lockReason(resources(), [loadRun()], null)).toBeNull();
  });
});

describe("ResourcesPage", () => {
  it("renders the four cards and says not configured for a null block", async () => {
    setup(resources());
    renderPage();
    const fleet = await screen.findByRole("region", { name: "Fleet" });
    expect(within(fleet).getByText("2 / 2 / 4")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Generators" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Cache" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Database" })).getByText("not configured"),
    ).toBeInTheDocument();
    expect(await screen.findByRole("table", { name: "resource audit" })).toBeInTheDocument();
    expect(await screen.findByText("Previous template version 6")).toBeInTheDocument();
  });

  it("applies a fleet size", async () => {
    const user = userEvent.setup();
    setup(resources());
    mock.onPut("/mgmt/resources/fleet/size").reply(202, {});
    renderPage();
    const size = await screen.findByLabelText("Fleet size");
    await waitFor(() => expect(size).toHaveValue(2));
    await user.clear(size);
    await user.type(size, "4");
    await user.click(screen.getByRole("button", { name: "Apply size" }));
    await waitFor(() => expect(mock.history.put).toHaveLength(1));
    expect(JSON.parse(mock.history.put[0].data)).toEqual({ size: 4 });
  });

  it("changes the fleet class after a confirm that says every node is replaced", async () => {
    const user = userEvent.setup();
    setup(resources());
    mock.onPut("/mgmt/resources/fleet/class").reply(202, { templateVersion: 8, refreshId: "r-1" });
    renderPage();
    await screen.findByRole("region", { name: "Fleet" });
    await chooseOption(user, "Fleet class", "class-large");
    await user.click(screen.getByRole("button", { name: "Apply class" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Every node is replaced one at a time/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Replace nodes" }));
    await waitFor(() => expect(mock.history.put).toHaveLength(1));
    expect(JSON.parse(mock.history.put[0].data)).toEqual({ instanceClass: "class-large" });
  });

  it("rolls back to the previous template version from the audit", async () => {
    const user = userEvent.setup();
    setup(resources());
    mock.onPut("/mgmt/resources/fleet/class/rollback").reply(202, {});
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Rollback" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Roll back" }));
    await waitFor(() => expect(mock.history.put).toHaveLength(1));
    expect(JSON.parse(mock.history.put[0].data)).toEqual({ templateVersion: "6" });
  });

  it("changes the cache node type after a confirm quoting the note", async () => {
    const user = userEvent.setup();
    setup(resources());
    mock.onPut("/mgmt/resources/cache/node-type").reply(202, { note: "publishes dropped" });
    renderPage();
    await screen.findByRole("region", { name: "Cache" });
    await chooseOption(user, "Node type", "cache-large");
    await user.click(screen.getByRole("button", { name: "Apply node type" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/publishes are dropped while it is degraded/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Change node type" }));
    await waitFor(() => expect(mock.history.put).toHaveLength(1));
    expect(JSON.parse(mock.history.put[0].data)).toEqual({ nodeType: "cache-large" });
  });

  it("changes the database class only with the typed identifier, listing the services", async () => {
    const user = userEvent.setup();
    setup(resources({ database: DATABASE }));
    mock.onGet("/mgmt/services").reply(200, [{ name: "svc-one" }, { name: "svc-two" }]);
    mock
      .onPut("/mgmt/resources/database/class")
      .reply(202, { services: ["svc-one", "svc-two"], note: "the database reboots" });
    renderPage();
    await screen.findByRole("region", { name: "Database" });
    await chooseOption(user, "Database class", "db-large");
    const apply = within(screen.getByRole("region", { name: "Database" })).getByRole("button", {
      name: "Apply class",
    });
    expect(apply).toBeDisabled();
    await user.type(screen.getByLabelText("Instance identifier"), "sample-d");
    expect(apply).toBeDisabled();
    await user.type(screen.getByLabelText("Instance identifier"), "b");
    expect(apply).toBeEnabled();
    await user.click(apply);
    const dialog = await screen.findByRole("dialog");
    const list = await within(dialog).findByRole("list", { name: "affected services" });
    expect(within(list).getByText("svc-one")).toBeInTheDocument();
    expect(within(dialog).getByText(/database reboots/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Change class" }));
    await waitFor(() => expect(mock.history.put).toHaveLength(1));
    expect(JSON.parse(mock.history.put[0].data)).toEqual({
      instanceClass: "db-large",
      confirm: "sample-db",
    });
  });

  it("disables every control with a reason while a load run is active", async () => {
    setup(resources({ database: DATABASE }), { runs: [loadRun({ id: 4, status: "holding", finishedAt: null })] });
    renderPage();
    expect(await screen.findByTestId("lock-reason")).toHaveTextContent("Load run 4 is holding");
    expect(screen.getByLabelText("Fleet size")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply size" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply node type" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rollback" })).toBeDisabled();
    expect(screen.getByLabelText("Instance identifier")).toBeDisabled();
  });

  it("shows refresh progress, locks during it and follows refresh events", async () => {
    setup(resources(), { refresh: { status: "InProgress", percentComplete: 20, inProgress: true } });
    renderPage();
    const progress = await screen.findByTestId("refresh-progress");
    expect(progress).toHaveTextContent("Instance refresh InProgress, 20%");
    expect(screen.getByTestId("lock-reason")).toHaveTextContent(/refresh is in progress/);
    await waitFor(() => expect(hubClient.joinChannel).toHaveBeenCalledWith("ops:resources"));
    act(() => hub.emit("ops:resources", "refresh", { refreshId: "r-1", status: "Successful", percentComplete: 100 }));
    await waitFor(() =>
      expect(screen.getByTestId("refresh-progress")).toHaveTextContent("Instance refresh Successful, 100%"),
    );
    await waitFor(() => expect(screen.queryByTestId("lock-reason")).toBeNull());
  });
});
