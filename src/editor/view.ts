import {
  CURSOR_MARKER,
  decodeKittyPrintable,
  type KeyId,
  matchesKey,
  renderFakeCursor,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { CellRange } from "../ui/selection.ts";
import { color, style } from "../ui/theme.ts";
import type { Position, TextBuffer } from "./buffer.ts";

interface Row {
  line: number;
  start: number;
  end: number;
}

type LineKind = "meta" | "code" | "heading" | "quote" | "text";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** Cells before the text of each row; marks such as a note's bullet are drawn there. */
export const GUTTER = 2;
const MAX_TEXT_WIDTH = 96;
const SCROLL_MARGIN = 2;
const INDENT = 4;

/** One cell per UTF-16 unit of a control character, so columns keep mapping to the text. */
function displayable(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the target
  return text.replace(/\t/g, "→").replace(/[\x00-\x1f\x7f-\x9f]/g, "·");
}

/** Split a line into rows of at most `width` cells, breaking after spaces when possible. */
export function wrapLine(text: string, width: number): { start: number; end: number }[] {
  const rows: { start: number; end: number }[] = [];
  let rowStart = 0;
  let rowWidth = 0;
  let breakAt = -1;
  let widthAtBreak = 0;
  for (const { index, segment } of graphemes.segment(text)) {
    const cells = visibleWidth(displayable(segment));
    if (rowWidth + cells > width && index > rowStart) {
      if (breakAt > rowStart) {
        rows.push({ start: rowStart, end: breakAt });
        rowWidth -= widthAtBreak;
        rowStart = breakAt;
      } else {
        rows.push({ start: rowStart, end: index });
        rowWidth = 0;
        rowStart = index;
      }
      breakAt = -1;
    }
    rowWidth += cells;
    if (segment === " ") {
      breakAt = index + segment.length;
      widthAtBreak = rowWidth;
    }
  }
  rows.push({ start: rowStart, end: text.length });
  return rows;
}

function classify(lines: readonly string[]): LineKind[] {
  const kinds: LineKind[] = [];
  let metaClose: RegExp | undefined;
  if (lines[0] === "---") metaClose = /^---\s*$/;
  else if (lines[0]?.startsWith("{")) metaClose = /^}\s*$/;
  let inMeta = metaClose !== undefined;
  let fence: string | undefined;
  lines.forEach((line, index) => {
    if (inMeta) {
      kinds.push("meta");
      if (index > 0 && metaClose?.test(line)) inMeta = false;
      return;
    }
    const opening = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      kinds.push("code");
      if (opening?.[1] === fence) fence = undefined;
    } else if (opening) {
      fence = opening[1];
      kinds.push("code");
    } else if (/^#{1,6}\s/.test(line)) {
      kinds.push("heading");
    } else if (/^\s*>/.test(line)) {
      kinds.push("quote");
    } else {
      kinds.push("text");
    }
  });
  return kinds;
}

const paint: Record<LineKind, (text: string) => string> = {
  meta: color.muted,
  code: color.code,
  heading: (text) => style.bold(color.accent(text)),
  quote: style.italic,
  text: (text) => text,
};

export interface EditorViewOptions {
  /** Show the text as typed, without the article's markdown and front matter colors. */
  plain?: boolean;
  /** Two cells drawn in the gutter of the first row, such as a prompt sign. */
  marker?: () => string;
}

/** Soft-wrapped, scrolling view of a TextBuffer with its key bindings. */
export class EditorView {
  focused = false;
  /** Logical lines flagged in the gutter, such as lines carrying a coach comment. */
  markedLines: ReadonlySet<number> = new Set();

  private readonly buffer: TextBuffer;
  private readonly options: EditorViewOptions;
  private rows: Row[] = [];
  private kinds: LineKind[] = [];
  private layoutKey = "";
  private top = 0;
  private height = 1;
  private width = 1;
  private textWidth = 1;
  /** Column the cursor aims for while moving vertically across shorter rows. */
  private preferredCells: number | undefined;

  constructor(buffer: TextBuffer, options: EditorViewOptions = {}) {
    this.buffer = buffer;
    this.options = options;
  }

