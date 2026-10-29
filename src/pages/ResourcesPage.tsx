import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  LinearProgress,
  MenuItem,
  Paper,
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
import RefreshIcon from "@mui/icons-material/Refresh";
import resourcesApi, {
  cacheNodeTypes,
  databaseClasses,
  fleetClasses,
  isRefreshInFlight,
  resourcesErrorMessage,
} from "../api/resourcesApi";
import loadApi, { isRunActive } from "../api/loadApi";
import servicesApi from "../api/servicesApi";
import type { FleetRefresh, LoadRun, ResourceAuditEntry, ResourcesState } from "../api/types";
import { formatRelative } from "./ServicesPage";
import { applyLoadRunEvent } from "./LoadPage";
import { useSnackbar } from "../contexts/SnackbarContext";
import { useLiveResource } from "../hooks/useLiveResource";
import { useResourcesChannel } from "../hooks/useOpsChannel";
import type { ChannelEventData } from "../lib/hubClient";
import { formatFigure } from "../lib/loadStats";
import ConfirmDialog from "../components/ConfirmDialog";
import LiveDot from "../components/LiveDot";

const POLL_FALLBACK_MS = 15_000;
const POLL_RECONCILE_MS = 60_000;
/** Refresh progress poll while a refresh is in flight, and when idle. */
const REFRESH_POLL_ACTIVE_MS = 10_000;
const REFRESH_POLL_IDLE_MS = 30_000;

export const CACHE_NOTE =
  "The backplane is modified in place and applied immediately; hub publishes are dropped while it is degraded.";
export const DATABASE_NOTE =
  "The class change is applied immediately and the database reboots; every service using it loses its connections for a few minutes.";
export const FLEET_CLASS_NOTE =
  "Every node is replaced one at a time by an instance refresh (min healthy 100%, one extra node at a time).";

/** An audit before or after value as text; objects are shown as JSON. */
export function auditValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Pull a template version out of an audit `before` value, whatever its shape. */
export function templateVersionFrom(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = auditValue(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return text;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") {
      const v = (parsed as Record<string, unknown>).templateVersion ?? (parsed as Record<string, unknown>).version;
      if (v !== undefined && v !== null && String(v).trim()) return String(v);
    }
  } catch {
    // Not JSON; fall through to the text patterns.
  }
  const match =
    /template\s*version\D{0,3}(\d+)/i.exec(text) ??
    /\bversion\D{0,3}(\d+)/i.exec(text) ??
    /\bv(\d+)\b/i.exec(text);
  return match ? match[1] : null;
}

/**
 * The template version to roll back to: the `before` of the newest fleet class
 * change (or rollback) in the audit, which is newest first.
 */
export function previousTemplateVersion(audit: ResourceAuditEntry[]): string | null {
  const entry = audit.find(
    (a) => a.resource === "fleet" && /class|rollback/i.test(a.action) && !/refresh/i.test(a.action),
  );
  return entry ? templateVersionFrom(entry.before) : null;
}

/** Why every control is disabled right now, or null. */
export function lockReason(
  resources: ResourcesState | null,
  runs: LoadRun[] | null,
  refresh: FleetRefresh | null,
): string | null {
  const active = (runs ?? []).find((r) => isRunActive(r));
  if (active) return `Load run ${active.id} is ${active.status}`;
  if (resources?.runActive) return "A load run is active";
  if (isRefreshInFlight(refresh) || resources?.fleet?.refreshInProgress) {
    return "A fleet instance refresh is in progress";
  }
  return null;
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
        {value ?? "-"}
      </Typography>
    </Box>
  );
}

