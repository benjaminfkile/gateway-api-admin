import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { Alert, Button, Snackbar, type AlertColor } from "@mui/material";

/** Optional action button rendered inside a toast (e.g. "View progress"). */
export interface SnackbarAction {
  label: string;
  onClick: () => void;
}

interface NotifyOptions {
  action?: SnackbarAction;
}

interface SnackbarContextValue {
  /** Show a toast with an explicit severity. */
  notify: (message: string, severity?: AlertColor, options?: NotifyOptions) => void;
  showSuccess: (message: string, options?: NotifyOptions) => void;
  showError: (message: string, options?: NotifyOptions) => void;
}

interface SnackbarState {
  open: boolean;
  message: string;
  severity: AlertColor;
  action?: SnackbarAction;
}

const SnackbarContext = createContext<SnackbarContextValue | null>(null);

/**
 * App-wide toast provider. A single Snackbar is rendered here and driven via the
 * `useSnackbar` hook so any page can surface action success/failure feedback.
 */
export function SnackbarProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SnackbarState>({
    open: false,
    message: "",
    severity: "info",
  });

  const notify = useCallback(
    (message: string, severity: AlertColor = "info", options?: NotifyOptions) => {
      setState({ open: true, message, severity, action: options?.action });
    },
    [],
  );

  const value = useMemo<SnackbarContextValue>(
    () => ({
      notify,
      showSuccess: (message: string, options?: NotifyOptions) =>
        notify(message, "success", options),
      showError: (message: string, options?: NotifyOptions) =>
        notify(message, "error", options),
    }),
    [notify],
  );

  const handleClose = (_event?: SyntheticEvent | Event, reason?: string) => {
    if (reason === "clickaway") return;
    setState((prev) => ({ ...prev, open: false }));
  };

  const { action } = state;
  const handleAction = () => {
    action?.onClick();
    setState((prev) => ({ ...prev, open: false }));
  };

  return (
    <SnackbarContext.Provider value={value}>
      {children}
      <Snackbar
        open={state.open}
        autoHideDuration={5000}
        onClose={handleClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      >
        <Alert
          onClose={handleClose}
          severity={state.severity}
          variant="filled"
          sx={{ width: "100%" }}
          action={
            action ? (
              <Button color="inherit" size="small" onClick={handleAction}>
                {action.label}
              </Button>
            ) : undefined
          }
        >
          {state.message}
        </Alert>
      </Snackbar>
    </SnackbarContext.Provider>
  );
}

export function useSnackbar(): SnackbarContextValue {
  const ctx = useContext(SnackbarContext);
  if (!ctx) throw new Error("useSnackbar must be used within SnackbarProvider");
  return ctx;
}
