import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import apiClient from "../api/apiClient";
import type { PreflightCheck } from "../api/types";
import LoadRunFormPage, {
  CONFIRM_HINT,
  VALIDATION_HINT,
  buildRunStart,
  initialRunForm,
  minutesToSeconds,
  startBlockedReason,
  withValidation,
} from "./LoadRunFormPage";
import { SnackbarProvider } from "../contexts/SnackbarContext";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";
import { loadScenario } from "../test/loadFixtures";

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
  mock.onGet("/mgmt/load/scenarios").reply(200, [loadScenario()]);
});

afterEach(() => {
  mock.restore();
  vi.clearAllMocks();
});

function RunProbe() {
  const { id } = useParams();
  return <div>run page {id}</div>;
}

function renderForm(path = "/load/runs/new?scenario=sample-scenario") {
  return render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/load/runs/new" element={<LoadRunFormPage />} />
            <Route path="/load/runs/:id" element={<RunProbe />} />
          </Routes>
        </MemoryRouter>
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
}

const GREEN: PreflightCheck[] = [
  { name: "target_known", status: "green", message: "target is a known service", fix: null },
  { name: "scenario_validated", status: "amber", message: "scenario not validated yet", fix: "run a validation run" },
];
const RED: PreflightCheck[] = [
  ...GREEN,
  { name: "presence_off", status: "red", message: "presence is on", fix: "turn presence off" },
];

describe("run form helpers", () => {
  it("converts minutes to seconds", () => {
    expect(minutesToSeconds("2.5")).toBe(150);
    expect(minutesToSeconds("")).toBe(0);
  });

  it("builds the start body without any fleet field", () => {
    const form = { ...initialRunForm("s", false), target: "t", confirm: "t", params: [{ key: "k", value: "v" }] };
    expect(buildRunStart(form)).toEqual({
      scenario: "s",
      target: "t",
      confirm: "t",
      generators: 1,
      vusPerGenerator: 100,
      rampSeconds: 300,
      holdSeconds: 600,
      validation: false,
      params: { k: "v" },
    });
  });

  it("pins the sizes when the validation switch goes on and keeps them when it goes off", () => {
    const form = { ...initialRunForm("s", false), generators: "4", vusPerGenerator: "500", rampMinutes: "5", holdMinutes: "15" };
    const on = withValidation(form, true);
    expect(on).toMatchObject({ validation: true, generators: "1", vusPerGenerator: "1", rampMinutes: "0", holdMinutes: "5" });
    expect(withValidation(on, false)).toMatchObject({ validation: false, generators: "1", vusPerGenerator: "1" });
  });

  it("blocks Start on a mismatched confirm or a red check", () => {
    const form = { ...initialRunForm("s", false), target: "t", confirm: "x" };
    expect(startBlockedReason(form, GREEN, false)).toMatch(/does not match/);
    expect(startBlockedReason({ ...form, confirm: "t" }, RED, false)).toMatch(/presence_off/);
    expect(startBlockedReason({ ...form, confirm: "t" }, GREEN, false)).toBeNull();
  });
});

