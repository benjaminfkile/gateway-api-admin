import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import apiClient from "../api/apiClient";
import type { JobDetail } from "../api/types";
import JobFormDialog, {
  browserTimeZone,
  buildJobPayload,
  formFromJob,
  JOB_NAME_PATTERN,
  validateJobForm,
} from "./JobFormDialog";
import { SnackbarProvider } from "../contexts/SnackbarContext";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
});

afterEach(() => {
  mock.restore();
});

const existing: JobDetail = {
  name: "nightly-report",
  schedule: "0 2 * * *",
  timeZone: "UTC",
  image: "registry.example.com/jobs",
  tag: "v1",
  envSecretRef: "jobs/nightly",
  timeoutSeconds: 3600,
  enabled: true,
  scriptVersion: 4,
  nextRunAt: "2026-08-04T02:00:00Z",
  lastRun: null,
  updatedBy: "alice",
  updatedAt: "2026-08-03T00:00:00Z",
  script: "#!/bin/sh\necho hello\n",
};

function renderDialog(jobName?: string, onClose = vi.fn(), onSaved = vi.fn()) {
  render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <JobFormDialog open jobName={jobName} onClose={onClose} onSaved={onSaved} />
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
  return { onClose, onSaved };
}

/** Set a field's value in one change event (fast for long values). */
function setValue(label: RegExp | string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("validation helpers", () => {
  it("JOB_NAME_PATTERN follows the contract", () => {
    expect(JOB_NAME_PATTERN.test("nightly-report")).toBe(true);
    expect(JOB_NAME_PATTERN.test("a")).toBe(false);
    expect(JOB_NAME_PATTERN.test("-lead")).toBe(false);
    expect(JOB_NAME_PATTERN.test("Upper")).toBe(false);
    expect(JOB_NAME_PATTERN.test("a".repeat(64))).toBe(false);
  });

  it("validateJobForm checks timeout bounds, cron field count and the script", () => {
    const base = { ...formFromJob(existing), name: "ok-name" };
    expect(validateJobForm(base, false)).toEqual({});
    expect(validateJobForm({ ...base, timeoutSeconds: "29" }, false).timeoutSeconds).toBeTruthy();
    expect(validateJobForm({ ...base, timeoutSeconds: "21601" }, false).timeoutSeconds).toBeTruthy();
    expect(validateJobForm({ ...base, timeoutSeconds: "1.5" }, false).timeoutSeconds).toBeTruthy();
    expect(validateJobForm({ ...base, schedule: "* * *" }, false).schedule).toBeTruthy();
    expect(validateJobForm({ ...base, script: "  " }, false).script).toBeTruthy();
    expect(
      validateJobForm({ ...base, script: "x".repeat(262_145) }, false).script,
    ).toBeTruthy();
  });

  it("buildJobPayload sends an emptied schedule as an empty string on edit", () => {
    const form = { ...formFromJob(existing), schedule: "", envSecretRef: "" };
    expect(buildJobPayload(form, existing)).toEqual({ schedule: "", envSecretRef: "" });
  });
});

describe("JobFormDialog create", () => {
  it("validates the name, the timeout and the required script", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/^name/i), "Bad_Name");
    setValue(/timeout seconds/i, "10");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(screen.getByText(/Name must be 2 to 63 lowercase/)).toBeInTheDocument();
    expect(screen.getByText(/Timeout must be a whole number/)).toBeInTheDocument();
    expect(screen.getByText("Script is required")).toBeInTheDocument();
    expect(mock.history.put).toHaveLength(0);
  });

  it("requires a name", async () => {
    const user = userEvent.setup();
    renderDialog();

    setValue(/^script/i, "echo hi");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(screen.getByText("Name is required")).toBeInTheDocument();
    expect(mock.history.put).toHaveLength(0);
  });

  it("defaults the zone to the browser zone and PUTs the required fields", async () => {
    const user = userEvent.setup();
    mock.onPut("/mgmt/jobs/cleanup").reply(201, { ...existing, name: "cleanup" });
    const { onClose, onSaved } = renderDialog();

    expect(screen.getByLabelText(/time zone/i)).toHaveValue(browserTimeZone());

    await user.type(screen.getByLabelText(/^name/i), "cleanup");
    setValue(/^schedule/i, "*/15 * * * *");
    setValue(/^script/i, "echo cleanup");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(mock.history.put).toHaveLength(1));
    expect(mock.history.put[0].url).toBe("/mgmt/jobs/cleanup");
    expect(JSON.parse(mock.history.put[0].data)).toEqual({
      schedule: "*/15 * * * *",
      timeZone: browserTimeZone(),
      script: "echo cleanup",
      timeoutSeconds: 3600,
      enabled: true,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onSaved).toHaveBeenCalled();
  });

  it("maps a 400 to the named field", async () => {
    const user = userEvent.setup();
    mock
      .onPut("/mgmt/jobs/cleanup")
      .reply(400, { error: "schedule is not a valid cron expression", field: "schedule" });
    const { onClose } = renderDialog();

    await user.type(screen.getByLabelText(/^name/i), "cleanup");
    setValue(/^schedule/i, "99 * * * *");
    setValue(/^script/i, "echo cleanup");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(
      await screen.findByText("schedule is not a valid cron expression"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/^schedule/i)).toHaveAttribute("aria-invalid", "true");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("JobFormDialog edit", () => {
  it("loads the job, disables the name, and sends only changed fields", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/jobs/nightly-report").reply(200, existing);
    mock.onPut("/mgmt/jobs/nightly-report").reply(200, existing);
    renderDialog("nightly-report");

    const script = await screen.findByLabelText(/^script/i);
    expect(script).toHaveValue(existing.script);
    expect(screen.getByLabelText(/^name/i)).toBeDisabled();
    expect(screen.getByText("script version 4")).toBeInTheDocument();

    setValue(/^script/i, "echo changed");
    setValue(/timeout seconds/i, "600");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(mock.history.put).toHaveLength(1));
    expect(JSON.parse(mock.history.put[0].data)).toEqual({
      script: "echo changed",
      timeoutSeconds: 600,
    });
  });

  it("does not PUT when nothing changed", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/jobs/nightly-report").reply(200, existing);
    const { onClose } = renderDialog("nightly-report");

    await screen.findByLabelText(/^script/i);
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mock.history.put).toHaveLength(0);
  });

  it("requires image and tag on edit", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/jobs/nightly-report").reply(200, existing);
    renderDialog("nightly-report");

    await screen.findByLabelText(/^script/i);
    setValue(/^image/i, "");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(screen.getByText("Image is required")).toBeInTheDocument();
    expect(mock.history.put).toHaveLength(0);
  });

  it("lists script versions and shows a past body read-only", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/jobs/nightly-report").reply(200, existing);
    mock.onGet("/mgmt/jobs/nightly-report/script/versions").reply(200, [
      { version: 4, sha256: "aaaaaaaaaaaaaaaa", updatedBy: "alice", updatedAt: "2026-08-03T00:00:00Z" },
      { version: 3, sha256: "bbbbbbbbbbbbbbbb", updatedBy: "bob", updatedAt: "2026-08-02T00:00:00Z" },
    ]);
    mock
      .onGet("/mgmt/jobs/nightly-report/script/versions/3")
      .reply(200, { version: 3, script: "echo version three" });
    renderDialog("nightly-report");

    await user.click(await screen.findByRole("button", { name: "View versions" }));
    const list = await screen.findByRole("list", { name: "script versions" });
    await user.click(within(list).getByText("Version 3"));

    const body = await screen.findByDisplayValue("echo version three");
    expect(body).toHaveAttribute("readonly");
  });
});
