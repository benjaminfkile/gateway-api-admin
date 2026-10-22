import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Link,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import jobsApi, { jobsErrorMessage, parseJobsApiError } from "../api/jobsApi";
import type { JobDetail, JobUpsert, ScriptVersion, ScriptVersionBody } from "../api/types";
import { useSnackbar } from "../contexts/SnackbarContext";
import { formatRelative } from "../pages/ServicesPage";

export interface JobFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called with the saved job after a successful PUT. */
  onSaved?: (job: JobDetail) => void;
  /** Name of the job to edit; null or absent opens the create form. */
  jobName?: string | null;
}

/** Job names as the gateway accepts them. */
export const JOB_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const TIMEOUT_MIN = 30;
export const TIMEOUT_MAX = 21_600;
export const TIMEOUT_DEFAULT = 3_600;
/** Largest script body the gateway stores, in UTF-8 bytes. */
export const SCRIPT_MAX_BYTES = 262_144;
const SCRIPT_MIN_ROWS = 18;

const MONOSPACE =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';

export interface JobFormState {
  name: string;
  schedule: string;
  timeZone: string;
  image: string;
  tag: string;
  envSecretRef: string;
  timeoutSeconds: string;
  enabled: boolean;
  script: string;
}

export type JobFieldErrors = Partial<Record<keyof JobFormState, string>>;

/** The browser's own IANA zone, falling back to UTC. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Every IANA zone the browser knows, always including UTC and the given extras. */
export function timeZoneOptions(...extra: string[]): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  const set = new Set(zones);
  for (const z of ["UTC", ...extra]) if (z) set.add(z);
  return Array.from(set).sort();
}

function emptyForm(): JobFormState {
  return {
    name: "",
    schedule: "",
    timeZone: browserTimeZone(),
    image: "",
    tag: "",
    envSecretRef: "",
    timeoutSeconds: String(TIMEOUT_DEFAULT),
    enabled: true,
    script: "",
  };
}

/** The editable fields of a loaded job as form values. */
export function formFromJob(job: JobDetail): JobFormState {
  return {
    name: job.name,
    schedule: job.schedule ?? "",
    timeZone: job.timeZone,
    image: job.image,
    tag: job.tag,
    envSecretRef: job.envSecretRef ?? "",
    timeoutSeconds: String(job.timeoutSeconds),
    enabled: job.enabled,
    script: job.script,
  };
}

/**
 * Client-side validation mirroring the gateway's constraints. On create a
 * blank image or tag falls back to the gateway defaults; on edit both must
 * stay non-empty because the gateway rejects an empty value.
 */
export function validateJobForm(form: JobFormState, isEdit: boolean): JobFieldErrors {
  const errors: JobFieldErrors = {};
  if (!isEdit) {
    if (!form.name.trim()) errors.name = "Name is required";
    else if (!JOB_NAME_PATTERN.test(form.name.trim())) {
      errors.name =
        "Name must be 2 to 63 lowercase letters, digits or dashes, starting with a letter or digit";
    }
  }
  const schedule = form.schedule.trim();
  if (schedule && schedule.split(/\s+/).length !== 5) {
    errors.schedule = "Schedule must have five cron fields (minute hour day month weekday)";
  }
  if (!form.timeZone.trim()) errors.timeZone = "Time zone is required";
  if (isEdit && !form.image.trim()) errors.image = "Image is required";
  if (isEdit && !form.tag.trim()) errors.tag = "Tag is required";
  const timeout = Number(form.timeoutSeconds);
  if (
    !form.timeoutSeconds.trim() ||
    !Number.isInteger(timeout) ||
    timeout < TIMEOUT_MIN ||
    timeout > TIMEOUT_MAX
  ) {
    errors.timeoutSeconds = `Timeout must be a whole number of seconds from ${TIMEOUT_MIN} to ${TIMEOUT_MAX}`;
  }
  if (!form.script.trim()) {
    errors.script = "Script is required";
  } else if (new TextEncoder().encode(form.script).length > SCRIPT_MAX_BYTES) {
    errors.script = `Script must be at most ${SCRIPT_MAX_BYTES} bytes`;
  }
  return errors;
}

