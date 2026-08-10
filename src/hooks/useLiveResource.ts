import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { getLastEventAt } from "../lib/hubClient";
import { useOpsChannel } from "./useOpsChannel";

/**
 * Liveness window: a channel is "live" only if a ChannelEvent (heartbeat or
 * otherwise) arrived within this many ms. The gateway leader publishes a
 * "heartbeat" on ops:fleet every ~30s, so a healthy connection refreshes this
 * well inside the window; a green-but-deaf connection falls outside it and
 * correctly reads NOT live. 90s tolerates two missed heartbeats before the dot
 * goes grey and polling drops back to the fast cadence.
 */
export const LIVENESS_WINDOW_MS = 90_000;

/** Reducer that folds an incoming event's data payload into the current data. */
export type LiveReducer<T> = (prev: T, data: Record<string, unknown>) => T;

export interface UseLiveResourceOptions<T> {
  /** Hub channel to subscribe to (e.g. "ops:fleet", "ops:deploys"). */
  channel: string;
  /** Per-event reducers; an event with no entry here only proves freshness. */
  events: Record<string, LiveReducer<T>>;
  pollMs: {
    /** Fast cadence used while NOT live (the page's current polling rate). */
    fallback: number;
    /** Slow cadence used while live — events carry freshness, so polls back off. */
    reconcile: number;
  };
}

export interface UseLiveResource<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  /** Force an immediate refetch (e.g. after a mutation). */
  refresh: () => void;
  /** True only when Connected AND an event proved delivery within the window. */
  live: boolean;
  /** Time (ms) of the most recent event on this channel, or null. */
  lastEventAt: number | null;
}

/**
 * The reusable "live-with-a-polling-floor" primitive every page builds on.
 *
 * Polling is the floor and never stops: it fetches on mount and then on an
 * interval — `pollMs.reconcile` (slow) while live, `pollMs.fallback` (fast)
 * while not. Incoming events are folded into `data` through the matching reducer
 * and also reset the poll timer, so a stream of events keeps the reconcile poll
 * perpetually deferred.
 *
 * Liveness is delivery, not connection state: `live` is Connected AND a real
 * event (heartbeats included, tracked in the hub layer) arrived within
 * {@link LIVENESS_WINDOW_MS}. A connection that is up but silent therefore reads
 * NOT live and keeps fast-polling — the honest signal this dashboard was missing.
 *
 * The poll pauses while the tab is hidden (throttled background timers waste
 * requests and fire late) and fetches immediately when it becomes visible again.
 */
export function useLiveResource<T>(
  fetcher: () => Promise<T>,
  options: UseLiveResourceOptions<T>,
): UseLiveResource<T> {
  const { channel } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(() =>
    getLastEventAt(channel),
  );
  // A bare re-render trigger used to re-evaluate liveness when the window lapses
  // with no new event (the "went silent" transition has no other signal).
  const [, tick] = useReducer((n: number) => n + 1, 0);

  // Latest options/fetcher without re-subscribing or re-arming timers each render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const activeRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRef = useRef(false);

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const runFetch = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      if (!activeRef.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (!activeRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (activeRef.current) setLoading(false);
    }
  }, []);

  // (Re)arm the recurring poll from now, at the cadence liveness currently
  // dictates. Called on every reset point (mount, each event, liveness flip,
  // tab-visible) so the interval always reflects the latest state. Paused while
  // the tab is hidden — no timer is armed until it becomes visible again.
  const schedulePoll = useCallback(() => {
    clearPoll();
    if (typeof document !== "undefined" && document.hidden) return;
    const { fallback, reconcile } = optionsRef.current.pollMs;
    const interval = liveRef.current ? reconcile : fallback;
    pollTimerRef.current = setTimeout(() => {
      void runFetch();
      schedulePoll();
    }, interval);
  }, [clearPoll, runFetch]);

  // Derived liveness, recomputed every render (and forced by `tick` when the
  // window lapses). Connection state comes from the shared hub subscription.
  const { connected } = useOpsChannel(
    channel,
    useCallback(
      (event: string, eventData: Record<string, unknown>) => {
        const reducer = optionsRef.current.events[event];
        if (reducer) setData((prev) => (prev === null ? prev : reducer(prev, eventData)));
        // The hub already stamped lastEventAt for this channel; mirror it into
        // state so liveness recomputes, and reset the poll (freshness proven).
        setLastEventAt(getLastEventAt(channel) ?? Date.now());
        schedulePoll();
      },
      [channel, schedulePoll],
    ),
  );

  const live =
    connected && lastEventAt !== null && Date.now() - lastEventAt < LIVENESS_WINDOW_MS;

  // When liveness flips, the poll cadence must change immediately.
  useEffect(() => {
    if (liveRef.current !== live) {
      liveRef.current = live;
      if (activeRef.current) schedulePoll();
    }
  }, [live, schedulePoll]);

  // Arm a one-shot timer at the moment the current window would lapse, so a
  // channel that goes silent transitions to NOT live on time.
  useEffect(() => {
    if (!connected || lastEventAt === null) return;
    const remaining = lastEventAt + LIVENESS_WINDOW_MS - Date.now();
    if (remaining <= 0) return;
    const t = setTimeout(tick, remaining);
    return () => clearTimeout(t);
  }, [connected, lastEventAt]);

  // Mount: immediate fetch, then start polling; pause/resume on tab visibility.
  useEffect(() => {
    activeRef.current = true;
    setLastEventAt(getLastEventAt(channel));
    void runFetch().finally(() => {
      if (activeRef.current) schedulePoll();
    });

    const onVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.hidden) {
        clearPoll();
      } else {
        void runFetch();
        schedulePoll();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      activeRef.current = false;
      clearPoll();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [channel, runFetch, schedulePoll, clearPoll]);

  const refresh = useCallback(() => {
    void runFetch();
    schedulePoll();
  }, [runFetch, schedulePoll]);

  return { data, loading, error, refresh, live, lastEventAt };
}
