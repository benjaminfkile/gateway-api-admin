import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Link,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import loadApi, { loadErrorMessage, parseLoadApiError } from "../api/loadApi";
import type {
  LoadScenarioDetail,
  LoadScenarioUpsert,
  ScriptVersion,
  ScriptVersionBody,
} from "../api/types";
import { useSnackbar } from "../contexts/SnackbarContext";
import { formatRelative } from "../pages/ServicesPage";
import KeyValueRows, { mapFromRows, rowsFromMap, type KeyValueRow } from "./KeyValueRows";

const MONOSPACE =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const SCRIPT_MIN_ROWS = 16;
/** Largest script body the gateway stores, in UTF-8 bytes. */
export const SCENARIO_SCRIPT_MAX_BYTES = 262_144;
export const MAX_VUS_LIMIT = 100_000;
export const SCENARIO_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface ScenarioFormState {
  name: string;
  repository: string;
  commitSha: string;
  image: string;
  tag: string;
  maxVusPerGenerator: string;
  params: KeyValueRow[];
  script: string;
}

export type ScenarioFieldErrors = Partial<Record<keyof ScenarioFormState, string>>;

function emptyForm(): ScenarioFormState {
  return {
    name: "",
    repository: "",
    commitSha: "",
    image: "",
    tag: "",
    maxVusPerGenerator: "",
    params: [],
    script: "",
  };
}

export function formFromScenario(s: LoadScenarioDetail): ScenarioFormState {
  return {
    name: s.name,
    repository: s.repository ?? "",
    commitSha: s.commitSha ?? "",
    image: s.image ?? "",
    tag: s.tag ?? "",
    maxVusPerGenerator: String(s.maxVusPerGenerator),
    params: rowsFromMap(s.paramsDefault),
    script: s.script ?? "",
  };
}

/** Client-side checks mirroring the gateway's 400 rules. */
export function validateScenarioForm(form: ScenarioFormState, isEdit: boolean): ScenarioFieldErrors {
  const errors: ScenarioFieldErrors = {};
  if (!isEdit && !SCENARIO_NAME_PATTERN.test(form.name.trim())) {
    errors.name = "2 to 63 lowercase letters, digits or dashes";
  }
  if (!REPOSITORY_PATTERN.test(form.repository.trim())) {
    errors.repository = "Repository as owner/name";
  }
  const vus = Number(form.maxVusPerGenerator);
  if (!Number.isInteger(vus) || vus < 1 || vus > MAX_VUS_LIMIT) {
    errors.maxVusPerGenerator = `A whole number from 1 to ${MAX_VUS_LIMIT}`;
  }
  if (!form.script.trim()) errors.script = "Script is required";
  else if (new TextEncoder().encode(form.script).length > SCENARIO_SCRIPT_MAX_BYTES) {
    errors.script = `Script must be at most ${SCENARIO_SCRIPT_MAX_BYTES} bytes`;
  }
  return errors;
}

function sameMap(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k]);
}

/**
 * The PUT body: every field with a value on create, only changed fields on
 * edit so the gateway keeps the rest (and a script left alone keeps its version).
 */
export function buildScenarioPayload(
  form: ScenarioFormState,
  original: LoadScenarioDetail | null,
): LoadScenarioUpsert {
  const values = {
    repository: form.repository.trim(),
    commitSha: form.commitSha.trim(),
    image: form.image.trim(),
    tag: form.tag.trim(),
    maxVusPerGenerator: Number(form.maxVusPerGenerator),
    paramsDefault: mapFromRows(form.params),
    script: form.script,
  };
  if (!original) {
    const body: LoadScenarioUpsert = {
      repository: values.repository,
      script: values.script,
      maxVusPerGenerator: values.maxVusPerGenerator,
      paramsDefault: values.paramsDefault,
    };
    if (values.commitSha) body.commitSha = values.commitSha;
    if (values.image) body.image = values.image;
    if (values.tag) body.tag = values.tag;
    return body;
  }
  const body: LoadScenarioUpsert = {};
  if (values.repository !== original.repository) body.repository = values.repository;
  if (values.commitSha !== (original.commitSha ?? "")) body.commitSha = values.commitSha;
  if (values.image !== (original.image ?? "")) body.image = values.image;
  if (values.tag !== (original.tag ?? "")) body.tag = values.tag;
  if (values.maxVusPerGenerator !== original.maxVusPerGenerator) {
    body.maxVusPerGenerator = values.maxVusPerGenerator;
  }
  if (!sameMap(values.paramsDefault, original.paramsDefault ?? {})) {
    body.paramsDefault = values.paramsDefault;
  }
  if (values.script !== original.script) body.script = values.script;
  return body;
}

const FIELD_KEYS: Array<keyof ScenarioFormState> = [
  "name",
  "repository",
  "commitSha",
  "image",
  "tag",
  "maxVusPerGenerator",
  "script",
];

