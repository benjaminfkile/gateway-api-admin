import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Drawer,
  IconButton,
  LinearProgress,
  Paper,
  Skeleton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import RefreshIcon from "@mui/icons-material/Refresh";
import deploysApi from "../api/deploysApi";
import type { DeployDetail, DeployStatus, DeploySummary } from "../api/types";
import { formatRelative } from "./ServicesPage";
import type { ChannelEventData } from "../lib/hubClient";
import { useDeployProgress } from "../hooks/useOpsChannel";
import { useLiveResource } from "../hooks/useLiveResource";
import LiveDot from "../components/LiveDot";

/**
 * Poll fast while a visible rollout is mid-flight, slow once everything has
 * settled — but only as the FALLBACK when live updates are not flowing. With
 * terminal deploy events now published server-side, the fast poll is a safety
 * net (a deploy stuck in_progress client-side is corrected by the reconcile
 * poll), not the primary path.
 */
const POLL_ACTIVE_MS = 5_000;
const POLL_IDLE_MS = 30_000;
/** Slow reconcile cadence used while live events are proving freshness. */
const POLL_RECONCILE_MS = 60_000;

const STATUS_CHIP: Record<
  DeployStatus,
  { label: string; color: "info" | "success" | "warning" | "error" }
> = {
  in_progress: { label: "in_progress", color: "info" },
  done: { label: "done", color: "success" },
  partial: { label: "partial", color: "warning" },
  failed: { label: "failed", color: "error" },
};

function StatusChip({ status }: { status: DeployStatus }) {
  const chip = STATUS_CHIP[status];
  return (
    <Chip
      label={chip.label}
      color={chip.color}
      size="small"
      icon={
        status === "in_progress" ? (
          <CircularProgress size={12} color="inherit" thickness={6} />
        ) : undefined
      }
    />
  );
}

/** First 12 chars of a digest, or an em dash when absent. */
export function shortDigest(digest: string | null): string {
  return digest ? digest.slice(0, 12) : "—";
}

