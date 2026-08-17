import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import MockAdapter from "axios-mock-adapter";

vi.mock("../lib/cognitoClient", () => ({
  getAccessToken: () => Promise.resolve(null),
}));

import apiClient from "../api/apiClient";
import type { ServiceSummary } from "../api/types";
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

const existingService: ServiceSummary = {
  name: "web",
  image: "registry/web",
  tag: "v1.2.3",
  digest: "sha256:abc",
  port: 8080,
  hostPort: 49213,
  desiredStatus: "running",
  includeInHealth: true,
  updatedBy: "alice",
  updatedAt: "2026-08-03T00:00:00Z",
  fleet: { runningOn: 2, totalInstances: 3, digests: { "sha256:abc": 2 } },
};

function renderDialog(onClose = vi.fn(), service?: ServiceSummary) {
  render(
    <ThemeModeProvider>
      <SnackbarProvider>
        <ServiceFormDialog open onClose={onClose} service={service} />
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
      envSecretRef: "",
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("renders the env secret ref field with its helper text", () => {
    renderDialog();

    expect(screen.getByLabelText(/env secret ref/i)).toBeInTheDocument();
    expect(
      screen.getByText(/AWS Secrets Manager secret name or ARN/i),
    ).toBeInTheDocument();
  });

  it("includes envSecretRef in the payload when set", async () => {
    const user = userEvent.setup();
    mock.onPut("/mgmt/services/api").reply(200, {});
    renderDialog();

    await user.type(screen.getByLabelText(/name/i), "api");
    await user.type(screen.getByLabelText(/image/i), "registry/api");
    await user.type(
      screen.getByLabelText(/env secret ref/i),
      "prod/api/env",
    );

    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(mock.history.put).toHaveLength(1));
    expect(JSON.parse(mock.history.put[0].data)).toMatchObject({
      name: "api",
      envSecretRef: "prod/api/env",
    });
  });

  it("sends an explicit empty envSecretRef when left blank (tri-state clear)", async () => {
    // The gateway's upsert preserves envSecretRef when the field is ABSENT and
    // clears it on an empty string. The dialog always shows the current value,
    // so a blank field is the user's intent to clear — it must be sent as ""
    // rather than omitted (omitting would silently keep a just-deleted ref).
    const user = userEvent.setup();
    mock.onPut("/mgmt/services/api").reply(200, {});
    renderDialog();

    await user.type(screen.getByLabelText(/name/i), "api");
    await user.type(screen.getByLabelText(/image/i), "registry/api");

    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(mock.history.put).toHaveLength(1));
    expect(JSON.parse(mock.history.put[0].data)).toHaveProperty(
      "envSecretRef",
      "",
    );
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

  describe("edit mode", () => {
    it("prefills the form from the service and renders the name read-only", () => {
      renderDialog(vi.fn(), existingService);

      expect(screen.getByRole("heading", { name: /edit service/i })).toBeInTheDocument();

      const name = screen.getByLabelText(/name/i);
      expect(name).toHaveValue("web");
      expect(name).toHaveAttribute("readonly");

      expect(screen.getByLabelText(/image/i)).toHaveValue("registry/web");
      expect(screen.getByLabelText(/tag/i)).toHaveValue("v1.2.3");
      expect(screen.getByLabelText(/port/i)).toHaveValue("8080");
      expect(screen.getByRole("switch", { name: /include in health/i })).toBeChecked();
    });

    it("PUTs the edited values without changing the name", async () => {
      const user = userEvent.setup();
      mock.onPut("/mgmt/services/web").reply(200, {});
      const onClose = renderDialog(vi.fn(), existingService);

      const tag = screen.getByLabelText(/tag/i);
      await user.clear(tag);
      await user.type(tag, "v2");

      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(mock.history.put).toHaveLength(1));
      expect(mock.history.put[0].url).toBe("/mgmt/services/web");
      expect(JSON.parse(mock.history.put[0].data)).toEqual({
        name: "web",
        image: "registry/web",
        tag: "v2",
        port: 8080,
        includeInHealth: true,
        desiredStatus: "running",
        envSecretRef: "",
      });
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it("prefills the env secret ref and resends it when unchanged", async () => {
      const user = userEvent.setup();
      mock.onPut("/mgmt/services/web").reply(200, {});
      renderDialog(vi.fn(), { ...existingService, envSecretRef: "prod/web/env" });

      expect(screen.getByLabelText(/env secret ref/i)).toHaveValue("prod/web/env");

      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(mock.history.put).toHaveLength(1));
      expect(JSON.parse(mock.history.put[0].data)).toMatchObject({
        name: "web",
        envSecretRef: "prod/web/env",
      });
    });

    it("sends an empty env secret ref when cleared in edit mode (tri-state clear)", async () => {
      // Clearing the field must reach the gateway as an explicit "" — the
      // upsert preserves the stored ref when the field is ABSENT, so omitting
      // it here would silently keep the ref the user just deleted.
      const user = userEvent.setup();
      mock.onPut("/mgmt/services/web").reply(200, {});
      renderDialog(vi.fn(), { ...existingService, envSecretRef: "prod/web/env" });

      await user.clear(screen.getByLabelText(/env secret ref/i));
      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(mock.history.put).toHaveLength(1));
      expect(JSON.parse(mock.history.put[0].data)).toHaveProperty(
        "envSecretRef",
        "",
      );
    });
  });

  describe("realtime section", () => {
    const withRealtime: ServiceSummary = {
      ...existingService,
      realtimeAllowedOrigins: "https://app.example.com",
      realtimeAuthPath: "/realtime/auth",
      realtimeMessagePath: "/realtime/send",
      realtimePresence: true,
      hasPublishToken: true,
    };

    it("renders the realtime fields with helpers and links the section header", () => {
      renderDialog();

      const link = screen.getByRole("link", { name: /realtime hub/i });
      expect(link).toHaveAttribute("href", expect.stringMatching(/REALTIME\.md/));

      expect(screen.getByLabelText(/allowed origins/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/auth path/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/message path/i)).toBeInTheDocument();
      expect(
        screen.getByRole("switch", { name: /broadcast presence events/i }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/exposes connection ids|exposes connection ids and identities|presence broadcasts connection ids/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/comma-separated exact origins/i),
      ).toBeInTheDocument();
    });

    it("prefills the realtime fields from the service", () => {
      renderDialog(vi.fn(), withRealtime);

      expect(screen.getByLabelText(/allowed origins/i)).toHaveValue(
        "https://app.example.com",
      );
      expect(screen.getByLabelText(/auth path/i)).toHaveValue("/realtime/auth");
      expect(screen.getByLabelText(/message path/i)).toHaveValue(
        "/realtime/send",
      );
      expect(
        screen.getByRole("switch", { name: /broadcast presence events/i }),
      ).toBeChecked();
    });

    it("shows a read-only publish token indicator when the summary exposes it", () => {
      renderDialog(vi.fn(), withRealtime);
      expect(screen.getByText(/publish token minted/i)).toBeInTheDocument();
    });

    it("omits the publish token chip when the field is absent", () => {
      renderDialog(vi.fn(), existingService);
      expect(screen.queryByText(/publish token/i)).toBeNull();
    });

    it("blocks save with a clear message when an origin is malformed", async () => {
      const user = userEvent.setup();
      renderDialog(vi.fn(), existingService);

      const origins = screen.getByLabelText(/allowed origins/i);
      await user.type(
        origins,
        "https://ok.example.com, https://bad.example.com/path",
      );

      await user.click(screen.getByRole("button", { name: /save/i }));
      expect(
        screen.getByText(
          /"https:\/\/bad\.example\.com\/path" is not a valid origin/i,
        ),
      ).toBeInTheDocument();
      expect(mock.history.put).toHaveLength(0);
    });

    it("blocks save with a clear message when a wildcard origin is entered", async () => {
      const user = userEvent.setup();
      renderDialog(vi.fn(), existingService);

      await user.type(
        screen.getByLabelText(/allowed origins/i),
        "https://*.example.com",
      );

      await user.click(screen.getByRole("button", { name: /save/i }));
      expect(
        screen.getByText(/is not a valid origin/i),
      ).toBeInTheDocument();
      expect(mock.history.put).toHaveLength(0);
    });

    it("blocks save when the auth path is not rooted", async () => {
      const user = userEvent.setup();
      renderDialog(vi.fn(), existingService);

      await user.type(screen.getByLabelText(/auth path/i), "realtime/auth");
      await user.click(screen.getByRole("button", { name: /save/i }));

      expect(
        screen.getByText(/auth path must be rooted/i),
      ).toBeInTheDocument();
      expect(mock.history.put).toHaveLength(0);
    });

    it("blocks save when the message path is not rooted", async () => {
      const user = userEvent.setup();
      renderDialog(vi.fn(), existingService);

      await user.type(screen.getByLabelText(/message path/i), "send");
      await user.click(screen.getByRole("button", { name: /save/i }));

      expect(
        screen.getByText(/message path must be rooted/i),
      ).toBeInTheDocument();
      expect(mock.history.put).toHaveLength(0);
    });

    it("sends touched realtime fields on save", async () => {
      const user = userEvent.setup();
      mock.onPut("/mgmt/services/web").reply(200, {});
      renderDialog(vi.fn(), existingService);

      await user.type(
        screen.getByLabelText(/allowed origins/i),
        "https://app.example.com, https://admin.example.com:8443",
      );
      await user.type(screen.getByLabelText(/auth path/i), "/realtime/auth");
      await user.type(
        screen.getByLabelText(/message path/i),
        "/realtime/send",
      );
      await user.click(
        screen.getByRole("switch", { name: /broadcast presence events/i }),
      );

      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(mock.history.put).toHaveLength(1));
      expect(JSON.parse(mock.history.put[0].data)).toMatchObject({
        realtimeAllowedOrigins:
          "https://app.example.com,https://admin.example.com:8443",
        realtimeAuthPath: "/realtime/auth",
        realtimeMessagePath: "/realtime/send",
        realtimePresence: true,
      });
    });

    it("does NOT send realtime fields the user did not touch (tri-state omission)", async () => {
      // The gateway upsert is tri-state on the realtime fields: omitting
      // preserves, "" clears, non-empty sets. If a form saved with prefilled
      // values sent every field, editing image or tag would silently overwrite
      // stored values the user never changed. The editor must therefore omit
      // untouched realtime fields entirely.
      const user = userEvent.setup();
      mock.onPut("/mgmt/services/web").reply(200, {});
      renderDialog(vi.fn(), withRealtime);

      // Edit an unrelated field only.
      const tag = screen.getByLabelText(/tag/i);
      await user.clear(tag);
      await user.type(tag, "v2");

      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(mock.history.put).toHaveLength(1));
      const body = JSON.parse(mock.history.put[0].data);
      expect(body).not.toHaveProperty("realtimeAllowedOrigins");
      expect(body).not.toHaveProperty("realtimeAuthPath");
      expect(body).not.toHaveProperty("realtimeMessagePath");
      expect(body).not.toHaveProperty("realtimePresence");
      expect(body.tag).toBe("v2");
    });

    it("sends an explicit empty string when a realtime field is cleared (tri-state clear)", async () => {
      const user = userEvent.setup();
      mock.onPut("/mgmt/services/web").reply(200, {});
      renderDialog(vi.fn(), withRealtime);

      await user.clear(screen.getByLabelText(/allowed origins/i));
      await user.clear(screen.getByLabelText(/auth path/i));
      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(mock.history.put).toHaveLength(1));
      const body = JSON.parse(mock.history.put[0].data);
      expect(body).toHaveProperty("realtimeAllowedOrigins", "");
      expect(body).toHaveProperty("realtimeAuthPath", "");
      // Untouched fields remain omitted even when others were cleared.
      expect(body).not.toHaveProperty("realtimeMessagePath");
      expect(body).not.toHaveProperty("realtimePresence");
    });

    it("sends realtimePresence: false when the presence toggle is turned off", async () => {
      const user = userEvent.setup();
      mock.onPut("/mgmt/services/web").reply(200, {});
      renderDialog(vi.fn(), withRealtime);

      await user.click(
        screen.getByRole("switch", { name: /broadcast presence events/i }),
      );
      await user.click(screen.getByRole("button", { name: /save/i }));

      await waitFor(() => expect(mock.history.put).toHaveLength(1));
      expect(JSON.parse(mock.history.put[0].data)).toHaveProperty(
        "realtimePresence",
        false,
      );
    });
  });
});
