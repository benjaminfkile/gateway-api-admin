import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import apiClient from "../api/apiClient";
import type { ServiceSummary } from "../api/types";
import RemoveServiceDialog from "./RemoveServiceDialog";
import { SnackbarProvider } from "../contexts/SnackbarContext";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
});

afterEach(() => {
  mock.restore();
});

function svc(overrides: Partial<ServiceSummary> = {}): ServiceSummary {
  return {
    name: "web",
    image: "registry/web",
    tag: "v1.2.3",
    digest: "sha256:abc",
    port: 8080,
    hostPort: 49213,
    desiredStatus: "running",
    includeInHealth: false,
    updatedBy: "alice",
    updatedAt: "2026-08-03T00:00:00Z",
    fleet: { runningOn: 2, totalInstances: 3, digests: { "sha256:abc": 2 } },
    ...overrides,
  };
}

function renderDialog(
  service: ServiceSummary = svc(),
  onClose = vi.fn(),
  onRemoved = vi.fn(),
) {
  render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <RemoveServiceDialog
          open
          service={service}
          onClose={onClose}
          onRemoved={onRemoved}
        />
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
  return { onClose, onRemoved };
}

describe("RemoveServiceDialog", () => {
  it("keeps the remove button disabled until the name is typed exactly", async () => {
    const user = userEvent.setup();
    renderDialog();

    const button = screen.getByRole("button", { name: /^remove$/i });
    expect(button).toBeDisabled();

    const input = screen.getByLabelText(/service name/i);
    await user.type(input, "we");
    expect(button).toBeDisabled();

    await user.type(input, "b");
    expect(button).toBeEnabled();
  });

  it("DELETEs the service without force when confirmed", async () => {
    const user = userEvent.setup();
    mock.onDelete("/mgmt/services/web").reply(204);
    const { onClose, onRemoved } = renderDialog();

    await user.type(screen.getByLabelText(/service name/i), "web");
    await user.click(screen.getByRole("button", { name: /^remove$/i }));

    await waitFor(() => expect(mock.history.delete).toHaveLength(1));
    expect(mock.history.delete[0].url).toBe("/mgmt/services/web");
    expect(mock.history.delete[0].params).toBeUndefined();
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows a force checkbox for health-critical services and passes ?force=true", async () => {
    const user = userEvent.setup();
    mock.onDelete("/mgmt/services/web").reply(204);
    renderDialog(svc({ includeInHealth: true }));

    // The health warning is surfaced and a force checkbox is offered.
    expect(screen.getByText(/included in health checks/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/service name/i), "web");
    await user.click(screen.getByRole("checkbox", { name: /force removal/i }));
    await user.click(screen.getByRole("button", { name: /^remove$/i }));

    await waitFor(() => expect(mock.history.delete).toHaveLength(1));
    expect(mock.history.delete[0].params).toEqual({ force: true });
  });

  it("does not render a force checkbox for non-health-critical services", () => {
    renderDialog(svc({ includeInHealth: false }));
    expect(screen.queryByRole("checkbox", { name: /force removal/i })).toBeNull();
  });

  it("renders the API error inline and stays open", async () => {
    const user = userEvent.setup();
    mock.onDelete("/mgmt/services/web").reply(409, { message: "still in health" });
    const { onClose } = renderDialog(svc({ includeInHealth: true }));

    await user.type(screen.getByLabelText(/service name/i), "web");
    await user.click(screen.getByRole("button", { name: /^remove$/i }));

    expect(await screen.findByText(/still in health/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
