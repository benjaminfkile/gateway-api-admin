import { useMemo, useState } from "react";
import { Box, Paper, Typography, useTheme } from "@mui/material";

export interface ChartPoint {
  /** Milliseconds since the epoch. */
  t: number;
  v: number;
}

/** At most `max` points, keeping the first and last and spacing the rest evenly. */
export function downsample(points: ChartPoint[], max: number): ChartPoint[] {
  if (points.length <= max || max < 2) return points;
  const out: ChartPoint[] = [];
  const stride = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * stride)]);
  return out;
}

export interface LineChartProps {
  title: string;
  points: ChartPoint[];
  /** Formats a value for the axis and the hover readout. */
  format?: (v: number) => string;
  height?: number;
}

const WIDTH = 600;
const PAD = { top: 12, right: 12, bottom: 22, left: 56 };

function defaultFormat(v: number): string {
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * A single-series line chart as inline SVG with a zero baseline, a max gridline
 * and a hover crosshair that reads out the nearest point.
 */
export default function LineChart({
  title,
  points,
  format = defaultFormat,
  height = 160,
}: LineChartProps) {
  const theme = useTheme();
  const [hover, setHover] = useState<number | null>(null);

  const geometry = useMemo(() => {
    if (points.length === 0) return null;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const vMax = Math.max(...points.map((p) => p.v), 0);
    const innerW = WIDTH - PAD.left - PAD.right;
    const innerH = height - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + (t1 === t0 ? innerW : ((t - t0) / (t1 - t0)) * innerW);
    const y = (v: number) => PAD.top + innerH - (vMax === 0 ? 0 : (v / vMax) * innerH);
    const path = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`)
      .join(" ");
    return { t0, t1, vMax, x, y, path, innerW };
  }, [points, height]);

  const hovered = hover !== null ? points[hover] : null;
  const ink = theme.palette.text.secondary;
  const grid = theme.palette.divider;

  return (
    <Paper variant="outlined" sx={{ p: 2, flex: 1, minWidth: 280 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <Typography variant="subtitle2">{title}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: "monospace" }}>
          {hovered
            ? `${new Date(hovered.t).toLocaleTimeString()}  ${format(hovered.v)}`
            : points.length > 0
              ? `latest ${format(points[points.length - 1].v)}`
              : ""}
        </Typography>
      </Box>
      {!geometry ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: "center" }}>
          No data yet
        </Typography>
      ) : (
        <svg
          role="img"
          aria-label={title}
          viewBox={`0 0 ${WIDTH} ${height}`}
          width="100%"
          height={height}
          preserveAspectRatio="none"
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            if (rect.width === 0) return;
            const px = ((e.clientX - rect.left) / rect.width) * WIDTH;
            let best = 0;
            let bestDist = Infinity;
            points.forEach((p, i) => {
              const d = Math.abs(geometry.x(p.t) - px);
              if (d < bestDist) {
                bestDist = d;
                best = i;
              }
            });
            setHover(best);
          }}
        >
          <line
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={geometry.y(geometry.vMax)}
            y2={geometry.y(geometry.vMax)}
            stroke={grid}
            strokeDasharray="2 4"
          />
          <line
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={geometry.y(0)}
            y2={geometry.y(0)}
            stroke={grid}
          />
          <text x={PAD.left - 6} y={geometry.y(geometry.vMax) + 4} textAnchor="end" fontSize={11} fill={ink}>
            {format(geometry.vMax)}
          </text>
          <text x={PAD.left - 6} y={geometry.y(0) + 4} textAnchor="end" fontSize={11} fill={ink}>
            0
          </text>
          <text x={PAD.left} y={height - 6} fontSize={11} fill={ink}>
            {new Date(geometry.t0).toLocaleTimeString()}
          </text>
          <text x={WIDTH - PAD.right} y={height - 6} textAnchor="end" fontSize={11} fill={ink}>
            {new Date(geometry.t1).toLocaleTimeString()}
          </text>
          <path
            d={geometry.path}
            fill="none"
            stroke={theme.palette.primary.main}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {hovered && (
            <>
              <line
                x1={geometry.x(hovered.t)}
                x2={geometry.x(hovered.t)}
                y1={PAD.top}
                y2={geometry.y(0)}
                stroke={ink}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
              <circle
                cx={geometry.x(hovered.t)}
                cy={geometry.y(hovered.v)}
                r={4}
                fill={theme.palette.primary.main}
                stroke={theme.palette.background.paper}
                strokeWidth={2}
              />
            </>
          )}
        </svg>
      )}
    </Paper>
  );
}
