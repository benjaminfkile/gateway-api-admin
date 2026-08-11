import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import * as hubClient from "../lib/hubClient";
vi.mock("../lib/hubClient");

import { installHubMock, type HubMockControl } from "../test/hubClientMock";
import {
  REFETCH_DEBOUNCE_MS,
  useLiveResource,
  type UseLiveResourceOptions,
} from "./useLiveResource";

let hub: HubMockControl;

beforeEach(() => {
  vi.useFakeTimers();
  hub = installHubMock(hubClient);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** Flush pending microtasks (promise chains) under fake timers. */
async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

const POLL = { fallback: 30_000, reconcile: 90_000 };

function Probe<T>({
  fetcher,
  options,
}: {
  fetcher: () => Promise<T>;
  options: UseLiveResourceOptions<T>;
}) {
  const { data, live, loading, error, refresh } = useLiveResource(fetcher, options);
  return (
    <div>
      <span data-testid="data">{JSON.stringify(data)}</span>
      <span data-testid="live">{live ? "live" : "offline"}</span>
      <span data-testid="loading">{loading ? "loading" : "ready"}</span>
      <span data-testid="error">{error ? error.message : ""}</span>
      <button type="button" onClick={refresh}>
        refresh
      </button>
    </div>
  );
}

describe("useLiveResource", () => {
  it("fetches immediately on mount and clears loading", async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    render(
      <Probe fetcher={fetcher} options={{ channel: "ops:fleet", events: {}, pollMs: POLL }} />,
    );

    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("data")).toHaveTextContent('{"n":1}');
    expect(screen.getByTestId("loading")).toHaveTextContent("ready");
  });

  it("is offline (and fast-polls) when connected but deaf, then live on a heartbeat", async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    render(
      <Probe fetcher={fetcher} options={{ channel: "ops:fleet", events: {}, pollMs: POLL }} />,
    );

    await flush();
    // Connected (ensureStarted) but no event has arrived: the green-but-deaf case.
    expect(screen.getByTestId("live")).toHaveTextContent("offline");

    // Fast cadence: a fallback interval fires another fetch.
    await advance(POLL.fallback);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // A heartbeat proves delivery: goes live and switches to the slow cadence.
    await act(async () => {
      hub.emit("ops:fleet", "heartbeat", { ts: "2026-08-10T00:00:00Z" });
    });
    expect(screen.getByTestId("live")).toHaveTextContent("live");

    fetcher.mockClear();
    // A full fallback interval passes with no fetch — reconcile cadence is slower.
    await advance(POLL.fallback);
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.getByTestId("live")).toHaveTextContent("live");
  });

  it("switches back to grey + fast polling when the liveness window lapses", async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    render(
      <Probe fetcher={fetcher} options={{ channel: "ops:fleet", events: {}, pollMs: POLL }} />,
    );
    await flush();

    await act(async () => {
      hub.emit("ops:fleet", "heartbeat", { ts: "2026-08-10T00:00:00Z" });
    });
    expect(screen.getByTestId("live")).toHaveTextContent("live");

    fetcher.mockClear();
    // No further heartbeats: after the 90s window the dot goes grey and the
    // deferred reconcile poll fires.
    await advance(90_001);
    expect(screen.getByTestId("live")).toHaveTextContent("offline");
    expect(fetcher).toHaveBeenCalled();

    // And fast polling resumes.
    fetcher.mockClear();
    await advance(POLL.fallback);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("applies incoming events through the matching reducer", async () => {
    const fetcher = vi.fn().mockResolvedValue({ items: ["a"] as string[] });
    const options: UseLiveResourceOptions<{ items: string[] }> = {
      channel: "ops:deploys",
      events: {
        deploy: (prev, data) => ({ items: [...prev.items, data.id as string] }),
      },
      pollMs: POLL,
    };
    render(<Probe fetcher={fetcher} options={options} />);
    await flush();
    expect(screen.getByTestId("data")).toHaveTextContent('{"items":["a"]}');

    await act(async () => {
      hub.emit("ops:deploys", "deploy", { id: "b" });
    });
    expect(screen.getByTestId("data")).toHaveTextContent('{"items":["a","b"]}');

    // An event with no matching reducer only proves freshness — data unchanged.
    await act(async () => {
      hub.emit("ops:deploys", "somethingElse", { id: "c" });
    });
    expect(screen.getByTestId("data")).toHaveTextContent('{"items":["a","b"]}');
  });

  it("refetches on an event listed in refetchOn instead of patching", async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    render(
      <Probe
        fetcher={fetcher}
        options={{
          channel: "ops:fleet",
          events: {},
          refetchOn: ["instances"],
          pollMs: POLL,
        }}
      />,
    );
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // A refetch-triggering event refetches after the coalescing window — and a
    // BURST of them coalesces into ONE fetch (review finding: a rollout emitting
    // one composite event per instance transition must not GET per event).
    await act(async () => {
      hub.emit("ops:fleet", "instances", { joined: [], pruned: [] });
      hub.emit("ops:fleet", "instances", { joined: ["i-9"], pruned: [] });
      hub.emit("ops:fleet", "instances", { joined: [], pruned: ["i-2"] });
    });
    expect(fetcher).toHaveBeenCalledTimes(1); // nothing until the window elapses
    await advance(REFETCH_DEBOUNCE_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // An event NOT in refetchOn only proves freshness — no refetch.
    await act(async () => {
      hub.emit("ops:fleet", "leaderChange", { instanceId: "i-1" });
    });
    await advance(REFETCH_DEBOUNCE_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("re-arms the poll when an adaptive fallback cadence changes", async () => {
    // Fallback tightens to 5s while `active` is true, relaxes to 30s otherwise —
    // the shape DeploysPage uses. Never live (no events), so fallback governs.
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    function Adaptive({ active }: { active: boolean }) {
      const { data } = useLiveResource(fetcher, {
        channel: "ops:fleet",
        events: {},
        pollMs: { fallback: active ? 5_000 : 30_000, reconcile: 90_000 },
      });
      return <span data-testid="data">{JSON.stringify(data)}</span>;
    }

    const { rerender } = render(<Adaptive active />);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Fast cadence: a 5s tick refetches.
    await advance(5_000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Relax to the idle cadence: the 5s timer is dropped and re-armed at 30s.
    rerender(<Adaptive active={false} />);
    await advance(5_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await advance(25_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("refresh() forces an immediate fetch", async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    render(
      <Probe fetcher={fetcher} options={{ channel: "ops:fleet", events: {}, pollMs: POLL }} />,
    );
    await flush();

    fetcher.mockClear();
    await act(async () => {
      screen.getByText("refresh").click();
    });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("pauses polling while the tab is hidden and fetches on becoming visible", async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    render(
      <Probe fetcher={fetcher} options={{ channel: "ops:fleet", events: {}, pollMs: POLL }} />,
    );
    await flush();

    fetcher.mockClear();
    setHidden(true);
    // Several intervals pass while hidden: no polling.
    await advance(POLL.fallback * 3);
    expect(fetcher).not.toHaveBeenCalled();

    // Becoming visible fetches immediately and resumes polling.
    await act(async () => {
      setHidden(false);
    });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await advance(POLL.fallback);
    expect(fetcher).toHaveBeenCalledTimes(2);

    setHidden(false);
  });

  it("surfaces fetch errors", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("boom"));
    render(
      <Probe fetcher={fetcher} options={{ channel: "ops:fleet", events: {}, pollMs: POLL }} />,
    );
    await flush();
    expect(screen.getByTestId("error")).toHaveTextContent("boom");
  });

  // FINDING 1: heartbeats must NOT reset the reconcile poll. A ~30s heartbeat
  // stream over 5 minutes must still let the fixed 90s reconcile poll fire —
  // otherwise reducer-less data (Services status, NodeStats) freezes at mount
  // values forever under a green dot.
  it("keeps the fixed reconcile cadence despite a steady heartbeat stream", async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    render(
      <Probe fetcher={fetcher} options={{ channel: "ops:fleet", events: {}, pollMs: POLL }} />,
    );
    await flush();

    // First heartbeat proves delivery: goes live and to the slow cadence.
    await act(async () => {
      hub.emit("ops:fleet", "heartbeat", {});
    });
    expect(screen.getByTestId("live")).toHaveTextContent("live");

    fetcher.mockClear();
    // 5 simulated minutes of heartbeats every 30s. Each heartbeat lands well
    // inside the 90s window, so the channel stays live throughout.
    for (let elapsed = 0; elapsed < 300_000; elapsed += 30_000) {
      await advance(30_000);
      await act(async () => {
        hub.emit("ops:fleet", "heartbeat", {});
      });
    }

    // Reconcile fetches still fired at ~90s intervals (t≈90/180/270s): at least
    // three over the five minutes. Under the old bug this would be zero.
    expect(screen.getByTestId("live")).toHaveTextContent("live");
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  // FINDING 3 (task 610): a page whose event channel carries no heartbeats
  // (DeploysPage on "ops:deploys") must still read live from the "ops:fleet"
  // heartbeat — otherwise an idle system reads offline forever and fast-polls.
  it("sources liveness from ops:fleet even when the event channel is silent", async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    render(
      <Probe
        fetcher={fetcher}
        options={{ channel: "ops:deploys", events: {}, pollMs: POLL }}
      />,
    );
    await flush();
    // Connected but no ops:deploys events: still offline until a heartbeat lands.
    expect(screen.getByTestId("live")).toHaveTextContent("offline");
    // The liveness channel is joined even though it is not the event channel.
    expect(hub.joinChannel).toHaveBeenCalledWith("ops:fleet");

    // A heartbeat on ops:fleet alone (nothing on ops:deploys) flips the dot live.
    await act(async () => {
      hub.emit("ops:fleet", "heartbeat", {});
    });
    expect(screen.getByTestId("live")).toHaveTextContent("live");
  });

  it("does not double-join when the event channel is already the liveness channel", async () => {
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    render(
      <Probe
        fetcher={fetcher}
        options={{ channel: "ops:fleet", events: {}, pollMs: POLL }}
      />,
    );
    await flush();
    const fleetJoins = hub.joinChannel.mock.calls.filter((c) => c[0] === "ops:fleet");
    expect(fleetJoins).toHaveLength(1);
  });

  // FINDING 2: a slow in-flight poll response must not overwrite newer state a
  // live event just patched (deploy flips done -> reverts to in_progress).
  it("discards a stale in-flight fetch that a mid-flight event superseded", async () => {
    let resolveSlow: (v: { status: string }) => void = () => {};
    const fetcher = vi
      .fn<() => Promise<{ status: string }>>()
      // mount fetch: initial baseline.
      .mockResolvedValueOnce({ status: "in_progress" })
      // second fetch (via refresh): slow, resolves with STALE data later.
      .mockImplementationOnce(() => new Promise((r) => (resolveSlow = r)));

    const options: UseLiveResourceOptions<{ status: string }> = {
      channel: "ops:deploys",
      events: { deploy: (_prev, data) => ({ status: data.status as string }) },
      pollMs: POLL,
    };
    render(<Probe fetcher={fetcher} options={options} />);
    await flush();
    expect(screen.getByTestId("data")).toHaveTextContent('{"status":"in_progress"}');

    // Start a slow poll (still in flight), then a live event flips it to done.
    await act(async () => {
      screen.getByText("refresh").click();
    });
    await act(async () => {
      hub.emit("ops:deploys", "deploy", { status: "done" });
    });
    expect(screen.getByTestId("data")).toHaveTextContent('{"status":"done"}');

    // The slow fetch resolves with the now-stale "in_progress": it must be
    // discarded (data stays "done") WITHOUT chaining an immediate refetch
    // (review finding: during a sustained event stream faster than fetch RTT,
    // discard-and-refetch chained back-to-back GETs for the whole burst — the
    // reducer-patched state is already the newest view and the fixed-cadence
    // reconcile poll settles any drift).
    await act(async () => {
      resolveSlow({ status: "in_progress" });
    });
    await flush();

    expect(screen.getByTestId("data")).toHaveTextContent('{"status":"done"}');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  // FINDING 3: an event arriving while data is still null (initial fetch in
  // flight) is dropped by the reducer guard; it must force an immediate refetch
  // once the initial fetch settles rather than being lost under a green dot.
  it("forces a refetch for an event that arrived while data was null", async () => {
    let resolveInitial: (v: { v: number }) => void = () => {};
    const fetcher = vi
      .fn<() => Promise<{ v: number }>>()
      // mount fetch: slow, so an event arrives while data is still null.
      .mockImplementationOnce(() => new Promise((r) => (resolveInitial = r)))
      // forced follow-up fetch: fresh snapshot that reflects the event.
      .mockResolvedValueOnce({ v: 2 });

    const options: UseLiveResourceOptions<{ v: number }> = {
      channel: "ops:deploys",
      // A reducer that would produce a DIFFERENT value than the fresh fetch, so
      // "fresh fetch beats stale merge" is observable.
      events: { deploy: (prev) => ({ v: prev.v + 100 }) },
      pollMs: POLL,
    };
    render(<Probe fetcher={fetcher} options={options} />);
    await flush();
    // Initial fetch still in flight: data is null.
    expect(screen.getByTestId("data")).toHaveTextContent("null");

    // Event arrives while null — dropped by the reducer guard, flag pending.
    await act(async () => {
      hub.emit("ops:deploys", "deploy", {});
    });
    expect(screen.getByTestId("data")).toHaveTextContent("null");

    // Initial fetch lands; because an event was dropped, a fresh fetch fires.
    await act(async () => {
      resolveInitial({ v: 1 });
    });
    await flush();

    expect(screen.getByTestId("data")).toHaveTextContent('{"v":2}');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  // FINDING 4: lastEventAt lives in a ref and only the boolean `live` verdict is
  // state, so a steady heartbeat stream does not re-render the page per event.
  it("does not re-render on every heartbeat once already live", async () => {
    let renders = 0;
    const fetcher = vi.fn().mockResolvedValue({ n: 1 });
    function Counting() {
      renders += 1;
      const { live } = useLiveResource(fetcher, {
        channel: "ops:fleet",
        events: {},
        pollMs: POLL,
      });
      return <span data-testid="live">{live ? "live" : "offline"}</span>;
    }
    render(<Counting />);
    await flush();

    // First heartbeat flips live true (a render is expected here).
    await act(async () => {
      hub.emit("ops:fleet", "heartbeat", {});
    });
    expect(screen.getByTestId("live")).toHaveTextContent("live");

    const rendersAfterGoingLive = renders;
    // Further heartbeats keep it live but change no visible state: no re-render.
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        hub.emit("ops:fleet", "heartbeat", {});
      });
    }
    expect(screen.getByTestId("live")).toHaveTextContent("live");
    expect(renders).toBe(rendersAfterGoingLive);
  });
});
