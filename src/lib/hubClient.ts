import {
  type HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  type IRetryPolicy,
  LogLevel,
  type RetryContext,
} from "@microsoft/signalr";
import { getAccessToken } from "./cognitoClient";

// The gateway pushes live fleet and deploy events over a SignalR hub at `/hub`.
// A single shared connection is multiplexed across every logical channel the UI
// subscribes to ("ops:fleet", "ops:deploys"); hooks join/leave channels on top
// of it.
//
// Self-healing is layered:
//   - `reconnectPolicy` drives SignalR's own automatic reconnect with an
//     UNBOUNDED backoff (0, 2s, 5s, 10s, then 30s forever + jitter) so a flaky
//     link never exhausts a finite budget and gives up.
//   - a supervisor restarts the connection from scratch on `onclose` (a state
//     SignalR's reconnect does not recover from) until it is Connected again.
//   - `visibilitychange`/`online` listeners kick the supervisor immediately when
//     a backgrounded tab wakes or the network returns, skipping backoff delay.
//   - every channel the UI has joined is tracked and re-joined after any
//     reconnect (the server assigns a fresh connection id, dropping groups).
// Pages keep polling as a fallback whenever the hub is unavailable.

const HUB_URL = `${(import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ""}/hub`;

/**
 * Reconnect backoff (ms): 0, then 2s, 5s, 10s, then 30s forever. Each delay gets
 * up to 20% additive random jitter so a fleet of tabs does not reconnect in
 * lockstep after a shared outage.
 */
const RECONNECT_BACKOFF_MS = [0, 2_000, 5_000, 10_000];
const RECONNECT_STEADY_MS = 30_000;
const RECONNECT_JITTER = 0.2;

/**
 * Backoff for retry attempt `retryCount` (0-based), with jitter applied. Never
 * returns null: the sequence caps at 30s and repeats indefinitely so the client
 * keeps trying to reconnect for as long as the page is open.
 */
export function nextBackoffDelayMs(retryCount: number): number {
  const base =
    retryCount < RECONNECT_BACKOFF_MS.length
      ? RECONNECT_BACKOFF_MS[retryCount]
      : RECONNECT_STEADY_MS;
  return base + base * RECONNECT_JITTER * Math.random();
}

/**
 * SignalR reconnect policy with an unbounded schedule. The default array-based
 * policy appends a terminating null, so ~47s after a drop the client fires
 * `onclose` and never retries again; this policy always returns a delay.
 */
export const reconnectPolicy: IRetryPolicy = {
  nextRetryDelayInMilliseconds(retryContext: RetryContext): number {
    return nextBackoffDelayMs(retryContext.previousRetryCount);
  },
};

/** Method the server invokes on the client to deliver a channel event. */
const CHANNEL_EVENT = "ChannelEvent";

/**
 * The single envelope the gateway pushes over `ChannelEvent`. `channel` names
 * the logical stream, `event` the server-side kind, and `data` the typed
 * payload for that kind.
 */
export interface ChannelEvent {
  channel: string;
  event: string;
  data: Record<string, unknown>;
}

/** Payload object carried by a channel event's `data` field. */
export type ChannelEventData = Record<string, unknown>;

/** Handler for a single channel: receives the event name and its data payload. */
export type ChannelHandler = (event: string, data: ChannelEventData) => void;
export type ConnectionStateListener = (state: HubConnectionState) => void;

/** Build (but do not start) a hub connection. Exported for testing/DI. */
export function buildHubConnection(): HubConnection {
  return new HubConnectionBuilder()
    .withUrl(HUB_URL, {
      // Cognito bearer token; SignalR re-invokes this on every (re)connect.
      accessTokenFactory: async () => (await getAccessToken()) ?? "",
    })
    .withAutomaticReconnect(reconnectPolicy)
    // Information in dev so the reconnect narrative is visible in the console;
    // Warning in prod to keep noise down.
    .configureLogging(import.meta.env.DEV ? LogLevel.Information : LogLevel.Warning)
    .build();
}

/** Swappable factory so tests can inject a fake connection. */
let connectionFactory: () => HubConnection = buildHubConnection;

