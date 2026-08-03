import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Box,
  FormControlLabel,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
  useTheme,
} from "@mui/material";
import servicesApi from "../api/servicesApi";
import instancesApi from "../api/instancesApi";
import logsApi from "../api/logsApi";
import type { InstanceInfo, LogLine, ServiceSummary } from "../api/types";
import {
  createTerminal,
  themeFromPalette,
  type TerminalHandle,
} from "../lib/terminal";

/** Follow-mode poll cadence. */
const POLL_INTERVAL_MS = 2_000;

const TAIL_OPTIONS = [100, 500, 2000] as const;

/** Render a log line as it appears in the terminal: `{ts} {message}`. */
export function formatLogLine(line: LogLine): string {
  return `${line.ts} ${line.message}`;
}

/**
 * Given the newest tail response and the timestamp of the last line already
 * written, return only the lines that are strictly newer. This is what keeps
 * follow-mode append-only rather than re-printing the whole tail every poll.
 */
export function newLinesSince(
  lines: LogLine[],
  lastTs: string | null,
): LogLine[] {
  if (lastTs === null) return lines;
  return lines.filter((line) => line.ts > lastTs);
}

/** Pick the instance to select by default: first non-stale, else the first. */
export function defaultInstanceId(instances: InstanceInfo[]): string {
  if (instances.length === 0) return "";
  const live = instances.find((i) => !i.stale);
  return (live ?? instances[0]).instanceId;
}

export default function LogsPage() {
  const muiTheme = useTheme();

  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [service, setService] = useState("");
  const [instance, setInstance] = useState("");
  const [tail, setTail] = useState<number>(TAIL_OPTIONS[0]);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const termRef = useRef<TerminalHandle | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Timestamp of the last line written to the terminal; drives append-only.
  const lastTsRef = useRef<string | null>(null);

  // Load the service and instance pickers once on mount.
  useEffect(() => {
    let active = true;
    Promise.all([servicesApi.list(), instancesApi.list()])
      .then(([svcs, insts]) => {
        if (!active) return;
        setServices(svcs);
        setInstances(insts);
        setService((cur) => cur || (svcs[0]?.name ?? ""));
        setInstance((cur) => cur || defaultInstanceId(insts));
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Failed to load pickers");
      });
    return () => {
      active = false;
    };
  }, []);

  // Spin up the xterm terminal once and dispose it on unmount.
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

  // Re-colour the live terminal whenever the palette (light/dark) changes.
  useEffect(() => {
    termRef.current?.setTheme(themeFromPalette(muiTheme));
  }, [muiTheme]);

  const canLoad = service !== "" && instance !== "";

  // Fetch a tail and paint it. `full` clears first and reprints everything;
  // otherwise only lines newer than the last one already shown are appended.
  const loadLogs = useCallback(
    async (full: boolean) => {
      if (!canLoad) return;
      let lines: LogLine[];
      try {
        lines = await logsApi.tail(service, instance, tail);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load logs");
        return;
      }
      const term = termRef.current;
      if (!term) return;
      if (full) {
        term.clear();
        lastTsRef.current = null;
      }
      const fresh = newLinesSince(lines, lastTsRef.current);
      for (const line of fresh) term.writeln(formatLogLine(line));
      if (lines.length > 0) {
        lastTsRef.current = lines[lines.length - 1].ts;
      }
    },
    [canLoad, service, instance, tail],
  );

  // Switching service/instance/tail clears the view and reloads from scratch.
  useEffect(() => {
    if (!canLoad) return;
    loadLogs(true);
  }, [canLoad, loadLogs]);

  // Follow mode: poll and append only new lines. Off => no timer.
  useEffect(() => {
    if (!follow || !canLoad) return;
    const id = setInterval(() => {
      loadLogs(false);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [follow, canLoad, loadLogs]);

  const instanceLabel = useCallback((i: InstanceInfo): string => {
    return i.stale ? `${i.instanceId} (stale)` : i.instanceId;
  }, []);

  const controlsDisabled = useMemo(
    () => services.length === 0,
    [services.length],
  );

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        // Fill the viewport below the app bar (64px) and the main padding.
        height: "calc(100vh - 64px - 48px)",
      }}
    >
      <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: "center" }}>
        <Typography variant="h5" sx={{ mr: 1 }}>
          Logs
        </Typography>
      </Stack>

      <Stack
        direction="row"
        spacing={2}
        sx={{ mb: 2, flexWrap: "wrap", gap: 2, alignItems: "center" }}
      >
        <TextField
          select
          size="small"
          label="Service"
          value={service}
          onChange={(e) => setService(e.target.value)}
          disabled={controlsDisabled}
          slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
          sx={{ minWidth: 180 }}
        >
          {services.length === 0 && <option value="">No services</option>}
          {services.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </TextField>

        <TextField
          select
          size="small"
          label="Instance"
          value={instance}
          onChange={(e) => setInstance(e.target.value)}
          disabled={instances.length === 0}
          slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
          sx={{ minWidth: 220 }}
        >
          {instances.length === 0 && <option value="">No instances</option>}
          {instances.map((i) => (
            <option key={i.instanceId} value={i.instanceId}>
              {instanceLabel(i)}
            </option>
          ))}
        </TextField>

        <TextField
          select
          size="small"
          label="Tail"
          value={String(tail)}
          onChange={(e) => setTail(Number(e.target.value))}
          slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
          sx={{ minWidth: 120 }}
        >
          {TAIL_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </TextField>

        <FormControlLabel
          control={
            <Switch
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
              slotProps={{ input: { "aria-label": "Follow" } }}
            />
          }
          label="Follow"
        />
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Paper
        variant="outlined"
        sx={{
          flexGrow: 1,
          minHeight: 0,
          overflow: "hidden",
          p: 1,
          bgcolor: "background.default",
        }}
      >
        <Box
          ref={containerRef}
          data-testid="log-terminal"
          sx={{ height: "100%", width: "100%" }}
        />
      </Paper>
    </Box>
  );
}
