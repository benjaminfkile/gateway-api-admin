import { vi } from "vitest";
import { HubConnectionState } from "@microsoft/signalr";
import type * as HubClientModule from "../lib/hubClient";
import type { ChannelEvent } from "../lib/hubClient";

// Shared test double for `src/lib/hubClient`. Tests call `vi.mock("../lib/hubClient")`
// to auto-mock the module, then `installHubMock(hubClient)` in a beforeEach to wire
// in-memory join/leave/subscribe behaviour and expose controls for driving events
// and connection state — no real SignalR connection is ever created.

export interface HubMockControl {
  /** Deliver an event to every handler subscribed to `channel`. */
  emit(channel: string, event: Record<string, unknown>): void;
  /** Force a connection-state transition and notify subscribers. */
  setState(state: HubConnectionState): void;
  joinChannel: ReturnType<typeof vi.fn>;
  leaveChannel: ReturnType<typeof vi.fn>;
  ensureStarted: ReturnType<typeof vi.fn>;
}

export function installHubMock(mod: typeof HubClientModule): HubMockControl {
  const channelHandlers = new Map<string, Set<(e: ChannelEvent) => void>>();
  const stateListeners = new Set<(s: HubConnectionState) => void>();
  let state: HubConnectionState = HubConnectionState.Disconnected;

  const notify = () => stateListeners.forEach((listener) => listener(state));

  vi.mocked(mod.getConnectionState).mockImplementation(() => state);

  vi.mocked(mod.ensureStarted).mockImplementation(() => {
    state = HubConnectionState.Connected;
    notify();
    return Promise.resolve({} as never);
  });

  vi.mocked(mod.joinChannel).mockResolvedValue(undefined);
  vi.mocked(mod.leaveChannel).mockResolvedValue(undefined);

  vi.mocked(mod.onChannelEvent).mockImplementation((channel, handler) => {
    let set = channelHandlers.get(channel);
    if (!set) {
      set = new Set();
      channelHandlers.set(channel, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  });

  vi.mocked(mod.subscribeConnectionState).mockImplementation((listener) => {
    stateListeners.add(listener);
    return () => {
      stateListeners.delete(listener);
    };
  });

  return {
    emit(channel, event) {
      const set = channelHandlers.get(channel);
      set?.forEach((handler) =>
        handler({ channel, event: "update", ...event } as ChannelEvent),
      );
    },
    setState(next) {
      state = next;
      notify();
    },
    joinChannel: vi.mocked(mod.joinChannel),
    leaveChannel: vi.mocked(mod.leaveChannel),
    ensureStarted: vi.mocked(mod.ensureStarted),
  };
}