/** Lists a scenario's stored script versions and shows a chosen body read-only. */
function ScenarioVersionsDialog({
  open,
  name,
  onClose,
}: {
  open: boolean;
  name: string;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<ScriptVersion[] | null>(null);
  const [viewing, setViewing] = useState<ScriptVersionBody | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setVersions(null);
    setViewing(null);
    setError(null);
    loadApi
      .scriptVersions(name)
      .then((v) => {
        if (active) setVersions(v);
      })
      .catch((err: unknown) => {
        if (active) setError(loadErrorMessage(err, "Failed to load versions"));
      });
    return () => {
      active = false;
    };
  }, [open, name]);

  const view = async (version: number) => {
    setError(null);
    try {
      setViewing(await loadApi.scriptVersion(name, version));
    } catch (err) {
      setError(loadErrorMessage(err, "Failed to load the script version"));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{viewing ? `Script version ${viewing.version}` : "Script versions"}</DialogTitle>
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
                  secondary={`by ${v.updatedBy}, ${formatRelative(v.updatedAt)}, sha256 ${v.sha256.slice(0, 12)}`}
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
            slotProps={{ input: { readOnly: true, sx: { fontFamily: MONOSPACE, fontSize: 13 } } }}
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

export interface ScenarioFormDialogProps {
  open: boolean;
  /** Scenario to edit; null opens the create form. */
  name: string | null;
  onClose: () => void;
  onSaved?: () => void;
}

/** Create or edit a load scenario, its default params and its k6 script. */
export default function ScenarioFormDialog({ open, name, onClose, onSaved }: ScenarioFormDialogProps) {
  const isEdit = Boolean(name);
  const [form, setForm] = useState<ScenarioFormState>(emptyForm);
  const [original, setOriginal] = useState<LoadScenarioDetail | null>(null);
  const [errors, setErrors] = useState<ScenarioFieldErrors>({});
  const [loading, setLoading] = useState(false);
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
    if (!name) {
      setForm(emptyForm());
      setLoading(false);
      return;
    }
    setLoading(true);
    loadApi
      .scenario(name)
      .then((s) => {
        if (!active) return;
        setOriginal(s);
        setForm(formFromScenario(s));
      })
      .catch((err: unknown) => {
        if (active) setApiError(loadErrorMessage(err, "Failed to load scenario"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, name]);

  const set = <K extends keyof ScenarioFormState>(key: K, value: ScenarioFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const disabled = busy || loading || (isEdit && original === null);

  const handleSubmit = async () => {
    const found = validateScenarioForm(form, isEdit);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const target = isEdit && name ? name : form.name.trim();
    const body = buildScenarioPayload(form, original);
    if (isEdit && Object.keys(body).length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    setApiError(null);
    try {
      await loadApi.upsertScenario(target, body);
      showSuccess(`Saved scenario ${target}`);
      onSaved?.();
      onClose();
    } catch (err) {
      const parsed = parseLoadApiError(err);
      const field = (parsed.field === "paramsDefault" ? null : parsed.field) as
        | keyof ScenarioFormState
        | null;
      if (parsed.status === 400 && field && FIELD_KEYS.includes(field)) {
        setErrors({ [field]: parsed.error ?? "Invalid value" });
      } else {
        setApiError(loadErrorMessage(err, "Failed to save scenario"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="lg" fullWidth>
      <DialogTitle>{isEdit ? `Edit scenario ${name}` : "New scenario"}</DialogTitle>
      <DialogContent>
        {loading && (
          <Box sx={{ display: "flex", justifyContent: "center", py: 4 }}>
            <CircularProgress aria-label="loading scenario" />
          </Box>
        )}
        {!loading && (
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Stack direction={{ xs: "column", md: "row" }} spacing={2}>
              <TextField
                label="Name"
                value={isEdit ? (name ?? "") : form.name}
                onChange={(e) => set("name", e.target.value)}
                error={Boolean(errors.name)}
                helperText={errors.name ?? (isEdit ? "Name cannot be changed" : undefined)}
                disabled={isEdit || disabled}
                fullWidth
              />
              <TextField
                label="Repository"
                value={form.repository}
                onChange={(e) => set("repository", e.target.value)}
                error={Boolean(errors.repository)}
                helperText={errors.repository ?? "owner/name"}
                disabled={disabled}
                fullWidth
              />
              <TextField
                label="Commit"
                value={form.commitSha}
                onChange={(e) => set("commitSha", e.target.value)}
                error={Boolean(errors.commitSha)}
                helperText={errors.commitSha}
                disabled={disabled}
                fullWidth
                slotProps={{ htmlInput: { style: { fontFamily: MONOSPACE } } }}
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
              <TextField
                label="Max users per generator"
                type="number"
                value={form.maxVusPerGenerator}
                onChange={(e) => set("maxVusPerGenerator", e.target.value)}
                error={Boolean(errors.maxVusPerGenerator)}
                helperText={errors.maxVusPerGenerator ?? `1 to ${MAX_VUS_LIMIT}`}
                disabled={disabled}
                fullWidth
                slotProps={{ htmlInput: { min: 1, max: MAX_VUS_LIMIT, step: 1 } }}
              />
            </Stack>
            <KeyValueRows
              label="Params default"
              rows={form.params}
              onChange={(rows) => set("params", rows)}
              disabled={disabled}
            />
            <TextField
              label="Script"
              value={form.script}
              onChange={(e) => set("script", e.target.value)}
              error={Boolean(errors.script)}
              helperText={errors.script ?? "k6 script; a change bumps the version and clears validation"}
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
                <Link component="button" type="button" variant="body2" onClick={() => setVersionsOpen(true)}>
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
      {isEdit && name && (
        <ScenarioVersionsDialog open={versionsOpen} name={name} onClose={() => setVersionsOpen(false)} />
      )}
    </Dialog>
  );
}
