import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  Radio,
  RadioGroup,
  Skeleton,
  Stack,
  Typography,
} from "@mui/material";
import deploysApi from "../api/deploysApi";
import servicesApi from "../api/servicesApi";
import type { DeploySummary, ServiceSummary } from "../api/types";
import { useSnackbar } from "../contexts/SnackbarContext";

export interface RollbackDialogProps {
  open: boolean;
  service: ServiceSummary | null;
  onClose: () => void;
  /** Called after a successful rollback so the caller can refresh the fleet. */
  onRolledBack?: () => void;
}

/** How many recent successful deploys to offer as rollback targets. */
const MAX_TARGETS = 10;

function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "response" in err) {
    const data = (err as { response?: { data?: unknown } }).response?.data;
    if (typeof data === "string" && data) return data;
    if (data && typeof data === "object" && "message" in data) {
      const m = (data as { message?: unknown }).message;
      if (typeof m === "string" && m) return m;
    }
    // An HTTP error without a useful body — prefer the caller's context message.
    return fallback;
  }
  return err instanceof Error ? err.message : fallback;
}

/**
 * Pick a previously-deployed digest to roll a service back to. Loads the
 * service's recent successful deploys and offers each distinct target digest
 * (other than the one currently running) as a radio option.
 */
export default function RollbackDialog({
  open,
  service,
  onClose,
  onRolledBack,
}: RollbackDialogProps) {
  const [deploys, setDeploys] = useState<DeploySummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { showSuccess } = useSnackbar();

  const serviceName = service?.name;
  const currentDigest = service?.digest ?? null;

  const load = useCallback(async () => {
    if (!serviceName) return;
    setDeploys(null);
    setLoadError(null);
    try {
      const all = await deploysApi.list({ service: serviceName });
      const targets = all
        .filter((d) => d.service === serviceName && d.status === "done")
        .filter((d) => d.toDigest && d.toDigest !== currentDigest)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      // Dedupe by target digest, keeping the most recent deploy for each.
      const seen = new Set<string>();
      const deduped: DeploySummary[] = [];
      for (const d of targets) {
        if (seen.has(d.toDigest)) continue;
        seen.add(d.toDigest);
        deduped.push(d);
        if (deduped.length >= MAX_TARGETS) break;
      }
      setDeploys(deduped);
    } catch (err) {
      setLoadError(errorMessage(err, "Failed to load deploy history"));
    }
  }, [serviceName, currentDigest]);

  useEffect(() => {
    if (open) {
      setSelected("");
      setBusy(false);
      setError(null);
      load();
    }
  }, [open, load]);

  if (!service) return null;

  const handleConfirm = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await servicesApi.rollback(service.name, selected);
      showSuccess(`Rolling back ${service.name}`);
      onRolledBack?.();
      onClose();
    } catch (err) {
      setError(errorMessage(err, "Rollback failed"));
    } finally {
      setBusy(false);
    }
  };

  const loading = deploys === null && loadError === null;
  const noTargets = deploys !== null && deploys.length === 0;

  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle>Roll back {service.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Select a previously-deployed digest to roll {service.name} back to.
          </Typography>

          {loading && (
            <Stack spacing={1}>
              <Skeleton variant="text" />
              <Skeleton variant="text" />
              <Skeleton variant="text" />
            </Stack>
          )}

          {loadError && (
            <Alert
              severity="error"
              action={
                <Button color="inherit" size="small" onClick={load}>
                  Retry
                </Button>
              }
            >
              {loadError}
            </Alert>
          )}

          {noTargets && (
            <Typography color="text.secondary">
              No previous successful deploys to roll back to.
            </Typography>
          )}

          {deploys && deploys.length > 0 && (
            <FormControl>
              <RadioGroup
                aria-label="rollback target"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
              >
                {deploys.map((d) => (
                  <FormControlLabel
                    key={d.id}
                    value={d.toDigest}
                    control={<Radio disabled={busy} />}
                    label={
                      <Typography variant="body2">
                        <Typography
                          component="span"
                          variant="body2"
                          sx={{ fontFamily: "monospace" }}
                        >
                          {d.toDigest.slice(0, 19)}
                        </Typography>{" "}
                        · {d.actor} · {new Date(d.startedAt).toLocaleString()}
                      </Typography>
                    }
                  />
                ))}
              </RadioGroup>
            </FormControl>
          )}

          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          onClick={handleConfirm}
          disabled={busy || !selected}
          color="warning"
          variant="contained"
        >
          Roll back
        </Button>
      </DialogActions>
    </Dialog>
  );
}
