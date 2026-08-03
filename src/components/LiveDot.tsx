import { Box, Tooltip } from "@mui/material";

interface LiveDotProps {
  /** True when the SignalR hub is connected and pushing live updates. */
  connected: boolean;
}

/**
 * A small status dot shown next to a page title. Green and pulsing when the hub
 * is connected (live updates flowing); a dim static dot otherwise, when the page
 * is relying on its polling fallback.
 */
export default function LiveDot({ connected }: LiveDotProps) {
  return (
    <Tooltip title={connected ? "Live updates connected" : "Live updates offline — polling"}>
      <Box
        component="span"
        role="status"
        aria-label={connected ? "live" : "offline"}
        sx={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          display: "inline-block",
          bgcolor: connected ? "success.main" : "action.disabled",
          boxShadow: (theme) =>
            connected ? `0 0 0 3px ${theme.palette.success.main}33` : "none",
        }}
      />
    </Tooltip>
  );
}
