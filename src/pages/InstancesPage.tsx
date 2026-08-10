import { useCallback, useMemo } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
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
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import StarIcon from "@mui/icons-material/Star";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlineOutlined";
import instancesApi from "../api/instancesApi";
import type { InstanceInfo } from "../api/types";
import { formatRelative } from "./ServicesPage";
import { shortDigest } from "./DeploysPage";
import LiveDot from "../components/LiveDot";
import { useLiveResource } from "../hooks/useLiveResource";

export interface InstancesSummary {
  total: number;
  leaderId: string | null;
  staleCount: number;
  gatewayVersions: string[];
  /** True when more than one distinct gateway version is live (mid-rollout). */
  mixedVersions: boolean;
}

/** Roll a fleet list up into the numbers shown in the summary cards. */
export function summarize(instances: InstanceInfo[]): InstancesSummary {
  const leader = instances.find((i) => i.isLeader);
  const versions = Array.from(new Set(instances.map((i) => i.gatewayVer))).sort();
  return {
    total: instances.length,
    leaderId: leader ? leader.instanceId : null,
    staleCount: instances.filter((i) => i.stale).length,
    gatewayVersions: versions,
    mixedVersions: versions.length > 1,
  };
}

interface SummaryCardProps {
  label: string;
  value: React.ReactNode;
  amber?: boolean;
  caption?: string;
}

function SummaryCard({ label, value, amber, caption }: SummaryCardProps) {
  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2,
        flex: 1,
        minWidth: 160,
        ...(amber && {
          borderColor: "warning.main",
          bgcolor: (theme) => `${theme.palette.warning.main}14`,
        }),
      }}
    >
      <Typography variant="overline" color="text.secondary">
        {label}
      </Typography>
      <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
        <Typography variant="h5" component="div" sx={{ fontFamily: "monospace" }}>
          {value}
        </Typography>
        {amber && (
          <Tooltip title="Gateway rollout in progress: instances are on more than one version">
            <WarningAmberIcon color="warning" aria-label="mixed gateway versions" />
          </Tooltip>
        )}
      </Stack>
      {caption && (
        <Typography variant="caption" color="text.secondary">
          {caption}
        </Typography>
      )}
    </Paper>
  );
}

function ServicesCell({ instance }: { instance: InstanceInfo }) {
  const { services } = instance;
  if (services.length === 0) {
    return <Typography color="text.secondary">0</Typography>;
  }
  const errored = services.filter((s) => s.lastError);
  const tip = (
    <Stack spacing={0.5}>
      {services.map((s) => (
        <Stack key={s.name} spacing={0.25}>
          <Typography
            variant="caption"
            component="span"
            sx={{ fontFamily: "monospace" }}
          >
            {s.name}@{shortDigest(s.digest)}
          </Typography>
          {s.lastError && (
            <Typography
              variant="caption"
              component="span"
              sx={{ color: "warning.light" }}
            >
              ⚠ {s.lastError}
              {s.lastErrorAt ? ` · ${formatRelative(s.lastErrorAt)}` : ""}
            </Typography>
          )}
        </Stack>
      ))}
    </Stack>
  );
  return (
    <Tooltip title={tip}>
      <Stack
        direction="row"
        spacing={0.5}
        component="span"
        sx={{ alignItems: "center", justifyContent: "flex-end", cursor: "default" }}
      >
        {errored.length > 0 && (
          <ErrorOutlineIcon
            color="warning"
            fontSize="small"
            aria-label={`${errored.length} service${
              errored.length === 1 ? "" : "s"
            } with a reconcile error`}
          />
        )}
        <Typography component="span">{services.length}</Typography>
      </Stack>
    </Tooltip>
  );
}

