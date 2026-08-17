import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Link,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import servicesApi from "../api/servicesApi";
import type { DesiredStatus, ServiceSummary, ServiceUpsert } from "../api/types";
import { useSnackbar } from "../contexts/SnackbarContext";

export interface ServiceFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful upsert so the caller can refresh the fleet. */
  onSaved?: () => void;
  /**
   * When provided, the dialog edits this existing service: its fields are
   * prefilled and the name (the primary key / route prefix) is read-only.
   */
  service?: ServiceSummary | null;
}

export const NAME_PATTERN = /^[a-z0-9-]+$/;

/**
 * Exact-origin format: scheme://host[:port], no path or query, no wildcards.
 * Host is a hostname or IPv4 literal — the gateway rejects paths and `*`, so
 * we mirror that check client-side to fail fast with a clear message.
 */
export const ORIGIN_PATTERN = /^https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?$/;

interface FormState {
  name: string;
  image: string;
  tag: string;
  port: string;
  includeInHealth: boolean;
  desiredStatus: DesiredStatus;
  envSecretRef: string;
  realtimeAllowedOrigins: string;
  realtimeAuthPath: string;
  realtimeMessagePath: string;
  realtimePresence: boolean;
}

/**
 * Per-field "did the user touch this?" flags for the realtime section. The
 * gateway's upsert is tri-state on those fields (absent = preserve, "" = clear,
 * non-empty = set) — so we must only send fields the user actually edited, or
 * saving an unrelated change would silently overwrite (or wipe) a stored
 * realtime value. Non-realtime fields don't need this: they are always required
 * and always sent.
 */
type RealtimeKey =
  | "realtimeAllowedOrigins"
  | "realtimeAuthPath"
  | "realtimeMessagePath"
  | "realtimePresence";

type RealtimeTouched = Record<RealtimeKey, boolean>;

const INITIAL: FormState = {
  name: "",
  image: "",
  tag: "latest",
  port: "8080",
  includeInHealth: false,
  desiredStatus: "running",
  envSecretRef: "",
  realtimeAllowedOrigins: "",
  realtimeAuthPath: "",
  realtimeMessagePath: "",
  realtimePresence: false,
};

const INITIAL_TOUCHED: RealtimeTouched = {
  realtimeAllowedOrigins: false,
  realtimeAuthPath: false,
  realtimeMessagePath: false,
  realtimePresence: false,
};

type FieldErrors = Partial<
  Record<
    | "name"
    | "image"
    | "tag"
    | "port"
    | "realtimeAllowedOrigins"
    | "realtimeAuthPath"
    | "realtimeMessagePath",
    string
  >
>;

/** Split the comma-separated origins field, trimming and dropping empty entries. */
export function parseOrigins(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Client-side validation mirroring the gateway's own constraints. */
export function validate(form: FormState, touched: RealtimeTouched): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.name.trim()) {
    errors.name = "Name is required";
  } else if (!NAME_PATTERN.test(form.name)) {
    errors.name = "Name must match ^[a-z0-9-]+$";
  }
  if (!form.image.trim()) errors.image = "Image is required";
  if (!form.tag.trim()) errors.tag = "Tag is required";

  const port = Number(form.port);
  if (!form.port.trim() || !Number.isInteger(port) || port < 1 || port > 65535) {
    errors.port = "Port must be an integer between 1 and 65535";
  }

  // Only validate realtime fields the user actually edited: untouched fields
  // are omitted from the payload entirely, so their contents are irrelevant.
  if (touched.realtimeAllowedOrigins && form.realtimeAllowedOrigins.trim()) {
    const bad = parseOrigins(form.realtimeAllowedOrigins).find(
      (o) => !ORIGIN_PATTERN.test(o),
    );
    if (bad) {
      errors.realtimeAllowedOrigins = `"${bad}" is not a valid origin (scheme://host[:port], no paths or wildcards)`;
    }
  }
  if (touched.realtimeAuthPath && form.realtimeAuthPath.trim()) {
    if (!form.realtimeAuthPath.startsWith("/")) {
      errors.realtimeAuthPath = "Auth path must be rooted (start with /)";
    }
  }
  if (touched.realtimeMessagePath && form.realtimeMessagePath.trim()) {
    if (!form.realtimeMessagePath.startsWith("/")) {
      errors.realtimeMessagePath = "Message path must be rooted (start with /)";
    }
  }
  return errors;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "response" in err) {
    const data = (err as { response?: { data?: unknown } }).response?.data;
    if (typeof data === "string" && data) return data;
    if (data && typeof data === "object" && "message" in data) {
      const m = (data as { message?: unknown }).message;
      if (typeof m === "string" && m) return m;
    }
    return "Failed to save service";
  }
  return err instanceof Error ? err.message : "Failed to save service";
}

