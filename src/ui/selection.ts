import { sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";
import { fit, style } from "./theme.ts";

export interface Cell {
  x: number;
  y: number;
}

/** Cells from `start` to `end` in reading order; `end.x` is the first cell left out. */
export interface CellRange {
  start: Cell;
  end: Cell;
}

/** The range a drag from `anchor` to `focus` covers, both cells included. */
export function rangeBetween(anchor: Cell, focus: Cell): CellRange {
  const forward = anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x);
  const [start, last] = forward ? [anchor, focus] : [focus, anchor];
  return { start: { ...start }, end: { x: last.x + 1, y: last.y } };
}

function columns(range: CellRange, row: number, width: number): { from: number; to: number } {
  const from = row === range.start.y ? range.start.x : 0;
  const to = row === range.end.y ? range.end.x : width;
  return { from: Math.min(from, width), to: Math.min(to, width) };
}

/** Text of rendered lines inside the range, without styling or trailing padding. */
export function textInRange(lines: readonly string[], range: CellRange, width: number): string {
  const rows: string[] = [];
  for (let row = range.start.y; row <= range.end.y; row++) {
    const { from, to } = columns(range, row, width);
    const cut = sliceByColumn(lines[row] ?? "", from, to - from, true);
    rows.push(stripTerminalSequences(cut).trimEnd());
  }
  return rows.join("\n");
}

/** The lines with the range shown in reverse video; every line stays `width` cells wide. */
export function highlightRange(
  lines: readonly string[],
  range: CellRange,
  width: number,
): string[] {
  return lines.map((line, row) => {
    if (row < range.start.y || row > range.end.y) return line;
    const { from, to } = columns(range, row, width);
    if (to <= from) return line;
    const selected = stripTerminalSequences(sliceByColumn(line, from, to - from, true));
    // sliceByColumn leaves the styles of the cut part open, hence the reset before the selection.
    const before = `${sliceByColumn(line, 0, from, true)}\x1b[0m`;
    return fit(
      before + style.inverse(fit(selected, to - from)) + sliceByColumn(line, to, width),
      width,
    );
  });
}