export default function InstancesPage() {
  // Instance rows are composite (services, leadership, staleness), so fleet
  // membership/leadership/error events refetch rather than patch client-side;
  // heartbeats only prove liveness. Polling stays the fallback.
  const {
    data: instances,
    loading,
    error,
    refresh: load,
    live,
  } = useLiveResource<InstanceInfo[]>(
    useCallback(() => instancesApi.list(), []),
    {
      channel: "ops:fleet",
      refetchOn: ["instances", "leaderChange", "serviceError"],
      pollMs: { fallback: 30_000, reconcile: 90_000 },
    },
  );

  const summary = useMemo(() => summarize(instances ?? []), [instances]);

  const showSkeleton = loading && instances === null;
  const showError = !loading && error !== null && instances === null;

  return (
    <Box>
      <Stack
        direction="row"
        sx={{ mb: 2, alignItems: "center", justifyContent: "space-between" }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="h5">Instances</Typography>
          <LiveDot live={live} />
        </Stack>
        <Button
          startIcon={<RefreshIcon />}
          onClick={load}
          disabled={loading}
          variant="outlined"
        >
          Refresh
        </Button>
      </Stack>

      <Stack
        direction="row"
        spacing={2}
        sx={{ mb: 3, flexWrap: "wrap", gap: 2 }}
        role="region"
        aria-label="fleet summary"
      >
        <SummaryCard label="Instances" value={summary.total} />
        <SummaryCard
          label="Leader"
          value={summary.leaderId ?? "—"}
          caption={summary.leaderId ? undefined : "no leader elected"}
        />
        <SummaryCard
          label="Stale"
          value={summary.staleCount}
          caption={summary.staleCount > 0 ? "not heartbeating" : undefined}
        />
        <SummaryCard
          label="Gateway versions"
          value={summary.gatewayVersions.length}
          amber={summary.mixedVersions}
          caption={summary.gatewayVersions.join(", ") || undefined}
        />
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
          <Table aria-label="instance fleet">
            <TableHead>
              <TableRow>
                <TableCell>Instance</TableCell>
                <TableCell>Gateway</TableCell>
                <TableCell>Private IP</TableCell>
                <TableCell>Public IP</TableCell>
                <TableCell align="right">Services</TableCell>
                <TableCell>Heartbeat</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {showSkeleton &&
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={`skeleton-${i}`}>
                    {Array.from({ length: 6 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton variant="text" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

              {!showSkeleton && instances?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center">
                    <Typography color="text.secondary" sx={{ py: 3 }}>
                      No instances reporting.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}

              {!showSkeleton &&
                instances?.map((instance) => (
                  <TableRow key={instance.instanceId} hover>
                    <TableCell>
                      <Stack
                        direction="row"
                        spacing={0.5}
                        sx={{ alignItems: "center" }}
                      >
                        {instance.isLeader && (
                          <Tooltip title="Cluster leader">
                            <StarIcon
                              color="warning"
                              fontSize="small"
                              aria-label="leader"
                            />
                          </Tooltip>
                        )}
                        <Typography
                          component="span"
                          variant="body2"
                          sx={{ fontFamily: "monospace" }}
                        >
                          {instance.instanceId}
                        </Typography>
                      </Stack>
                    </TableCell>
                    <TableCell>{instance.gatewayVer}</TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>
                      {instance.privateIp}
                    </TableCell>
                    <TableCell sx={{ fontFamily: "monospace" }}>
                      {instance.publicIp}
                    </TableCell>
                    <TableCell align="right">
                      <ServicesCell instance={instance} />
                    </TableCell>
                    <TableCell>
                      <Stack
                        direction="row"
                        spacing={1}
                        sx={{ alignItems: "center" }}
                      >
                        <Tooltip
                          title={new Date(instance.heartbeatAt).toLocaleString()}
                        >
                          <Typography
                            component="span"
                            variant="body2"
                            sx={{
                              color: instance.stale ? "error.main" : undefined,
                              fontWeight: instance.stale ? 600 : undefined,
                            }}
                          >
                            {formatRelative(instance.heartbeatAt)}
                          </Typography>
                        </Tooltip>
                        {instance.stale && (
                          <Chip label="stale" color="error" size="small" />
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}
