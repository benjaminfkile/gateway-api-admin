import { createTheme, type PaletteMode } from "@mui/material";

export function buildTheme(mode: PaletteMode) {
  return createTheme({
    palette: {
      mode,
      primary: { main: "#1565c0" },
      secondary: { main: "#00897b" },
    },
    shape: { borderRadius: 8 },
  });
}
