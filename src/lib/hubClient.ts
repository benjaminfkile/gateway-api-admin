import {
  type HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from "@microsoft/signalr";
import { getAccessToken } from "./cognitoClient";

// The gateway pushes live fleet and deploy events over a SignalR hub at `/hub`.
// A single shared connection is multiplexed across every logical channel the UI
// subscribes to ("ops:fleet", "ops:deploys"); hooks join/leave channels on top
// of it. Reconnect is automatic with a backoff so a flaky link self-heals, and
// pages keep polling as a fallback whenever the hub is unavailable.

const HUB_URL = `${(import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ""}/hub`;

/** Backoff (ms) between automatic reconnect attempts, then steady at 30s. */
const RECONNECT_BACKOFF_MS = [0, 2_000, 5_000, 10_000, 30_000];

/** Method the server invokes on the client to deliver a channel event. */
const CHANNEL_EVENT = "ChannelEvent";

/** A live event delivered on a channel. `event` names the server-side kind. */
export interface ChannelEvent {
  channel: string;
  event: string;
  [key: string]: unknown;
}

export type ChannelHandler = (payload: ChannelEvent) => void;
export type ConnectionStateListener = (state: HubConnectionState) => void;

/** Build (but do not start) a hub connection. Exported for testing/DI. */
export function buildHubConnection(): HubConnection {
  return new HubConnectionBuilder()
    .withUrl(HUB_URL, {
      // Cognito bearer token; SignalR re-invokes this on every (re)connect.
      accessTokenFactory: async () => (await getAccessToken()) ?? "",
    })
    .withAutomaticReconnect([...RECONNECT_BACKOFF_MS])
    .configureLogging(LogLevel.Warning)
    .build();
}

let connection: HubConnection | null = null;
let startPromise: Promise<void> | null = null;
const stateListeners = new Set<ConnectionStateListener>();

function notifyState(): void {
  const state = getConnectionState();
  for (const listener of stateListeners) listener(state);
}

/** Lazily create the one shared connection, wiring reconnect notifications. */
function getConnection(): HubConnection {
  if (!connection) {
    connection = buildHubConnection();
    connection.onreconnecting(notifyState);
    connection.onreconnected(notifyState);
    connection.onclose(notifyState);
  }
  return connection;
}

export function getConnectionState(): HubConnectionState {
  return connection?.state ?? HubConnectionState.Disconnected;
}

/**
 * Lazily start the one shared connection. Concurrent callers share the same
 * in-flight start; a failed start rejects so the caller can fall back to
 * polling, and later calls may retry.
 */
export async function ensureStarted(): Promise<HubConnection> {
  const conn = getConnection();
  if (conn.state === HubConnectionState.Disconnected && !startPromise) {
    startPromise = conn
      .start()
      .then(() => notifyState())
      .catch((err) => {
        notifyState();
        throw err;
      })
      .finally(() => {
        startPromise = null;
      });
  }
  if (startPromise) await startPromise;
  return conn;
}

/**
 * Fully stop the shared connection and drop it so no further automatic reconnect
 * attempts fire. Called on sign-out: a closed session must not keep retrying with
 * a stale token. A subsequent ensureStarted() (after a fresh sign-in) rebuilds a
 * new connection from scratch.
 */
export async function stopConnection(): Promise<void> {
  const conn = connection;
  connection = null;
  startPromise = null;
  if (conn) {
    try {
      await conn.stop();
    } finally {
      notifyState();
    }
  }
}

export function joinChannel(channel: string): Promise<void> {
  return getConnection().invoke("JoinChannel", channel);
}

export function leaveChannel(channel: string): Promise<void> {
  return getConnection().invoke("LeaveChannel", channel);
}

/**
 * Subscribe to events for a single channel. Registers a handler on the shared
 * connection and filters by channel; returns an unsubscribe that removes only
 * this handler.
 */
export function onChannelEvent(channel: string, handler: ChannelHandler): () => void {
  const conn = getConnection();
  const wrapped = (payload: ChannelEvent) => {
    if (payload?.channel === channel) handler(payload);
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
