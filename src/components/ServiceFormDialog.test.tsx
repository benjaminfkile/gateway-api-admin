import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import apiClient from "../api/apiClient";
import ServiceFormDialog from "./ServiceFormDialog";
import { SnackbarProvider } from "../contexts/SnackbarContext";
import { ThemeModeProvider } from "../theme/ThemeModeProvider";

let mock: MockAdapter;

beforeEach(() => {
  mock = new MockAdapter(apiClient);
});

afterEach(() => {
  mock.restore();
});

function renderDialog(onClose = vi.fn()) {
  render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <ServiceFormDialog open onClose={onClose} />
      </SnackbarProvider>
    </ThemeModeProvider>,
  );
  return onClose;
}

describe("ServiceFormDialog", () => {
  it("PUTs a valid service payload and closes", async () => {
    const user = userEvent.setup();
    mock.onPut("/mgmt/services/api").reply(200, {});
    const onClose = renderDialog();

    await user.type(screen.getByLabelText(/name/i), "api");
    await user.type(screen.getByLabelText(/image/i), "registry/api");
    const tag = screen.getByLabelText(/tag/i);
    await user.clear(tag);
    await user.type(tag, "v1");
    const port = screen.getByLabelText(/port/i);
    await user.clear(port);
    await user.type(port, "9090");
    await user.click(screen.getByRole("switch", { name: /include in health/i }));

    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(mock.history.put).toHaveLength(1));
    expect(mock.history.put[0].url).toBe("/mgmt/services/api");
    expect(JSON.parse(mock.history.put[0].data)).toEqual({
      name: "api",
      image: "registry/api",
      tag: "v1",
      port: 9090,
      includeInHealth: true,
      desiredStatus: "running",
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("blocks submit and shows validation errors for a bad name and port", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/name/i), "Bad_Name");
    await user.type(screen.getByLabelText(/image/i), "registry/api");
    const port = screen.getByLabelText(/port/i);
    await user.clear(port);
    await user.type(port, "70000");

    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(screen.getByText(/must match \^\[a-z0-9-\]\+\$/i)).toBeInTheDocument();
    expect(screen.getByText(/between 1 and 65535/i)).toBeInTheDocument();
    expect(mock.history.put).toHaveLength(0);
  });

  it("requires a name", async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText(/image/i), "registry/api");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(screen.getByText(/name is required/i)).toBeInTheDocument();
    expect(mock.history.put).toHaveLength(0);
  });

  it("renders the API error inline and stays open", async () => {
    const user = userEvent.setup();
    mock.onPut("/mgmt/services/api").reply(409, { message: "already exists" });
    const onClose = renderDialog();

    await user.type(screen.getByLabelText(/name/i), "api");
    await user.type(screen.getByLabelText(/image/i), "registry/api");
    await user.click(screen.getByRole("button", { name: /save/i }));

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