let connection: HubConnection | null = null;
let startPromise: Promise<void> | null = null;
const stateListeners = new Set<ConnectionStateListener>();

/** Channels the UI has joined; re-joined after every reconnect. */
const joinedChannels = new Set<string>();

// Supervisor state. `supervisorActive` gates all restart work so an intentional
// stop (sign-out) cannot resurrect the connection.
let supervisorActive = false;
let supervisorAttempts = 0;
let supervisorTimer: ReturnType<typeof setTimeout> | null = null;
let intentionalStop = false;

function notifyState(): void {
  const state = getConnectionState();
  for (const listener of stateListeners) listener(state);
}

/** Resolve on the next connection-state notification. */
function waitForStateChange(): Promise<void> {
  return new Promise((resolve) => {
    const unsub = subscribeConnectionState(() => {
      unsub();
      resolve();
    });
  });
}

/** Lazily create the one shared connection, wiring reconnect + rejoin. */
function getConnection(): HubConnection {
  if (!connection) {
    connection = connectionFactory();
    connection.onreconnecting(notifyState);
    connection.onreconnected(() => {
      notifyState();
      // A reconnect gets a fresh server-side connection id, so every group is
      // gone — re-join everything the UI is subscribed to.
      void rejoinChannels();
    });
    connection.onclose(() => {
      notifyState();
      // SignalR's automatic reconnect does not recover from a full close; the
      // supervisor restarts from scratch. Skip it for an intentional stop.
      if (!intentionalStop) startSupervisor();
    });
  }
  return connection;
}

export function getConnectionState(): HubConnectionState {
  return connection?.state ?? HubConnectionState.Disconnected;
}

/** Re-invoke JoinChannel for every registered channel on the live connection. */
async function rejoinChannels(): Promise<void> {
  const conn = connection;
  if (!conn || conn.state !== HubConnectionState.Connected) return;
  for (const channel of joinedChannels) {
    try {
      await conn.invoke("JoinChannel", channel);
    } catch {
      // A failed re-join will be retried on the next reconnect/supervisor tick.
    }
  }
}

/**
 * Lazily start the one shared connection, awaiting any in-flight transition
 * first so a caller that arrives mid-(re)connect resolves once the socket is
 * actually Connected rather than acting on a half-open one. Concurrent callers
 * share the same in-flight start; a failed start rejects so the caller can fall
 * back to polling, and later calls may retry.
 */
export async function ensureStarted(): Promise<HubConnection> {
  const conn = getConnection();
  for (;;) {
    switch (conn.state) {
      case HubConnectionState.Connected:
        return conn;
      case HubConnectionState.Connecting:
      case HubConnectionState.Reconnecting:
        // A transition is under way. If we own the start, await it; otherwise
        // (SignalR-driven reconnect) wait for the next state change and re-check.
        if (startPromise) await startPromise;
        else await waitForStateChange();
        break;
      default: {
        // Disconnected (or Disconnecting settling): (re)start the socket.
        if (!startPromise) {
          startPromise = conn
            .start()
            .then(() => {
              notifyState();
              void rejoinChannels();
            })
            .catch((err) => {
              notifyState();
              throw err;
            })
            .finally(() => {
              startPromise = null;
            });
        }
        await startPromise;
      }
    }
  }
}

/** Schedule the next supervisor tick (backoff, or immediate to skip it). */
function scheduleSupervisorTick(immediate = false): void {
  if (!supervisorActive || supervisorTimer) return;
  if (getConnectionState() === HubConnectionState.Connected) {
    supervisorAttempts = 0;
    supervisorActive = false;
    return;
  }
  const delay = immediate ? 0 : nextBackoffDelayMs(supervisorAttempts);
  supervisorTimer = setTimeout(() => {
    supervisorTimer = null;
    void supervisorTick();
  }, delay);
}

