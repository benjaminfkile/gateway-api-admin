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
import type { ServiceSummary } from "../api/types";
import ServicesPage from "./ServicesPage";
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
  vi.useRealTimers();
});

function svc(overrides: Partial<ServiceSummary> = {}): ServiceSummary {
  return {
    name: "web",
    image: "registry/web",
    tag: "v1.2.3",
    digest: "sha256:abcdef0123456789",
    port: 8080,
    hostPort: 49213,
    desiredStatus: "running",
    includeInHealth: true,
    updatedBy: "alice",
    updatedAt: "2026-08-03T00:00:00Z",
    fleet: { runningOn: 3, totalInstances: 3, digests: { "sha256:abcdef0123456789": 3 } },
    ...overrides,
  };
}

const RUNNING = svc({ name: "web" });
const STOPPED = svc({
  name: "worker",
  includeInHealth: false,
  hostPort: null,
  fleet: { runningOn: 0, totalInstances: 2, digests: {} },
});
const PARTIAL = svc({
  name: "cache",
  includeInHealth: false,
  fleet: {
    runningOn: 2,
    totalInstances: 3,
    digests: { "sha256:aaaaaaaaaaaa": 1, "sha256:bbbbbbbbbbbb": 1 },
  },
});
const ERRORED = svc({
  name: "api",
  fleet: {
    runningOn: 3,
    totalInstances: 3,
    digests: { "sha256:abcdef0123456789": 3 },
    errorOn: 2,
    latestError: {
      instanceId: "i-0badcafe",
      message: "image pull failed: unauthorized",
      at: "2026-08-08T00:00:00Z",
    },
  },
});

function renderPage(children: ReactNode = <ServicesPage />) {
  return render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
}