/** Elapsed time between two ISO timestamps as a compact "1m 5s" string. */
export function formatDuration(
  startedAt: string,
  finishedAt: string | null,
  now: number = Date.now(),
): string {
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return "—";
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (min < 60) return `${min}m ${remSec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

function DigestArrow({ deploy }: { deploy: DeploySummary }) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
      <Tooltip title={deploy.fromDigest ?? "no prior digest"}>
        <Typography component="span" variant="body2" sx={{ fontFamily: "monospace" }}>
          {shortDigest(deploy.fromDigest)}
        </Typography>
      </Tooltip>
      <Typography component="span" variant="body2" color="text.secondary">
        →
      </Typography>
      <Tooltip title={deploy.toDigest}>
        <Typography component="span" variant="body2" sx={{ fontFamily: "monospace" }}>
          {shortDigest(deploy.toDigest)}
        </Typography>
      </Tooltip>
    </Stack>
  );
}

/** How many instances in a detail have reached the target digest. */
export function convergence(detail: DeployDetail): { converged: number; total: number } {
  const total = detail.instances.length;
  const converged = detail.instances.filter((i) => i.status === "converged").length;
  return { converged, total };
}

/**
 * Fold a live "ops:deploys" `deploy` event's data payload into the history list,
 * upserting the row it names by `deployId`. The payload carries the row's live
 * fields — status and the terminal `finishedAt`/`error` in particular. An event
 * for a deploy already in the list patches it in place; one for a deploy we have
 * not seen (started elsewhere) is prepended as a best-effort row that the
 * fallback poll fills out. Returns the same reference when the event names no
 * deploy.
 */
export function applyDeployEvent(
  deploys: DeploySummary[],
  data: ChannelEventData,
): DeploySummary[] {
  const id = data.deployId as string | undefined;
  if (!id) return deploys;

  const patch: Partial<DeploySummary> = {};
  if (data.service !== undefined) patch.service = data.service as string;
  if (data.action !== undefined) patch.action = data.action as string;
  if (data.fromDigest !== undefined) patch.fromDigest = data.fromDigest as string | null;
  if (data.toDigest !== undefined) patch.toDigest = data.toDigest as string;
  if (data.status !== undefined) patch.status = data.status as DeployStatus;
  if (data.finishedAt !== undefined) patch.finishedAt = data.finishedAt as string | null;
  if (data.error !== undefined) patch.error = data.error as string | null;

  const idx = deploys.findIndex((d) => d.id === id);
  if (idx >= 0) {
    return deploys.map((d, k) => (k === idx ? { ...d, ...patch } : d));
  }

  const created: DeploySummary = {
    id,
    service: (data.service as string) ?? "",
    fromDigest: (data.fromDigest as string | null) ?? null,
    toDigest: (data.toDigest as string) ?? "",
    actor: (data.actor as string) ?? "",
    action: (data.action as string) ?? "deploy",
    status: (data.status as DeployStatus) ?? "in_progress",
    startedAt: (data.finishedAt as string | null) ?? new Date().toISOString(),
    finishedAt: (data.finishedAt as string | null) ?? null,
    error: (data.error as string | null) ?? null,
  };
  return [created, ...deploys];
}

interface DeployDetailPanelProps {
  summary: DeploySummary;
  detail: DeployDetail | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}

function DeployDetailPanel({
  summary,
  detail,
  loading,
  error,
  onRetry,
  onClose,
}: DeployDetailPanelProps) {
  const { converged, total } = detail
    ? convergence(detail)
    : { converged: 0, total: 0 };
  const pct = total > 0 ? Math.round((converged / total) * 100) : 0;

  return (
    <Box
      sx={{ width: { xs: 360, sm: 480 }, p: 3 }}
      role="region"
      aria-label={`deploy ${summary.id} detail`}
    >
      <Stack
        direction="row"
        sx={{ alignItems: "center", justifyContent: "space-between", mb: 2 }}
      >
        <Typography variant="h6">
          {summary.service}
          <Typography component="span" color="text.secondary">
            {" "}· {summary.action}
          </Typography>
        </Typography>
        <IconButton aria-label="Close" onClick={onClose} size="small">
          <CloseIcon />
        </IconButton>
      </Stack>

      <Stack spacing={1} sx={{ mb: 3 }}>
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <StatusChip status={summary.status} />
          <Typography variant="body2" color="text.secondary">
            by {summary.actor}
          </Typography>
        </Stack>
        <DigestArrow deploy={summary} />
        <Typography variant="body2" color="text.secondary">
          Started {formatRelative(summary.startedAt)} ·{" "}
          {formatDuration(summary.startedAt, summary.finishedAt)}
        </Typography>
      </Stack>

      {loading && !detail && (
        <Stack spacing={1}>
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} variant="rounded" height={32} />
          ))}
        </Stack>
      )}

      {error && !detail && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={onRetry}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      )}

      {detail && (
        <>
          <Box sx={{ mb: 2 }}>
            <Typography variant="body2" sx={{ mb: 0.5 }}>
              {converged}/{total} instances converged
            </Typography>
            <LinearProgress
              variant="determinate"
              value={pct}
              aria-label="convergence"
            />
          </Box>

          <TableContainer component={Paper} variant="outlined">
            <Table size="small" aria-label="deploy instances">
              <TableHead>
                <TableRow>
                  <TableCell>Instance</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Detail</TableCell>
                  <TableCell>Updated</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {detail.instances.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} align="center">
                      <Typography color="text.secondary" sx={{ py: 2 }}>
                        No instances reporting yet.
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
                {detail.instances.map((inst) => (
                  <TableRow key={inst.instanceId}>
                    <TableCell sx={{ fontFamily: "monospace" }}>
                      {inst.instanceId}
                    </TableCell>
                    <TableCell>{inst.status}</TableCell>
                    <TableCell>{inst.detail ?? "—"}</TableCell>
                    <TableCell>
                      <Tooltip title={new Date(inst.updatedAt).toLocaleString()}>
                        <span>{formatRelative(inst.updatedAt)}</span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}
    </Box>
  );
}

const STATUS_OPTIONS: DeployStatus[] = ["in_progress", "done", "partial", "failed"];

export default function DeploysPage() {
  const [serviceFilter, setServiceFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<DeploySummary | null>(null);
  const [detail, setDetail] = useState<DeployDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // Adaptive fallback cadence: 5s while a visible rollout is converging, 30s
  // otherwise. Derived from the list below and fed back into the resource — the
  // hook re-arms its poll when the value flips.
  const [fallbackMs, setFallbackMs] = useState(POLL_ACTIVE_MS);

  // The history list is a live resource on "ops:deploys": `deploy` events upsert
  // the row they name (carrying terminal status/finishedAt/error), heartbeat-less
  // freshness comes from those events, and polling is the fallback floor.
  const {
    data: deploys,
    loading,
    error,
    refresh: load,
    live,
  } = useLiveResource<DeploySummary[]>(
    useCallback(() => deploysApi.list(), []),
    {
      channel: "ops:deploys",
      events: { deploy: applyDeployEvent },
      pollMs: { fallback: fallbackMs, reconcile: POLL_RECONCILE_MS },
    },
  );

  const filtered = useMemo(
    () =>
      (deploys ?? []).filter(
        (d) =>
          (serviceFilter === "" || d.service === serviceFilter) &&
          (statusFilter === "" || d.status === statusFilter),
      ),
    [deploys, serviceFilter, statusFilter],
  );

  // Keep the fallback cadence in step with whether a visible rollout is active.
  const hasActive = filtered.some((d) => d.status === "in_progress");
  useEffect(() => {
    setFallbackMs(hasActive ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  }, [hasActive]);

  const services = useMemo(() => {
    const set = new Set((deploys ?? []).map((d) => d.service));
    return Array.from(set).sort();
  }, [deploys]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const data = await deploysApi.get(id);
      setDetail(data);
      setDetailError(null);
    } catch (err) {
      setDetailError(err instanceof Error ? err.message : "Failed to load deploy");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const openDeploy = (deploy: DeploySummary) => {
    setSelectedId(deploy.id);
    setSelectedSnapshot(deploy);
    setDetail(null);
    setDetailError(null);
    loadDetail(deploy.id);
  };

  const closeDeploy = () => {
    setSelectedId(null);
    setSelectedSnapshot(null);
    setDetail(null);
    setDetailError(null);
  };

  // The drawer summary tracks the live list so a `deploy` event that patches the
  // row (e.g. flips its status to done) is reflected in the header immediately;
  // the snapshot taken on open is a fallback if the row leaves the list.
  const selected =
    selectedId !== null
      ? ((deploys ?? []).find((d) => d.id === selectedId) ?? selectedSnapshot)
      : null;

  // Per-instance convergence is too composite to patch from an event, so a
  // `deployInstance` for the open deploy refetches its detail. useDeployProgress
  // already filters to the selected deploy, so data.deployId is that deploy.
  const onDeployEvent = useCallback(
    (event: string, data: ChannelEventData) => {
      if (event !== "deployInstance") return;
      const id = data.deployId as string | undefined;
      if (id) loadDetail(id);
    },
    [loadDetail],
  );

  useDeployProgress(selectedId, onDeployEvent);

  const showSkeleton = loading && deploys === null;
  const showError = !loading && error !== null && deploys === null;

  return (
    <Box>
      <Stack
        direction="row"
        sx={{ mb: 2, alignItems: "center", justifyContent: "space-between" }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="h5">Deploys</Typography>
          <LiveDot live={live} />
        </Stack>
        <Button
          startIcon={<RefreshIcon />}
          onClick={load}
          variant="outlined"
        >
          Refresh
        </Button>
      </Stack>

      <Stack direction="row" spacing={2} sx={{ mb: 2 }}>
        <TextField
          select
          size="small"
          label="Service"
          value={serviceFilter}
          onChange={(e) => setServiceFilter(e.target.value)}
          slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
          sx={{ minWidth: 180 }}
        >
          <option value="">All services</option>
          {services.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
          sx={{ minWidth: 180 }}
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </TextField>
      </Stack>

      {showError ? (
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
          <Table aria-label="deploy history">
            <TableHead>
              <TableRow>
                <TableCell>Service</TableCell>
                <TableCell>Action</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Actor</TableCell>
                <TableCell>Digest</TableCell>
                <TableCell>Started</TableCell>
                <TableCell>Duration</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {showSkeleton &&
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={`skeleton-${i}`}>
                    {Array.from({ length: 7 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton variant="text" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

              {!showSkeleton && filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} align="center">
                    <Typography color="text.secondary" sx={{ py: 3 }}>
                      No deploys match the current filters.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}

              {!showSkeleton &&
                filtered.map((deploy) => (
                  <TableRow
                    key={deploy.id}
                    hover
                    onClick={() => openDeploy(deploy)}
                    sx={{ cursor: "pointer" }}
                  >
                    <TableCell>{deploy.service}</TableCell>
                    <TableCell>{deploy.action}</TableCell>
                    <TableCell>
                      <StatusChip status={deploy.status} />
                    </TableCell>
                    <TableCell>{deploy.actor}</TableCell>
                    <TableCell>
                      <DigestArrow deploy={deploy} />
                    </TableCell>
                    <TableCell>
                      <Tooltip title={new Date(deploy.startedAt).toLocaleString()}>
                        <span>{formatRelative(deploy.startedAt)}</span>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      {formatDuration(deploy.startedAt, deploy.finishedAt)}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Drawer anchor="right" open={selected !== null} onClose={closeDeploy}>
        {selected && (
          <DeployDetailPanel
            summary={selected}
            detail={detail}
            loading={detailLoading}
            error={detailError}
            onRetry={() => loadDetail(selected.id)}
            onClose={closeDeploy}
          />
        )}
      </Drawer>
    </Box>
  );
}