/**
 * Build the PUT body. On create every field with a value is sent (timeZone and
 * script are always present); on edit only fields that differ from the loaded
 * job are sent, so the gateway preserves everything else. An emptied schedule
 * or secret ref is sent as "" which clears it.
 */
export function buildJobPayload(form: JobFormState, original: JobDetail | null): JobUpsert {
  const values = {
    schedule: form.schedule.trim(),
    timeZone: form.timeZone.trim(),
    script: form.script,
    image: form.image.trim(),
    tag: form.tag.trim(),
    envSecretRef: form.envSecretRef.trim(),
    timeoutSeconds: Number(form.timeoutSeconds),
    enabled: form.enabled,
  };

  if (!original) {
    const body: JobUpsert = {
      timeZone: values.timeZone,
      script: values.script,
      timeoutSeconds: values.timeoutSeconds,
      enabled: values.enabled,
    };
    if (values.schedule) body.schedule = values.schedule;
    if (values.image) body.image = values.image;
    if (values.tag) body.tag = values.tag;
    if (values.envSecretRef) body.envSecretRef = values.envSecretRef;
    return body;
  }

  const body: JobUpsert = {};
  if (values.schedule !== (original.schedule ?? "")) body.schedule = values.schedule;
  if (values.timeZone !== original.timeZone) body.timeZone = values.timeZone;
  if (values.script !== original.script) body.script = values.script;
  if (values.image !== original.image) body.image = values.image;
  if (values.tag !== original.tag) body.tag = values.tag;
  if (values.envSecretRef !== (original.envSecretRef ?? "")) {
    body.envSecretRef = values.envSecretRef;
  }
  if (values.timeoutSeconds !== original.timeoutSeconds) {
    body.timeoutSeconds = values.timeoutSeconds;
  }
  if (values.enabled !== original.enabled) body.enabled = values.enabled;
  return body;
}

const FIELD_KEYS: Array<keyof JobFormState> = [
  "name",
  "schedule",
  "timeZone",
  "image",
  "tag",
  "envSecretRef",
  "timeoutSeconds",
  "enabled",
  "script",
];

interface ScriptVersionsDialogProps {
  open: boolean;
  jobName: string;
  onClose: () => void;
}

