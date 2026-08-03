import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { Alert, Snackbar, type AlertColor } from "@mui/material";

interface SnackbarContextValue {
  /** Show a toast with an explicit severity. */
  notify: (message: string, severity?: AlertColor) => void;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
}

interface SnackbarState {
  open: boolean;
  message: string;
  severity: AlertColor;
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
    (message: string, severity: AlertColor = "info") => {
      setState({ open: true, message, severity });
    },
    [],
  );

  const value = useMemo<SnackbarContextValue>(
    () => ({
      notify,
      showSuccess: (message: string) => notify(message, "success"),
      showError: (message: string) => notify(message, "error"),
    }),
    [notify],
  );

  const handleClose = (_event?: SyntheticEvent | Event, reason?: string) => {
    if (reason === "clickaway") return;
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
