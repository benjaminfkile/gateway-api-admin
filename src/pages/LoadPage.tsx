import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Paper,
  Skeleton,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import RefreshIcon from "@mui/icons-material/Refresh";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import StopIcon from "@mui/icons-material/Stop";
import EditIcon from "@mui/icons-material/Edit";
import FactCheckIcon from "@mui/icons-material/FactCheck";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import loadApi, { isRunActive, loadErrorMessage } from "../api/loadApi";
import type { LoadRun, LoadRunStatus, LoadScenario } from "../api/types";
import { formatRelative } from "./ServicesPage";
import { formatDuration } from "./DeploysPage";
import { useSnackbar } from "../contexts/SnackbarContext";
import { useLiveResource } from "../hooks/useLiveResource";
import type { ChannelEventData } from "../lib/hubClient";
import { formatFigure } from "../lib/loadStats";
import ConfirmDialog from "../components/ConfirmDialog";
import LiveDot from "../components/LiveDot";
import LoadRunStatusChip from "../components/LoadRunStatusChip";
import ScenarioFormDialog from "../components/ScenarioFormDialog";

const POLL_ACTIVE_MS = 5_000;
const POLL_IDLE_MS = 30_000;
const POLL_RECONCILE_MS = 60_000;

/** The peaks key of the gateway's own event lag p(95). */
export const EVENT_LAG_PEAK = "event_lag_ms.p(95)";

/** Path of the run form, prefilled for a validation run when asked. */
export function newRunPath(options: { scenario?: string; validation?: boolean } = {}): string {
  const params = new URLSearchParams();
  if (options.scenario) params.set("scenario", options.scenario);
  if (options.validation) params.set("validation", "1");
  const qs = params.toString();
  return `/load/runs/new${qs ? `?${qs}` : ""}`;
}

/**
 * Fold an "ops:load" `run` event into the run list: a listed run is patched in
 * place, an unknown newer run is added at the top as a best-effort row that the
 * next poll fills out.
 */
export function applyLoadRunEvent(runs: LoadRun[], data: ChannelEventData): LoadRun[] {
  const runId = data.runId as number | undefined;
  if (runId === undefined || runId === null) return runs;
  const patch: Partial<LoadRun> = {};
  if (data.status !== undefined) patch.status = data.status as LoadRunStatus;
  if (data.scenario !== undefined) patch.scenario = data.scenario as string;
  if (data.actor !== undefined) patch.actor = data.actor as string;
  if (data.generators !== undefined) patch.generators = data.generators as number;
  if (data.vusPerGenerator !== undefined) patch.vusPerGenerator = data.vusPerGenerator as number;
  if (data.startedAt !== undefined) patch.startedAt = data.startedAt as string | null;
  if (data.finishedAt !== undefined) patch.finishedAt = data.finishedAt as string | null;
  if (data.stopReason !== undefined) patch.stopReason = data.stopReason as string | null;

  const idx = runs.findIndex((r) => String(r.id) === String(runId));
  if (idx >= 0) return runs.map((r, k) => (k === idx ? { ...r, ...patch } : r));
  if (runs.length > 0 && Number(runId) < Number(runs[runs.length - 1].id)) return runs;
  const row: LoadRun = {
    id: runId,
    scenario: "",
    scenarioVersion: 0,
    target: "",
    validation: false,
    actor: "",
    status: "queued",
    generators: 0,
    vusPerGenerator: 0,
    rampSeconds: 0,
    holdSeconds: 0,
    hardStopAt: null,
    checkedIn: 0,
    queuedAt: (data.startedAt as string | null | undefined) ?? new Date().toISOString(),
    startedAt: null,
    rampStartedAt: null,
    finishedAt: null,
    stopRequestedAt: null,
    stopReason: null,
    verdict: null,
    detail: null,
    peaks: null,
    ...patch,
  };
  return [row, ...runs].sort((a, b) => Number(b.id) - Number(a.id));
}

function TimeCell({ iso }: { iso: string | null }) {
  if (!iso) return <>-</>;
  return (
    <Tooltip title={new Date(iso).toLocaleString()}>
      <span>{formatRelative(iso)}</span>
    </Tooltip>
  );
}

type RunConfirm = { kind: "stop" | "delete"; run: LoadRun };

const RUN_COLUMNS = 9;

