import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
} from "@mui/material";
import servicesApi from "../api/servicesApi";
import type { DesiredStatus, ServiceUpsert } from "../api/types";
import { useSnackbar } from "../contexts/SnackbarContext";

export interface ServiceFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful upsert so the caller can refresh the fleet. */
  onSaved?: () => void;
}

export const NAME_PATTERN = /^[a-z0-9-]+$/;

interface FormState {
  name: string;
  image: string;
  tag: string;
  port: string;
  includeInHealth: boolean;
  desiredStatus: DesiredStatus;
}

const INITIAL: FormState = {
  name: "",
  image: "",
  tag: "latest",
  port: "8080",
  includeInHealth: false,
  desiredStatus: "running",
};

type FieldErrors = Partial<Record<"name" | "image" | "tag" | "port", string>>;

/** Client-side validation mirroring the gateway's own constraints. */
export function validate(form: FormState): FieldErrors {
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
}: ServiceFormDialogProps) {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const { showSuccess } = useSnackbar();

  useEffect(() => {
    if (open) {
      setForm(INITIAL);
      setErrors({});
      setBusy(false);
      setApiError(null);
    }
  }, [open]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async () => {
    const found = validate(form);
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
      <DialogTitle>Add service</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField
            label="Name"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            error={Boolean(errors.name)}
            helperText={errors.name ?? "Lowercase letters, digits and dashes"}
            disabled={busy}
            fullWidth
            autoFocus
          />
          <TextField
            label="Image"
            value={form.image}
            onChange={(e) => set("image", e.target.value)}
            error={Boolean(errors.image)}
            helperText={errors.image}
            disabled={busy}
            fullWidth
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