async function supervisorTick(): Promise<void> {
  if (!supervisorActive) return;
  if (getConnectionState() === HubConnectionState.Connected) {
    supervisorAttempts = 0;
    supervisorActive = false;
    return;
  }
  supervisorAttempts++;
  try {
    await ensureStarted();
    // Connected again: re-join channels (a restart drops all groups) and rest.
    await rejoinChannels();
    supervisorAttempts = 0;
    supervisorActive = false;
  } catch {
    // Still down — back off and try again.
    scheduleSupervisorTick();
  }
}

/** Begin (or continue) supervising toward a Connected state. */
function startSupervisor(): void {
  if (intentionalStop) return;
  supervisorActive = true;
  scheduleSupervisorTick();
}

/**
 * Wake/online recovery: a backgrounded tab's timers are throttled, so its
 * backoff can stall for minutes. When the tab becomes visible or the network
 * returns, kick the supervisor immediately (skipping any pending backoff) if the
 * connection exists but is not Connected.
 */
function kickSupervisor(): void {
  if (!connection || intentionalStop) return;
  if (connection.state === HubConnectionState.Connected) return;
  if (supervisorTimer) {
    clearTimeout(supervisorTimer);
    supervisorTimer = null;
  }
  supervisorAttempts = 0;
  supervisorActive = true;
  scheduleSupervisorTick(true);
}

if (typeof window !== "undefined") {
  window.addEventListener("online", kickSupervisor);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") kickSupervisor();
  });
}

/**
 * Fully stop the shared connection and drop it so no further automatic reconnect
 * or supervisor attempts fire. Called on sign-out: a closed session must not keep
 * retrying with a stale token. A subsequent ensureStarted() (after a fresh
 * sign-in) rebuilds a new connection from scratch.
 */
export async function stopConnection(): Promise<void> {
  const conn = connection;
  intentionalStop = true;
  connection = null;
  startPromise = null;
  supervisorActive = false;
  supervisorAttempts = 0;
  if (supervisorTimer) {
    clearTimeout(supervisorTimer);
    supervisorTimer = null;
  }
  joinedChannels.clear();
  try {
    if (conn) {
      try {
        await conn.stop();
      } finally {
        notifyState();
      }
    }
  } finally {
    intentionalStop = false;
  }
}

/**
 * Join a channel. Registers it so it is re-joined after every reconnect, then
 * waits (via ensureStarted) for a Connected socket before invoking so a call
 * during a transition does not throw on a not-yet-open connection.
 */
export async function joinChannel(channel: string): Promise<void> {
  joinedChannels.add(channel);
  const conn = await ensureStarted();
  await conn.invoke("JoinChannel", channel);
}

/** Leave a channel and stop re-joining it. Best-effort when already offline. */
export async function leaveChannel(channel: string): Promise<void> {
  joinedChannels.delete(channel);
  const conn = connection;
  if (conn && conn.state === HubConnectionState.Connected) {
    await conn.invoke("LeaveChannel", channel);
  }
}

/**
 * Subscribe to events for a single channel. Registers a handler on the shared
 * connection, filters by channel, and hands the handler the parsed envelope's
 * event name and data payload — so client and server can never drift on shape.
 * Returns an unsubscribe that removes only this handler.
 */
export function onChannelEvent(channel: string, handler: ChannelHandler): () => void {
  const conn = getConnection();
  const wrapped = (payload: ChannelEvent) => {
    if (payload?.channel === channel) handler(payload.event, payload.data ?? {});
  };
  conn.on(CHANNEL_EVENT, wrapped);
  return () => conn.off(CHANNEL_EVENT, wrapped);
}

/** Subscribe to connection-state changes; returns an unsubscribe. */
export function subscribeConnectionState(listener: ConnectionStateListener): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/** Test-only hooks: inject a fake connection factory and reset module state. */
export const __testing = {
  setConnectionFactory(factory: () => HubConnection): void {
    connectionFactory = factory;
  },
  reset(): void {
    connectionFactory = buildHubConnection;
    connection = null;
    startPromise = null;
    stateListeners.clear();
    joinedChannels.clear();
    supervisorActive = false;
    supervisorAttempts = 0;
    intentionalStop = false;
    if (supervisorTimer) {
      clearTimeout(supervisorTimer);
      supervisorTimer = null;
    }
  },
  kickSupervisor,
  joinedChannels,
};