/**
 * Create (or overwrite) a service definition. Validates name/port client-side
 * before calling the upsert endpoint and surfaces API failures inline.
 */
export default function ServiceFormDialog({
  open,
  onClose,
  onSaved,
  service,
}: ServiceFormDialogProps) {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [touched, setTouched] = useState<RealtimeTouched>(INITIAL_TOUCHED);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const { showSuccess } = useSnackbar();

  const isEdit = Boolean(service);

  useEffect(() => {
    if (open) {
      setForm(
        service
          ? {
              name: service.name,
              image: service.image,
              tag: service.tag,
              port: String(service.port),
              includeInHealth: service.includeInHealth,
              desiredStatus: service.desiredStatus,
              envSecretRef: service.envSecretRef ?? "",
              realtimeAllowedOrigins: service.realtimeAllowedOrigins ?? "",
              realtimeAuthPath: service.realtimeAuthPath ?? "",
              realtimeMessagePath: service.realtimeMessagePath ?? "",
              realtimePresence: Boolean(service.realtimePresence),
            }
          : INITIAL,
      );
      setTouched(INITIAL_TOUCHED);
      setErrors({});
      setBusy(false);
      setApiError(null);
    }
  }, [open, service]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const setRealtime = <K extends RealtimeKey>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTouched((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  };

  const handleSubmit = async () => {
    const found = validate(form, touched);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const payload: ServiceUpsert = {
      name: form.name.trim(),
      image: form.image.trim(),
      tag: form.tag.trim(),
      port: Number(form.port),
      includeInHealth: form.includeInHealth,
      desiredStatus: form.desiredStatus,
    };

    // The gateway's upsert is tri-state for envSecretRef (absent = preserve,
    // empty string = clear, non-empty = set). This form always displays the
    // current value, so the field's content IS the user's intent — send it
    // verbatim: a blank field explicitly clears the stored ref, matching what
    // the user sees. (Omitting it would silently preserve a ref the user just
    // deleted.) Send only the reference, never secret values.
    payload.envSecretRef = form.envSecretRef.trim();

    // Realtime fields use tri-state omission driven by per-field touched
    // flags: only send what the user actually edited. This is the ONLY safe
    // choice for these — the form is shared with unrelated edits (image,
    // tag, port, …), and sending a blank untouched field would silently wipe
    // a stored value the user never saw or changed. Empty-string-when-touched
    // is a real clear.
    if (touched.realtimeAllowedOrigins) {
      payload.realtimeAllowedOrigins = parseOrigins(
        form.realtimeAllowedOrigins,
      ).join(",");
    }
    if (touched.realtimeAuthPath) {
      payload.realtimeAuthPath = form.realtimeAuthPath.trim();
    }
    if (touched.realtimeMessagePath) {
      payload.realtimeMessagePath = form.realtimeMessagePath.trim();
    }
    if (touched.realtimePresence) {
      payload.realtimePresence = form.realtimePresence;
    }

    setBusy(true);
    setApiError(null);
    try {
      await servicesApi.upsert(payload);
      showSuccess(`Saved ${payload.name}`);
      onSaved?.();
      onClose();
    } catch (err) {
      setApiError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle>{isEdit ? "Edit service" : "Add service"}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Name"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            error={Boolean(errors.name)}
            helperText={
              errors.name ??
              (isEdit
                ? "Name is the primary key and cannot be changed"
                : "Lowercase letters, digits and dashes")
            }
            disabled={busy}
            fullWidth
            autoFocus={!isEdit}
            slotProps={isEdit ? { input: { readOnly: true } } : undefined}
          />
          <TextField
            label="Image"
            value={form.image}
            onChange={(e) => set("image", e.target.value)}
            error={Boolean(errors.image)}
            helperText={errors.image}
            disabled={busy}
            fullWidth
            autoFocus={isEdit}
          />
          <TextField
            label="Tag"
            value={form.tag}
            onChange={(e) => set("tag", e.target.value)}
            error={Boolean(errors.tag)}
            helperText={errors.tag}
            disabled={busy}
            fullWidth
          />
          <TextField
            label="Port"
            value={form.port}
            onChange={(e) => set("port", e.target.value)}
            error={Boolean(errors.port)}
            helperText={errors.port}
            disabled={busy}
            fullWidth
            slotProps={{ htmlInput: { inputMode: "numeric" } }}
          />
          <TextField
            label="Env secret ref"
            value={form.envSecretRef}
            onChange={(e) => set("envSecretRef", e.target.value)}
            helperText="AWS Secrets Manager secret name or ARN; its flat JSON keys become the container environment. Leave blank for none."
            disabled={busy}
            fullWidth
          />
          <TextField
            select
            label="Desired status"
            value={form.desiredStatus}
            onChange={(e) => set("desiredStatus", e.target.value as DesiredStatus)}
            disabled={busy}
            fullWidth
          >
            <MenuItem value="running">running</MenuItem>
            <MenuItem value="stopped">stopped</MenuItem>
          </TextField>
          <FormControlLabel
            control={
              <Switch
                checked={form.includeInHealth}
                onChange={(e) => set("includeInHealth", e.target.checked)}
                disabled={busy}
              />
            }
            label="Include in health checks"
          />

          <Divider />

          <Stack spacing={1}>
            <Stack
              direction="row"
              spacing={1}
              sx={{ alignItems: "center", flexWrap: "wrap" }}
            >
              <Link
                href="https://github.com/benjaminfkile/gateway-api/blob/main/REALTIME.md"
                target="_blank"
                rel="noopener noreferrer"
                underline="hover"
                variant="subtitle2"
              >
                Realtime hub
              </Link>
              {service?.hasPublishToken !== undefined && (
                <Chip
                  label={
                    service.hasPublishToken
                      ? "publish token minted"
                      : "no publish token"
                  }
                  color={service.hasPublishToken ? "success" : "default"}
                  size="small"
                  variant="outlined"
                />
              )}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Per-service SignalR channels for browser clients. Leaving all
              fields blank leaves the feature off; each field is preserved on
              save unless you edit it here.
            </Typography>
          </Stack>

          <TextField
            label="Allowed origins"
            value={form.realtimeAllowedOrigins}
            onChange={(e) => setRealtime("realtimeAllowedOrigins", e.target.value)}
            error={Boolean(errors.realtimeAllowedOrigins)}
            helperText={
              errors.realtimeAllowedOrigins ??
              "Comma-separated exact origins, e.g. https://app.example.com, https://admin.example.com:8443. No paths, no wildcards."
            }
            disabled={busy}
            fullWidth
          />
          <TextField
            label="Auth path"
            value={form.realtimeAuthPath}
            onChange={(e) => setRealtime("realtimeAuthPath", e.target.value)}
            error={Boolean(errors.realtimeAuthPath)}
            helperText={
              errors.realtimeAuthPath ??
              "Rooted path on the service that authorises private channel joins (e.g. /realtime/auth). Blank keeps channels public."
            }
            disabled={busy}
            fullWidth
          />
          <TextField
            label="Message path"
            value={form.realtimeMessagePath}
            onChange={(e) => setRealtime("realtimeMessagePath", e.target.value)}
            error={Boolean(errors.realtimeMessagePath)}
            helperText={
              errors.realtimeMessagePath ??
              "Rooted path that receives client-to-service messages (SendToChannel). Blank disables client-to-service messaging."
            }
            disabled={busy}
            fullWidth
          />
          <Stack spacing={0.5}>
            <FormControlLabel
              control={
                <Switch
                  checked={form.realtimePresence}
                  onChange={(e) =>
                    setRealtime("realtimePresence", e.target.checked)
                  }
                  disabled={busy}
                />
              }
              label="Broadcast presence events"
            />
            <Typography variant="caption" color="text.secondary">
              Warning: presence broadcasts connection ids and identities to all
              subscribers on a channel. Only enable if that visibility is
              acceptable to your clients.
            </Typography>
          </Stack>

          {apiError && <Alert severity="error">{apiError}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={busy} variant="contained">
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}
