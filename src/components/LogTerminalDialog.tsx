import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  useTheme,
} from "@mui/material";
import type { LogLine } from "../api/types";
import { formatLogLine, newLinesSince } from "../pages/LogsPage";
import { createTerminal, themeFromPalette, type TerminalHandle } from "../lib/terminal";

export interface LogTerminalDialogProps {
  open: boolean;
  title: string;
  /** Reads the newest log tail. */
  fetchLines: () => Promise<LogLine[]>;
  /** Re-read the tail every this many ms; absent reads once. */
  pollMs?: number;
  /** Turns a failed read into a message. */
  errorMessage: (err: unknown) => string;
  onClose: () => void;
}

interface BodyProps {
  fetchLines: () => Promise<LogLine[]>;
  pollMs?: number;
  errorMessage: (err: unknown) => string;
}

/** The terminal itself, mounted inside the open dialog so its container exists. */
function LogTerminalBody({ fetchLines, pollMs, errorMessage }: BodyProps) {
  const muiTheme = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<TerminalHandle | null>(null);
  const lastTsRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fetchRef = useRef(fetchLines);
  fetchRef.current = fetchLines;
  const errorRef = useRef(errorMessage);
  errorRef.current = errorMessage;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = createTerminal(themeFromPalette(muiTheme));
    term.open(container);
    termRef.current = term;
    return () => {
      term.dispose();
      termRef.current = null;
    };
    // Created once on mount; palette changes are pushed via setTheme below.
  }, []);

  useEffect(() => {
    termRef.current?.setTheme(themeFromPalette(muiTheme));
  }, [muiTheme]);

  const load = useCallback(async () => {
    let lines: LogLine[];
    try {
      lines = await fetchRef.current();
      setError(null);
    } catch (err) {
      setError(errorRef.current(err));
      return;
    }
    const term = termRef.current;
    if (!term) return;
    for (const line of newLinesSince(lines, lastTsRef.current)) {
      term.writeln(formatLogLine(line));
    }
    if (lines.length > 0) lastTsRef.current = lines[lines.length - 1].ts;
  }, []);

  useEffect(() => {
    void load();
    if (!pollMs) return;
    const id = setInterval(() => void load(), pollMs);
    return () => clearInterval(id);
  }, [load, pollMs]);

  return (
    <>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <Paper
        variant="outlined"
        sx={{ height: "60vh", overflow: "hidden", p: 1, bgcolor: "background.default" }}
      >
        <Box ref={containerRef} data-testid="log-terminal" sx={{ height: "100%", width: "100%" }} />
      </Paper>
    </>
  );
}

/**
 * A log tail in the shared xterm terminal panel. Only lines newer than the
 * last one written are appended on each read.
 */
export default function LogTerminalDialog({
  open,
  title,
  fetchLines,
  pollMs,
  errorMessage,
  onClose,
}: LogTerminalDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {open && (
          <LogTerminalBody fetchLines={fetchLines} pollMs={pollMs} errorMessage={errorMessage} />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
