import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Drawer,
  IconButton,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
  useTheme,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import RefreshIcon from "@mui/icons-material/Refresh";
import jobsApi, { jobsErrorMessage, parseJobsApiError } from "../api/jobsApi";
import type { JobRun, JobRunStatus, LogLine } from "../api/types";
import { formatRelative } from "../pages/ServicesPage";
import { formatDuration } from "../pages/DeploysPage";
import { formatLogLine, newLinesSince } from "../pages/LogsPage";
import { useJobsChannel } from "../hooks/useOpsChannel";
import { useSnackbar } from "../contexts/SnackbarContext";
import type { ChannelEventData } from "../lib/hubClient";
import { createTerminal, themeFromPalette, type TerminalHandle } from "../lib/terminal";
import ConfirmDialog from "./ConfirmDialog";
import JobRunStatusChip, { isActiveRun } from "./JobRunStatusChip";

/** Runs fetched per page; a full page means older runs may exist. */
export const RUNS_PAGE_SIZE = 50;
/** Log poll cadence while the run is queued or running. */
export const LOG_POLL_MS = 2_000;
/** Run history refresh cadence while any listed run is active. */
const RUNS_POLL_ACTIVE_MS = 5_000;
const LOG_TAIL = 500;

/**
 * Merge freshly fetched runs into the list already shown, newest first. A
 * fetched row replaces the shown row with the same id.
 */
export function mergeRuns(existing: JobRun[], fresh: JobRun[]): JobRun[] {
  const byId = new Map<string, JobRun>();
  for (const run of existing) byId.set(String(run.id), run);
  for (const run of fresh) byId.set(String(run.id), run);
  return Array.from(byId.values()).sort((a, b) => Number(b.id) - Number(a.id));
}

/** Patch one shown run from a live `run` event. Unknown runs are left alone. */
export function applyRunEventToRuns(runs: JobRun[], data: ChannelEventData): JobRun[] {
  const runId = data.runId;
  const idx = runs.findIndex((r) => String(r.id) === String(runId));
  if (idx < 0) return runs;
  const patch: Partial<JobRun> = {};
  if (data.status !== undefined) patch.status = data.status as JobRunStatus;
  if (data.instanceId !== undefined) patch.instanceId = data.instanceId as string | null;
  if (data.startedAt !== undefined) patch.startedAt = data.startedAt as string | null;
  if (data.finishedAt !== undefined) patch.finishedAt = data.finishedAt as string | null;
  if (data.exitCode !== undefined) patch.exitCode = data.exitCode as number | null;
  return runs.map((r, k) => (k === idx ? { ...r, ...patch } : r));
}

function TimeCell({ iso }: { iso: string | null }) {
  if (!iso) return <>-</>;
  return (
    <Tooltip title={new Date(iso).toLocaleString()}>
      <span>{formatRelative(iso)}</span>
    </Tooltip>
  );
}

interface RunLogBodyProps {
  jobName: string;
  run: JobRun;
  /** Receives the run as re-read while polling, so the history row stays current. */
  onRunUpdate: (run: JobRun) => void;
}

/**
 * The run's log in the shared xterm terminal. While the run is queued or
 * running the log (and the run itself) is re-read every {@link LOG_POLL_MS};
 * a finished run's log is read once. Only lines newer than the last one shown
 * are appended. Rendered inside the dialog so the terminal container exists
 * when this component mounts.
 */
function RunLogBody({ jobName, run, onRunUpdate }: RunLogBodyProps) {
  const muiTheme = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<TerminalHandle | null>(null);
  const lastTsRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onRunUpdateRef = useRef(onRunUpdate);
  onRunUpdateRef.current = onRunUpdate;

  const active = isActiveRun(run);
  const runId = run.id;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = createTerminal(themeFromPalette(muiTheme));
    term.open(container);
    termRef.current = term;
    return () => {
      term.dispose();
      termRef.current = null;
    };
    // Created once on mount; palette changes are pushed via setTheme below.
  }, []);

  useEffect(() => {
    termRef.current?.setTheme(themeFromPalette(muiTheme));
  }, [muiTheme]);

  const loadLog = useCallback(async () => {
    let lines: LogLine[];
    try {
      lines = await jobsApi.runLog(jobName, runId, LOG_TAIL);
      setError(null);
    } catch (err) {
      setError(jobsErrorMessage(err, "Failed to load the run log"));
      return;
    }
    const term = termRef.current;
    if (!term) return;
    for (const line of newLinesSince(lines, lastTsRef.current)) {
      term.writeln(formatLogLine(line));
    }
    if (lines.length > 0) lastTsRef.current = lines[lines.length - 1].ts;
  }, [jobName, runId]);

  // Read once on open and again when the run leaves the active states; keep
  // polling (log and run status) while it is queued or running.
  useEffect(() => {
    void loadLog();
    if (!active) return;
    const id = setInterval(() => {
      void loadLog();
      jobsApi
        .getRun(jobName, runId)
        .then((fresh) => onRunUpdateRef.current(fresh))
        .catch(() => {
          // The log poll surfaces request failures; the history list and the
          // live channel keep the status current.
        });
    }, LOG_POLL_MS);
    return () => clearInterval(id);
  }, [active, jobName, runId, loadLog]);

  return (
    <>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <Paper
        variant="outlined"
        sx={{ height: "60vh", overflow: "hidden", p: 1, bgcolor: "background.default" }}
      >
        <Box
          ref={containerRef}
          data-testid="run-log-terminal"
          sx={{ height: "100%", width: "100%" }}
        />
      </Paper>
    </>
  );
}

