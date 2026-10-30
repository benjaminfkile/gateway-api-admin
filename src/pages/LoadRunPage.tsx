import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  List,
  ListItem,
  ListItemText,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import DownloadIcon from "@mui/icons-material/Download";
import StopIcon from "@mui/icons-material/Stop";
import StarIcon from "@mui/icons-material/Star";
import loadApi, { isRunActive, loadErrorMessage } from "../api/loadApi";
import type {
  FleetStatsBody,
  GeneratorStatsBody,
  LoadRunDetail,
  LoadRunStatus,
  LoadStatRow,
} from "../api/types";
import { formatDuration } from "./DeploysPage";
import { useSnackbar } from "../contexts/SnackbarContext";
import { useLoadChannel } from "../hooks/useOpsChannel";
import type { ChannelEventData } from "../lib/hubClient";
import {
  aggregateLines,
  byteTiles,
  chartSeries,
  firstTrendName,
  formatFigure,
  metricTiles,
  newestFleet,
  newestPerGenerator,
  statsStep,
  MAX_CHART_POINTS,
} from "../lib/loadStats";
import ConfirmDialog from "../components/ConfirmDialog";
import LineChart, { downsample, type ChartPoint } from "../components/LineChart";
import LoadRunStatusChip from "../components/LoadRunStatusChip";
import LogTerminalDialog from "../components/LogTerminalDialog";

/** Fallback poll of the run and the stats tail while the run is non-terminal. */
export const RUN_POLL_MS = 10_000;
/** How far back the stats tail reaches for the newest line of each generator. */
const TAIL_WINDOW_MS = 60_000;
const LOG_POLL_MS = 3_000;

function percent(v: number | null | undefined): string {
  if (v === null || v === undefined) return "-";
  return `${formatFigure(v)}%`;
}

