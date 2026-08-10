import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";

import * as hubClient from "../lib/hubClient";
vi.mock("../lib/hubClient");

import { installHubMock, type HubMockControl } from "../test/hubClientMock";
import { useDeployProgress, useFleetStatus, useOpsChannel } from "./useOpsChannel";
import type { ChannelHandler } from "../lib/hubClient";

let hub: HubMockControl;

beforeEach(() => {
  hub = installHubMock(hubClient);
});

afterEach(() => {
  vi.clearAllMocks();
});

function Probe({
  channel,
  onEvent,
}: {
  channel: string;
  onEvent: ChannelHandler;
}) {
  const { connected } = useOpsChannel(channel, onEvent);
  return <div data-testid="state">{connected ? "live" : "offline"}</div>;
}

describe("useOpsChannel", () => {
  it("starts the shared connection and joins the channel on mount", async () => {
    render(<Probe channel="ops:fleet" onEvent={() => {}} />);

    await waitFor(() => expect(hub.ensureStarted).toHaveBeenCalled());
    expect(hubClient.joinChannel).toHaveBeenCalledWith("ops:fleet");
    await waitFor(() =>
      expect(screen.getByTestId("state")).toHaveTextContent("live"),
    );
  });

  it("leaves the channel on unmount", async () => {
    const { unmount } = render(<Probe channel="ops:fleet" onEvent={() => {}} />);
    await waitFor(() => expect(hubClient.joinChannel).toHaveBeenCalled());

    unmount();
    expect(hubClient.leaveChannel).toHaveBeenCalledWith("ops:fleet");
  });

  it("delivers channel events to the handler", async () => {
    const onEvent = vi.fn();
    render(<Probe channel="ops:fleet" onEvent={onEvent} />);
    await waitFor(() => expect(hubClient.joinChannel).toHaveBeenCalled());

    act(() => hub.emit("ops:fleet", "serviceChanged", { service: "web" }));
    expect(onEvent).toHaveBeenCalledWith(
      "serviceChanged",
      expect.objectContaining({ service: "web" }),
    );

    // Events on other channels are ignored.
    act(() => hub.emit("ops:deploys", "deploy", {}));
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes the handler on unmount", async () => {
    const onEvent = vi.fn();
    const { unmount } = render(<Probe channel="ops:fleet" onEvent={onEvent} />);
    await waitFor(() => expect(hubClient.joinChannel).toHaveBeenCalled());

    unmount();
    act(() => hub.emit("ops:fleet", "serviceChanged", {}));
    expect(onEvent).not.toHaveBeenCalled();
  });
});

function DeployProbe({ onEvent }: { onEvent: ChannelHandler }) {
  const [id, setId] = useState<string | null>("d-1");
  useDeployProgress(id, onEvent);
  return (
    <button onClick={() => setId(null)} type="button">
      detach
    </button>
  );
}

describe("useDeployProgress", () => {
  it("only forwards events for the given deployId", async () => {
    const onEvent = vi.fn();
    render(<DeployProbe onEvent={onEvent} />);
    await waitFor(() =>
      expect(hubClient.joinChannel).toHaveBeenCalledWith("ops:deploys"),
    );

    act(() => hub.emit("ops:deploys", "deploy", { deployId: "d-9" }));
    expect(onEvent).not.toHaveBeenCalled();

    act(() => hub.emit("ops:deploys", "deploy", { deployId: "d-1" }));
    expect(onEvent).toHaveBeenCalledTimes(1);
  });
});

function FleetProbe({ onEvent }: { onEvent: ChannelHandler }) {
  useFleetStatus(onEvent);
  return null;
}

describe("useFleetStatus", () => {
  it("subscribes to the ops:fleet channel", async () => {
    render(<FleetProbe onEvent={() => {}} />);
    await waitFor(() =>
      expect(hubClient.joinChannel).toHaveBeenCalledWith("ops:fleet"),
    );
  });
});
