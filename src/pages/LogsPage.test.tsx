import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import MockAdapter from "axios-mock-adapter";
import type { ReactNode } from "react";

// No Cognito in the test container — stub the token source.
vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

// jsdom cannot render a real xterm canvas, so the terminal wrapper is mocked
// wholesale. A single shared handle lets us assert against its methods.
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
import type { InstanceInfo, LogLine, ServiceSummary } from "../api/types";
import LogsPage, { formatLogLine, newLinesSince, defaultInstanceId } from "./LogsPage";
import ThemeToggle from "../components/ThemeToggle";
import { SnackbarProvider } from "../contexts/SnackbarContext";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
  // Clear before each test so a lingering unmount (RTL auto-cleanup) from the
  // previous test cannot leak dispose/writeln calls into this one's counts.
  vi.clearAllMocks();
});

afterEach(() => {
  mock.restore();
  vi.useRealTimers();
});

function svc(name: string): ServiceSummary {
  return {
    name,
    image: "registry/" + name,
    tag: "latest",
    digest: "sha256:abc",
    port: 8080,
    hostPort: 49213,
    desiredStatus: "running",
    includeInHealth: true,
    updatedBy: "ci",
    updatedAt: "2026-08-03T00:00:00Z",
    fleet: { runningOn: 1, totalInstances: 1, digests: {} },
  };
}

function inst(instanceId: string, stale = false): InstanceInfo {
  return {
    instanceId,
    privateIp: "10.0.0.1",
    publicIp: "3.3.3.3",
    gatewayVer: "1.4.0",
    isLeader: false,
    stale,
    heartbeatAt: "2026-08-03T00:00:00Z",
    services: [],
  };
}

const SERVICES = [svc("web"), svc("api")];
const INSTANCES = [inst("i-stale", true), inst("i-live")];

const LINE_A: LogLine = { ts: "2026-08-03T00:00:01Z", message: "started" };
const LINE_B: LogLine = { ts: "2026-08-03T00:00:02Z", message: "listening" };
const LINE_C: LogLine = { ts: "2026-08-03T00:00:03Z", message: "request served" };

function renderPage(children: ReactNode = <LogsPage />) {
  return render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
}

function writtenLines(): string[] {
  return term.handle.writeln.mock.calls.map((c) => c[0] as string);
}

describe("pure helpers", () => {
  it("formatLogLine renders '{ts} {message}'", () => {
    expect(formatLogLine(LINE_A)).toBe("2026-08-03T00:00:01Z started");
  });

  it("newLinesSince returns everything when no last ts", () => {
    expect(newLinesSince([LINE_A, LINE_B], null)).toEqual([LINE_A, LINE_B]);
  });

  it("newLinesSince keeps only lines strictly newer than last ts", () => {
    expect(newLinesSince([LINE_A, LINE_B, LINE_C], LINE_B.ts)).toEqual([LINE_C]);
  });

  it("defaultInstanceId prefers the first non-stale instance", () => {
    expect(defaultInstanceId(INSTANCES)).toBe("i-live");
    expect(defaultInstanceId([inst("i-1", true)])).toBe("i-1");
    expect(defaultInstanceId([])).toBe("");
  });
});

