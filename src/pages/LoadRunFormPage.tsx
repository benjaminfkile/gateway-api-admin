import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import loadApi, { loadErrorMessage, parseLoadApiError } from "../api/loadApi";
import type { LoadRunStart, LoadScenario, PreflightCheck, PreflightStatus } from "../api/types";
import { useSnackbar } from "../contexts/SnackbarContext";
import KeyValueRows, { mapFromRows, rowsFromMap, type KeyValueRow } from "../components/KeyValueRows";

/** Wait after the last field change before re-reading pre-flight. */
export const PREFLIGHT_DEBOUNCE_MS = 400;

export const CONFIRM_HINT = "type the target to confirm; production is allowed";
/** What the gateway pins a validation run to, whatever the form says. */
export const VALIDATION_HINT = "fixed for a validation run";

export interface RunFormState {
  scenario: string;
  target: string;
  confirm: string;
  generators: string;
  vusPerGenerator: string;
  rampMinutes: string;
  holdMinutes: string;
  fleetSize: string;
  leaveFleetAlone: boolean;
  restoreFleet: boolean;
  validation: boolean;
  params: KeyValueRow[];
}

export function initialRunForm(scenario: string, validation: boolean): RunFormState {
  return {
    scenario,
    target: "",
    confirm: "",
    generators: "1",
    vusPerGenerator: validation ? "1" : "100",
    rampMinutes: validation ? "0" : "5",
    holdMinutes: validation ? "5" : "10",
    fleetSize: "",
    leaveFleetAlone: true,
    restoreFleet: true,
    validation,
    params: [],
  };
}

/**
 * The form with the Validation run switch set. The gateway pins a validation run to one
 * generator, one user, no ramp and a five minute hold and ignores the sent sizes, so the
 * form shows those values and locks the fields while the switch is on.
 */
export function withValidation(form: RunFormState, validation: boolean): RunFormState {
  if (!validation) return { ...form, validation };
  return { ...form, validation, generators: "1", vusPerGenerator: "1", rampMinutes: "0", holdMinutes: "5" };
}

/** Whole minutes or fractions of a minute as whole seconds. */
export function minutesToSeconds(minutes: string): number {
  const n = Number(minutes);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 60) : 0;
}

function toInt(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function totalUsers(form: RunFormState): number {
  return Math.max(0, toInt(form.generators)) * Math.max(0, toInt(form.vusPerGenerator));
}

/** The POST body for the form. */
export function buildRunStart(form: RunFormState): LoadRunStart {
  const params = mapFromRows(form.params);
  const body: LoadRunStart = {
    scenario: form.scenario,
    target: form.target.trim(),
    confirm: form.confirm.trim(),
    generators: toInt(form.generators),
    vusPerGenerator: toInt(form.vusPerGenerator),
    rampSeconds: minutesToSeconds(form.rampMinutes),
    holdSeconds: minutesToSeconds(form.holdMinutes),
    fleetSize: form.leaveFleetAlone ? null : toInt(form.fleetSize),
    restoreFleet: form.leaveFleetAlone ? false : form.restoreFleet,
    validation: form.validation,
  };
  if (Object.keys(params).length > 0) body.params = params;
  return body;
}

/** Why Start is disabled, or null when it may be pressed. */
export function startBlockedReason(
  form: RunFormState,
  checks: PreflightCheck[] | null,
  preflightLoading: boolean,
): string | null {
  if (!form.scenario) return "Choose a scenario";
  if (!form.target.trim()) return "Enter the target";
  if (form.confirm.trim() !== form.target.trim()) return "The typed confirmation does not match the target";
  if (checks === null || preflightLoading) return "Waiting for pre-flight";
  const red = checks.filter((c) => c.status === "red");
  if (red.length > 0) return `Pre-flight is red: ${red.map((c) => c.name).join(", ")}`;
  return null;
}

const DOT_COLOR: Record<PreflightStatus, string> = {
  green: "success.main",
  amber: "warning.main",
  red: "error.main",
};

function PreflightList({
  checks,
  loading,
  error,
}: {
  checks: PreflightCheck[] | null;
  loading: boolean;
  error: string | null;
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }} role="region" aria-label="pre-flight">
      <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
        <Typography variant="subtitle1">Pre-flight</Typography>
        {loading && <CircularProgress size={14} aria-label="checking" />}
      </Stack>
      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          {error}
        </Alert>
      )}
      {checks === null && !error && (
        <Typography variant="body2" color="text.secondary">
          Choose a scenario and a target to run the checks.
        </Typography>
      )}
      <Stack spacing={1.5}>
        {(checks ?? []).map((check) => (
          <Stack
            key={check.name}
            direction="row"
            spacing={1.5}
            data-testid={`check-${check.name}`}
            data-status={check.status}
          >
            <Box
              component="span"
              aria-label={check.status}
              sx={{
                mt: 0.75,
                width: 10,
                height: 10,
                borderRadius: "50%",
                flexShrink: 0,
                bgcolor: DOT_COLOR[check.status] ?? "action.disabled",
              }}
            />
            <Box>
              <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
                {check.name}
              </Typography>
              <Typography variant="body2">{check.message}</Typography>
              {check.fix && check.status !== "green" && (
                <Typography variant="caption" color="text.secondary">
                  Fix: {check.fix}
                </Typography>
              )}
            </Box>
          </Stack>
        ))}
      </Stack>
    </Paper>
  );
}

