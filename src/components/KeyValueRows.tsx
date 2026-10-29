import { Button, IconButton, Stack, TextField, Tooltip, Typography } from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutlined";

export interface KeyValueRow {
  key: string;
  value: string;
}

/** Rows from a flat string map, in its key order. */
export function rowsFromMap(map: Record<string, string> | null | undefined): KeyValueRow[] {
  return Object.entries(map ?? {}).map(([key, value]) => ({ key, value: String(value) }));
}

/** A flat string map from rows; blank keys are dropped and a later key wins. */
export function mapFromRows(rows: KeyValueRow[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key) map[key] = row.value;
  }
  return map;
}

export interface KeyValueRowsProps {
  label: string;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  disabled?: boolean;
}

/** Editable key and value rows with add and remove buttons. */
export default function KeyValueRows({ label, rows, onChange, disabled }: KeyValueRowsProps) {
  const update = (index: number, patch: Partial<KeyValueRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  return (
    <Stack spacing={1} role="group" aria-label={label}>
      <Typography variant="subtitle2">{label}</Typography>
      {rows.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          None
        </Typography>
      )}
      {rows.map((row, index) => (
        <Stack key={index} direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <TextField
            size="small"
            label="Key"
            value={row.key}
            onChange={(e) => update(index, { key: e.target.value })}
            disabled={disabled}
            slotProps={{ htmlInput: { "aria-label": `${label} key ${index + 1}` } }}
          />
          <TextField
            size="small"
            label="Value"
            value={row.value}
            onChange={(e) => update(index, { value: e.target.value })}
            disabled={disabled}
            fullWidth
            slotProps={{ htmlInput: { "aria-label": `${label} value ${index + 1}` } }}
          />
          <Tooltip title="Remove">
            <span>
              <IconButton
                size="small"
                aria-label={`remove ${label} row ${index + 1}`}
                disabled={disabled}
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              >
                <DeleteOutlineIcon />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      ))}
      <div>
        <Button
          size="small"
          startIcon={<AddIcon />}
          disabled={disabled}
          onClick={() => onChange([...rows, { key: "", value: "" }])}
        >
          Add row
        </Button>
      </div>
    </Stack>
  );
}
