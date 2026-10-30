import { describe, expect, it } from "vitest";
import type { GeneratorStatsBody, LoadStatRow } from "../api/types";
import {
  aggregateLines,
  chartSeries,
  firstTrendName,
  metricTiles,
  byteTiles,
  formatBytes,
  formatByteRate,
  newestFleet,
  newestPerGenerator,
  statsStep,
} from "./loadStats";

function line(index: number, at: string, vus: number, reqs: number, p95: number): LoadStatRow {
  const body: GeneratorStatsBody = {
    runId: 1,
    index,
    at,
    vus,
    metrics: {
      http_reqs: { type: "counter", count: reqs, rate: reqs / 5 },
      http_req_duration: { type: "trend", "p(90)": p95 - 1, "p(95)": p95 },
      vus: { type: "gauge", value: vus },
    },
  };
  return { id: index, source: "generator", index, at, body };
}

describe("loadStats", () => {
  it("statsStep keeps a span at or under 300 points with a 5 s floor", () => {
    expect(statsStep(0, 60_000)).toBe(5);
    expect(statsStep(0, 3_600_000)).toBe(12);
  });

  it("takes the newest line of each generator", () => {
    const rows = [
      line(0, "2026-10-01T00:00:00Z", 10, 1, 1),
      line(0, "2026-10-01T00:00:05Z", 20, 2, 2),
      line(1, "2026-10-01T00:00:05Z", 30, 3, 3),
    ];
    expect(newestPerGenerator(rows).map((b) => b.vus)).toEqual([20, 30]);
  });

  it("sums counters and gauges and keeps the worst trend value", () => {
    const agg = aggregateLines([
      line(0, "2026-10-01T00:00:05Z", 20, 100, 40).body as GeneratorStatsBody,
      line(1, "2026-10-01T00:00:05Z", 30, 50, 90).body as GeneratorStatsBody,
    ]);
    expect(agg?.vus).toBe(50);
    expect(agg?.metrics.http_reqs.count).toBe(150);
    expect(agg?.metrics.vus.value).toBe(50);
    expect(agg?.metrics.http_req_duration["p(95)"]).toBe(90);
  });

  it("makes a tile for users, each counter count and each trend p(95)", () => {
    const aggregate: GeneratorStatsBody = {
      at: "2026-10-01T00:00:05Z",
      vus: 400,
      metrics: {
        http_reqs: { type: "counter", count: 1200, rate: 240 },
        event_lag_ms: { type: "trend", "p(90)": 12, "p(95)": 18.5 },
        messages_sent: { type: "counter", count: 77 },
        vus: { type: "gauge", value: 400 },
      },
    };
    expect(metricTiles(aggregate)).toEqual([
      { key: "vus", label: "total users", value: 400 },
      { key: "http_reqs.count", label: "http_reqs count", value: 1200 },
      { key: "event_lag_ms.p(95)", label: "event_lag_ms p(95)", value: 18.5 },
      { key: "messages_sent.count", label: "messages_sent count", value: 77 },
    ]);
    expect(firstTrendName(aggregate)).toBe("event_lag_ms");
    expect(metricTiles(null)).toEqual([]);
  });

  it("leaves the byte counters to their own tiles", () => {
    const aggregate: GeneratorStatsBody = {
      at: "2026-10-01T00:00:05Z",
      vus: 10,
      metrics: {
        data_received: { type: "counter", count: 5000, rate: 100 },
        data_sent: { type: "counter", count: 4000, rate: 80 },
        bytes_received: { type: "counter", count: 3 * 1024 * 1024 * 1024, rate: 2048 },
        bytes_sent: { type: "counter", count: 1536, rate: 512 },
      },
    };
    expect(metricTiles(aggregate)).toEqual([{ key: "vus", label: "total users", value: 10 }]);
    expect(byteTiles(aggregate)).toEqual([
      { key: "bytes_received", label: "Bytes in", value: "3.0 GB", rate: "2.0 KB/s" },
      { key: "bytes_sent", label: "Bytes out", value: "1.5 KB", rate: "0.5 KB/s" },
    ]);
  });

  it("shows a dash on the byte tiles for a run from before scenario version 3", () => {
    const old: GeneratorStatsBody = {
      at: "2026-10-01T00:00:05Z",
      vus: 10,
      metrics: { data_received: { type: "counter", count: 5000, rate: 100 } },
    };
    expect(byteTiles(old).map((t) => [t.label, t.value, t.rate])).toEqual([
      ["Bytes in", "-", null],
      ["Bytes out", "-", null],
    ]);
    expect(byteTiles(null).map((t) => t.value)).toEqual(["-", "-"]);
  });

  it("formats bytes as KB, MB or GB with one decimal", () => {
    expect(formatBytes(512)).toBe("0.5 KB");
    expect(formatBytes(2.5 * 1024 * 1024)).toBe("2.5 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatByteRate(10240)).toBe("10.0 KB/s");
  });

  it("builds the users and first trend series, merging rows that share a time", () => {
    const series = chartSeries([
      line(0, "2026-10-01T00:00:00Z", 10, 1, 5),
      line(1, "2026-10-01T00:00:00Z", 15, 1, 7),
      line(0, "2026-10-01T00:00:05Z", 20, 1, 9),
    ]);
    expect(series.trendName).toBe("http_req_duration");
    expect(series.users.map((p) => p.v)).toEqual([25, 20]);
    expect(series.trend.map((p) => p.v)).toEqual([7, 9]);
  });

  it("picks the newest fleet sample", () => {
    const rows: LoadStatRow[] = [
      { id: 1, source: "fleet", index: null, at: "2026-10-01T00:00:00Z", body: { at: "a", instances: [], channelMembers: 1 } },
      { id: 2, source: "fleet", index: null, at: "2026-10-01T00:00:10Z", body: { at: "b", instances: [], channelMembers: 2 } },
    ];
    expect(newestFleet(rows)?.channelMembers).toBe(2);
  });
});