describe("LoadRunFormPage", () => {
  it("prefills a validation run and seeds params from the scenario", async () => {
    renderForm("/load/runs/new?scenario=sample-scenario&validation=1");
    expect(screen.getByRole("heading", { name: "New validation run" })).toBeInTheDocument();
    expect(screen.getByLabelText("Generators")).toHaveValue(1);
    expect(screen.getByLabelText("Users each")).toHaveValue(1);
    expect(screen.getByLabelText("Ramp minutes")).toHaveValue(0);
    expect(screen.getByRole("switch", { name: "Validation run" })).toBeChecked();
    expect(screen.queryByRole("switch", { name: "Leave the fleet alone" })).toBeNull();
    expect(screen.queryByLabelText("Fleet size")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Restore fleet afterwards" })).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("Params key 1")).toHaveValue("rate"));
    expect(screen.getByLabelText("Params value 1")).toHaveValue("10");
    expect(screen.getByText(CONFIRM_HINT)).toBeInTheDocument();
  });

  it("locks the size fields while the validation switch is on", async () => {
    const user = userEvent.setup();
    renderForm();
    const generators = screen.getByLabelText("Generators");
    await user.clear(generators);
    await user.type(generators, "4");
    await user.click(screen.getByRole("switch", { name: "Validation run" }));
    expect(screen.getByRole("heading", { name: "New validation run" })).toBeInTheDocument();
    expect(generators).toBeDisabled();
    expect(generators).toHaveValue(1);
    expect(screen.getByLabelText("Users each")).toBeDisabled();
    expect(screen.getByLabelText("Users each")).toHaveValue(1);
    expect(screen.getByLabelText("Ramp minutes")).toBeDisabled();
    expect(screen.getByLabelText("Hold minutes")).toHaveValue(5);
    expect(screen.getAllByText(VALIDATION_HINT).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("switch", { name: "Validation run" }));
    expect(generators).toBeEnabled();
    expect(screen.getByRole("heading", { name: "New load run" })).toBeInTheDocument();
  });

  it("shows the computed total users", async () => {
    const user = userEvent.setup();
    renderForm();
    const generators = screen.getByLabelText("Generators");
    await user.clear(generators);
    await user.type(generators, "3");
    expect(screen.getByTestId("total-users")).toHaveTextContent("Total users: 300");
  });

  it("debounces pre-flight and gates Start on red checks and the typed target", async () => {
    const user = userEvent.setup();
    let checks = RED;
    mock.onGet("/mgmt/load/preflight").reply(() => [200, { ok: false, checks }]);
    mock.onPost("/mgmt/load/runs").reply(202, { runId: 12 });
    renderForm();
    await waitFor(() => expect(screen.getByLabelText("Params key 1")).toHaveValue("rate"));

    await user.type(screen.getByLabelText("Target"), "sample-service");
    await screen.findByTestId("check-presence_off");
    // One read for the whole burst of keystrokes.
    expect(mock.history.get.filter((r) => r.url === "/mgmt/load/preflight")).toHaveLength(1);
    const start = screen.getByRole("button", { name: "Start" });
    expect(start).toBeDisabled();

    await user.type(screen.getByLabelText("Confirm target"), "sample-serv");
    expect(screen.getByText("Does not match the target")).toBeInTheDocument();
    checks = GREEN;
    await user.type(screen.getByLabelText("Confirm target"), "ice");
    await waitFor(() => expect(screen.queryByTestId("check-presence_off")).toBeNull());
    await waitFor(() => expect(start).toBeEnabled());
    const lastPreflight = mock.history.get.filter((r) => r.url === "/mgmt/load/preflight").at(-1);
    expect(lastPreflight?.params).toMatchObject({ confirm: "sample-service", target: "sample-service" });
    expect(within(screen.getByTestId("check-scenario_validated")).getByText(/run a validation run/)).toBeInTheDocument();

    await user.click(start);
    await screen.findByText("run page 12");
    expect(JSON.parse(mock.history.post[0].data)).toMatchObject({
      scenario: "sample-scenario",
      target: "sample-service",
      confirm: "sample-service",
      params: { rate: "10" },
    });
    const body = JSON.parse(mock.history.post[0].data);
    expect(body).not.toHaveProperty("fleetSize");
    expect(body).not.toHaveProperty("restoreFleet");
    expect(lastPreflight?.params).not.toHaveProperty("fleet");
  });

  it("shows the checks from a 409 preflight_failed answer", async () => {
    const user = userEvent.setup();
    let calls = 0;
    mock.onGet("/mgmt/load/preflight").reply(() => [200, { checks: GREEN }]);
    mock.onPost("/mgmt/load/runs").reply(() => {
      calls += 1;
      return [409, { error: "preflight_failed", checks: RED }];
    });
    renderForm();
    await user.type(screen.getByLabelText("Target"), "svc");
    await user.type(screen.getByLabelText("Confirm target"), "svc");
    const start = screen.getByRole("button", { name: "Start" });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    expect(await screen.findByText("Pre-flight failed: presence_off")).toBeInTheDocument();
    expect(calls).toBe(1);
    expect(screen.getByTestId("check-presence_off")).toBeInTheDocument();
  });
});
