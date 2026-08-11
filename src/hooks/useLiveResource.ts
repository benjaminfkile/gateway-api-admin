import { useCallback, useEffect, useRef, useState } from "react";
import {
  getLastEventAt,
  joinChannel,
  leaveChannel,
  onChannelEvent,
} from "../lib/hubClient";
import { useOpsChannel } from "./useOpsChannel";

/**
 * Default channel liveness keys off. Heartbeats are published only on
 * "ops:fleet", so every page — even ones subscribed to a non-heartbeat event
 * channel like "ops:deploys" — sources its live dot from here unless it opts out
 * (finding 3). A page keyed to a silent channel would otherwise read offline
 * forever and fast-poll indefinitely on an idle system.
 */
export const DEFAULT_LIVENESS_CHANNEL = "ops:fleet";

/**
 * Liveness window: a channel is "live" only if a ChannelEvent (heartbeat or
 * otherwise) arrived within this many ms. The gateway leader publishes a
 * "heartbeat" on ops:fleet every ~30s, so a healthy connection refreshes this
 * well inside the window; a green-but-deaf connection falls outside it and
 * correctly reads NOT live. 90s tolerates two missed heartbeats before the dot
 * goes grey and polling drops back to the fast cadence.
 */
export const LIVENESS_WINDOW_MS = 90_000;

/**
 * How often the derived `live` boolean is re-evaluated when nothing else forces
 * it. Coarse on purpose: the "went silent" transition has no event to ride on,
 * so a low-frequency timer flips the dot to grey shortly after the window lapses
 * without re-rendering the page on every incoming heartbeat.
 */
export const LIVENESS_CHECK_MS = 5_000;

/** Reducer that folds an incoming event's data payload into the current data. */
export type LiveReducer<T> = (prev: T, data: Record<string, unknown>) => T;

