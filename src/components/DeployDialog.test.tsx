import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import apiClient from "../api/apiClient";
import type { ServiceSummary } from "../api/types";
import DeployDialog from "./DeployDialog";
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
  tag: "v1.2.3",
  digest: "sha256:abcdef0123456789",
  port: 8080,
  hostPort: 49213,
  desiredStatus: "running",
  includeInHealth: true,
  updatedBy: "alice",
  updatedAt: "2026-08-03T00:00:00Z",
  fleet: { runningOn: 3, totalInstances: 3, digests: { "sha256:abcdef0123456789": 3 } },
};

function renderDialog() {
  const onClose = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <Routes>
        <Route
          path="/"
          element={
            <DeployDialog
              open={open}
              service={service}
              onClose={() => {
                onClose();
                setOpen(false);
              }}
            />
          }
        />
        <Route path="/deploys" element={<div>Deploys page</div>} />
      </Routes>
    );
  }
  render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <MemoryRouter initialEntries={["/"]}>
          <Harness />
        </MemoryRouter>
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
  return onClose;
}

describe("DeployDialog", () => {
  it("posts the entered tag and closes on success", async () => {
    const user = userEvent.setup();
    mock.onPost("/mgmt/services/web/deploy").reply(202);
    const onClose = renderDialog();

    const tag = screen.getByLabelText(/image tag/i);
    await user.clear(tag);
    await user.type(tag, "v2.0.0");
    await user.click(screen.getByRole("button", { name: /^deploy$/i }));

    await waitFor(() => expect(mock.history.post).toHaveLength(1));
    expect(mock.history.post[0].url).toBe("/mgmt/services/web/deploy");
    expect(JSON.parse(mock.history.post[0].data)).toEqual({ tag: "v2.0.0" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("defaults the tag to latest", async () => {
    renderDialog();
    expect(screen.getByLabelText(/image tag/i)).toHaveValue("latest");
  });

  it("disables deploy when the tag is empty", async () => {
    const user = userEvent.setup();
    renderDialog();

    const button = screen.getByRole("button", { name: /^deploy$/i });
    expect(button).toBeEnabled();
    await user.clear(screen.getByLabelText(/image tag/i));
    expect(button).toBeDisabled();
  });

  it("offers a View progress action that navigates to /deploys", async () => {
    const user = userEvent.setup();
    mock.onPost("/mgmt/services/web/deploy").reply(202);
    renderDialog();

    await user.click(screen.getByRole("button", { name: /^deploy$/i }));
    const view = await screen.findByRole("button", { name: /view progress/i });
    await user.click(view);

    expect(await screen.findByText("Deploys page")).toBeInTheDocument();
  });

  it("renders the API error inline and stays open", async () => {
    const user = userEvent.setup();
    mock.onPost("/mgmt/services/web/deploy").reply(500, { message: "registry unreachable" });
    const onClose = renderDialog();

    await user.click(screen.getByRole("button", { name: /^deploy$/i }));

    expect(await screen.findByText(/registry unreachable/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
