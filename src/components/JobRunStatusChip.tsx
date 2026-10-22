import { Chip, CircularProgress } from "@mui/material";
import type { JobRun, JobRunStatus } from "../api/types";

/** Chip label and colour per run status. */
export const RUN_STATUS_CHIP: Record<
  JobRunStatus,
  { label: string; color: "default" | "info" | "success" | "warning" | "error" }
> = {
  queued: { label: "queued", color: "default" },
  running: { label: "running", color: "info" },
  succeeded: { label: "succeeded", color: "success" },
  failed: { label: "failed", color: "error" },
  timed_out: { label: "timed_out", color: "warning" },
  cancelled: { label: "cancelled", color: "default" },
  lost: { label: "lost", color: "error" },
};

/** True while a run is queued or running. */
export function isActiveRun(run: Pick<JobRun, "status"> | null | undefined): boolean {
  return run?.status === "queued" || run?.status === "running";
}

/**
 * Status chip for a job run. Active runs carry a spinner so a queued or
 * running row reads as in progress at a glance.
 */
export default function JobRunStatusChip({ status }: { status: JobRunStatus }) {
  const chip = RUN_STATUS_CHIP[status] ?? { label: status, color: "default" };
  const active = isActiveRun({ status });
  return (
    <Chip
      label={chip.label}
      color={chip.color}
      size="small"
      icon={
        active ? (
          <CircularProgress
            size={12}
            color="inherit"
            thickness={6}
            aria-label="run in progress"
          />
        ) : undefined
      }
    />
  );
}