/** The New run form at /load/runs/new with the live pre-flight list beside it. */
export default function LoadRunFormPage() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { showSuccess } = useSnackbar();
  const [form, setForm] = useState<RunFormState>(() =>
    initialRunForm(search.get("scenario") ?? "", search.get("validation") === "1"),
  );
  const [scenarios, setScenarios] = useState<LoadScenario[] | null>(null);
  const [scenariosError, setScenariosError] = useState<string | null>(null);
  const [checks, setChecks] = useState<PreflightCheck[] | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadApi
      .scenarios()
      .then((list) => {
        if (active) setScenarios(list);
      })
      .catch((err: unknown) => {
        if (active) setScenariosError(loadErrorMessage(err, "Failed to load scenarios"));
      });
    return () => {
      active = false;
    };
  }, []);

  // Seed params from the chosen scenario's defaults whenever the scenario changes.
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!scenarios || seededFor.current === form.scenario) return;
    const chosen = scenarios.find((s) => s.name === form.scenario);
    if (!chosen) return;
    seededFor.current = form.scenario;
    setForm((prev) => ({ ...prev, params: rowsFromMap(chosen.paramsDefault) }));
  }, [scenarios, form.scenario]);

  const set = <K extends keyof RunFormState>(key: K, value: RunFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // Re-read pre-flight 400 ms after the last field change; a newer read wins.
  const preflightSeq = useRef(0);
  const query = useMemo(
    () => ({
      scenario: form.scenario,
      target: form.target.trim(),
      confirm: form.confirm.trim(),
      generators: toInt(form.generators),
      vus: toInt(form.vusPerGenerator),
      fleet: form.leaveFleetAlone ? null : toInt(form.fleetSize),
      validation: form.validation,
    }),
    [form.scenario, form.target, form.confirm, form.generators, form.vusPerGenerator, form.leaveFleetAlone, form.fleetSize, form.validation],
  );
  useEffect(() => {
    if (!query.scenario || !query.target) {
      setChecks(null);
      setPreflightLoading(false);
      return;
    }
    const seq = ++preflightSeq.current;
    setPreflightLoading(true);
    const id = setTimeout(() => {
      loadApi
        .preflight(query)
        .then((result) => {
          if (seq !== preflightSeq.current) return;
          setChecks(result.checks);
          setPreflightError(null);
        })
        .catch((err: unknown) => {
          if (seq !== preflightSeq.current) return;
          setPreflightError(loadErrorMessage(err, "Pre-flight failed to load"));
        })
        .finally(() => {
          if (seq === preflightSeq.current) setPreflightLoading(false);
        });
    }, PREFLIGHT_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  const blocked = startBlockedReason(form, checks, preflightLoading);
  const confirmMismatch = form.confirm.trim() !== "" && form.confirm.trim() !== form.target.trim();
  const maxVus = scenarios?.find((s) => s.name === form.scenario)?.maxVusPerGenerator;

  const start = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { runId } = await loadApi.start(buildRunStart(form));
      showSuccess(`Started load run ${runId}`);
      navigate(`/load/runs/${runId}`);
    } catch (err) {
      const parsed = parseLoadApiError(err);
      if (parsed.checks) setChecks(parsed.checks);
      setSubmitError(loadErrorMessage(err, "Failed to start the run"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 2 }}>
        {form.validation ? "New validation run" : "New load run"}
      </Typography>
      <Stack direction={{ xs: "column", md: "row" }} spacing={3} sx={{ alignItems: "flex-start" }}>
        <Stack spacing={2} sx={{ flex: 3, width: "100%" }}>
          {scenariosError && <Alert severity="error">{scenariosError}</Alert>}
          <TextField
            select
            label="Scenario"
            value={scenarios ? form.scenario : ""}
            onChange={(e) => set("scenario", e.target.value)}
            helperText={maxVus ? `At most ${maxVus} users per generator` : undefined}
          >
            {(scenarios ?? []).map((s) => (
              <MenuItem key={s.name} value={s.name}>
                {s.name} (version {s.scriptVersion}
                {s.validated ? ", validated" : ", not validated"})
              </MenuItem>
            ))}
          </TextField>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              label="Target"
              value={form.target}
              onChange={(e) => set("target", e.target.value)}
              helperText="The service behind the gateway to load"
              fullWidth
            />
            <TextField
              label="Confirm target"
              value={form.confirm}
              onChange={(e) => set("confirm", e.target.value)}
              error={confirmMismatch}
              helperText={confirmMismatch ? "Does not match the target" : CONFIRM_HINT}
              fullWidth
            />
          </Stack>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ alignItems: "center" }}>
            <TextField
              label="Generators"
              type="number"
              value={form.generators}
              onChange={(e) => set("generators", e.target.value)}
              disabled={form.validation}
              helperText={form.validation ? VALIDATION_HINT : undefined}
              slotProps={{ htmlInput: { min: 1, step: 1 } }}
            />
            <TextField
              label="Users each"
              type="number"
              value={form.vusPerGenerator}
              onChange={(e) => set("vusPerGenerator", e.target.value)}
              disabled={form.validation}
              helperText={form.validation ? VALIDATION_HINT : undefined}
              slotProps={{ htmlInput: { min: 1, step: 1, max: maxVus } }}
            />
            <Typography variant="body1" data-testid="total-users" sx={{ whiteSpace: "nowrap" }}>
              Total users: <strong>{totalUsers(form).toLocaleString()}</strong>
            </Typography>
          </Stack>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
            <TextField
              label="Ramp minutes"
              type="number"
              value={form.rampMinutes}
              onChange={(e) => set("rampMinutes", e.target.value)}
              disabled={form.validation}
              helperText={form.validation ? VALIDATION_HINT : `${minutesToSeconds(form.rampMinutes)} s`}
              slotProps={{ htmlInput: { min: 0, step: 0.5 } }}
            />
            <TextField
              label="Hold minutes"
              type="number"
              value={form.holdMinutes}
              onChange={(e) => set("holdMinutes", e.target.value)}
              disabled={form.validation}
              helperText={form.validation ? VALIDATION_HINT : `${minutesToSeconds(form.holdMinutes)} s`}
              slotProps={{ htmlInput: { min: 0, step: 0.5 } }}
            />
          </Stack>
          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ alignItems: "center" }}>
            <FormControlLabel
              control={
                <Switch
                  checked={form.leaveFleetAlone}
                  onChange={(e) => set("leaveFleetAlone", e.target.checked)}
                />
              }
              label="Leave the fleet alone"
            />
            <TextField
              label="Fleet size"
              type="number"
              value={form.fleetSize}
              onChange={(e) => set("fleetSize", e.target.value)}
              disabled={form.leaveFleetAlone}
              slotProps={{ htmlInput: { min: 1, step: 1 } }}
            />
            <FormControlLabel
              control={
                <Switch
                  checked={form.restoreFleet}
                  onChange={(e) => set("restoreFleet", e.target.checked)}
                  disabled={form.leaveFleetAlone}
                />
              }
              label="Restore fleet afterwards"
            />
          </Stack>
          <FormControlLabel
            control={
              <Switch
                checked={form.validation}
                onChange={(e) => setForm((f) => withValidation(f, e.target.checked))}
              />
            }
            label="Validation run"
          />
          <KeyValueRows label="Params" rows={form.params} onChange={(rows) => set("params", rows)} />
          {submitError && <Alert severity="error">{submitError}</Alert>}
          <Stack direction="row" spacing={1}>
            <Tooltip title={blocked ?? ""}>
              <span>
                <Button variant="contained" disabled={blocked !== null || submitting} onClick={() => void start()}>
                  Start
                </Button>
              </span>
            </Tooltip>
            <Button onClick={() => navigate("/load")}>Cancel</Button>
          </Stack>
        </Stack>
        <Box sx={{ flex: 2, width: "100%" }}>
          <PreflightList checks={checks} loading={preflightLoading} error={preflightError} />
        </Box>
      </Stack>
    </Box>
  );
}