interface RunLogDialogProps extends RunLogBodyProps {
  onClose: () => void;
}

function RunLogDialog({ jobName, run, onClose, onRunUpdate }: RunLogDialogProps) {
  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <span>
            {jobName} run #{run.id}
          </span>
          <JobRunStatusChip status={run.status} />
        </Stack>
      </DialogTitle>
      <DialogContent>
        <RunLogBody jobName={jobName} run={run} onRunUpdate={onRunUpdate} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

export interface JobRunsDrawerProps {
  open: boolean;
  jobName: string | null;
  onClose: () => void;
}

const COLUMNS = 9;

/**
 * Right-side drawer with a job's run history, newest first. "Load more" pages
 * back with the `before` cursor; live `run` events patch the shown rows and a
 * run not yet listed triggers a refetch of the newest page.
 */
export default function JobRunsDrawer({ open, jobName, onClose }: JobRunsDrawerProps) {
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logRunId, setLogRunId] = useState<number | null>(null);
  const [cancelRun, setCancelRun] = useState<JobRun | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const { showSuccess, showError } = useSnackbar();

  // Guards against a response for a previously opened job landing late.
  const jobRef = useRef(jobName);
  jobRef.current = jobName;
  const runsRef = useRef<JobRun[] | null>(null);
  runsRef.current = runs;

  const loadNewest = useCallback(async () => {
    if (!jobName) return;
    try {
      const page = await jobsApi.runs(jobName, { limit: RUNS_PAGE_SIZE });
      if (jobRef.current !== jobName) return;
      setRuns((prev) => (prev ? mergeRuns(prev, page) : page));
      setHasMore((prev) => (runsRef.current ? prev : page.length >= RUNS_PAGE_SIZE));
      setError(null);
    } catch (err) {
      if (jobRef.current !== jobName) return;
      setError(jobsErrorMessage(err, "Failed to load runs"));
    } finally {
      if (jobRef.current === jobName) setLoading(false);
    }
  }, [jobName]);

  useEffect(() => {
    if (!open || !jobName) return;
    setRuns(null);
    runsRef.current = null;
    setHasMore(false);
    setError(null);
    setLogRunId(null);
    setLoading(true);
    void loadNewest();
  }, [open, jobName, loadNewest]);

  const loadMore = async () => {
    if (!jobName || !runs || runs.length === 0) return;
    const oldest = runs[runs.length - 1];
    setLoadingMore(true);
    try {
      const page = await jobsApi.runs(jobName, {
        limit: RUNS_PAGE_SIZE,
        before: oldest.id,
      });
      if (jobRef.current !== jobName) return;
      setRuns((prev) => mergeRuns(prev ?? [], page));
      setHasMore(page.length >= RUNS_PAGE_SIZE);
    } catch (err) {
      showError(jobsErrorMessage(err, "Failed to load older runs"));
    } finally {
      setLoadingMore(false);
    }
  };

  useJobsChannel(
    useCallback(
      (event: string, data: ChannelEventData) => {
        if (!open || event !== "run" || data.job !== jobName) return;
        const shown = runsRef.current;
        if (shown && shown.some((r) => String(r.id) === String(data.runId))) {
          setRuns((prev) => (prev ? applyRunEventToRuns(prev, data) : prev));
        } else {
          void loadNewest();
        }
      },
      [open, jobName, loadNewest],
    ),
  );

  // Polling fallback: refresh the newest page while any shown run is active.
  const anyActive = (runs ?? []).some((r) => isActiveRun(r));
  useEffect(() => {
    if (!open || !anyActive) return;
    const id = setInterval(() => void loadNewest(), RUNS_POLL_ACTIVE_MS);
    return () => clearInterval(id);
  }, [open, anyActive, loadNewest]);

  const updateRun = useCallback((fresh: JobRun) => {
    setRuns((prev) => (prev ? mergeRuns(prev, [fresh]) : prev));
  }, []);

  const confirmCancel = async () => {
    if (!jobName || !cancelRun) return;
    setCancelling(true);
    try {
      await jobsApi.cancelRun(jobName, cancelRun.id);
      showSuccess(`Cancel requested for run #${cancelRun.id}`);
      setCancelRun(null);
      void loadNewest();
    } catch (err) {
      const parsed = parseJobsApiError(err);
      showError(
        parsed.status === 409
          ? `Run #${cancelRun.id} has already finished`
          : `Failed to cancel run #${cancelRun.id}: ${jobsErrorMessage(err, "unknown error")}`,
      );
      setCancelRun(null);
      void loadNewest();
    } finally {
      setCancelling(false);
    }
  };

  const logRun =
    logRunId !== null ? ((runs ?? []).find((r) => r.id === logRunId) ?? null) : null;

  return (
    <Drawer anchor="right" open={open} onClose={onClose}>
      <Box
        sx={{ width: { xs: "100vw", md: 960 }, p: 3 }}
        role="region"
        aria-label={`runs of ${jobName ?? ""}`}
      >
        <Stack
          direction="row"
          sx={{ alignItems: "center", justifyContent: "space-between", mb: 2 }}
        >
          <Typography variant="h6">Runs of {jobName}</Typography>
          <Stack direction="row" spacing={1}>
            <IconButton aria-label="Refresh runs" onClick={() => void loadNewest()} size="small">
              <RefreshIcon />
            </IconButton>
            <IconButton aria-label="Close" onClick={onClose} size="small">
              <CloseIcon />
            </IconButton>
          </Stack>
        </Stack>

        {error && runs === null ? (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void loadNewest()}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        ) : (
          <TableContainer component={Paper} variant="outlined">
            <Table size="small" aria-label="job runs">
              <TableHead>
                <TableRow>
                  <TableCell>Status</TableCell>
                  <TableCell>Trigger</TableCell>
                  <TableCell>Actor</TableCell>
                  <TableCell>Queued</TableCell>
                  <TableCell>Started</TableCell>
                  <TableCell>Duration</TableCell>
                  <TableCell>Exit code</TableCell>
                  <TableCell>Instance</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {loading &&
                  runs === null &&
                  Array.from({ length: 3 }).map((_, i) => (
                    <TableRow key={`skeleton-${i}`}>
                      {Array.from({ length: COLUMNS }).map((__, j) => (
                        <TableCell key={j}>
                          <Skeleton variant="text" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                {runs?.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={COLUMNS} align="center">
                      <Typography color="text.secondary" sx={{ py: 2 }}>
                        No runs yet.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
                {runs?.map((run) => {
                  const active = isActiveRun(run);
                  const showDetail = !active && Boolean(run.detail);
                  return (
                    <Fragment key={run.id}>
                      <TableRow
                        data-testid={`run-${run.id}`}
                        sx={showDetail ? { "& > td": { borderBottom: 0 } } : undefined}
                      >
                        <TableCell>
                          <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
                            <JobRunStatusChip status={run.status} />
                            {active && run.cancelRequestedAt && (
                              <Typography variant="caption" color="text.secondary">
                                cancelling
                              </Typography>
                            )}
                          </Stack>
                        </TableCell>
                        <TableCell>{run.trigger}</TableCell>
                        <TableCell>{run.actor}</TableCell>
                        <TableCell>
                          <TimeCell iso={run.queuedAt} />
                        </TableCell>
                        <TableCell>
                          <TimeCell iso={run.startedAt} />
                        </TableCell>
                        <TableCell>
                          {run.startedAt ? formatDuration(run.startedAt, run.finishedAt) : "-"}
                        </TableCell>
                        <TableCell>{run.exitCode ?? "-"}</TableCell>
                        <TableCell sx={{ fontFamily: "monospace" }}>
                          {run.instanceId ?? "-"}
                        </TableCell>
                        <TableCell align="right" sx={{ whiteSpace: "nowrap" }}>
                          <Button
                            size="small"
                            aria-label={`log of run ${run.id}`}
                            onClick={() => setLogRunId(run.id)}
                          >
                            Log
                          </Button>
                          {active && (
                            <Button
                              size="small"
                              color="error"
                              aria-label={`cancel run ${run.id}`}
                              disabled={Boolean(run.cancelRequestedAt)}
                              onClick={() => setCancelRun(run)}
                            >
                              Cancel
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                      {showDetail && (
                        <TableRow>
                          <TableCell colSpan={COLUMNS} sx={{ pt: 0 }}>
                            <Typography variant="caption" color="text.secondary">
                              {run.detail}
                            </Typography>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}

        {hasMore && (
          <Box sx={{ display: "flex", justifyContent: "center", mt: 2 }}>
            <Button onClick={() => void loadMore()} disabled={loadingMore} variant="outlined">
              Load more
            </Button>
          </Box>
        )}
      </Box>

      {jobName && logRun && (
        <RunLogDialog
          jobName={jobName}
          run={logRun}
          onClose={() => setLogRunId(null)}
          onRunUpdate={updateRun}
        />
      )}

      <ConfirmDialog
        open={cancelRun !== null}
        title={`Cancel run #${cancelRun?.id ?? ""}?`}
        message={
          cancelRun?.status === "queued"
            ? "The queued run is cancelled at once and never starts."
            : "The running container is killed by its instance. Work in progress is lost."
        }
        confirmLabel="Cancel run"
        cancelLabel="Keep running"
        confirmColor="error"
        severity="warning"
        loading={cancelling}
        onConfirm={confirmCancel}
        onCancel={() => setCancelRun(null)}
      />
    </Drawer>
  );
}