function ResourceCard({
  title,
  configured,
  error,
  children,
}: {
  title: string;
  configured: boolean;
  error?: string | null;
  children?: ReactNode;
}) {
  return (
    <Card variant="outlined" sx={{ flex: "1 1 320px" }} role="region" aria-label={title}>
      <CardContent>
        <Typography variant="h6" sx={{ mb: 1 }}>
          {title}
        </Typography>
        {!configured ? (
          <Typography color="text.secondary">not configured</Typography>
        ) : (
          <Stack spacing={2}>
            {error && <Alert severity="warning">{error}</Alert>}
            {children}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

/** A button that shows why it is disabled in a tooltip. */
function GatedButton({
  reason,
  disabled,
  onClick,
  children,
  color,
}: {
  reason: string | null;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  color?: "primary" | "warning" | "error";
}) {
  return (
    <Tooltip title={reason ?? ""}>
      <span>
        <Button variant="contained" color={color} disabled={Boolean(reason) || disabled} onClick={onClick}>
          {children}
        </Button>
      </span>
    </Tooltip>
  );
}

type Pending =
  | { kind: "fleetClass"; value: string }
  | { kind: "rollback"; value: string }
  | { kind: "cache"; value: string }
  | { kind: "database"; value: string; confirm: string; services: string[] | null };

/** Scale the fleet, the backplane cache and the database at /resources. */
export default function ResourcesPage() {
  const { showSuccess, showError } = useSnackbar();

  const {
    data: resources,
    loading,
    error,
    refresh: reload,
    live,
  } = useLiveResource<ResourcesState>(useCallback(() => resourcesApi.get(), []), {
    channel: "ops:resources",
    refetchOn: ["change"],
    pollMs: { fallback: POLL_FALLBACK_MS, reconcile: POLL_RECONCILE_MS },
  });

  const { data: runs, refresh: reloadRuns } = useLiveResource<LoadRun[]>(
    useCallback(() => loadApi.runs({ limit: 10 }), []),
    {
      channel: "ops:load",
      events: { run: applyLoadRunEvent },
      pollMs: { fallback: POLL_FALLBACK_MS, reconcile: POLL_RECONCILE_MS },
    },
  );

  const [refreshState, setRefreshState] = useState<FleetRefresh | null>(null);
  const [audit, setAudit] = useState<ResourceAuditEntry[] | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);

  const loadRefresh = useCallback(async () => {
    try {
      setRefreshState(await resourcesApi.fleetRefresh());
    } catch {
      // A box without a fleet group has no refresh to show; the card says so.
    }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      setAudit(await resourcesApi.audit(50));
      setAuditError(null);
    } catch (err) {
      setAuditError(resourcesErrorMessage(err, "Failed to load the audit"));
    }
  }, []);

  useEffect(() => {
    void loadRefresh();
    void loadAudit();
  }, [loadRefresh, loadAudit]);

  const refreshing = isRefreshInFlight(refreshState);
  useEffect(() => {
    const id = setInterval(
      () => void loadRefresh(),
      refreshing ? REFRESH_POLL_ACTIVE_MS : REFRESH_POLL_IDLE_MS,
    );
    return () => clearInterval(id);
  }, [refreshing, loadRefresh]);

  useResourcesChannel(
    useCallback(
      (event: string, data: ChannelEventData) => {
        if (event === "refresh") {
          setRefreshState((prev) => ({
            ...(prev ?? {}),
            refreshId: (data.refreshId as string | undefined) ?? prev?.refreshId,
            status: (data.status as string) ?? prev?.status ?? "",
            percentComplete: (data.percentComplete as number | null | undefined) ?? null,
            inProgress: undefined,
          }));
        } else if (event === "change") {
          void loadAudit();
        }
      },
      [loadAudit],
    ),
  );

  const reason = lockReason(resources, runs, refreshState);
  const rollbackVersion = useMemo(() => previousTemplateVersion(audit ?? []), [audit]);

  const [fleetSize, setFleetSize] = useState("");
  const [fleetClass, setFleetClass] = useState("");
  const [cacheType, setCacheType] = useState("");
  const [dbClass, setDbClass] = useState("");
  const [dbConfirm, setDbConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [dbResult, setDbResult] = useState<{ services: string[]; note: string } | null>(null);

  // Seed the inputs from the first read so Apply starts from the current values.
  const seeded = useRef(false);
  useEffect(() => {
    if (!resources || seeded.current) return;
    seeded.current = true;
    if (resources.fleet) {
      setFleetSize(String(resources.fleet.desired));
      setFleetClass(resources.fleet.instanceClass ?? "");
    }
    if (resources.cache) setCacheType(resources.cache.nodeType ?? "");
    if (resources.database) setDbClass(resources.database.instanceClass ?? "");
  }, [resources]);

  const afterChange = () => {
    reload();
    reloadRuns();
    void loadAudit();
    void loadRefresh();
  };

  const applySize = async () => {
    const size = Number(fleetSize);
    setBusy(true);
    try {
      await resourcesApi.setFleetSize(size);
      showSuccess(`Fleet size set to ${size}`);
      afterChange();
    } catch (err) {
      showError(`Failed to set the fleet size: ${resourcesErrorMessage(err, "unknown error")}`);
    } finally {
      setBusy(false);
    }
  };

  const openDatabaseConfirm = () => {
    setPending({ kind: "database", value: dbClass, confirm: dbConfirm.trim(), services: null });
    servicesApi
      .list()
      .then((list) =>
        setPending((prev) =>
          prev?.kind === "database" ? { ...prev, services: list.map((s) => s.name) } : prev,
        ),
      )
      .catch(() =>
        setPending((prev) => (prev?.kind === "database" ? { ...prev, services: [] } : prev)),
      );
  };

  const runPending = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === "fleetClass") {
        const res = await resourcesApi.setFleetClass(pending.value);
        showSuccess(`Fleet class change started (template version ${res?.templateVersion ?? "?"})`);
      } else if (pending.kind === "rollback") {
        await resourcesApi.rollbackFleetClass(pending.value);
        showSuccess(`Rollback to template version ${pending.value} started`);
      } else if (pending.kind === "cache") {
        const res = await resourcesApi.setCacheNodeType(pending.value);
        showSuccess(res.note ? `Cache node type change started. ${res.note}` : "Cache node type change started");
      } else {
        const res = await resourcesApi.setDatabaseClass(pending.value, pending.confirm);
        setDbResult({ services: res.services ?? [], note: res.note ?? "" });
        setDbConfirm("");
        showSuccess("Database class change started");
      }
      afterChange();
    } catch (err) {
      showError(resourcesErrorMessage(err, "The change failed"));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const confirmProps = (() => {
    if (!pending) return null;
    switch (pending.kind) {
      case "fleetClass":
        return {
          title: `Change the fleet class to ${pending.value}?`,
          message: `${FLEET_CLASS_NOTE} A new launch template version becomes the default.`,
          label: "Replace nodes",
        };
      case "rollback":
        return {
          title: `Roll back to template version ${pending.value}?`,
          message: `${FLEET_CLASS_NOTE} Version ${pending.value} becomes the default again.`,
          label: "Roll back",
        };
      case "cache":
        return {
          title: `Change the cache node type to ${pending.value}?`,
          message: `"${CACHE_NOTE}"`,
          label: "Change node type",
        };
      case "database":
        return {
          title: `Change the database class to ${pending.value}?`,
          message: (
            <>
              <Typography variant="body2" sx={{ mb: 1 }}>
                {DATABASE_NOTE}
              </Typography>
              <Typography variant="body2">Affected services:</Typography>
              {pending.services === null ? (
                <CircularProgress size={16} aria-label="loading services" />
              ) : pending.services.length === 0 ? (
                <Typography variant="body2">every service on the gateway</Typography>
              ) : (
                <ul style={{ margin: 0 }} aria-label="affected services">
                  {pending.services.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              )}
            </>
          ),
          label: "Change class",
        };
    }
  })();

  const fleet = resources?.fleet ?? null;
  const generators = resources?.generators ?? null;
  const cache = resources?.cache ?? null;
  const database = resources?.database ?? null;
  const sizeNumber = Number(fleetSize);
  const sizeValid =
    Number.isInteger(sizeNumber) && sizeNumber >= 1 && (!fleet?.maxSize || sizeNumber <= fleet.maxSize);

  return (
    <Box>
      <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: "center" }}>
        <Typography variant="h5">Resources</Typography>
        <LiveDot live={live} />
        <Box sx={{ flexGrow: 1 }} />
        <Button startIcon={<RefreshIcon />} variant="outlined" onClick={afterChange}>
          Refresh
        </Button>
      </Stack>

      {reason && (
        <Alert severity="info" sx={{ mb: 2 }} data-testid="lock-reason">
          Changes are disabled: {reason}.
        </Alert>
      )}

      {error && !resources && !loading && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {resourcesErrorMessage(error, error.message)}
        </Alert>
      )}
      {loading && !resources && <CircularProgress aria-label="loading resources" />}

      {resources && (
        <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: "wrap", mb: 3 }}>
          <ResourceCard title="Fleet" configured={fleet !== null} error={fleet?.error}>
            {fleet && (
              <>
                <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: "wrap" }}>
                  <Field label="group" value={fleet.group} />
                  <Field label="min / desired / max" value={`${fleet.min} / ${fleet.desired} / ${fleet.max}`} />
                  <Field label="in service" value={fleet.inService} />
                  <Field label="class" value={fleet.instanceClass} />
                  <Field label="template version" value={fleet.templateVersion} />
                </Stack>
                <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                  <TextField
                    size="small"
                    label="Fleet size"
                    type="number"
                    value={fleetSize}
                    onChange={(e) => setFleetSize(e.target.value)}
                    disabled={Boolean(reason)}
                    error={fleetSize !== "" && !sizeValid}
                    helperText={`Sets min, desired and max${fleet.maxSize ? `, 1 to ${fleet.maxSize}` : ""}`}
                    slotProps={{ htmlInput: { min: 1, max: fleet.maxSize, step: 1 } }}
                  />
                  <GatedButton reason={reason} disabled={busy || !sizeValid} onClick={() => void applySize()}>
                    Apply size
                  </GatedButton>
                </Stack>
                <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                  <TextField
                    select
                    size="small"
                    label="Fleet class"
                    value={fleetClasses(resources).includes(fleetClass) ? fleetClass : ""}
                    onChange={(e) => setFleetClass(e.target.value)}
                    disabled={Boolean(reason)}
                    sx={{ minWidth: 180 }}
                  >
                    {fleetClasses(resources).map((c) => (
                      <MenuItem key={c} value={c}>
                        {c}
                      </MenuItem>
                    ))}
                  </TextField>
                  <GatedButton
                    reason={reason}
                    disabled={busy || !fleetClass || fleetClass === fleet.instanceClass}
                    onClick={() => setPending({ kind: "fleetClass", value: fleetClass })}
                  >
                    Apply class
                  </GatedButton>
                </Stack>
                {refreshState && (
                  <Box data-testid="refresh-progress">
                    <Typography variant="body2" sx={{ mb: 0.5 }}>
                      Instance refresh {refreshState.status}
                      {refreshState.percentComplete !== null && refreshState.percentComplete !== undefined
                        ? `, ${refreshState.percentComplete}%`
                        : ""}
                    </Typography>
                    <LinearProgress
                      variant="determinate"
                      value={Math.max(0, Math.min(100, refreshState.percentComplete ?? 0))}
                      aria-label="instance refresh progress"
                    />
                  </Box>
                )}
                {rollbackVersion && (
                  <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                    <Typography variant="body2" color="text.secondary">
                      Previous template version {rollbackVersion}
                    </Typography>
                    <GatedButton
                      reason={reason}
                      disabled={busy}
                      color="warning"
                      onClick={() => setPending({ kind: "rollback", value: rollbackVersion })}
                    >
                      Rollback
                    </GatedButton>
                  </Stack>
                )}
              </>
            )}
          </ResourceCard>

          <ResourceCard title="Generators" configured={generators !== null} error={generators?.error}>
            {generators && (
              <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: "wrap" }}>
                <Field label="group" value={generators.group} />
                <Field label="desired" value={generators.desired} />
                <Field label="in service" value={generators.inService} />
                <Field label="max" value={generators.max} />
              </Stack>
            )}
          </ResourceCard>

          <ResourceCard title="Cache" configured={cache !== null} error={cache?.error}>
            {cache && (
              <>
                <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: "wrap" }}>
                  <Field label="replication group" value={cache.id} />
                  <Field label="node type" value={cache.nodeType} />
                  <Field label="status" value={cache.status} />
                </Stack>
                <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
                  <TextField
                    select
                    size="small"
                    label="Node type"
                    value={cacheNodeTypes(resources).includes(cacheType) ? cacheType : ""}
                    onChange={(e) => setCacheType(e.target.value)}
                    disabled={Boolean(reason)}
                    sx={{ minWidth: 200 }}
                  >
                    {cacheNodeTypes(resources).map((c) => (
                      <MenuItem key={c} value={c}>
                        {c}
                      </MenuItem>
                    ))}
                  </TextField>
                  <GatedButton
                    reason={reason}
                    disabled={busy || !cacheType || cacheType === cache.nodeType}
                    onClick={() => setPending({ kind: "cache", value: cacheType })}
                  >
                    Apply node type
                  </GatedButton>
                </Stack>
              </>
            )}
          </ResourceCard>

          <ResourceCard title="Database" configured={database !== null} error={database?.error}>
            {database && (
              <>
                <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: "wrap" }}>
                  <Field label="instance" value={database.id} />
                  <Field label="class" value={database.instanceClass} />
                  <Field label="status" value={database.status} />
                  <Field
                    label="connections in use / max"
                    value={`${formatFigure(database.connectionsInUse)} / ${formatFigure(database.maxConnections)}`}
                  />
                </Stack>
                <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: "flex-start" }}>
                  <TextField
                    select
                    size="small"
                    label="Database class"
                    value={databaseClasses(resources).includes(dbClass) ? dbClass : ""}
                    onChange={(e) => setDbClass(e.target.value)}
                    disabled={Boolean(reason)}
                    sx={{ minWidth: 200 }}
                  >
                    {databaseClasses(resources).map((c) => (
                      <MenuItem key={c} value={c}>
                        {c}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    size="small"
                    label="Instance identifier"
                    value={dbConfirm}
                    onChange={(e) => setDbConfirm(e.target.value)}
                    disabled={Boolean(reason)}
                    error={dbConfirm !== "" && dbConfirm.trim() !== database.id}
                    helperText="Type the instance shown above to confirm"
                  />
                  <GatedButton
                    reason={
                      reason ??
                      (dbConfirm.trim() !== database.id ? "Type the instance identifier to confirm" : null)
                    }
                    disabled={busy || !dbClass || dbClass === database.instanceClass}
                    onClick={openDatabaseConfirm}
                  >
                    Apply class
                  </GatedButton>
                </Stack>
                {dbResult && (
                  <Alert severity="info" onClose={() => setDbResult(null)}>
                    {dbResult.note}
                    {dbResult.services.length > 0 && ` Services: ${dbResult.services.join(", ")}.`}
                  </Alert>
                )}
              </>
            )}
          </ResourceCard>
        </Stack>
      )}

      <Typography variant="h6" sx={{ mb: 1 }}>
        Audit
      </Typography>
      {auditError && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {auditError}
        </Alert>
      )}
      <TableContainer component={Paper}>
        <Table size="small" aria-label="resource audit">
          <TableHead>
            <TableRow>
              <TableCell>When</TableCell>
              <TableCell>Actor</TableCell>
              <TableCell>Resource</TableCell>
              <TableCell>Action</TableCell>
              <TableCell>Before</TableCell>
              <TableCell>After</TableCell>
              <TableCell>Detail</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(audit ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={7} align="center">
                  <Typography color="text.secondary" sx={{ py: 2 }}>
                    {audit === null ? "Loading" : "No changes recorded."}
                  </Typography>
                </TableCell>
              </TableRow>
            )}
            {(audit ?? []).map((entry, i) => (
              <TableRow key={entry.id ?? `${entry.at}-${i}`}>
                <TableCell>
                  <Tooltip title={new Date(entry.at).toLocaleString()}>
                    <span>{formatRelative(entry.at)}</span>
                  </Tooltip>
                </TableCell>
                <TableCell>{entry.actor}</TableCell>
                <TableCell>{entry.resource}</TableCell>
                <TableCell>{entry.action}</TableCell>
                <TableCell sx={{ fontFamily: "monospace" }}>{auditValue(entry.before) || "-"}</TableCell>
                <TableCell sx={{ fontFamily: "monospace" }}>{auditValue(entry.after) || "-"}</TableCell>
                <TableCell>{entry.detail ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <ConfirmDialog
        open={pending !== null}
        title={confirmProps?.title ?? ""}
        message={confirmProps?.message ?? ""}
        confirmLabel={confirmProps?.label}
        confirmColor="warning"
        severity="warning"
        loading={busy || (pending?.kind === "database" && pending.services === null)}
        onConfirm={runPending}
        onCancel={() => setPending(null)}
      />
    </Box>
  );
}
