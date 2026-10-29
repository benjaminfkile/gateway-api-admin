import { useCallback, useEffect, useState } from "react";
import { Alert, Button } from "@mui/material";
import loadApi, { isRunActive, loadErrorMessage } from "../api/loadApi";
import resourcesApi from "../api/resourcesApi";
import type { LoadRun, LoadRunStatus } from "../api/types";
import { useSnackbar } from "../contexts/SnackbarContext";
import { useLoadChannel } from "../hooks/useOpsChannel";
import type { ChannelEventData } from "../lib/hubClient";
import ConfirmDialog from "./ConfirmDialog";

/** Poll of the run list and the resources behind the banner. */
export const BANNER_POLL_MS = 30_000;

/** The banner text for an active run. */
export function bannerText(run: LoadRun): string {
  const hardStop = run.hardStopAt ? new Date(run.hardStopAt).toLocaleTimeString() : "not set";
  return `Load run ${run.id} ${run.status}, generators ${run.generators}, hard stop ${hardStop}`;
}

/**
 * Red banner above every page while a load run is non-terminal or the
 * generator group is above zero. Driven by ops:load `run` events and a
 * {@link BANNER_POLL_MS} poll of the run list and the resources; hidden when
 * both are quiet.
 */
export default function LoadBanner() {
  const { showSuccess, showError } = useSnackbar();
  const [run, setRun] = useState<LoadRun | null>(null);
  const [generatorsUp, setGeneratorsUp] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stopping, setStopping] = useState(false);

  const load = useCallback(async () => {
    const [runs, resources] = await Promise.allSettled([
      loadApi.runs({ limit: 10 }),
      resourcesApi.get(),
    ]);
    if (runs.status === "fulfilled" && Array.isArray(runs.value)) {
      setRun(runs.value.find((r) => isRunActive(r)) ?? null);
    }
    if (resources.status === "fulfilled") {
      setGeneratorsUp((resources.value?.generators?.desired ?? 0) > 0);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), BANNER_POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  useLoadChannel(
    useCallback(
      (event: string, data: ChannelEventData) => {
        if (event !== "run") return;
        const status = data.status as LoadRunStatus | undefined;
        setRun((prev) => {
          if (prev && String(prev.id) === String(data.runId)) {
            const next = { ...prev, status: status ?? prev.status };
            return isRunActive(next) ? next : null;
          }
          return prev;
        });
        // A run the banner does not know yet, or one that just ended, is read
        // in full from the list (and the generator group with it).
        void load();
      },
      [load],
    ),
  );

  const stop = async () => {
    if (!run) return;
    setStopping(true);
    try {
      await loadApi.stop(run.id);
      showSuccess(`Stop requested for load run ${run.id}`);
      void load();
    } catch (err) {
      showError(`Failed to stop load run ${run.id}: ${loadErrorMessage(err, "unknown error")}`);
    } finally {
      setStopping(false);
      setConfirmOpen(false);
    }
  };

  if (!run && !generatorsUp) return null;

  return (
    <>
      <Alert
        severity="error"
        variant="filled"
        role="alert"
        aria-label="load banner"
        sx={{ mb: 2 }}
        action={
          run ? (
            <Button
              color="inherit"
              size="small"
              variant="outlined"
              disabled={Boolean(run.stopRequestedAt)}
              onClick={() => setConfirmOpen(true)}
            >
              {run.stopRequestedAt ? "Stopping" : "Stop"}
            </Button>
          ) : undefined
        }
      >
        {run ? bannerText(run) : "Generators above zero with no run"}
      </Alert>
      <ConfirmDialog
        open={confirmOpen}
        title={`Stop load run ${run?.id ?? ""}?`}
        message="The generators are told to stop at their next stats line and the run drains."
        confirmLabel="Stop run"
        confirmColor="error"
        severity="warning"
        loading={stopping}
        onConfirm={stop}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
