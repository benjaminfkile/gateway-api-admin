import { useEffect, useState, type ReactNode } from "react";
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
} from "@mui/material";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** Body copy stating exactly what the action will do. */
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmColor?: "primary" | "error" | "warning" | "secondary" | "inherit";
  /** When set, the message is rendered inside an Alert of this severity. */
  severity?: "info" | "warning" | "error" | "success";
  /**
   * When provided, an acknowledgement checkbox with this label is shown and the
   * confirm button stays disabled until it is checked — used to gate dangerous
   * actions such as force-stopping a health-critical service.
   */
  acknowledgement?: string;
  /** Disables the buttons and reflects an in-flight action. */
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Reusable confirmation dialog. Callers pass copy describing exactly what will
 * happen; an optional acknowledgement checkbox gates the confirm button.
 */
export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmColor = "primary",
  severity,
  acknowledgement,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [acked, setAcked] = useState(false);

  // Reset the acknowledgement each time the dialog is (re)opened.
  useEffect(() => {
    if (open) setAcked(false);
  }, [open]);

  const needsAck = Boolean(acknowledgement);
  const confirmDisabled = loading || (needsAck && !acked);

  return (
    <Dialog open={open} onClose={loading ? undefined : onCancel} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {severity ? (
          <Alert severity={severity} sx={{ mb: needsAck ? 2 : 0 }}>
            {message}
          </Alert>
        ) : (
          <DialogContentText>{message}</DialogContentText>
        )}
        {needsAck && (
          <FormControlLabel
            sx={{ mt: 1 }}
            control={
              <Checkbox
                checked={acked}
                onChange={(e) => setAcked(e.target.checked)}
              />
            }
            label={acknowledgement}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={loading}>
          {cancelLabel}
        </Button>
        <Button
          onClick={onConfirm}
          disabled={confirmDisabled}
          color={confirmColor}
          variant="contained"
        >
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
