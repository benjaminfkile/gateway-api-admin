import { vi } from "vitest";
import { HubConnectionState } from "@microsoft/signalr";
import type * as HubClientModule from "../lib/hubClient";
import type { ChannelHandler } from "../lib/hubClient";

// Shared test double for `src/lib/hubClient`. Tests call `vi.mock("../lib/hubClient")`
// to auto-mock the module, then `installHubMock(hubClient)` in a beforeEach to wire
// in-memory join/leave/subscribe behaviour and expose controls for driving events
// and connection state — no real SignalR connection is ever created.

export interface HubMockControl {
  /**
   * Deliver the server envelope `{ channel, event, data }` to every handler
   * subscribed to `channel` — exactly as the real client parses it, so tests and
   * the wire contract can never drift.
   */
  emit(channel: string, event: string, data?: Record<string, unknown>): void;
  /** Force a connection-state transition and notify subscribers. */
  setState(state: HubConnectionState): void;
  joinChannel: ReturnType<typeof vi.fn>;
  leaveChannel: ReturnType<typeof vi.fn>;
  ensureStarted: ReturnType<typeof vi.fn>;
}

export function installHubMock(mod: typeof HubClientModule): HubMockControl {
  const channelHandlers = new Map<string, Set<ChannelHandler>>();
  const stateListeners = new Set<(s: HubConnectionState) => void>();
  // Mirrors the real client's lastEventAt tap: any emitted ChannelEvent stamps
  // its channel, so liveness in tests is driven by the same wire proof (a
  // heartbeat on ops:fleet, a deploy event, etc.) the gateway sends.
  const lastEventAt = new Map<string, number>();
  let state: HubConnectionState = HubConnectionState.Disconnected;

  const notify = () => stateListeners.forEach((listener) => listener(state));

  vi.mocked(mod.getConnectionState).mockImplementation(() => state);
  vi.mocked(mod.getLastEventAt).mockImplementation(
    (channel) => lastEventAt.get(channel) ?? null,
  );

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
    emit(channel, event, data = {}) {
      // Stamp lastEventAt before dispatch, exactly as the real client's central
      // tap runs ahead of per-subscriber handlers.
      lastEventAt.set(channel, Date.now());
      const set = channelHandlers.get(channel);
      set?.forEach((handler) => handler(event, data));
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