function RunsTab() {
  const navigate = useNavigate();
  const { showSuccess, showError } = useSnackbar();
  const [confirm, setConfirm] = useState<RunConfirm | null>(null);
  const [acting, setActing] = useState(false);
  const [fallbackMs, setFallbackMs] = useState(POLL_IDLE_MS);
  const [, setTick] = useState(0);

  const { data: runs, loading, error, refresh, live } = useLiveResource<LoadRun[]>(
    useCallback(() => loadApi.runs({ limit: 50 }), []),
    {
      channel: "ops:load",
      events: { run: applyLoadRunEvent },
      pollMs: { fallback: fallbackMs, reconcile: POLL_RECONCILE_MS },
    },
  );

  const anyActive = (runs ?? []).some((r) => isRunActive(r));
  useEffect(() => {
    setFallbackMs(anyActive ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    if (!anyActive) return;
    // Re-render each second so running durations count up.
    const id = setInterval(() => setTick((t) => t + 1), 1_000);
    return () => clearInterval(id);
  }, [anyActive]);

  const runConfirmed = async () => {
    if (!confirm) return;
    const { run, kind } = confirm;
    setActing(true);
    try {
      if (kind === "stop") {
        await loadApi.stop(run.id);
        showSuccess(`Stop requested for load run ${run.id}`);
      } else {
        await loadApi.removeRun(run.id);
        showSuccess(`Deleted load run ${run.id}`);
      }
      refresh();
    } catch (err) {
      showError(`Failed to ${kind} load run ${run.id}: ${loadErrorMessage(err, "unknown error")}`);
    } finally {
      setActing(false);
      setConfirm(null);
    }
  };

  const showSkeleton = loading && runs === null;

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: "center" }}>
        <LiveDot live={live} />
        <Box sx={{ flexGrow: 1 }} />
        <Button startIcon={<AddIcon />} variant="contained" onClick={() => navigate(newRunPath())}>
          New run
        </Button>
        <Button
          startIcon={<FactCheckIcon />}
          variant="outlined"
          onClick={() => navigate(newRunPath({ validation: true }))}
        >
          Validate
        </Button>
        <Button startIcon={<RefreshIcon />} variant="outlined" onClick={refresh}>
          Refresh
        </Button>
      </Stack>

      {error && runs === null && !loading ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={refresh}>
              Retry
            </Button>
          }
        >
          {error.message}
        </Alert>
      ) : (
        <TableContainer component={Paper}>
          <Table aria-label="load runs">
            <TableHead>
              <TableRow>
                <TableCell>Status</TableCell>
                <TableCell>Scenario</TableCell>
                <TableCell>Target</TableCell>
                <TableCell>Generators x users</TableCell>
                <TableCell>Started</TableCell>
                <TableCell>Duration</TableCell>
                <TableCell>Peak event lag p(95)</TableCell>
                <TableCell>Verdict</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {showSkeleton &&
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={`skeleton-${i}`}>
                    {Array.from({ length: RUN_COLUMNS }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton variant="text" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              {!showSkeleton && (runs ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={RUN_COLUMNS} align="center">
                    <Typography color="text.secondary" sx={{ py: 3 }}>
                      No load runs yet. Start one with New run.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {!showSkeleton &&
                (runs ?? []).map((run) => {
                  const active = isRunActive(run);
                  const peak = run.peaks?.[EVENT_LAG_PEAK];
                  return (
                    <TableRow key={run.id} hover data-testid={`load-run-${run.id}`}>
                      <TableCell>
                        <LoadRunStatusChip status={run.status} />
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                          <span>{run.scenario}</span>
                          {run.validation && <Chip size="small" variant="outlined" label="validation" />}
                        </Stack>
                      </TableCell>
                      <TableCell>{run.target}</TableCell>
                      <TableCell sx={{ whiteSpace: "nowrap" }}>
                        {run.generators} x {formatFigure(run.vusPerGenerator)} ={" "}
                        {formatFigure(run.generators * run.vusPerGenerator)}
                      </TableCell>
                      <TableCell>
                        <TimeCell iso={run.startedAt} />
                      </TableCell>
                      <TableCell>
                        {run.startedAt ? formatDuration(run.startedAt, run.finishedAt) : "-"}
                      </TableCell>
                      <TableCell>{typeof peak === "number" ? `${formatFigure(peak)} ms` : "-"}</TableCell>
                      <TableCell sx={{ maxWidth: 240 }}>
                        <Typography variant="body2" noWrap title={run.verdict ?? undefined}>
                          {run.verdict || "-"}
                        </Typography>
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                        <Tooltip title="Open">
                          <IconButton
                            size="small"
                            aria-label={`open run ${run.id}`}
                            onClick={() => navigate(`/load/runs/${run.id}`)}
                          >
                            <OpenInNewIcon />
                          </IconButton>
                        </Tooltip>
                        {active ? (
                          <Tooltip title="Stop">
                            <span>
                              <IconButton
                                size="small"
                                color="error"
                                aria-label={`stop run ${run.id}`}
                                disabled={Boolean(run.stopRequestedAt)}
                                onClick={() => setConfirm({ kind: "stop", run })}
                              >
                                <StopIcon />
                              </IconButton>
                            </span>
                          </Tooltip>
                        ) : (
                          <Tooltip title="Delete">
                            <IconButton
                              size="small"
                              aria-label={`delete run ${run.id}`}
                              onClick={() => setConfirm({ kind: "delete", run })}
                            >
                              <DeleteOutlineIcon />
                            </IconButton>
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === "stop" ? `Stop load run ${confirm.run.id}?` : `Delete load run ${confirm?.run.id ?? ""}?`
        }
        message={
          confirm?.kind === "stop"
            ? "The generators are told to stop at their next stats line and the run drains."
            : "This removes the run and all of its stored stats."
        }
        confirmLabel={confirm?.kind === "stop" ? "Stop run" : "Delete"}
        confirmColor="error"
        severity="warning"
        loading={acting}
        onConfirm={runConfirmed}
        onCancel={() => setConfirm(null)}
      />
    </Box>
  );
}

const SCENARIO_COLUMNS = 8;

function ScenariosTab() {
  const navigate = useNavigate();
  const { showSuccess, showError } = useSnackbar();
  const [formOpen, setFormOpen] = useState(false);
  const [editName, setEditName] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<LoadScenario | null>(null);
  const [acting, setActing] = useState(false);

  const { data: scenarios, loading, error, refresh, live } = useLiveResource<LoadScenario[]>(
    useCallback(() => loadApi.scenarios(), []),
    {
      channel: "ops:load",
      refetchOn: ["scenario"],
      pollMs: { fallback: POLL_IDLE_MS, reconcile: POLL_RECONCILE_MS },
    },
  );

  const confirmDelete = async () => {
    if (!deleting) return;
    setActing(true);
    try {
      await loadApi.removeScenario(deleting.name);
      showSuccess(`Deleted scenario ${deleting.name}`);
      refresh();
    } catch (err) {
      showError(`Failed to delete ${deleting.name}: ${loadErrorMessage(err, "unknown error")}`);
    } finally {
      setActing(false);
      setDeleting(null);
    }
  };

  const showSkeleton = loading && scenarios === null;

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: "center" }}>
        <LiveDot live={live} />
        <Box sx={{ flexGrow: 1 }} />
        <Button
          startIcon={<AddIcon />}
          variant="contained"
          onClick={() => {
            setEditName(null);
            setFormOpen(true);
          }}
        >
          New scenario
        </Button>
        <Button startIcon={<RefreshIcon />} variant="outlined" onClick={refresh}>
          Refresh
        </Button>
      </Stack>

      {error && scenarios === null && !loading ? (
        <Alert severity="error">{error.message}</Alert>
      ) : (
        <TableContainer component={Paper}>
          <Table aria-label="load scenarios">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Repository</TableCell>
                <TableCell>Commit</TableCell>
                <TableCell>Version</TableCell>
                <TableCell>Max users per generator</TableCell>
                <TableCell>Validated</TableCell>
                <TableCell>Updated</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {showSkeleton &&
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={`skeleton-${i}`}>
                    {Array.from({ length: SCENARIO_COLUMNS }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton variant="text" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              {!showSkeleton && (scenarios ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={SCENARIO_COLUMNS} align="center">
                    <Typography color="text.secondary" sx={{ py: 3 }}>
                      No scenarios yet.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
              {!showSkeleton &&
                (scenarios ?? []).map((s) => (
                  <TableRow key={s.name} hover>
                    <TableCell>{s.name}</TableCell>
                    <TableCell>{s.repository}</TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>
                      {s.commitSha ? s.commitSha.slice(0, 7) : "-"}
                    </TableCell>
                    <TableCell>{s.scriptVersion}</TableCell>
                    <TableCell>{formatFigure(s.maxVusPerGenerator)}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={s.validated ? "validated" : "not validated"}
                        color={s.validated ? "success" : "warning"}
                        variant={s.validated ? "filled" : "outlined"}
                      />
                    </TableCell>
                    <TableCell>
                      <Tooltip title={`${new Date(s.updatedAt).toLocaleString()} by ${s.updatedBy}`}>
                        <span>{formatRelative(s.updatedAt)}</span>
                      </Tooltip>
                    </TableCell>
                    <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                      <Tooltip title="Edit">
                        <IconButton
                          size="small"
                          aria-label={`edit ${s.name}`}
                          onClick={() => {
                            setEditName(s.name);
                            setFormOpen(true);
                          }}
                        >
                          <EditIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Validate">
                        <IconButton
                          size="small"
                          aria-label={`validate ${s.name}`}
                          onClick={() => navigate(newRunPath({ scenario: s.name, validation: true }))}
                        >
                          <FactCheckIcon />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <IconButton size="small" aria-label={`delete ${s.name}`} onClick={() => setDeleting(s)}>
                          <DeleteOutlineIcon />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <ScenarioFormDialog
        open={formOpen}
        name={editName}
        onClose={() => setFormOpen(false)}
        onSaved={refresh}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={`Delete scenario ${deleting?.name ?? ""}?`}
        message="The scenario is removed. Its script history and past runs are kept."
        confirmLabel="Delete"
        confirmColor="error"
        severity="warning"
        loading={acting}
        onConfirm={confirmDelete}
        onCancel={() => setDeleting(null)}
      />
    </Box>
  );
}

/** Load runs and scenarios, as two tabs at /load and /load/scenarios. */
export default function LoadPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const tab = location.pathname.startsWith("/load/scenarios") ? "scenarios" : "runs";

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 1 }}>
        Load
      </Typography>
      <Tabs
        value={tab}
        onChange={(_e, value: string) => navigate(value === "scenarios" ? "/load/scenarios" : "/load")}
        sx={{ mb: 2 }}
      >
        <Tab label="Runs" value="runs" />
        <Tab label="Scenarios" value="scenarios" />
      </Tabs>
      {tab === "runs" ? <RunsTab /> : <ScenariosTab />}
    </Box>
  );
}