describe("LogsPage", () => {
  it("loads pickers and writes the initial tail into the terminal", async () => {
    mock.onGet("/mgmt/services").reply(200, SERVICES);
    mock.onGet("/mgmt/instances").reply(200, INSTANCES);
    mock.onGet("/mgmt/services/web/logs").reply(200, { lines: [LINE_A, LINE_B] });

    renderPage();

    await waitFor(() => expect(term.createTerminal).toHaveBeenCalledTimes(1));
    expect(term.handle.open).toHaveBeenCalledTimes(1);

    await waitFor(() =>
      expect(writtenLines()).toEqual([formatLogLine(LINE_A), formatLogLine(LINE_B)]),
    );

    // Default selections: first service, first non-stale instance.
    expect((screen.getByLabelText("Service") as HTMLSelectElement).value).toBe("web");
    expect((screen.getByLabelText("Instance") as HTMLSelectElement).value).toBe("i-live");

    // The tail request carried the selected instance and default tail size.
    const logGet = mock.history.get.find((g) => g.url === "/mgmt/services/web/logs");
    expect(logGet?.params).toEqual({ instance: "i-live", tail: 100 });
  });

  it("clears and reloads when the service selection changes", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/services").reply(200, SERVICES);
    mock.onGet("/mgmt/instances").reply(200, INSTANCES);
    mock.onGet("/mgmt/services/web/logs").reply(200, { lines: [LINE_A] });
    mock.onGet("/mgmt/services/api/logs").reply(200, { lines: [LINE_C] });

    renderPage();

    await waitFor(() =>
      expect(writtenLines()).toEqual([formatLogLine(LINE_A)]),
    );
    term.handle.clear.mockClear();
    term.handle.writeln.mockClear();

    await user.selectOptions(screen.getByLabelText("Service"), "api");

    // Full reload: terminal cleared, then only the new service's lines written.
    await waitFor(() => expect(term.handle.clear).toHaveBeenCalled());
    await waitFor(() =>
      expect(writtenLines()).toEqual([formatLogLine(LINE_C)]),
    );
    expect(term.createTerminal).toHaveBeenCalledTimes(1); // not recreated
  });

  it("follow mode appends only new lines every poll", async () => {
    vi.useFakeTimers();
    let lines: LogLine[] = [LINE_A, LINE_B];
    mock.onGet("/mgmt/services").reply(200, SERVICES);
    mock.onGet("/mgmt/instances").reply(200, INSTANCES);
    mock.onGet("/mgmt/services/web/logs").reply(() => [200, { lines }]);

    renderPage();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(writtenLines()).toEqual([formatLogLine(LINE_A), formatLogLine(LINE_B)]);

    // A newer line appears; the next poll should append only it.
    lines = [LINE_A, LINE_B, LINE_C];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(writtenLines()).toEqual([
      formatLogLine(LINE_A),
      formatLogLine(LINE_B),
      formatLogLine(LINE_C),
    ]);
    // Nothing was cleared during follow polling.
    expect(term.handle.clear).toHaveBeenCalledTimes(1); // only the initial load
  });

  it("polls while Follow is on and stops once it is turned off", async () => {
    vi.useFakeTimers();
    mock.onGet("/mgmt/services").reply(200, SERVICES);
    mock.onGet("/mgmt/instances").reply(200, INSTANCES);
    mock.onGet("/mgmt/services/web/logs").reply(200, { lines: [LINE_A] });

    renderPage();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const logGets = () =>
      mock.history.get.filter((g) => g.url === "/mgmt/services/web/logs").length;
    const afterInitial = logGets();

    // Follow defaults on: an interval tick issues another tail request.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(logGets()).toBe(afterInitial + 1);

    // Turn Follow off (fireEvent — userEvent does not compose with fake timers).
    act(() => {
      fireEvent.click(screen.getByLabelText("Follow"));
    });
    const afterOff = logGets();

    // No further requests no matter how many intervals elapse.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(logGets()).toBe(afterOff);
  });

  it("re-themes the terminal when the palette mode changes", async () => {
    mock.onGet("/mgmt/services").reply(200, SERVICES);
    mock.onGet("/mgmt/instances").reply(200, INSTANCES);
    mock.onGet("/mgmt/services/web/logs").reply(200, { lines: [LINE_A] });

    renderPage(
      <>
        <ThemeToggle />
        <LogsPage />
      </>,
    );

    await waitFor(() => expect(term.createTerminal).toHaveBeenCalledTimes(1));
    const before = term.handle.setTheme.mock.calls.length;

    const user = userEvent.setup();
    await user.click(screen.getByRole("button"));

    await waitFor(() =>
      expect(term.handle.setTheme.mock.calls.length).toBeGreaterThan(before),
    );
    expect(term.createTerminal).toHaveBeenCalledTimes(1); // reused, not recreated
  });

  it("disposes the terminal on unmount", async () => {
    mock.onGet("/mgmt/services").reply(200, SERVICES);
    mock.onGet("/mgmt/instances").reply(200, INSTANCES);
    mock.onGet("/mgmt/services/web/logs").reply(200, { lines: [LINE_A] });

    const { unmount } = renderPage();
    await waitFor(() => expect(term.createTerminal).toHaveBeenCalledTimes(1));

    unmount();
    expect(term.handle.dispose).toHaveBeenCalledTimes(1);
  });
});
