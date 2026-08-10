import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type HubConnection, HubConnectionState } from "@microsoft/signalr";

import {
  __testing,
  ensureStarted,
  getConnectionState,
  getLastEventAt,
  joinChannel,
  leaveChannel,
  nextBackoffDelayMs,
  onChannelEvent,
  reconnectPolicy,
  stopConnection,
} from "./hubClient";

// A stand-in for a real SignalR HubConnection. It exposes the surface hubClient
// uses (state, start/stop, on/off, invoke, on{reconnecting,reconnected,close})
// plus test drivers to simulate server pushes and connection lifecycle events.
class FakeConnection {
  state: HubConnectionState = HubConnectionState.Disconnected;
  startCount = 0;
  invoke = vi.fn((_method: string, ..._args: unknown[]) => Promise.resolve());
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  private reconnectedCbs: Array<() => void> = [];
  private reconnectingCbs: Array<() => void> = [];
  private closeCbs: Array<() => void> = [];
  private pendingStart: (() => void) | null = null;

  /** When true, start() stays pending until resolveStart() is called. */
  manualStart = false;

  start = vi.fn((): Promise<void> => {
    this.startCount++;
    this.state = HubConnectionState.Connecting;
    if (this.manualStart) {
      return new Promise<void>((resolve) => {
        this.pendingStart = () => {
          this.state = HubConnectionState.Connected;
          resolve();
        };
      });
    }
    this.state = HubConnectionState.Connected;
    return Promise.resolve();
  });

  resolveStart(): void {
    this.pendingStart?.();
    this.pendingStart = null;
  }

  stop = vi.fn((): Promise<void> => {
    this.state = HubConnectionState.Disconnected;
    this.closeCbs.forEach((cb) => cb());
    return Promise.resolve();
  });

  on(method: string, cb: (...args: unknown[]) => void): void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(cb);
  }

  off(method: string, cb: (...args: unknown[]) => void): void {
    this.handlers.get(method)?.delete(cb);
  }

  onreconnecting(cb: () => void): void {
    this.reconnectingCbs.push(cb);
  }
  onreconnected(cb: () => void): void {
    this.reconnectedCbs.push(cb);
  }
  onclose(cb: () => void): void {
    this.closeCbs.push(cb);
  }

  // ---- test drivers ----
  /** Simulate a server invoking a client method (e.g. "ChannelEvent"). */
  pushServer(method: string, payload: unknown): void {
    this.handlers.get(method)?.forEach((cb) => cb(payload));
  }
  /** Simulate SignalR's automatic reconnect succeeding. */
  triggerReconnected(): void {
    this.state = HubConnectionState.Connected;
    this.reconnectedCbs.forEach((cb) => cb());
  }
  /** Simulate a full close SignalR cannot recover from. */
  triggerClose(): void {
    this.state = HubConnectionState.Disconnected;
    this.closeCbs.forEach((cb) => cb());
  }
}

function useFake(fake = new FakeConnection()): FakeConnection {
  __testing.setConnectionFactory(() => fake as unknown as HubConnection);
  return fake;
}

beforeEach(() => {
  __testing.reset();
});

afterEach(() => {
  __testing.reset();
});

