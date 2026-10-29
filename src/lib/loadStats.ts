import type {
  FleetStatsBody,
  GeneratorStatsBody,
  LoadMetric,
  LoadStatRow,
} from "../api/types";
import type { ChartPoint } from "../components/LineChart";

/** Most points the run chart asks the stats endpoint for. */
export const MAX_CHART_POINTS = 300;
/** Generators send a stats line every five seconds; no bucket is narrower. */
export const MIN_STEP_SECONDS = 5;

/** Bucket width in seconds that keeps a span at or under `maxPoints` rows. */
export function statsStep(
  startMs: number,
  endMs: number,
  maxPoints: number = MAX_CHART_POINTS,
): number {
  const seconds = Math.max(0, (endMs - startMs) / 1000);
  return Math.max(MIN_STEP_SECONDS, Math.ceil(seconds / maxPoints));
}

export function isGeneratorRow(row: LoadStatRow): boolean {
  return row.source === "generator";
}

/** The newest line of each generator index, ordered by index. */
export function newestPerGenerator(rows: LoadStatRow[]): GeneratorStatsBody[] {
  const newest = new Map<number, LoadStatRow>();
  for (const row of rows) {
    if (!isGeneratorRow(row)) continue;
    const body = row.body as GeneratorStatsBody;
    const index = row.index ?? body.index ?? 0;
    const prev = newest.get(index);
    if (!prev || Date.parse(row.at) >= Date.parse(prev.at)) newest.set(index, row);
  }
  return Array.from(newest.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, row]) => row.body as GeneratorStatsBody);
}

/**
 * Merge generator lines into one fleet-wide line the way the gateway does:
 * users, counters and gauges are summed, every other metric (trends, rates)
 * keeps the worst value of each numeric field.
 */
export function aggregateLines(lines: GeneratorStatsBody[]): GeneratorStatsBody | null {
  if (lines.length === 0) return null;
  const metrics: Record<string, LoadMetric> = {};
  let vus = 0;
  let at = lines[0].at;
  for (const line of lines) {
    vus += Number(line.vus) || 0;
    if (Date.parse(line.at) > Date.parse(at)) at = line.at;
    for (const [name, metric] of Object.entries(line.metrics ?? {})) {
      const summed = metric.type === "counter" || metric.type === "gauge";
      const merged: LoadMetric = metrics[name] ?? { type: metric.type };
      for (const [field, value] of Object.entries(metric)) {
        if (typeof value !== "number") continue;
        const prev = merged[field];
        if (typeof prev !== "number") merged[field] = value;
        else merged[field] = summed ? prev + value : Math.max(prev, value);
      }
      metrics[name] = merged;
    }
  }
  return { at, vus, metrics };
}

export interface MetricTile {
  key: string;
  label: string;
  value: number;
}

/**
 * One tile for total users, then one for every counter's `count` and every
 * trend's `p(95)` in the aggregate, in the order the metrics arrived.
 */
export function metricTiles(aggregate: GeneratorStatsBody | null): MetricTile[] {
  if (!aggregate) return [];
  const tiles: MetricTile[] = [
    { key: "vus", label: "total users", value: Number(aggregate.vus) || 0 },
  ];
  for (const [name, metric] of Object.entries(aggregate.metrics ?? {})) {
    if (metric.type === "trend" && typeof metric["p(95)"] === "number") {
      tiles.push({ key: `${name}.p(95)`, label: `${name} p(95)`, value: metric["p(95)"] });
    } else if (metric.type === "counter" && typeof metric.count === "number") {
      tiles.push({ key: `${name}.count`, label: `${name} count`, value: metric.count });
    }
  }
  return tiles;
}

/** Name of the first trend metric that carries a p(95), or null. */
export function firstTrendName(body: GeneratorStatsBody | null): string | null {
  if (!body) return null;
  for (const [name, metric] of Object.entries(body.metrics ?? {})) {
    if (metric.type === "trend" && typeof metric["p(95)"] === "number") return name;
  }
  return null;
}

export interface ChartSeries {
  users: ChartPoint[];
  trendName: string | null;
  trend: ChartPoint[];
}

/**
 * The users series and the first trend's p(95) series over generator rows.
 * Rows sharing a timestamp (one per generator) merge with aggregateLines.
 */
export function chartSeries(rows: LoadStatRow[], trendName?: string | null): ChartSeries {
  const byAt = new Map<number, GeneratorStatsBody[]>();
  for (const row of rows) {
    if (!isGeneratorRow(row)) continue;
    const t = Date.parse(row.at);
    if (Number.isNaN(t)) continue;
    const list = byAt.get(t) ?? [];
    list.push(row.body as GeneratorStatsBody);
    byAt.set(t, list);
  }
  const merged = Array.from(byAt.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([t, lines]) => ({ t, body: aggregateLines(lines) as GeneratorStatsBody }));
  let name = trendName ?? null;
  if (!name) {
    for (const m of merged) {
      name = firstTrendName(m.body);
      if (name) break;
    }
  }
  const users = merged.map((m) => ({ t: m.t, v: Number(m.body.vus) || 0 }));
  const trend: ChartPoint[] = [];
  if (name) {
    for (const m of merged) {
      const v = m.body.metrics?.[name]?.["p(95)"];
      if (typeof v === "number") trend.push({ t: m.t, v });
    }
  }
  return { users, trendName: name, trend };
}

/** The newest fleet sample among the rows, or null. */
export function newestFleet(rows: LoadStatRow[]): FleetStatsBody | null {
  let best: LoadStatRow | null = null;
  for (const row of rows) {
    if (row.source !== "fleet") continue;
    if (!best || Date.parse(row.at) >= Date.parse(best.at)) best = row;
  }
  return best ? (best.body as FleetStatsBody) : null;
}

/** A tile or table figure: whole numbers grouped, fractions to two places. */
export function formatFigure(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "-";
  if (Number.isInteger(v)) return v.toLocaleString();
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
