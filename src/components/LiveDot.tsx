import { Box, Tooltip } from "@mui/material";

interface LiveDotProps {
  /**
   * True only when events are verifiably flowing end-to-end — the hub is
   * Connected AND something (heartbeat or a real event) arrived recently. This
   * is deliberately NOT raw connection state: a green-but-deaf connection must
   * read as offline, since claiming "live" while nothing arrives is the exact
   * complaint this dashboard was built to fix.
   */
  live: boolean;
  /** Optional time (ms) of the most recent event, surfaced in the tooltip. */
  lastEventAt?: number | null;
}

/**
 * A small status dot shown next to a page title. Green and pulsing only when
 * events are verifiably flowing; a dim static dot otherwise, when the page is
 * relying on its polling fallback. Never green while events are not arriving.
 */
export default function LiveDot({ live, lastEventAt }: LiveDotProps) {
  const title = live
    ? "Live updates connected"
    : lastEventAt != null
      ? `Live updates offline — polling (last event ${new Date(lastEventAt).toLocaleTimeString()})`
      : "Live updates offline — polling";

  return (
    <Tooltip title={title}>
      <Box
        component="span"
        role="status"
        aria-label={live ? "live" : "offline"}
        sx={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          display: "inline-block",
          bgcolor: live ? "success.main" : "action.disabled",
          boxShadow: (theme) =>
            live ? `0 0 0 3px ${theme.palette.success.main}33` : "none",
        }}
      />
    </Tooltip>
  );
}
