import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { Theme } from "@mui/material";
import "@xterm/xterm/css/xterm.css";

/**
 * Colours xterm understands. Kept structurally identical to xterm's `ITheme`
 * but declared locally so the page can depend on this thin wrapper instead of
 * reaching into `@xterm/xterm` directly (and so tests can mock the module).
 */
export interface TerminalTheme {
  background?: string;
  foreground?: string;
  cursor?: string;
  cursorAccent?: string;
  selectionBackground?: string;
}

/**
 * The handful of terminal operations the Logs page needs. jsdom cannot render a
 * real xterm canvas, so tests `vi.mock("../lib/terminal")` and assert against
 * these methods instead of a live terminal.
 */
export interface TerminalHandle {
  /** Attach the terminal to a DOM node and size it to fit. */
  open(container: HTMLElement): void;
  /** Write a single line followed by a newline. */
  writeln(line: string): void;
  /** Clear all buffered output. */
  clear(): void;
  /** Recompute rows/cols to fill the current container. */
  fit(): void;
  /** Re-colour the terminal (e.g. on light/dark mode change). */
  setTheme(theme: TerminalTheme): void;
  /** Tear down the terminal and release its DOM/resources. */
  dispose(): void;
}

/** Map the active MUI palette onto xterm's colour slots. */
export function themeFromPalette(theme: Theme): TerminalTheme {
  const { palette } = theme;
  return {
    background: palette.background.default,
    foreground: palette.text.primary,
    cursor: palette.text.primary,
    cursorAccent: palette.background.default,
    selectionBackground: palette.action.selected,
  };
}

/** Create a real xterm terminal wrapped in the {@link TerminalHandle} surface. */
export function createTerminal(theme: TerminalTheme): TerminalHandle {
  const term = new Terminal({
    convertEol: true,
    disableStdin: true,
    cursorBlink: false,
    scrollback: 5_000,
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    theme,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  return {
    open(container) {
      term.open(container);
      fit.fit();
    },
    writeln(line) {
      term.writeln(line);
    },
    clear() {
      term.clear();
    },
    fit() {
      fit.fit();
    },
    setTheme(next) {
      term.options.theme = next;
    },
    dispose() {
      term.dispose();
    },
  };
}