describe("reconnect backoff", () => {
  it("first attempt is immediate and the schedule caps at 30s + jitter", () => {
    expect(nextBackoffDelayMs(0)).toBe(0);
    // 0, 2s, 5s, 10s then a steady 30s cap (with up to 20% additive jitter).
    for (let i = 4; i < 50; i++) {
      const d = nextBackoffDelayMs(i);
      expect(d).toBeGreaterThanOrEqual(30_000);
      expect(d).toBeLessThanOrEqual(36_000);
    }
  });

  it("retry policy never returns null, for any attempt count", () => {
    for (let i = 0; i < 100; i++) {
      const delay = reconnectPolicy.nextRetryDelayInMilliseconds({
        previousRetryCount: i,
        elapsedMilliseconds: i * 1000,
        retryReason: new Error("drop"),
      });
      expect(delay).not.toBeNull();
      expect(typeof delay).toBe("number");
      expect(delay as number).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("ensureStarted", () => {
  it("starts the socket and reports Connected", async () => {
    const fake = useFake();
    await ensureStarted();
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(getConnectionState()).toBe(HubConnectionState.Connected);
  });

  it("resolves and joins when called mid-connect (Connecting state)", async () => {
    const fake = useFake();
    fake.manualStart = true;

    // First caller kicks off the start; the socket is now Connecting.
    const started = ensureStarted();
    expect(fake.state).toBe(HubConnectionState.Connecting);

    // A page mounting during the transition joins — it must await Connected
    // rather than invoking on a half-open socket.
    const joined = joinChannel("ops:fleet");

    fake.resolveStart();
    await Promise.all([started, joined]);

    expect(getConnectionState()).toBe(HubConnectionState.Connected);
    expect(fake.invoke).toHaveBeenCalledWith("JoinChannel", "ops:fleet");
  });
});

describe("channel rejoin", () => {
  it("re-invokes JoinChannel for every registered channel after a reconnect", async () => {
    const fake = useFake();
    await ensureStarted();
    await joinChannel("ops:fleet");
    await joinChannel("ops:deploys");

    fake.invoke.mockClear();
    fake.triggerReconnected();

    await vi.waitFor(() => {
      expect(fake.invoke).toHaveBeenCalledWith("JoinChannel", "ops:fleet");
      expect(fake.invoke).toHaveBeenCalledWith("JoinChannel", "ops:deploys");
    });
  });

  it("stops re-joining a channel after leaveChannel", async () => {
    const fake = useFake();
    await ensureStarted();
    await joinChannel("ops:fleet");
    await joinChannel("ops:deploys");
    await leaveChannel("ops:fleet");

    fake.invoke.mockClear();
    fake.triggerReconnected();

    await vi.waitFor(() =>
      expect(fake.invoke).toHaveBeenCalledWith("JoinChannel", "ops:deploys"),
    );
    expect(fake.invoke).not.toHaveBeenCalledWith("JoinChannel", "ops:fleet");
  });
});

describe("supervisor", () => {
  it("restarts the connection after an unexpected close", async () => {
    const fake = useFake();
    await ensureStarted();
    expect(fake.start).toHaveBeenCalledTimes(1);

    fake.triggerClose();

    await vi.waitFor(() => expect(fake.start).toHaveBeenCalledTimes(2));
    expect(getConnectionState()).toBe(HubConnectionState.Connected);
  });

  it("re-joins channels after a supervised restart", async () => {
    const fake = useFake();
    await ensureStarted();
    await joinChannel("ops:fleet");

    fake.invoke.mockClear();
    fake.triggerClose();

    await vi.waitFor(() =>
      expect(fake.invoke).toHaveBeenCalledWith("JoinChannel", "ops:fleet"),
    );
  });

  it("does not restart after an intentional stop (sign-out)", async () => {
    const fake = useFake();
    await ensureStarted();
    await stopConnection();

    // The old socket was stopped; nothing should have rebuilt/restarted it.
    expect(getConnectionState()).toBe(HubConnectionState.Disconnected);
    // Give any stray supervisor tick a chance to (wrongly) fire.
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.start).toHaveBeenCalledTimes(1);
  });
});

describe("wake/online recovery", () => {
  it("an online event kicks the supervisor when not Connected", async () => {
    const fake = useFake();
    await ensureStarted();
    // Simulate a silent drop (background-tab throttling) with no onclose.
    fake.state = HubConnectionState.Disconnected;

    window.dispatchEvent(new Event("online"));

    await vi.waitFor(() => expect(fake.start).toHaveBeenCalledTimes(2));
    expect(getConnectionState()).toBe(HubConnectionState.Connected);
  });

  it("a visibilitychange to visible kicks the supervisor when not Connected", async () => {
    const fake = useFake();
    await ensureStarted();
    fake.state = HubConnectionState.Disconnected;

    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => expect(fake.start).toHaveBeenCalledTimes(2));
  });

  it("does nothing when already Connected", async () => {
    const fake = useFake();
    await ensureStarted();

    window.dispatchEvent(new Event("online"));
    await new Promise((r) => setTimeout(r, 10));

    expect(fake.start).toHaveBeenCalledTimes(1);
  });
});

describe("envelope parsing", () => {
  it("dispatches by event name and extracts the data payload", () => {
    const fake = useFake();
    const received: Array<[string, Record<string, unknown>]> = [];
    const unsub = onChannelEvent("ops:deploys", (event, data) =>
      received.push([event, data]),
    );

    // The server pushes exactly one method, "ChannelEvent", carrying the
    // envelope { channel, event, data }; the client dispatches on event + data.
    fake.pushServer("ChannelEvent", {
      channel: "ops:deploys",
      event: "deploy",
      data: { deployId: "d-1", status: "done" },
    });
    expect(received).toEqual([["deploy", { deployId: "d-1", status: "done" }]]);

    // Events for other channels are filtered out.
    fake.pushServer("ChannelEvent", {
      channel: "ops:fleet",
      event: "heartbeat",
      data: { ts: "2026-08-10T00:00:00Z" },
    });
    expect(received).toHaveLength(1);

    unsub();
    fake.pushServer("ChannelEvent", {
      channel: "ops:deploys",
      event: "deploy",
      data: { deployId: "d-2" },
    });
    expect(received).toHaveLength(1); // unsubscribed handler no longer fires
  });
});

describe("liveness (lastEventAt)", () => {
  it("stamps lastEventAt for events on a joined channel — heartbeats included", async () => {
    const fake = useFake();
    await ensureStarted();
    await joinChannel("ops:fleet");

    expect(getLastEventAt("ops:fleet")).toBeNull();

    fake.pushServer("ChannelEvent", {
      channel: "ops:fleet",
      event: "heartbeat",
      data: { ts: "2026-08-10T00:00:00Z" },
    });

    const first = getLastEventAt("ops:fleet");
    expect(first).toBeTypeOf("number");
  });

  it("ignores events for channels the UI has not joined", async () => {
    const fake = useFake();
    // Connection exists (tap registered) and one channel is joined, but a stray
    // event for a *different*, unjoined channel must not register liveness.
    await ensureStarted();
    await joinChannel("ops:fleet");

    fake.pushServer("ChannelEvent", {
      channel: "ops:deploys",
      event: "deploy",
      data: {},
    });
    expect(getLastEventAt("ops:deploys")).toBeNull();
  });
});
