import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import MockAdapter from "axios-mock-adapter";

// No Cognito in the test container. Report a valid session so AuthProvider lands
// in "signedIn" and the authed shell renders without a login round-trip.
vi.mock("./lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve("test-token"),
  hasValidSession: () => Promise.resolve(true),
  signOut: vi.fn(),
}));

// The SignalR hub is mocked wholesale — no real connection is made in tests.
import * as hubClient from "./lib/hubClient";
vi.mock("./lib/hubClient");

// jsdom cannot render a real xterm canvas, so stub the terminal wrapper used by
// the Logs page.
vi.mock("./lib/terminal", () => ({
  createTerminal: vi.fn(() => ({
    open: vi.fn(),
    writeln: vi.fn(),
    clear: vi.fn(),
    fit: vi.fn(),
    setTheme: vi.fn(),
    dispose: vi.fn(),
  })),
  themeFromPalette: vi.fn(() => ({})),
}));

import apiClient from "./api/apiClient";
import App from "./App";
import { AuthProvider } from "./contexts/AuthContext";
import { SnackbarProvider } from "./contexts/SnackbarContext";
import { ThemeModeProvider } from "./theme/ThemeModeProvider";
import { installHubMock } from "./test/hubClientMock";

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
  installHubMock(hubClient);
  // Every page's initial fetch resolves to an empty-but-valid payload so the
  // heading renders regardless of which page we're on.
  mock.onGet("/mgmt/services").reply(200, []);
  mock.onGet("/mgmt/deploys").reply(200, []);
  mock.onGet("/mgmt/instances").reply(200, []);
  mock.onGet(/\/mgmt\/services\/.+\/logs/).reply(200, []);
});

afterEach(() => {
  mock.restore();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function renderApp() {
  return render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={["/"]}>
            <App />
          </MemoryRouter>
        </AuthProvider>
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
}

// Every nav item and the heading the page it opens should render.
const NAV = [
  { label: "Services", heading: "Services" },
  { label: "Deploys", heading: "Deploys" },
  { label: "Instances", heading: "Instances" },
  { label: "Logs", heading: "Logs" },
  { label: "Node stats", heading: "Node stats" },
];

describe("App router smoke test", () => {
  it("renders each page's heading when navigating through every nav item", async () => {
    const user = userEvent.setup();
    renderApp();

    // The default route ("/") is the Services page.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Services" })).toBeInTheDocument(),
    );

    for (const { label, heading } of NAV) {
      // The mobile + permanent drawers both render the nav; clicking either
      // navigates. getAllByText[0] targets a stable one.
      await user.click(screen.getAllByText(label)[0]);
      await waitFor(() =>
        expect(
          screen.getByRole("heading", { name: heading }),
        ).toBeInTheDocument(),
      );
    }
  });

  it("shows the 404 page for an unknown route inside the shell", async () => {
    render(
      <ThemeModeProvider>
        <SnackbarProvider>
          <AuthProvider>
            <MemoryRouter initialEntries={["/does-not-exist"]}>
              <App />
            </MemoryRouter>
          </AuthProvider>
        </SnackbarProvider>
      </ThemeModeProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText("Page not found")).toBeInTheDocument(),
    );
    expect(screen.getByText("404")).toBeInTheDocument();
  });
});
