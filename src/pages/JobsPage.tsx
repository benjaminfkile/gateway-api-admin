import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  IconButton,
  Paper,
  Skeleton,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import RefreshIcon from "@mui/icons-material/Refresh";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import EditIcon from "@mui/icons-material/Edit";
import HistoryIcon from "@mui/icons-material/History";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";
import jobsApi, { jobsErrorMessage, parseJobsApiError } from "../api/jobsApi";
import type { JobRun, JobRunStatus, JobRunTrigger, JobSummary } from "../api/types";
import { formatRelative } from "./ServicesPage";
import { formatDuration } from "./DeploysPage";
import { useSnackbar } from "../contexts/SnackbarContext";
import { useLiveResource } from "../hooks/useLiveResource";
import type { ChannelEventData } from "../lib/hubClient";
import ConfirmDialog from "../components/ConfirmDialog";
import JobFormDialog from "../components/JobFormDialog";
import JobRunsDrawer from "../components/JobRunsDrawer";
import JobRunStatusChip, { isActiveRun } from "../components/JobRunStatusChip";
import LiveDot from "../components/LiveDot";

/** Fallback poll while a visible run is queued or running and live updates are down. */
const POLL_ACTIVE_MS = 5_000;
/** Fallback poll when nothing is running and live updates are down. */
const POLL_IDLE_MS = 30_000;
/** Slow reconcile cadence while live events prove freshness. */
const POLL_RECONCILE_MS = 60_000;

/**
 * Relative time that reads naturally on both sides of now: "in 5m" for a
 * future instant, "5m ago" (via formatRelative) for a past one.
 */
export function formatFromNow(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const sec = Math.round((then - now) / 1000);
  if (sec <= 0) return formatRelative(iso, now);
  if (sec < 45) return "in a moment";
  const min = Math.round(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  return `in ${Math.round(hr / 24)}d`;
}

/** The most meaningful timestamp of a run for a "when" label. */
export function runWhen(run: JobRun): string {
  return run.finishedAt ?? run.startedAt ?? run.queuedAt;
}

/**
 * Fold a live "ops:jobs" `run` event into the job list by patching the named
 * job's `lastRun`. An event for the run already shown updates it in place; an
 * event for a newer run replaces it with a best-effort row that the next poll
 * fills out. Events for an older run, or for a job not in the list, leave the
 * list unchanged.
 */
export function applyRunEvent(
  jobs: JobSummary[],
  data: ChannelEventData,
): JobSummary[] {
  const jobName = data.job as string | undefined;
  const runId = data.runId as number | undefined;
  if (!jobName || runId === undefined || runId === null) return jobs;
  const idx = jobs.findIndex((j) => j.name === jobName);
  if (idx < 0) return jobs;

  const job = jobs[idx];
  const current = job.lastRun;
  const patch: Partial<JobRun> = {};
  if (data.status !== undefined) patch.status = data.status as JobRunStatus;
  if (data.trigger !== undefined) patch.trigger = data.trigger as JobRunTrigger;
  if (data.actor !== undefined) patch.actor = data.actor as string;
  if (data.instanceId !== undefined) patch.instanceId = data.instanceId as string | null;
  if (data.startedAt !== undefined) patch.startedAt = data.startedAt as string | null;
  if (data.finishedAt !== undefined) patch.finishedAt = data.finishedAt as string | null;
  if (data.exitCode !== undefined) patch.exitCode = data.exitCode as number | null;

  let lastRun: JobRun;
  if (current && String(current.id) === String(runId)) {
    lastRun = { ...current, ...patch };
  } else if (current && Number(runId) < Number(current.id)) {
    return jobs;
  } else {
    lastRun = {
      id: runId,
      job: jobName,
      trigger: "manual",
      actor: "",
      status: "queued",
      instanceId: null,
      imageDigest: null,
      scriptVersion: job.scriptVersion,
      exitCode: null,
      // The event carries no queue time; the start time (or now) stands in
      // until the next poll brings the real row.
      queuedAt: (data.startedAt as string | null | undefined) ?? new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      cancelRequestedAt: null,
      detail: null,
      ...patch,
    };
  }
  return jobs.map((j, k) => (k === idx ? { ...j, lastRun } : j));
}

function ScheduleCell({ job }: { job: JobSummary }) {
  if (!job.schedule) {
    return (
      <Typography variant="body2" color="text.secondary">
        manual only
      </Typography>
    );
  }
  return (
    <Stack spacing={0}>
      <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
        {job.schedule}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {job.timeZone}
      </Typography>
    </Stack>
  );
}

function NextRunCell({ job }: { job: JobSummary }) {
  if (!job.nextRunAt) {
    return (
      <Typography variant="body2" color="text.secondary">
        -
      </Typography>
    );
  }
  return (
    <Tooltip title={new Date(job.nextRunAt).toLocaleString()}>
      <span>{formatFromNow(job.nextRunAt)}</span>
    </Tooltip>
  );
}

function LastRunCell({ run }: { run: JobRun | null }) {
  if (!run) {
    return (
      <Typography variant="body2" color="text.secondary">
        never
      </Typography>
    );
  }
  const when = runWhen(run);
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
      <JobRunStatusChip status={run.status} />
      <Tooltip title={new Date(when).toLocaleString()}>
        <Typography component="span" variant="body2">
          {formatRelative(when)}
        </Typography>
      </Tooltip>
      {run.startedAt && (
        <Typography component="span" variant="body2" color="text.secondary">
          {formatDuration(run.startedAt, run.finishedAt)}
        </Typography>
      )}
    </Stack>
  );
}