export interface UseLiveResourceOptions<T> {
  /** Hub channel to subscribe to (e.g. "ops:fleet", "ops:deploys"). */
  channel: string;
  /**
   * Channel whose events prove liveness (drive the dot and the reconcile/fallback
   * cadence). Defaults to {@link DEFAULT_LIVENESS_CHANNEL} ("ops:fleet"), the only
   * channel carrying heartbeats. Event SUBSCRIPTION stays on `channel`; when the
   * two differ the hook also joins this channel purely to source freshness.
   */
  livenessChannel?: string;
  /** Per-event reducers; an event with no entry here only proves freshness. */
  events?: Record<string, LiveReducer<T>>;
  /**
   * Event names that force an immediate refetch instead of a client-side patch.
   * For data too composite to fold in from an event payload (e.g. instance rows),
   * a refetch is the honest way to reconcile — the event still proves freshness.
   */
  refetchOn?: string[];
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
 * Polling is the floor and never stops: it fetches on mount and then on a FIXED
 * cadence — `pollMs.reconcile` (slow) while live, `pollMs.fallback` (fast) while
 * not. Crucially the poll timer is re-armed only by a completed fetch (and by a
 * cadence change or tab-visibility), never by an incoming event: a stream of
 * heartbeats must NOT keep the reconcile poll perpetually deferred, or data with
 * no matching reducer would freeze at mount-time values under a green dot.
 * Incoming events only fold their payload into `data` through the matching
 * reducer (or force a refetch) and select which cadence applies.
 *
 * Liveness is delivery, not connection state: `live` is Connected AND a real
 * event (heartbeats included, tracked in the hub layer) arrived within
 * {@link LIVENESS_WINDOW_MS}. A connection that is up but silent therefore reads
 * NOT live and keeps fast-polling — the honest signal this dashboard was missing.
 * `lastEventAt` lives in a ref and only the derived boolean is state, so a busy
 * channel does not re-render the page on every heartbeat.
 *
 * The poll pauses while the tab is hidden (throttled background timers waste
 * requests and fire late) and fetches immediately when it becomes visible again.
 */
export function useLiveResource<T>(
  fetcher: () => Promise<T>,
  options: UseLiveResourceOptions<T>,
): UseLiveResource<T> {
  const { channel } = options;
  const livenessChannel = options.livenessChannel ?? DEFAULT_LIVENESS_CHANNEL;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  // Only the boolean verdict is state; the raw timestamp is a ref (below) so an
  // event stream does not force a render per heartbeat.
  const [liveState, setLiveState] = useState(false);

  // Latest options/fetcher without re-subscribing or re-arming timers each render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const activeRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRef = useRef(false);
  const connectedRef = useRef(false);
  // Mirror of `data` readable synchronously inside the event handler, so a
  // reducer folds onto the latest committed value even between renders.
  const dataRef = useRef<T | null>(null);
  // Monotonic fetch id: only the newest fetch may commit (older ones are
  // superseded). Paired with the event counter below for stale-response guarding.
  const fetchIdRef = useRef(0);
  // Bumped whenever an event MUTATES state (a reducer applied). A fetch that
  // started before such an event carries a snapshot older than what the event
  // just patched, so its response must be discarded (finding 2).
  const eventSeqRef = useRef(0);
  // Set when an event could not be applied because `data` was still null (the
  // initial fetch was in flight). Forces an immediate refetch once that fetch
  // settles, so the change is not silently lost under a green dot (finding 3).
  const pendingRefetchRef = useRef(false);

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const runFetch = useCallback(async () => {
    const myId = ++fetchIdRef.current;
    const startSeq = eventSeqRef.current;
    try {
      const result = await fetcherRef.current();
      if (!activeRef.current) return;
      // A newer fetch has since started (e.g. a refetchOn event or refresh); let
      // it own the result and drop this one silently.
      if (myId !== fetchIdRef.current) return;
      // Finding 2: an event mutated state after this fetch started, so its
      // response is stale relative to what the reducer already patched. Discard
      // it and trigger one immediate follow-up — a fresh fetch beats a stale merge.
      if (eventSeqRef.current !== startSeq) {
        void runFetch();
        return;
      }
      setData(result);
      dataRef.current = result;
      setError(null);
    } catch (err) {
      if (!activeRef.current || myId !== fetchIdRef.current) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (activeRef.current && myId === fetchIdRef.current) {
        setLoading(false);
        // Finding 3: an event arrived while data was null and had to be dropped;
        // now that we have a baseline, refetch immediately so it is not lost.
        if (pendingRefetchRef.current) {
          pendingRefetchRef.current = false;
          void runFetch();
        }
      }
    }
  }, []);

  // Re-evaluate the derived `live` boolean from the current refs and flip state
  // only when it actually changes — the render-cheap heart of finding 4.
  const recomputeLive = useCallback(() => {
    // Liveness is sourced from the (heartbeat-bearing) liveness channel, read
    // straight from the hub tap so a separate liveness channel stays honest even
    // when the event channel is silent (finding 3).
    const last = getLastEventAt(livenessChannel);
    const next =
      connectedRef.current &&
      last !== null &&
      Date.now() - last < LIVENESS_WINDOW_MS;
    if (next !== liveRef.current) {
      liveRef.current = next;
      setLiveState(next);
    }
  }, [livenessChannel]);

  // (Re)arm the recurring poll from now, at the cadence liveness currently
  // dictates. Called only at legitimate reset points — mount, a cadence change,
  // tab-visible, refresh, and the completion of each poll fetch — never per
  // event, so heartbeats cannot defer the reconcile poll (finding 1). Paused
  // while the tab is hidden: no timer is armed until it becomes visible again.
  const schedulePoll = useCallback(() => {
    clearPoll();
    if (typeof document !== "undefined" && document.hidden) return;
    const { fallback, reconcile } = optionsRef.current.pollMs;
    const interval = liveRef.current ? reconcile : fallback;
    pollTimerRef.current = setTimeout(() => {
      pollTimerRef.current = null;
      // Only a completed fetch re-arms the timer, keeping the cadence fixed.
      void runFetch().finally(() => {
        if (activeRef.current) schedulePoll();
      });
    }, interval);
  }, [clearPoll, runFetch]);

  const { connected } = useOpsChannel(
    channel,
    useCallback(
      (event: string, eventData: Record<string, unknown>) => {
        const opts = optionsRef.current;
        const reducer = opts.events?.[event];
        if (reducer) {
          if (dataRef.current === null) {
            // Can't fold onto a null baseline; force a refetch once one lands.
            pendingRefetchRef.current = true;
          } else {
            const next = reducer(dataRef.current, eventData);
            dataRef.current = next;
            setData(next);
            // Mark that state changed so an in-flight fetch's stale response is
            // discarded rather than reverting the patch (finding 2).
            eventSeqRef.current += 1;
          }
        }
        // Some events carry too little to patch a composite row from; refetch.
        if (opts.refetchOn?.includes(event)) void runFetch();
        // An event on the subscribed channel may itself prove freshness (when it
        // IS the liveness channel); re-evaluate the dot from the hub tap.
        recomputeLive();
      },
      [recomputeLive, runFetch],
    ),
  );

  // Liveness subscription (finding 3): when the liveness channel differs from the
  // event channel, join it too so its heartbeats stamp the hub tap and flip the
  // dot promptly. When they are the same, the primary subscription above already
  // covers it — skip to avoid a redundant join/leave.
  useEffect(() => {
    if (livenessChannel === channel) return;
    let active = true;
    const unsub = onChannelEvent(livenessChannel, () => {
      if (active) recomputeLive();
    });
    void joinChannel(livenessChannel).catch(() => {});
    return () => {
      active = false;
      unsub();
      void leaveChannel(livenessChannel).catch(() => {});
    };
  }, [livenessChannel, channel, recomputeLive]);

  // Re-arm the poll whenever the cadence it should run at changes: either
  // liveness flipped (reconcile ⇄ fallback) or the caller tightened/loosened a
  // cadence between renders (e.g. a page whose fallback drops to 5s while a
  // rollout is in flight, then back to 30s once it settles). Reading the value
  // here — not just `live` — keeps an adaptive `pollMs.fallback` honest.
  const effectiveInterval = liveState
    ? options.pollMs.reconcile
    : options.pollMs.fallback;
  useEffect(() => {
    liveRef.current = liveState;
    if (activeRef.current) schedulePoll();
  }, [effectiveInterval, liveState, schedulePoll]);

  // Track connection state in a ref and re-evaluate liveness when it changes.
  useEffect(() => {
    connectedRef.current = connected;
    recomputeLive();
  }, [connected, recomputeLive]);

  // Coarse liveness heartbeat: flips the dot to grey shortly after a silent
  // channel's window lapses, without any event to ride on. State only changes
  // when the boolean actually flips (finding 4).
  useEffect(() => {
    const id = setInterval(recomputeLive, LIVENESS_CHECK_MS);
    return () => clearInterval(id);
  }, [recomputeLive]);

  // Mount: immediate fetch, then start polling; pause/resume on tab visibility.
  useEffect(() => {
    activeRef.current = true;
    recomputeLive();
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
  }, [channel, runFetch, schedulePoll, clearPoll, recomputeLive]);

  const refresh = useCallback(() => {
    void runFetch();
    schedulePoll();
  }, [runFetch, schedulePoll]);

  return {
    data,
    loading,
    error,
    refresh,
    live: liveState,
    // Exposed via a getter reading the hub tap so tooltips see the latest
    // timestamp without the hook re-rendering the page on every event (finding 4).
    get lastEventAt() {
      return getLastEventAt(livenessChannel);
    },
  };
}