function rowFor(name: string): HTMLElement {
  const cell = screen.getByText(name);
  const row = cell.closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe("ServicesPage", () => {
  it("renders a row per service from the mocked api", async () => {
    mock.onGet("/mgmt/services").reply(200, [RUNNING, STOPPED, PARTIAL]);
    renderPage();

    expect(await screen.findByText("web")).toBeInTheDocument();
    expect(screen.getByText("worker")).toBeInTheDocument();
    expect(screen.getByText("cache")).toBeInTheDocument();
  });

  it("computes the status chip incl. partial", async () => {
    mock.onGet("/mgmt/services").reply(200, [RUNNING, STOPPED, PARTIAL]);
    renderPage();

    await screen.findByText("web");
    expect(within(rowFor("web")).getByText("running")).toBeInTheDocument();
    expect(within(rowFor("worker")).getByText("stopped")).toBeInTheDocument();
    expect(within(rowFor("cache")).getByText("partial")).toBeInTheDocument();
  });

  it("flags digest drift when multiple digests are running", async () => {
    mock.onGet("/mgmt/services").reply(200, [RUNNING, PARTIAL]);
    renderPage();

    await screen.findByText("cache");
    expect(within(rowFor("cache")).getByLabelText("digest drift")).toBeInTheDocument();
    expect(within(rowFor("web")).queryByLabelText("digest drift")).toBeNull();
  });

  it("shows the container port with its host port, dashing when unbound", async () => {
    mock.onGet("/mgmt/services").reply(200, [RUNNING, STOPPED]);
    renderPage();

    await screen.findByText("web");
    expect(within(rowFor("web")).getByText("→ host 49213")).toBeInTheDocument();
    expect(within(rowFor("worker")).getByText("→ host —")).toBeInTheDocument();
  });

  it("shows a reconcile-error indicator only when errorOn > 0", async () => {
    mock.onGet("/mgmt/services").reply(200, [RUNNING, ERRORED]);
    renderPage();

    await screen.findByText("api");
    expect(
      within(rowFor("api")).getByLabelText(/reconcile error on 2 instances/i),
    ).toBeInTheDocument();
    // A clean fleet (and old-gateway fixtures without the field) render no icon.
    expect(
      within(rowFor("web")).queryByLabelText(/reconcile error/i),
    ).toBeNull();
  });

  it("shows the latest error details in the indicator tooltip", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/services").reply(200, [ERRORED]);
    renderPage();

    await screen.findByText("api");
    await user.hover(
      within(rowFor("api")).getByLabelText(/reconcile error on 2 instances/i),
    );
    expect(
      await screen.findByText("image pull failed: unauthorized"),
    ).toBeInTheDocument();
    expect(screen.getByText(/i-0badcafe/)).toBeInTheDocument();
  });

  it("confirm flow fires the correct api call", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/services").reply(200, [PARTIAL]);
    mock.onPost("/mgmt/services/cache/restart").reply(204);
    renderPage();

    await screen.findByText("cache");
    await user.click(screen.getByLabelText("actions for cache"));
    await user.click(await screen.findByRole("menuitem", { name: /restart/i }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /restart/i }));

    await waitFor(() => {
      expect(mock.history.post).toHaveLength(1);
    });
    expect(mock.history.post[0].url).toBe("/mgmt/services/cache/restart");
  });

  it("gates a health-critical stop behind the force checkbox", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/services").reply(200, [RUNNING]);
    mock.onPost("/mgmt/services/web/stop").reply(204);
    renderPage();

    await screen.findByText("web");
    await user.click(screen.getByLabelText("actions for web"));
    await user.click(await screen.findByRole("menuitem", { name: /stop/i }));

    const dialog = await screen.findByRole("dialog");
    const confirmBtn = within(dialog).getByRole("button", { name: /force stop/i });
    // Confirm is disabled until the acknowledgement checkbox is ticked.
    expect(confirmBtn).toBeDisabled();

    await user.click(within(dialog).getByRole("checkbox"));
    expect(confirmBtn).toBeEnabled();

    await user.click(confirmBtn);

    await waitFor(() => {
      expect(mock.history.post).toHaveLength(1);
    });
    expect(mock.history.post[0].url).toBe("/mgmt/services/web/stop");
    expect(mock.history.post[0].params).toEqual({ force: true });
  });

  it("stops a non-health-critical service without force", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/services").reply(200, [STOPPED]);
    mock.onPost("/mgmt/services/worker/stop").reply(204);
    renderPage();

    await screen.findByText("worker");
    await user.click(screen.getByLabelText("actions for worker"));
    await user.click(await screen.findByRole("menuitem", { name: /stop/i }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: /^stop$/i }));

    await waitFor(() => {
      expect(mock.history.post).toHaveLength(1);
    });
    expect(mock.history.post[0].url).toBe("/mgmt/services/worker/stop");
    expect(mock.history.post[0].params).toBeUndefined();
  });

  it("refetches on a live fleet event and shows the live dot as fallback-free", async () => {
    mock.onGet("/mgmt/services").reply(200, [RUNNING]);
    renderPage();

    await screen.findByText("web");
    // Hub connected → the "live" dot is lit while polling stays as a fallback.
    await screen.findByLabelText("live");

    const gets = () =>
      mock.history.get.filter((g) => g.url === "/mgmt/services").length;
    const before = gets();

    act(() => hub.emit("ops:fleet", { event: "serviceChanged" }));
    await waitFor(() => expect(gets()).toBe(before + 1));
  });

  it("opens the edit dialog prefilled and PUTs the update", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/services").reply(200, [RUNNING]);
    mock.onPut("/mgmt/services/web").reply(200, {});
    renderPage();

    await screen.findByText("web");
    await user.click(screen.getByLabelText("actions for web"));
    await user.click(await screen.findByRole("menuitem", { name: /edit/i }));

    const dialog = await screen.findByRole("dialog");
    // Prefilled with the current values and a read-only name.
    const name = within(dialog).getByLabelText(/name/i);
    expect(name).toHaveValue("web");
    expect(name).toHaveAttribute("readonly");
    expect(within(dialog).getByLabelText(/image/i)).toHaveValue("registry/web");

    const tag = within(dialog).getByLabelText(/tag/i);
    await user.clear(tag);
    await user.type(tag, "v2");
    await user.click(within(dialog).getByRole("button", { name: /save/i }));

    await waitFor(() => expect(mock.history.put).toHaveLength(1));
    expect(mock.history.put[0].url).toBe("/mgmt/services/web");
    expect(JSON.parse(mock.history.put[0].data).tag).toBe("v2");
  });

  it("removes a service after typing its name to confirm", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/services").reply(200, [STOPPED]);
    mock.onDelete("/mgmt/services/worker").reply(204);
    renderPage();

    await screen.findByText("worker");
    await user.click(screen.getByLabelText("actions for worker"));
    await user.click(await screen.findByRole("menuitem", { name: /remove/i }));

    const dialog = await screen.findByRole("dialog");
    const confirmBtn = within(dialog).getByRole("button", { name: /^remove$/i });
    expect(confirmBtn).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/service name/i), "worker");
    expect(confirmBtn).toBeEnabled();
    await user.click(confirmBtn);

    await waitFor(() => expect(mock.history.delete).toHaveLength(1));
    expect(mock.history.delete[0].url).toBe("/mgmt/services/worker");
    expect(mock.history.delete[0].params).toBeUndefined();
  });

  it("renders an error state with retry that recovers", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/services").replyOnce(500);
    mock.onGet("/mgmt/services").reply(200, [RUNNING]);
    renderPage();

    const retry = await screen.findByRole("button", { name: /retry/i });
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.click(retry);
    expect(await screen.findByText("web")).toBeInTheDocument();
  });
});
