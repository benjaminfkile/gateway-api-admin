import { Component, type ErrorInfo, type ReactNode } from "react";
import {
  Box,
  Button,
  Card,
  CardContent,
  Stack,
  Typography,
} from "@mui/material";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlineOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render/lifecycle errors from the subtree it wraps (the authed shell)
 * and shows a recoverable reload card instead of a blank white screen. React
 * only routes errors thrown during rendering to boundaries, so this cannot
 * catch async/event-handler failures — those are handled per-page with Alerts.
 */
export default class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the failure for diagnostics; the UI still degrades gracefully.
    console.error("Unhandled UI error:", error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <Box
        role="alert"
        sx={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          minHeight: "100vh",
          p: 3,
        }}
      >
        <Card variant="outlined" sx={{ maxWidth: 480, width: "100%" }}>
          <CardContent>
            <Stack spacing={2} sx={{ alignItems: "center", textAlign: "center" }}>
              <ErrorOutlineIcon color="error" sx={{ fontSize: 48 }} />
              <Typography variant="h5">Something went wrong</Typography>
              <Typography variant="body2" color="text.secondary">
                The dashboard hit an unexpected error and can't continue. Reload
                the page to recover; if it keeps happening, check the gateway
                logs.
              </Typography>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ fontFamily: "monospace", wordBreak: "break-word" }}
              >
                {error.message}
              </Typography>
              <Button
                variant="contained"
                startIcon={<RefreshIcon />}
                onClick={this.handleReload}
              >
                Reload
              </Button>
            </Stack>
          </CardContent>
        </Card>
      </Box>
    );
  }
}
