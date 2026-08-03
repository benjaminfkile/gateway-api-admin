import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import servicesApi from "../api/servicesApi";
import type { ServiceSummary } from "../api/types";
import { useSnackbar } from "../contexts/SnackbarContext";

export interface DeployDialogProps {
  open: boolean;
  service: ServiceSummary | null;
  onClose: () => void;
  /** Called after a successful deploy so the caller can refresh the fleet. */
  onDeployed?: () => void;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "response" in err) {
    const data = (err as { response?: { data?: unknown } }).response?.data;
    if (typeof data === "string" && data) return data;
    if (data && typeof data === "object" && "message" in data) {
      const m = (data as { message?: unknown }).message;
      if (typeof m === "string" && m) return m;
    }
    return "Deploy failed";
  }
  return err instanceof Error ? err.message : "Deploy failed";
}

/**
 * Rolls a new image tag onto a service. Shows the current digest for context and
 * surfaces API failures inline; on success it toasts with a shortcut to the
 * live deploy progress page.
 */
export default function DeployDialog({
  open,
  service,
  onClose,
  onDeployed,
}: DeployDialogProps) {
  const [tag, setTag] = useState("latest");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { showSuccess } = useSnackbar();

  // Reset the form each time the dialog is (re)opened.
  useEffect(() => {
    if (open) {
      setTag("latest");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  if (!service) return null;

  const trimmed = tag.trim();
  const digest = service.digest ? service.digest.slice(0, 19) : "—";

  const handleConfirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await servicesApi.deploy(service.name, trimmed);
      showSuccess(`Deploying ${service.name}:${trimmed}`, {
        action: { label: "View progress", onClick: () => navigate("/deploys") },
      });
      onDeployed?.();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
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
      <DialogTitle>Deploy {service.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Current digest:{" "}
            <Typography component="span" variant="body2" sx={{ fontFamily: "monospace" }}>
              {digest}
            </Typography>
          </Typography>
          <TextField
            label="Image tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            disabled={busy}
            fullWidth
            autoFocus
          />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={handleConfirm}
          disabled={busy || trimmed.length === 0}
          variant="contained"
        >
          Deploy
        </Button>
      </DialogActions>
    </Dialog>
  );
}
