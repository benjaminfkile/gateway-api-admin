import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
} from "@mui/material";
import servicesApi from "../api/servicesApi";
import type { ServiceSummary } from "../api/types";
import { useSnackbar } from "../contexts/SnackbarContext";

export interface RemoveServiceDialogProps {
  open: boolean;
  service: ServiceSummary | null;
  onClose: () => void;
  /** Called after a successful removal so the caller can refresh the fleet. */
  onRemoved?: () => void;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "response" in err) {
    const data = (err as { response?: { data?: unknown } }).response?.data;
    if (typeof data === "string" && data) return data;
    if (data && typeof data === "object" && "message" in data) {
      const m = (data as { message?: unknown }).message;
      if (typeof m === "string" && m) return m;
    }
    return "Failed to remove service";
  }
  return err instanceof Error ? err.message : "Failed to remove service";
}

/**
 * Destructive confirmation for removing a service. The confirm button stays
 * disabled until the operator types the service name exactly. Health-critical
 * services (includeInHealth) are refused by the gateway without `?force=true`,
 * so a "force removal" checkbox is surfaced for those.
 */
export default function RemoveServiceDialog({
  open,
  service,
  onClose,
  onRemoved,
}: RemoveServiceDialogProps) {
  const [typed, setTyped] = useState("");
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const { showSuccess } = useSnackbar();

  useEffect(() => {
    if (open) {
      setTyped("");
      setForce(false);
      setBusy(false);
      setApiError(null);
    }
  }, [open]);

  if (!service) return null;

  const healthCritical = service.includeInHealth;
  const nameMatches = typed.trim() === service.name;
  const confirmDisabled = busy || !nameMatches;

  const handleRemove = async () => {
    if (!nameMatches) return;
    setBusy(true);
    setApiError(null);
    try {
      await servicesApi.remove(service.name, force ? true : undefined);
      showSuccess(`Removed ${service.name}`);
      onRemoved?.();
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
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>Remove {service.name}?</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          <Alert severity="error">
            This permanently removes "{service.name}" from the fleet. This cannot
            be undone.
          </Alert>
          {healthCritical && (
            <Alert severity="warning">
              "{service.name}" is included in health checks. The gateway will
              refuse to remove it unless you force removal.
            </Alert>
          )}
          <DialogContentText>
            Type <strong>{service.name}</strong> to confirm.
          </DialogContentText>
          <TextField
            label="Service name"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
            fullWidth
            autoFocus
            autoComplete="off"
          />
          {healthCritical && (
            <FormControlLabel
              control={
                <Checkbox
                  checked={force}
                  onChange={(e) => setForce(e.target.checked)}
                  disabled={busy}
                />
              }
              label="Force removal"
            />
          )}
          {apiError && <Alert severity="error">{apiError}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={handleRemove}
          disabled={confirmDisabled}
          color="error"
          variant="contained"
        >
          Remove
        </Button>
      </DialogActions>
    </Dialog>
  );
}