/** Save a blob as a download with the given file name. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function Tile({ label, value, caption }: { label: string; value: string; caption?: string | null }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 160, flex: "1 1 160px" }} data-testid="metric-tile">
      <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.4, display: "block" }}>
        {label}
      </Typography>
      <Typography variant="h5" component="div" sx={{ fontFamily: "monospace" }}>
        {value}
      </Typography>
      {caption && (
        <Typography variant="body2" color="text.secondary" sx={{ fontFamily: "monospace" }}>
          {caption}
        </Typography>
      )}
    </Paper>
  );
}

function FleetPanel({ sample }: { sample: FleetStatsBody | null }) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }} role="region" aria-label="fleet">
      <Stack direction="row" spacing={1} sx={{ alignItems: "baseline", mb: 1 }}>
        <Typography variant="subtitle1">Fleet</Typography>
        {sample && (
          <Typography variant="body2" color="text.secondary">
            channel members {formatFigure(sample.channelMembers)}, sampled{" "}
            {new Date(sample.at).toLocaleTimeString()}
          </Typography>
        )}
      </Stack>
      {!sample ? (
        <Typography variant="body2" color="text.secondary">
          No fleet sample yet.
        </Typography>
      ) : (
        <TableContainer>
          <Table size="small" aria-label="fleet instances">
            <TableHead>
              <TableRow>
                <TableCell>Instance</TableCell>
                <TableCell>CPU</TableCell>
                <TableCell>Memory</TableCell>
                <TableCell>Hub connections</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sample.instances.map((inst) => (
                <TableRow key={inst.instanceId}>
                  <TableCell sx={{ fontFamily: "monospace" }}>
                    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                      <span>{inst.instanceId}</span>
                      {inst.leader && (
                        <Chip size="small" icon={<StarIcon />} label="leader" color="primary" variant="outlined" />
                      )}
                    </Stack>
                  </TableCell>
                  <TableCell>{percent(inst.cpu)}</TableCell>
                  <TableCell>{percent(inst.memory)}</TableCell>
                  <TableCell>{formatFigure(inst.hubConnections)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Paper>
  );
}

/** The live view of one load run at /load/runs/:id. */
export default function LoadRunPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { showSuccess, showError } = useSnackbar();
  const [run, setRun] = useState<LoadRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chartRows, setChartRows] = useState<LoadStatRow[]>([]);
  const [livePoints, setLivePoints] = useState<GeneratorStatsBody[]>([]);
  const [aggregate, setAggregate] = useState<GeneratorStatsBody | null>(null);
  const [fleet, setFleet] = useState<FleetStatsBody | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [logIndex, setLogIndex] = useState<number | null>(null);
  const [verdict, setVerdict] = useState("");
  const [savingVerdict, setSavingVerdict] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [, setTick] = useState(0);

  const idRef = useRef(id);
  idRef.current = id;
  const verdictLoaded = useRef(false);

  const loadRun = useCallback(async () => {
    try {
      const fresh = await loadApi.run(id);
      if (idRef.current !== id) return null;
      setRun(fresh);
      setError(null);
      if (!verdictLoaded.current) {
        verdictLoaded.current = true;
        setVerdict(fresh.verdict ?? "");
      }
      return fresh;
    } catch (err) {
      if (idRef.current === id) setError(loadErrorMessage(err, "Failed to load the run"));
      return null;
    }
  }, [id]);

  // Stored stats: the downsampled series for the chart, the tail for the tiles
  // and the newest fleet sample. A finished run renders from these alone.
  const loadStats = useCallback(
    async (current: LoadRunDetail) => {
      const startMs = Date.parse(current.startedAt ?? current.queuedAt);
      const endMs = current.finishedAt ? Date.parse(current.finishedAt) : Date.now();
      const tailFrom = new Date(endMs - TAIL_WINDOW_MS).toISOString();
      try {
        const [series, tail, fleetRows] = await Promise.all([
          loadApi.stats(id, { source: "generator", step: statsStep(startMs, endMs) }),
          loadApi.stats(id, { source: "generator", from: tailFrom }),
          loadApi.stats(id, { source: "fleet", from: tailFrom }),
        ]);
        if (idRef.current !== id) return;
        setChartRows(series);
        setLivePoints([]);
        const newest = newestPerGenerator(tail.length > 0 ? tail : series);
        setAggregate(aggregateLines(newest));
        const sample = newestFleet(fleetRows);
        if (sample) setFleet(sample);
      } catch (err) {
        if (idRef.current === id) showError(loadErrorMessage(err, "Failed to load run stats"));
      }
    },
    [id, showError],
  );

  const refreshAll = useCallback(async () => {
    const fresh = await loadRun();
    if (fresh) await loadStats(fresh);
  }, [loadRun, loadStats]);

  useEffect(() => {
    verdictLoaded.current = false;
    setRun(null);
    setChartRows([]);
    setLivePoints([]);
    setAggregate(null);
    setFleet(null);
    void refreshAll();
  }, [id, refreshAll]);

  const active = isRunActive(run);

  // Fallback poll while the run is non-terminal, and a one second tick for the
  // elapsed time.
  useEffect(() => {
    if (!active) return;
    const poll = setInterval(() => void refreshAll(), RUN_POLL_MS);
    const tick = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [active, refreshAll]);

  // When the run turns terminal, read it once more so the view settles on the
  // stored stats and the final timeline.
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && run && !active) void refreshAll();
    wasActive.current = active;
  }, [active, run, refreshAll]);

  useLoadChannel(
    useCallback(
      (event: string, data: ChannelEventData) => {
        if (String(data.runId) !== idRef.current) return;
        if (event === "stats" && data.aggregate) {
          const agg = data.aggregate as GeneratorStatsBody;
          setAggregate(agg);
          setLivePoints((prev) => [...prev, { ...agg, at: (data.at as string) ?? agg.at }]);
        } else if (event === "fleet" && data.sample) {
          setFleet(data.sample as FleetStatsBody);
        } else if (event === "run") {
          setRun((prev) =>
            prev
              ? {
                  ...prev,
                  status: (data.status as LoadRunStatus) ?? prev.status,
                  startedAt: (data.startedAt as string | null | undefined) ?? prev.startedAt,
                  finishedAt: (data.finishedAt as string | null | undefined) ?? prev.finishedAt,
                  stopReason: (data.stopReason as string | null | undefined) ?? prev.stopReason,
                }
              : prev,
          );
          void loadRun();
        }
      },
      [loadRun],
    ),
  );

  const series = useMemo(() => {
    const stored = chartSeries(chartRows);
    const lastStored = stored.users.length > 0 ? stored.users[stored.users.length - 1].t : -Infinity;
    const trendName = stored.trendName ?? firstTrendName(livePoints[0] ?? null);
    const users: ChartPoint[] = [...stored.users];
    const trend: ChartPoint[] = trendName ? [...chartSeries(chartRows, trendName).trend] : [];
    for (const point of livePoints) {
      const t = Date.parse(point.at);
      if (Number.isNaN(t) || t <= lastStored) continue;
      users.push({ t, v: Number(point.vus) || 0 });
      const v = trendName ? point.metrics?.[trendName]?.["p(95)"] : undefined;
      if (typeof v === "number") trend.push({ t, v });
    }
    return {
      users: downsample(users, MAX_CHART_POINTS),
      trend: downsample(trend, MAX_CHART_POINTS),
      trendName,
    };
  }, [chartRows, livePoints]);

  const tiles = metricTiles(aggregate);
  const bytes = byteTiles(aggregate);

  const confirmStop = async () => {
    setStopping(true);
    try {
      await loadApi.stop(id);
      showSuccess(`Stop requested for load run ${id}`);
      void loadRun();
    } catch (err) {
      showError(`Failed to stop load run ${id}: ${loadErrorMessage(err, "unknown error")}`);
    } finally {
      setStopping(false);
      setStopOpen(false);
    }
  };

  const saveVerdict = async () => {
    setSavingVerdict(true);
    try {
      await loadApi.setVerdict(id, verdict.trim());
      showSuccess("Verdict saved");
      void loadRun();
    } catch (err) {
      showError(`Failed to save the verdict: ${loadErrorMessage(err, "unknown error")}`);
    } finally {
      setSavingVerdict(false);
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const blob = await loadApi.statsCsv(id);
      saveBlob(blob, `load-run-${id}-stats.csv`);
    } catch (err) {
      showError(`Failed to export stats: ${loadErrorMessage(err, "unknown error")}`);
    } finally {
      setExporting(false);
    }
  };

  const fetchLog = useCallback(() => loadApi.runLog(id, logIndex ?? 0), [id, logIndex]);

  if (!run) {
    return (
      <Box>
        <Button startIcon={<ArrowBackIcon />} onClick={() => navigate("/load")} sx={{ mb: 2 }}>
          Load
        </Button>
        {error ? (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void refreshAll()}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        ) : (
          <CircularProgress aria-label="loading run" />
        )}
      </Box>
    );
  }

  const generatorIndexes = Array.from({ length: Math.max(0, run.generators) }, (_, i) => i);

  return (
    <Box>
      <Button startIcon={<ArrowBackIcon />} onClick={() => navigate("/load")} sx={{ mb: 1 }}>
        Load
      </Button>
      <Typography variant="h5" sx={{ mb: 1 }}>
        Load run {run.id}: {run.scenario} against {run.target}
        {run.validation ? " (validation)" : ""}
      </Typography>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }} role="region" aria-label="status">
        <Stack direction="row" spacing={3} useFlexGap sx={{ alignItems: "center", flexWrap: "wrap" }}>
          <LoadRunStatusChip status={run.status} />
          <Typography variant="body2">
            elapsed {run.startedAt ? formatDuration(run.startedAt, run.finishedAt) : "-"}
          </Typography>
          <Typography variant="body2">
            hard stop {run.hardStopAt ? new Date(run.hardStopAt).toLocaleString() : "-"}
          </Typography>
          {run.status === "generators_up" && (
            <Typography variant="body2" data-testid="checked-in">
              checked in {run.checkedIn} of {run.generators}
            </Typography>
          )}
          <Typography variant="body2" color="text.secondary">
            {run.generators} x {formatFigure(run.vusPerGenerator)} users, by {run.actor}
          </Typography>
          {run.stopReason && (
            <Typography variant="body2" color="text.secondary">
              stop reason {run.stopReason}
            </Typography>
          )}
          <Box sx={{ flexGrow: 1 }} />
          <Button
            startIcon={<DownloadIcon />}
            variant="outlined"
            disabled={exporting}
            onClick={() => void exportCsv()}
          >
            Export CSV
          </Button>
          {active && (
            <Button
              startIcon={<StopIcon />}
              color="error"
              variant="contained"
              disabled={Boolean(run.stopRequestedAt)}
              onClick={() => setStopOpen(true)}
            >
              {run.stopRequestedAt ? "Stopping" : "Stop"}
            </Button>
          )}
        </Stack>
        {run.detail && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            {run.detail}
          </Typography>
        )}
      </Paper>

      <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", mb: 2 }} aria-label="metrics">
        {tiles.length === 0 ? (
          <Tile label="total users" value="-" />
        ) : (
          tiles.map((tile) => <Tile key={tile.key} label={tile.label} value={formatFigure(tile.value)} />)
        )}
        {bytes.map((tile) => (
          <Tile key={tile.key} label={tile.label} value={tile.value} caption={tile.rate} />
        ))}
      </Stack>

      <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ mb: 2 }}>
        <LineChart title="Users" points={series.users} />
        <LineChart
          title={series.trendName ? `${series.trendName} p(95)` : "p(95)"}
          points={series.trend}
        />
      </Stack>

      <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ mb: 2, alignItems: "flex-start" }}>
        <Box sx={{ flex: 3, width: "100%" }}>
          <FleetPanel sample={fleet} />
        </Box>
        <Paper variant="outlined" sx={{ p: 2, flex: 2, width: "100%" }} role="region" aria-label="timeline">
          <Typography variant="subtitle1">Timeline</Typography>
          <List dense>
            {(run.timeline ?? []).map((entry, i) => (
              <ListItem key={`${entry.at}-${i}`} disableGutters>
                <ListItemText
                  primary={`${entry.status}${entry.by ? ` by ${entry.by}` : ""}`}
                  secondary={`${new Date(entry.at).toLocaleString()}${entry.note ? `, ${entry.note}` : ""}`}
                />
              </ListItem>
            ))}
            {(run.timeline ?? []).length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No entries yet.
              </Typography>
            )}
          </List>
        </Paper>
      </Stack>

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" sx={{ mb: 1 }}>
          Generator logs
        </Typography>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
          {generatorIndexes.map((index) => (
            <Button key={index} size="small" variant="outlined" onClick={() => setLogIndex(index)}>
              Logs {index}
            </Button>
          ))}
        </Stack>
      </Paper>

      {!active && (
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ alignItems: "flex-start" }}>
            <TextField
              label="Verdict"
              value={verdict}
              onChange={(e) => setVerdict(e.target.value)}
              multiline
              minRows={2}
              fullWidth
              helperText="At most 500 characters; empty clears"
              slotProps={{ htmlInput: { maxLength: 500 } }}
            />
            <Button variant="contained" disabled={savingVerdict} onClick={() => void saveVerdict()}>
              Save verdict
            </Button>
          </Stack>
        </Paper>
      )}

      <ConfirmDialog
        open={stopOpen}
        title={`Stop load run ${run.id}?`}
        message="The generators are told to stop at their next stats line and the run drains."
        confirmLabel="Stop run"
        confirmColor="error"
        severity="warning"
        loading={stopping}
        onConfirm={confirmStop}
        onCancel={() => setStopOpen(false)}
      />

      <LogTerminalDialog
        open={logIndex !== null}
        title={`Load run ${run.id}, generator ${logIndex ?? 0}`}
        fetchLines={fetchLog}
        pollMs={active ? LOG_POLL_MS : undefined}
        errorMessage={(err) => loadErrorMessage(err, "Failed to load the generator log")}
        onClose={() => setLogIndex(null)}
      />
    </Box>
  );
}