type ConfirmState =
  | { kind: "run"; job: JobSummary }
  | { kind: "delete"; job: JobSummary; force: boolean };

export default function JobsPage() {
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [acting, setActing] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editName, setEditName] = useState<string | null>(null);
  const [runsJob, setRunsJob] = useState<string | null>(null);
  // Enabled values returned by enable/disable, shown until the list agrees.
  const [enabledOverrides, setEnabledOverrides] = useState<
    Record<string, Pick<JobSummary, "enabled" | "nextRunAt">>
  >({});
  const [toggling, setToggling] = useState<Record<string, boolean>>({});

  const { showSuccess, showError } = useSnackbar();

  const [fallbackMs, setFallbackMs] = useState(POLL_IDLE_MS);

  // The list is a live resource on "ops:jobs": `run` events patch the named
  // job's last run, `job` events refetch the list, liveness comes from the
  // ops:fleet heartbeat and polling stays the fallback floor.
  const {
    data: jobs,
    loading,
    error,
    refresh: load,
    live,
  } = useLiveResource<JobSummary[]>(
    useCallback(() => jobsApi.list(), []),
    {
      channel: "ops:jobs",
      events: { run: applyRunEvent },
      refetchOn: ["job"],
      pollMs: { fallback: fallbackMs, reconcile: POLL_RECONCILE_MS },
    },
  );

  const hasActive = (jobs ?? []).some((j) => isActiveRun(j.lastRun));
  useEffect(() => {
    setFallbackMs(hasActive ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  }, [hasActive]);

  // Drop an override once the list reports the same enabled value.
  useEffect(() => {
    if (!jobs) return;
    setEnabledOverrides((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [name, override] of Object.entries(prev)) {
        const row = jobs.find((j) => j.name === name);
        if (!row || row.enabled === override.enabled) {
          delete next[name];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [jobs]);

  const rows = useMemo(
    () =>
      (jobs ?? []).map((j) =>
        enabledOverrides[j.name] ? { ...j, ...enabledOverrides[j.name] } : j,
      ),
    [jobs, enabledOverrides],
  );

  const toggleEnabled = async (job: JobSummary, enabled: boolean) => {
    setToggling((prev) => ({ ...prev, [job.name]: true }));
    try {
      const updated = enabled
        ? await jobsApi.enable(job.name)
        : await jobsApi.disable(job.name);
      setEnabledOverrides((prev) => ({
        ...prev,
        [job.name]: { enabled: updated.enabled, nextRunAt: updated.nextRunAt },
      }));
      showSuccess(`${enabled ? "Enabled" : "Disabled"} ${job.name}`);
      load();
    } catch (err) {
      showError(
        `Failed to ${enabled ? "enable" : "disable"} ${job.name}: ${jobsErrorMessage(
          err,
          "unknown error",
        )}`,
      );
    } finally {
      setToggling((prev) => {
        const next = { ...prev };
        delete next[job.name];
        return next;
      });
    }
  };

  const runConfirmed = async () => {
    if (!confirm) return;
    const { job } = confirm;
    setActing(true);
    try {
      if (confirm.kind === "run") {
        const { runId } = await jobsApi.run(job.name);
        showSuccess(`Queued run #${runId} of ${job.name}`);
        setConfirm(null);
        load();
      } else {
        await jobsApi.remove(job.name, confirm.force || undefined);
        showSuccess(`Deleted ${job.name}`);
        setConfirm(null);
        load();
      }
    } catch (err) {
      const parsed = parseJobsApiError(err);
      if (confirm.kind === "delete" && !confirm.force && parsed.error === "run_active") {
        // Offer force: the gateway cancels the active run first.
        setConfirm({ kind: "delete", job, force: true });
      } else {
        const verb = confirm.kind === "run" ? "run" : "delete";
        showError(`Failed to ${verb} ${job.name}: ${jobsErrorMessage(err, "unknown error")}`);
        setConfirm(null);
      }
    } finally {
      setActing(false);
    }
  };

  const confirmProps = (() => {
    if (!confirm) return null;
    const { job } = confirm;
    if (confirm.kind === "run") {
      return {
        title: `Run ${job.name} now?`,
        message: job.enabled
          ? `This queues a manual run of "${job.name}" right away.`
          : `This queues a manual run of "${job.name}" right away. The job is disabled, which only pauses its schedule.`,
        confirmLabel: "Run now",
        confirmColor: "primary" as const,
      };
    }
    if (confirm.force) {
      return {
        title: `Force delete ${job.name}?`,
        message: `A run of "${job.name}" is queued or running. Force delete cancels it first, then removes the job. Run history is kept.`,
        confirmLabel: "Force delete",
        confirmColor: "error" as const,
        severity: "error" as const,
      };
    }
    return {
      title: `Delete ${job.name}?`,
      message: `This removes the job "${job.name}" and its schedule. Run history is kept.`,
      confirmLabel: "Delete",
      confirmColor: "error" as const,
      severity: "warning" as const,
    };
  })();

  const showSkeleton = loading && jobs === null;
  const showListError = !loading && error !== null && jobs === null;

  return (
    <Box>
      <Stack
        direction="row"
        sx={{ mb: 2, alignItems: "center", justifyContent: "space-between" }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="h5">Jobs</Typography>
          <LiveDot live={live} />
        </Stack>
        <Stack direction="row" spacing={1}>
          <Button
            startIcon={<AddIcon />}
            onClick={() => {
              setEditName(null);
              setFormOpen(true);
            }}
            variant="contained"
          >
            New job
          </Button>
          <Button startIcon={<RefreshIcon />} onClick={load} variant="outlined">
            Refresh
          </Button>
        </Stack>
      </Stack>

      {showListError ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={load}>
              Retry
            </Button>
          }
        >
          {error?.message}
        </Alert>
      ) : (
        <TableContainer component={Paper}>
          <Table aria-label="jobs">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Schedule</TableCell>
                <TableCell>Next run</TableCell>
                <TableCell>Last run</TableCell>
                <TableCell>Enabled</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {showSkeleton &&
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={`skeleton-${i}`}>
                    {Array.from({ length: 6 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton variant="text" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

              {!showSkeleton && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    <Typography color="text.secondary" sx={{ py: 3 }}>
                      No jobs defined yet. Create one with New job.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}

              {!showSkeleton &&
                rows.map((job) => {
                  const active = isActiveRun(job.lastRun);
                  return (
                    <TableRow key={job.name} hover>
                      <TableCell>{job.name}</TableCell>
                      <TableCell>
                        <ScheduleCell job={job} />
                      </TableCell>
                      <TableCell>
                        <NextRunCell job={job} />
                      </TableCell>
                      <TableCell>
                        <LastRunCell run={job.lastRun} />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={job.enabled}
                          disabled={Boolean(toggling[job.name])}
                          onChange={(e) => void toggleEnabled(job, e.target.checked)}
                          slotProps={{
                            input: { "aria-label": `enabled ${job.name}` },
                          }}
                        />
                      </TableCell>
                      <TableCell align="right">
                        <Tooltip title={active ? "A run is in progress" : "Run now"}>
                          <span>
                            <IconButton
                              size="small"
                              aria-label={`run ${job.name} now`}
                              disabled={active}
                              onClick={() => setConfirm({ kind: "run", job })}
                            >
                              <PlayArrowIcon />
                            </IconButton>
                          </span>
                        </Tooltip>
                        <Tooltip title="Edit">
                          <IconButton
                            size="small"
                            aria-label={`edit ${job.name}`}
                            onClick={() => {
                              setEditName(job.name);
                              setFormOpen(true);
                            }}
                          >
                            <EditIcon />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Runs">
                          <IconButton
                            size="small"
                            aria-label={`runs of ${job.name}`}
                            onClick={() => setRunsJob(job.name)}
                          >
                            <HistoryIcon />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Delete">
                          <IconButton
                            size="small"
                            aria-label={`delete ${job.name}`}
                            onClick={() =>
                              setConfirm({ kind: "delete", job, force: false })
                            }
                          >
                            <DeleteOutlineIcon />
                          </IconButton>
                        </Tooltip>
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
        title={confirmProps?.title ?? ""}
        message={confirmProps?.message ?? ""}
        confirmLabel={confirmProps?.confirmLabel}
        confirmColor={confirmProps?.confirmColor}
        severity={confirmProps?.severity}
        loading={acting}
        onConfirm={runConfirmed}
        onCancel={() => setConfirm(null)}
      />

      <JobFormDialog
        open={formOpen}
        jobName={editName}
        onClose={() => setFormOpen(false)}
        onSaved={load}
      />

      <JobRunsDrawer
        open={runsJob !== null}
        jobName={runsJob}
        onClose={() => setRunsJob(null)}
      />
    </Box>
  );
}
