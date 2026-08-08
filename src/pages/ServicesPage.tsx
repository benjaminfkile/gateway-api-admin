import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  Menu,
  MenuItem,
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
import { Divider } from "@mui/material";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import RefreshIcon from "@mui/icons-material/Refresh";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StopIcon from "@mui/icons-material/Stop";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import AddIcon from "@mui/icons-material/Add";
import RocketLaunchIcon from "@mui/icons-material/RocketLaunch";
import UndoIcon from "@mui/icons-material/Undo";
import servicesApi from "../api/servicesApi";
import type { ServiceSummary } from "../api/types";
import { useSnackbar } from "../contexts/SnackbarContext";
import ConfirmDialog from "../components/ConfirmDialog";
import DeployDialog from "../components/DeployDialog";
import RollbackDialog from "../components/RollbackDialog";
import ServiceFormDialog from "../components/ServiceFormDialog";
import LiveDot from "../components/LiveDot";
import { useFleetStatus } from "../hooks/useOpsChannel";

const REFRESH_INTERVAL_MS = 30_000;

type FleetStatus = "running" | "stopped" | "partial";
type ServiceAction = "start" | "stop" | "restart";

/** Derive the fleet status from the running/total rollup counts. */
export function fleetStatus(service: ServiceSummary): FleetStatus {
  const { runningOn, totalInstances } = service.fleet;
  if (runningOn <= 0) return "stopped";
  if (runningOn < totalInstances) return "partial";
  return "running";
}

const STATUS_CHIP: Record<FleetStatus, { label: string; color: "success" | "default" | "warning" }> =
  {
    running: { label: "running", color: "success" },
    stopped: { label: "stopped", color: "default" },
    partial: { label: "partial", color: "warning" },
  };

/** Human-friendly relative time, e.g. "5m ago". */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const sec = Math.round((now - then) / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}

interface ConfirmConfig {
  action: ServiceAction;
  service: ServiceSummary;
  title: string;
  message: string;
  confirmLabel: string;
  confirmColor: "primary" | "error" | "warning";
  severity?: "warning" | "error";
  acknowledgement?: string;
  /** force=true is only ever passed for a health-critical stop. */
  force?: true;
}

function buildConfirm(action: ServiceAction, service: ServiceSummary): ConfirmConfig {
  const total = service.fleet.totalInstances;
  switch (action) {
    case "start":
      return {
        action,
        service,
        title: `Start ${service.name}?`,
        message: `This will start "${service.name}" on all ${total} instance(s) in the fleet.`,
        confirmLabel: "Start",
        confirmColor: "primary",
      };
    case "restart":
      return {
        action,
        service,
        title: `Restart ${service.name}?`,
        message: `This will restart "${service.name}" across all ${total} instance(s). In-flight requests may be dropped.`,
        confirmLabel: "Restart",
        confirmColor: "warning",
        severity: "warning",
      };
    case "stop":
      if (service.includeInHealth) {
        return {
          action,
          service,
          title: `Force-stop ${service.name}?`,
          message: `"${service.name}" is included in health checks. Stopping it will mark instances unhealthy and may take the fleet out of rotation.`,
          confirmLabel: "Force stop",
          confirmColor: "error",
          severity: "error",
          acknowledgement:
            "I understand this is a health-critical service and want to force-stop it",
          force: true,
        };
      }
      return {
        action,
        service,
        title: `Stop ${service.name}?`,
        message: `This will stop "${service.name}" across all ${total} instance(s).`,
        confirmLabel: "Stop",
        confirmColor: "error",
        severity: "warning",
      };
  }
}

const ACTION_PAST: Record<ServiceAction, string> = {
  start: "Started",
  stop: "Stopped",
  restart: "Restarted",
};

function DigestCell({ service }: { service: ServiceSummary }) {
  const digests = Object.keys(service.fleet.digests);
  const drift = digests.length > 1;
  const short = service.digest ? service.digest.slice(0, 12) : "—";
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
      <Tooltip title={service.digest ?? "no digest"}>
        <Typography component="span" variant="body2" sx={{ fontFamily: "monospace" }}>
          {short}
        </Typography>
      </Tooltip>
      {drift && (
        <Tooltip title={`Digest drift: ${digests.length} distinct digests running`}>
          <WarningAmberIcon
            color="warning"
            fontSize="small"
            aria-label="digest drift"
          />
        </Tooltip>
      )}
    </Stack>
  );
}