/** Lists a job's stored script versions and shows a chosen body read-only. */
function ScriptVersionsDialog({ open, jobName, onClose }: ScriptVersionsDialogProps) {
  const [versions, setVersions] = useState<ScriptVersion[] | null>(null);
  const [viewing, setViewing] = useState<ScriptVersionBody | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setVersions(null);
    setViewing(null);
    setError(null);
    jobsApi
      .scriptVersions(jobName)
      .then((v) => {
        if (active) setVersions(v);
      })
      .catch((err: unknown) => {
        if (active) setError(jobsErrorMessage(err, "Failed to load versions"));
      });
    return () => {
      active = false;
    };
  }, [open, jobName]);

  const view = async (version: number) => {
    setError(null);
    try {
      setViewing(await jobsApi.scriptVersion(jobName, version));
    } catch (err) {
      setError(jobsErrorMessage(err, "Failed to load the script version"));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>
        {viewing ? `Script version ${viewing.version}` : "Script versions"}
      </DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        {!viewing && versions === null && !error && <CircularProgress size={24} />}
        {!viewing && versions?.length === 0 && (
          <Typography color="text.secondary">No versions stored.</Typography>
        )}
        {!viewing && versions && versions.length > 0 && (
          <List dense aria-label="script versions">
            {versions.map((v) => (
              <ListItemButton key={v.version} onClick={() => void view(v.version)}>
                <ListItemText
                  primary={`Version ${v.version}`}
                  secondary={`by ${v.updatedBy}, ${formatRelative(v.updatedAt)} · sha256 ${v.sha256.slice(0, 12)}`}
                />
              </ListItemButton>
            ))}
          </List>
        )}
        {viewing && (
          <TextField
            label={`Version ${viewing.version}`}
            value={viewing.script}
            multiline
            minRows={SCRIPT_MIN_ROWS}
            fullWidth
            slotProps={{
              input: { readOnly: true, sx: { fontFamily: MONOSPACE, fontSize: 13 } },
            }}
          />
        )}
      </DialogContent>
      <DialogActions>
        {viewing && <Button onClick={() => setViewing(null)}>Back to versions</Button>}
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Create or edit a scheduled job. Edit loads the full job (with its script)
 * from the gateway and sends only the changed fields; create sends every field
 * with a value. A 400 naming a field is shown under that field.
 */
export default function JobFormDialog({
  open,
  onClose,
  onSaved,
  jobName,
}: JobFormDialogProps) {
  const isEdit = Boolean(jobName);
  const [form, setForm] = useState<JobFormState>(emptyForm);
  const [original, setOriginal] = useState<JobDetail | null>(null);
  const [errors, setErrors] = useState<JobFieldErrors>({});
  const [loadingJob, setLoadingJob] = useState(false);
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const { showSuccess } = useSnackbar();

  useEffect(() => {
    if (!open) return;
    let active = true;
    setErrors({});
    setApiError(null);
    setBusy(false);
    setVersionsOpen(false);
    setOriginal(null);
    if (!jobName) {
      setForm(emptyForm());
      setLoadingJob(false);
      return;
    }
    setLoadingJob(true);
    jobsApi
      .get(jobName)
      .then((job) => {
        if (!active) return;
        setOriginal(job);
        setForm(formFromJob(job));
      })
      .catch((err: unknown) => {
        if (active) setApiError(jobsErrorMessage(err, "Failed to load job"));
      })
      .finally(() => {
        if (active) setLoadingJob(false);
      });
    return () => {
      active = false;
    };
  }, [open, jobName]);

  const zones = useMemo(() => timeZoneOptions(form.timeZone), [form.timeZone]);

  const set = <K extends keyof JobFormState>(key: K, value: JobFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const editReady = !isEdit || original !== null;
  const disabled = busy || loadingJob || !editReady;

  const handleSubmit = async () => {
    const found = validateJobForm(form, isEdit);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const name = isEdit && jobName ? jobName : form.name.trim();
    const body = buildJobPayload(form, original);
    if (isEdit && Object.keys(body).length === 0) {
      onClose();
      return;
    }

    setBusy(true);
    setApiError(null);
    try {
      const saved = await jobsApi.upsert(name, body);
      showSuccess(
        saved?.nextRunAt
          ? `Saved ${name}, next run ${new Date(saved.nextRunAt).toLocaleString()}`
          : `Saved ${name}`,
      );
      onSaved?.(saved);
      onClose();
    } catch (err) {
      const parsed = parseJobsApiError(err);
      const field = parsed.field as keyof JobFormState | null;
      if (parsed.status === 400 && field && FIELD_KEYS.includes(field)) {
        setErrors({ [field]: parsed.error ?? "Invalid value" });
      } else {
        setApiError(jobsErrorMessage(err, "Failed to save job"));
      }
    } finally {
      setBusy(false);
    }
  };

  const scheduleHelper =
    errors.schedule ??
    (form.schedule.trim() === ""
      ? "Five cron fields (minute hour day month weekday). Empty means manual only."
      : original?.nextRunAt && form.schedule.trim() === (original.schedule ?? "")
        ? `Next run ${new Date(original.nextRunAt).toLocaleString()} (${original.timeZone})`
        : "Five cron fields (minute hour day month weekday). The next run time shows after save.");

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth="lg"
      fullWidth
    >
      <DialogTitle>{isEdit ? `Edit job ${jobName}` : "New job"}</DialogTitle>
      <DialogContent>
        {loadingJob && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress aria-label="loading job" />
          </Box>
        )}
        {!loadingJob && (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
              <TextField
                label="Name"
                value={isEdit ? (jobName ?? "") : form.name}
                onChange={(e) => set("name", e.target.value)}
                error={Boolean(errors.name)}
                helperText={
                  errors.name ??
                  (isEdit
                    ? "Name cannot be changed"
                    : "Lowercase letters, digits and dashes")
                }
                disabled={isEdit || disabled}
                fullWidth
                autoFocus={!isEdit}
              />
              <TextField
                label="Schedule"
                value={form.schedule}
                onChange={(e) => set("schedule", e.target.value)}
                error={Boolean(errors.schedule)}
                helperText={scheduleHelper}
                disabled={disabled}
                fullWidth
                placeholder="0 2 * * *"
                slotProps={{ htmlInput: { style: { fontFamily: MONOSPACE } } }}
              />
              <Autocomplete
                options={zones}
                value={form.timeZone || null}
                onChange={(_e, value) => set("timeZone", value ?? "")}
                disabled={disabled}
                fullWidth
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Time zone"
                    error={Boolean(errors.timeZone)}
                    helperText={errors.timeZone ?? "IANA zone the schedule runs in"}
                  />
                )}
              />
            </Stack>

            <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
              <TextField
                label="Image"
                value={form.image}
                onChange={(e) => set("image", e.target.value)}
                error={Boolean(errors.image)}
                helperText={errors.image ?? (isEdit ? undefined : "Blank uses the gateway default")}
                disabled={disabled}
                fullWidth
              />
              <TextField
                label="Tag"
                value={form.tag}
                onChange={(e) => set("tag", e.target.value)}
                error={Boolean(errors.tag)}
                helperText={errors.tag ?? (isEdit ? undefined : "Blank uses the gateway default")}
                disabled={disabled}
                fullWidth
              />
            </Stack>

            <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ alignItems: "flex-start" }}>
              <TextField
                label="Env secret ref"
                value={form.envSecretRef}
                onChange={(e) => set("envSecretRef", e.target.value)}
                error={Boolean(errors.envSecretRef)}
                helperText={
                  errors.envSecretRef ??
                  "Secrets Manager name or ARN whose keys become the run environment. Blank for none."
                }
                disabled={disabled}
                fullWidth
              />
              <TextField
                label="Timeout seconds"
                type="number"
                value={form.timeoutSeconds}
                onChange={(e) => set("timeoutSeconds", e.target.value)}
                error={Boolean(errors.timeoutSeconds)}
                helperText={errors.timeoutSeconds ?? `${TIMEOUT_MIN} to ${TIMEOUT_MAX}`}
                disabled={disabled}
                sx={{ minWidth: 200 }}
                slotProps={{ htmlInput: { min: TIMEOUT_MIN, max: TIMEOUT_MAX, step: 1 } }}
              />
              <FormControlLabel
                sx={{ pt: 1, minWidth: 140 }}
                control={
                  <Switch
                    checked={form.enabled}
                    onChange={(e) => set("enabled", e.target.checked)}
                    disabled={disabled}
                  />
                }
                label="Enabled"
              />
            </Stack>

            <TextField
              label="Script"
              value={form.script}
              onChange={(e) => set("script", e.target.value)}
              error={Boolean(errors.script)}
              helperText={errors.script}
              disabled={disabled}
              multiline
              minRows={SCRIPT_MIN_ROWS}
              fullWidth
              slotProps={{
                input: { sx: { fontFamily: MONOSPACE, fontSize: 13 } },
                htmlInput: { spellCheck: false },
              }}
            />

            {isEdit && original && (
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <Typography variant="body2" color="text.secondary">
                  script version {original.scriptVersion}
                </Typography>
                <Link
                  component="button"
                  type="button"
                  variant="body2"
                  onClick={() => setVersionsOpen(true)}
                >
                  View versions
                </Link>
              </Stack>
            )}
          </Stack>
        )}
        {apiError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {apiError}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={disabled} variant="contained">
          Save
        </Button>
      </DialogActions>

      {isEdit && jobName && (
        <ScriptVersionsDialog
          open={versionsOpen}
          jobName={jobName}
          onClose={() => setVersionsOpen(false)}
        />
      )}
    </Dialog>
  );
}