  private layout(width: number): void {
    this.width = width;
    // One cell stays free so the cursor can sit after the last character of a full row.
    this.textWidth = Math.max(8, Math.min(width - GUTTER, MAX_TEXT_WIDTH) - 1);
    const key = `${this.buffer.version}:${this.textWidth}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.rows = [];
    this.buffer.getLines().forEach((text, line) => {
      for (const row of wrapLine(text, this.textWidth)) this.rows.push({ line, ...row });
    });
    this.kinds = this.options.plain ? [] : classify(this.buffer.getLines());
  }

  /** Rows the text takes once wrapped to `width`. */
  rowCount(width: number): number {
    this.layout(width);
    return this.rows.length;
  }

  /** Where the cursor sits among the wrapped rows, so a caller can give the arrows another use. */
  cursorEdges(): { first: boolean; last: boolean } {
    this.layout(this.width);
    const row = this.cursorRow();
    return { first: row === 0, last: row >= this.rows.length - 1 };
  }

  private cursorRow(): number {
    const { line, col } = this.buffer.cursor;
    let found = 0;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i] as Row;
      if (row.line > line) break;
      if (row.line === line && row.start <= col) found = i;
    }
    return found;
  }

  private cellsBefore(row: Row, col: number): number {
    return visibleWidth(displayable(this.buffer.line(row.line).slice(row.start, col)));
  }

  private colAtCells(row: Row, cells: number, stayOnRow = true): number {
    const text = this.buffer.line(row.line).slice(row.start, row.end);
    let used = 0;
    for (const { index, segment } of graphemes.segment(text)) {
      const next = used + visibleWidth(displayable(segment));
      if (next > cells) return row.start + index;
      used = next;
    }
    const isLastRowOfLine = row.end === this.buffer.line(row.line).length;
    // The end of a wrapped row is the start of the next one; stay on this row.
    return isLastRowOfLine || !stayOnRow ? row.end : Math.max(row.start, row.end - 1);
  }

  private moveRows(delta: number): void {
    const current = this.cursorRow();
    const target = Math.max(0, Math.min(this.rows.length - 1, current + delta));
    if (target === current) return;
    const cells =
      this.preferredCells ?? this.cellsBefore(this.rows[current] as Row, this.buffer.cursor.col);
    const row = this.rows[target] as Row;
    this.buffer.moveTo({ line: row.line, col: this.colAtCells(row, cells) });
    this.preferredCells = cells;
  }

  private positionAt(x: number, y: number, stayOnRow = true): Position | undefined {
    const row = this.rows[Math.min(this.rows.length - 1, this.top + Math.max(0, y))];
    if (!row) return undefined;
    return { line: row.line, col: this.colAtCells(row, Math.max(0, x - GUTTER), stayOnRow) };
  }

  /** Place the cursor at a cell of the last rendered frame. */
  clickAt(x: number, y: number): void {
    const position = this.positionAt(x, y);
    if (!position) return;
    this.buffer.moveTo(position);
    this.preferredCells = undefined;
  }

  /** Text under a range of cells of the last rendered frame, without the breaks of soft wrapping. */
  textInRange(range: CellRange): string {
    const from = this.positionAt(range.start.x, range.start.y);
    const to = this.positionAt(range.end.x, range.end.y, false);
    if (!from || !to) return "";
    const lines = this.buffer.getLines().slice(from.line, to.line + 1);
    lines[lines.length - 1] = (lines.at(-1) ?? "").slice(0, to.col);
    lines[0] = (lines[0] ?? "").slice(from.col);
    return lines.join("\n");
  }

  scrollBy(rows: number): void {
    this.moveRows(rows);
  }

  /** Handle a key; returns false when the key is not an editing key. */
  handleInput(data: string): boolean {
    const buffer = this.buffer;
    const vertical: [KeyId[], number][] = [
      [["up"], -1],
      [["down"], 1],
      [["pageUp"], -(this.height - 1)],
      [["pageDown"], this.height - 1],
    ];
    for (const [keys, delta] of vertical) {
      if (keys.some((key) => matchesKey(data, key))) {
        this.moveRows(delta);
        return true;
      }
    }
    this.preferredCells = undefined;

    const actions: [KeyId[], () => void][] = [
      [["left", "ctrl+b"], () => buffer.moveLeft()],
      [["right", "ctrl+f"], () => buffer.moveRight()],
      [["ctrl+left", "alt+left", "alt+b"], () => buffer.moveWordLeft()],
      [["ctrl+right", "alt+right", "alt+f"], () => buffer.moveWordRight()],
      [["home", "ctrl+a"], () => this.moveRowEdge("start")],
      [["end", "ctrl+e"], () => this.moveRowEdge("end")],
      [["ctrl+home"], () => buffer.moveDocumentStart()],
      [["ctrl+end"], () => buffer.moveDocumentEnd()],
      [["enter", "shift+enter"], () => buffer.insert("\n")],
      [["tab"], () => buffer.insert(" ".repeat(INDENT - (buffer.cursor.col % INDENT)))],
      [["shift+tab"], () => this.outdent()],
      [["backspace", "shift+backspace"], () => buffer.backspace()],
      [["delete"], () => buffer.deleteForward()],
      [["ctrl+w", "alt+backspace", "ctrl+backspace"], () => buffer.deleteWordLeft()],
      [["alt+d", "alt+delete", "ctrl+delete"], () => buffer.deleteWordRight()],
      [["ctrl+k"], () => buffer.deleteToLineEnd()],
      [["ctrl+u"], () => buffer.deleteToLineStart()],
      [["ctrl+z"], () => buffer.undo()],
      [["ctrl+y", "ctrl+shift+z"], () => buffer.redo()],
    ];
    for (const [keys, action] of actions) {
      if (keys.some((key) => matchesKey(data, key))) {
        action();
        return true;
      }
    }

    const printable = decodeKittyPrintable(data) ?? data;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects escape sequences and control keys
    if (/[\x00-\x1f\x7f-\x9f]/.test(printable)) return false;
    buffer.insert(printable);
    return true;
  }

  private outdent(): void {
    const { line, col } = this.buffer.cursor;
    const spaces = Math.min(INDENT, /^ */.exec(this.buffer.line(line))?.[0].length ?? 0);
    if (spaces === 0) return;
    this.buffer.replaceRange({ start: { line, col: 0 }, end: { line, col: spaces } }, "");
    this.buffer.moveTo({ line, col: Math.max(0, col - spaces) });
  }

  paste(text: string): void {
    this.preferredCells = undefined;
    this.buffer.insert(text);
  }

  private moveRowEdge(edge: "start" | "end"): void {
    const row = this.rows[this.cursorRow()];
    if (!row) return;
    const col = edge === "start" ? row.start : this.colAtCells(row, Number.MAX_SAFE_INTEGER);
    this.buffer.moveTo({ line: row.line, col });
  }

  /** Render exactly `height` lines, each exactly `width` cells wide. */
  render(width: number, height: number): string[] {
    this.height = Math.max(1, height);
    this.layout(width);
    const cursorRow = this.cursorRow();
    const margin = Math.min(SCROLL_MARGIN, Math.floor((this.height - 1) / 2));
    if (cursorRow < this.top + margin) this.top = cursorRow - margin;
    if (cursorRow > this.top + this.height - 1 - margin) {
      this.top = cursorRow - this.height + 1 + margin;
    }
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.rows.length - this.height)));

    const cursor = this.buffer.cursor;
    const output: string[] = [];
    for (let i = this.top; i < this.top + this.height; i++) {
      const row = this.rows[i];
      if (!row) {
        output.push(" ".repeat(width));
        continue;
      }
      const text = this.buffer.line(row.line);
      const tint = paint[this.kinds[row.line] ?? "text"];
      const marked = row.start === 0 && this.markedLines.has(row.line);
      let line = marked ? `${color.highlight("●")} ` : "  ";
      if (i === 0 && this.options.marker) line = this.options.marker();
      let cells = GUTTER;
      if (i === cursorRow) {
        const before = displayable(text.slice(row.start, cursor.col));
        const rest = text.slice(cursor.col, row.end);
        const first = graphemes.segment(rest)[Symbol.iterator]().next().value?.segment ?? "";
        const under = first === "" ? " " : displayable(first);
        const after = displayable(rest.slice(first.length));
        const caret = this.focused ? CURSOR_MARKER + renderFakeCursor(under) : tint(under);
        line += tint(before) + caret + tint(after);
        cells += visibleWidth(before) + visibleWidth(under) + visibleWidth(after);
      } else {
        const shown = displayable(text.slice(row.start, row.end));
        line += tint(shown);
        cells += visibleWidth(shown);
      }
      output.push(line + " ".repeat(Math.max(0, width - cells)));
    }
    return output;
  }
}
