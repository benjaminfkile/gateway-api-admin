import { useCallback, useMemo } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Paper,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import StarIcon from "@mui/icons-material/Star";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import instancesApi from "../api/instancesApi";
import type { InstanceInfo, InstanceServiceState } from "../api/types";
import { formatRelative } from "./ServicesPage";
import { shortDigest } from "./DeploysPage";
import { summarize } from "./InstancesPage";
import LiveDot from "../components/LiveDot";
import { useLiveResource } from "../hooks/useLiveResource";

/** Map a container state string onto a MUI chip colour. */
export function serviceStateColor(
  state: string,
): "success" | "warning" | "error" | "default" {
  switch (state.toLowerCase()) {
    case "running":
      return "success";
    case "restarting":
    case "created":
    case "paused":
      return "warning";
    case "exited":
    case "dead":
      return "error";
    default:
      return "default";
  }
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

function ServiceRow({ service }: { service: InstanceServiceState }) {
  const restartWarn = service.restarts > 0;
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={{ alignItems: "center", py: 0.5 }}
      role="listitem"
      aria-label={`service ${service.name}`}
    >
      <Typography
        variant="body2"
        sx={{ flex: 1, minWidth: 0, fontFamily: "monospace" }}
        noWrap
      >
        {service.name}
      </Typography>
      <Chip label={service.state} color={serviceStateColor(service.state)} size="small" />
      <Tooltip title={`${service.restarts} restart(s)`}>
        <Typography
          component="span"
          variant="body2"
          aria-label={`restarts ${service.restarts}`}
          className={restartWarn ? "restart-warn" : undefined}
          sx={{
            minWidth: 28,
            textAlign: "right",
            fontWeight: restartWarn ? 700 : undefined,
            color: restartWarn ? "warning.main" : "text.secondary",
          }}
        >
          ↻{service.restarts}
        </Typography>
      </Tooltip>
      <Tooltip title={service.digest || "no digest"}>
        <Typography
          component="span"
          variant="body2"
          color="text.secondary"
          sx={{ fontFamily: "monospace", width: 96, textAlign: "right" }}
          noWrap
        >
          {shortDigest(service.digest)}
        </Typography>
      </Tooltip>
    </Stack>
  );
}

function InstanceCard({ instance }: { instance: InstanceInfo }) {
  return (
    <Card
      variant="outlined"
      role="listitem"
      aria-label={`instance ${instance.instanceId}`}
      sx={{ display: "flex", flexDirection: "column" }}
    >
      <CardContent sx={{ flex: 1 }}>
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: "center", justifyContent: "space-between", mb: 0.5 }}
        >
          <Stack direction="row" spacing={0.5} sx={{ alignItems: "center", minWidth: 0 }}>
            {instance.isLeader && (
              <Tooltip title="Cluster leader">
                <StarIcon color="warning" fontSize="small" aria-label="leader" />
              </Tooltip>
            )}
            <Typography
              variant="subtitle1"
              sx={{ fontFamily: "monospace", fontWeight: 600 }}
              noWrap
            >
              {instance.instanceId}
            </Typography>
          </Stack>
          <Chip label={`gw ${instance.gatewayVer}`} size="small" variant="outlined" />
        </Stack>

        <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
          <Tooltip title={new Date(instance.heartbeatAt).toLocaleString()}>
            <Typography
              variant="caption"
              sx={{
                color: instance.stale ? "error.main" : "text.secondary",
                fontWeight: instance.stale ? 600 : undefined,
              }}
            >
              heartbeat {formatRelative(instance.heartbeatAt)}
            </Typography>
          </Tooltip>
          {instance.stale && <Chip label="stale" color="error" size="small" />}
        </Stack>

        <Divider sx={{ mb: 1 }} />

        {instance.services.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            No services running.
          </Typography>
        ) : (
          <Stack divider={<Divider flexItem />} role="list" aria-label="services">
            {instance.services.map((service) => (
              <ServiceRow key={service.name} service={service} />
            ))}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

export default function NodeStatsPage() {
  // Same fleet resource as InstancesPage, rendered as cards. Composite instance
  // rows refetch on membership/leadership/error events; heartbeats prove
  // liveness; polling is the fallback.
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
          <Typography variant="h5">Node stats</Typography>
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
          label="Stale"
          value={summary.staleCount}
          amber={summary.staleCount > 0}
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
      ) : showSkeleton ? (
        <Box
          className="node-stats-grid"
          sx={{
            display: "grid",
            gap: 2,
            gridTemplateColumns: {
              xs: "1fr",
              sm: "repeat(2, 1fr)",
              md: "repeat(3, 1fr)",
            },
          }}
        >
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={`skeleton-${i}`} variant="rounded" height={200} />
          ))}
        </Box>
      ) : instances?.length === 0 ? (
        <Typography color="text.secondary" sx={{ py: 3 }}>
          No instances reporting.
        </Typography>
      ) : (
        <Box
          className="node-stats-grid"
          role="list"
          aria-label="instance node stats"
          sx={{
            display: "grid",
            gap: 2,
            gridTemplateColumns: {
              xs: "1fr",
              sm: "repeat(2, 1fr)",
              md: "repeat(3, 1fr)",
            },
          }}
        >
          {instances?.map((instance) => (
            <InstanceCard key={instance.instanceId} instance={instance} />
          ))}
        </Box>
      )}
    </Box>
  );
}