export default function ServicesPage() {
  const [services, setServices] = useState<ServiceSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [menuService, setMenuService] = useState<ServiceSummary | null>(null);

  const [confirm, setConfirm] = useState<ConfirmConfig | null>(null);
  const [acting, setActing] = useState(false);

  const [deployService, setDeployService] = useState<ServiceSummary | null>(null);
  const [rollbackService, setRollbackService] = useState<ServiceSummary | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const { showSuccess, showError } = useSnackbar();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await servicesApi.list();
      setServices(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load services");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [load]);

  // Live fleet events refresh the grid immediately; polling above is the
  // fallback whenever the hub is disconnected.
  const { connected: live } = useFleetStatus(load);

  const openMenu = (event: React.MouseEvent<HTMLElement>, service: ServiceSummary) => {
    setMenuAnchor(event.currentTarget);
    setMenuService(service);
  };

  const closeMenu = () => {
    setMenuAnchor(null);
    setMenuService(null);
  };

  const chooseAction = (action: ServiceAction) => {
    if (!menuService) return;
    setConfirm(buildConfirm(action, menuService));
    closeMenu();
  };

  const chooseDeploy = () => {
    if (!menuService) return;
    setDeployService(menuService);
    closeMenu();
  };

  const chooseRollback = () => {
    if (!menuService) return;
    setRollbackService(menuService);
    closeMenu();
  };

  const runAction = async () => {
    if (!confirm) return;
    const { action, service, force } = confirm;
    setActing(true);
    try {
      if (action === "start") await servicesApi.start(service.name);
      else if (action === "restart") await servicesApi.restart(service.name);
      else await servicesApi.stop(service.name, force);
      showSuccess(`${ACTION_PAST[action]} ${service.name}`);
      setConfirm(null);
      load();
    } catch (err) {
      showError(
        `Failed to ${action} ${service.name}: ${
          err instanceof Error ? err.message : "unknown error"
        }`,
      );
    } finally {
      setActing(false);
    }
  };

  const showSkeleton = loading && services === null;
  const showError_ = !loading && error !== null && services === null;

  return (
    <Box>
      <Stack
        direction="row"
        sx={{ mb: 2, alignItems: "center", justifyContent: "space-between" }}
      >
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Typography variant="h5">Services</Typography>
          <LiveDot connected={live} />
        </Stack>
        <Stack direction="row" spacing={1}>
          <Button
            startIcon={<AddIcon />}
            onClick={() => setAddOpen(true)}
            variant="contained"
          >
            Add service
          </Button>
          <Button
            startIcon={<RefreshIcon />}
            onClick={load}
            disabled={loading}
            variant="outlined"
          >
            Refresh
          </Button>
        </Stack>
      </Stack>

      {showError_ ? (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={load}>
              Retry
            </Button>
          }
        >
          {error}
        </Alert>
      ) : (
        <TableContainer component={Paper}>
          <Table aria-label="service fleet">
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Fleet</TableCell>
                <TableCell>Digest</TableCell>
                <TableCell>Tag</TableCell>
                <TableCell align="right">Port</TableCell>
                <TableCell>Updated</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {showSkeleton &&
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={`skeleton-${i}`}>
                    {Array.from({ length: 8 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton variant="text" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

              {!showSkeleton && services?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} align="center">
                    <Typography color="text.secondary" sx={{ py: 3 }}>
                      No services registered.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}

              {!showSkeleton &&
                services?.map((service) => {
                  const status = fleetStatus(service);
                  const chip = STATUS_CHIP[status];
                  return (
                    <TableRow key={service.name} hover>
                      <TableCell>{service.name}</TableCell>
                      <TableCell>
                        <Chip label={chip.label} color={chip.color} size="small" />
                      </TableCell>
                      <TableCell>
                        {service.fleet.runningOn}/{service.fleet.totalInstances}
                      </TableCell>
                      <TableCell>
                        <DigestCell service={service} />
                      </TableCell>
                      <TableCell>{service.tag}</TableCell>
                      <TableCell align="right">
                        <Tooltip
                          title={
                            service.hostPort === null
                              ? "No running container on the instance"
                              : `Container port ${service.port} is bound to host port ${service.hostPort}`
                          }
                        >
                          <Typography component="span" variant="body2">
                            {service.port}
                            <Typography
                              component="span"
                              variant="caption"
                              color="text.secondary"
                              sx={{ ml: 0.5 }}
                            >
                              → host {service.hostPort ?? "—"}
                            </Typography>
                          </Typography>
                        </Tooltip>
                      </TableCell>
                      <TableCell>
                        <Tooltip
                          title={`by ${service.updatedBy} · ${new Date(
                            service.updatedAt,
                          ).toLocaleString()}`}
                        >
                          <span>{formatRelative(service.updatedAt)}</span>
                        </Tooltip>
                      </TableCell>
                      <TableCell align="right">
                        <IconButton
                          size="small"
                          aria-label={`actions for ${service.name}`}
                          onClick={(e) => openMenu(e, service)}
                        >
                          <MoreVertIcon />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Menu
        anchorEl={menuAnchor}
        open={Boolean(menuAnchor)}
        onClose={closeMenu}
      >
        <MenuItem onClick={() => chooseAction("start")}>
          <PlayArrowIcon fontSize="small" sx={{ mr: 1 }} /> Start
        </MenuItem>
        <MenuItem onClick={() => chooseAction("stop")}>
          <StopIcon fontSize="small" sx={{ mr: 1 }} /> Stop
        </MenuItem>
        <MenuItem onClick={() => chooseAction("restart")}>
          <RestartAltIcon fontSize="small" sx={{ mr: 1 }} /> Restart
        </MenuItem>
        <Divider />
        <MenuItem onClick={chooseDeploy}>
          <RocketLaunchIcon fontSize="small" sx={{ mr: 1 }} /> Deploy
        </MenuItem>
        <MenuItem onClick={chooseRollback}>
          <UndoIcon fontSize="small" sx={{ mr: 1 }} /> Rollback
        </MenuItem>
      </Menu>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        message={confirm?.message ?? ""}
        confirmLabel={confirm?.confirmLabel}
        confirmColor={confirm?.confirmColor}
        severity={confirm?.severity}
        acknowledgement={confirm?.acknowledgement}
        loading={acting}
        onConfirm={runAction}
        onCancel={() => setConfirm(null)}
      />

      <DeployDialog
        open={deployService !== null}
        service={deployService}
        onClose={() => setDeployService(null)}
        onDeployed={load}
      />

      <RollbackDialog
        open={rollbackService !== null}
        service={rollbackService}
        onClose={() => setRollbackService(null)}
        onRolledBack={load}
      />

      <ServiceFormDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={load}
      />
    </Box>
  );
}
