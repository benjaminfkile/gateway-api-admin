import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import apiClient from "../api/apiClient";
import type { DeploySummary, ServiceSummary } from "../api/types";
import RollbackDialog from "./RollbackDialog";
import { SnackbarProvider } from "../contexts/SnackbarContext";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
});

afterEach(() => {
  mock.restore();
});

const service: ServiceSummary = {
  name: "web",
  image: "registry/web",
  tag: "v3",
  digest: "sha256:current0000",
  port: 8080,
  desiredStatus: "running",
  includeInHealth: false,
  updatedBy: "alice",
  updatedAt: "2026-08-03T00:00:00Z",
  fleet: { runningOn: 2, totalInstances: 2, digests: { "sha256:current0000": 2 } },
};

function deploy(overrides: Partial<DeploySummary>): DeploySummary {
  return {
    id: "d-x",
    service: "web",
    fromDigest: "sha256:prev",
    toDigest: "sha256:aaa",
    actor: "alice",
    action: "deploy",
    status: "done",
    startedAt: "2026-08-01T00:00:00Z",
    finishedAt: "2026-08-01T00:01:00Z",
    ...overrides,
  };
}

const DEPLOYS: DeploySummary[] = [
  deploy({ id: "d-1", toDigest: "sha256:aaa", startedAt: "2026-08-02T00:00:00Z" }),
  deploy({ id: "d-2", toDigest: "sha256:bbb", startedAt: "2026-08-01T00:00:00Z" }),
  // current digest — must be excluded as a target
  deploy({ id: "d-3", toDigest: "sha256:current0000", startedAt: "2026-08-03T00:00:00Z" }),
  // failed — must be excluded
  deploy({ id: "d-4", toDigest: "sha256:ccc", status: "failed" }),
];

function renderDialog(onClose = vi.fn()) {
  render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <RollbackDialog open service={service} onClose={onClose} />
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
  return onClose;
}

describe("RollbackDialog", () => {
  it("lists successful, non-current target digests and posts the selection", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/deploys").reply(200, DEPLOYS);
    mock.onPost("/mgmt/services/web/rollback").reply(202);
    const onClose = renderDialog();

    const aaa = await screen.findByRole("radio", { name: /sha256:aaa/ });
    expect(screen.getByRole("radio", { name: /sha256:bbb/ })).toBeInTheDocument();
    // current + failed deploys are not offered
    expect(screen.queryByRole("radio", { name: /sha256:current/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /sha256:ccc/ })).toBeNull();

    await user.click(aaa);
    await user.click(screen.getByRole("button", { name: /roll back/i }));

    await waitFor(() => expect(mock.history.post).toHaveLength(1));
    expect(mock.history.post[0].url).toBe("/mgmt/services/web/rollback");
    expect(JSON.parse(mock.history.post[0].data)).toEqual({ toDigest: "sha256:aaa" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("keeps confirm disabled until a target is selected", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/deploys").reply(200, DEPLOYS);
    renderDialog();

    const button = screen.getByRole("button", { name: /roll back/i });
    expect(button).toBeDisabled();
    await user.click(await screen.findByRole("radio", { name: /sha256:aaa/ }));
    expect(button).toBeEnabled();
  });

  it("shows a load error with retry when the history fails", async () => {
    mock.onGet("/mgmt/deploys").reply(500);
    renderDialog();

    expect(await screen.findByText(/failed to load deploy history/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("renders the API error inline and stays open", async () => {
    const user = userEvent.setup();
    mock.onGet("/mgmt/deploys").reply(200, DEPLOYS);
    mock.onPost("/mgmt/services/web/rollback").reply(409, { message: "conflict" });
    const onClose = renderDialog();

    await user.click(await screen.findByRole("radio", { name: /sha256:aaa/ }));
    await user.click(screen.getByRole("button", { name: /roll back/i }));

    expect(await screen.findByText(/conflict/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
