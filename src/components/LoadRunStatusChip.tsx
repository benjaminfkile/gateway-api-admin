import { Chip, CircularProgress } from "@mui/material";
import type { LoadRunStatus } from "../api/types";
import { isRunActive } from "../api/loadApi";

/** Chip colour per load run status. */
export const LOAD_STATUS_COLOR: Record<
  LoadRunStatus,
  "default" | "info" | "success" | "warning" | "error"
> = {
  queued: "default",
  fleet_up: "info",
  generators_up: "info",
  ramping: "info",
  holding: "info",
  draining: "info",
  succeeded: "success",
  stopped: "default",
  expired: "warning",
  failed: "error",
  lost: "error",
};

/**
 * Status chip for a load run. Non-terminal runs carry a spinner, like a
 * running job.
 */
export default function LoadRunStatusChip({ status }: { status: LoadRunStatus }) {
  const active = isRunActive({ status });
  return (
    <Chip
      label={status}
      color={LOAD_STATUS_COLOR[status] ?? "default"}
      size="small"
      icon={
        active ? (
          <CircularProgress size={12} color="inherit" thickness={6} aria-label="run in progress" />
        ) : undefined
      }
    />
  );
}
