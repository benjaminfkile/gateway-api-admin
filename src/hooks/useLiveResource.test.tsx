import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import * as hubClient from "../lib/hubClient";
vi.mock("../lib/hubClient");

import { installHubMock, type HubMockControl } from "../test/hubClientMock";
import {
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

    // A refetch-triggering event refetches (proof of freshness + reconcile).
    await act(async () => {
      hub.emit("ops:fleet", "instances", { joined: [], pruned: [] });
    });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);

    // An event NOT in refetchOn only proves freshness — no refetch.
    await act(async () => {
      hub.emit("ops:fleet", "leaderChange", { instanceId: "i-1" });
    });
    await flush();
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
});
