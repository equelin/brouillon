export interface Position {
  line: number;
  col: number;
}

export interface Range {
  start: Position;
  end: Position;
}

interface Snapshot {
  lines: string[];
  cursor: Position;
}

type EditKind = "type" | "delete" | "other";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });
const UNDO_LIMIT = 500;

function comparePositions(a: Position, b: Position): number {
  return a.line - b.line || a.col - b.col;
}

/** Start of the grapheme before `col`, and end of the grapheme at `col`. */
function graphemeBounds(text: string, col: number): { previous: number; next: number } {
  let previous = 0;
  let next = text.length;
  for (const { index, segment } of graphemes.segment(text)) {
    if (index < col) previous = index;
    if (index + segment.length > col) {
      next = index + segment.length;
      break;
    }
  }
  return { previous, next };
}

/**
 * Text of a document as lines, with one cursor and undo history. Columns are
 * UTF-16 offsets that always sit on a grapheme boundary.
 */
export class TextBuffer {
  private lines: string[] = [""];
  private position: Position = { line: 0, col: 0 };
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastEdit: EditKind = "other";
  /** Incremented on every change of the text, so views can cache by it. */
  version = 0;

  constructor(text = "") {
    this.lines = text.replace(/\r\n?/g, "\n").split("\n");
  }

  get cursor(): Position {
    return { ...this.position };
  }

  get lineCount(): number {
    return this.lines.length;
  }

  line(index: number): string {
    return this.lines[index] ?? "";
  }

  getLines(): readonly string[] {
    return this.lines;
  }

  getText(): string {
    return this.lines.join("\n");
  }

  /** Replace the whole text as one undoable step, keeping the cursor where it can stay. */
  setText(text: string): void {
    if (text === this.getText()) return;
    this.record("other");
    this.lines = text.replace(/\r\n?/g, "\n").split("\n");
    this.moveTo(this.position);
    this.version++;
  }

  /** Replace the text and forget history, for loading another document. */
  reset(text: string): void {
    this.lines = text.replace(/\r\n?/g, "\n").split("\n");
    this.position = { line: 0, col: 0 };
    this.undoStack = [];
    this.redoStack = [];
    this.lastEdit = "other";
    this.version++;
  }

  moveTo(position: Position): void {
    const line = Math.max(0, Math.min(position.line, this.lines.length - 1));
    const text = this.line(line);
    let col = Math.max(0, Math.min(position.col, text.length));
    for (const { index, segment } of graphemes.segment(text)) {
      if (index >= col) break;
      if (col < index + segment.length) col = index + segment.length;
    }
    this.position = { line, col };
    this.lastEdit = "other";
  }

  private leftOf({ line, col }: Position): Position {
    if (col > 0) return { line, col: graphemeBounds(this.line(line), col).previous };
    return line > 0 ? { line: line - 1, col: this.line(line - 1).length } : { line, col };
  }

  private rightOf({ line, col }: Position): Position {
    const text = this.line(line);
    if (col < text.length) return { line, col: graphemeBounds(text, col).next };
    return line < this.lines.length - 1 ? { line: line + 1, col: 0 } : { line, col };
  }

  private wordLeftOf(position: Position): Position {
    if (position.col === 0) return this.leftOf(position);
    const before = this.line(position.line).slice(0, position.col);
    const match = /[\p{L}\p{N}_]+[^\p{L}\p{N}_]*$/u.exec(before);
    return { line: position.line, col: match ? match.index : 0 };
  }

  private wordRightOf(position: Position): Position {
    const text = this.line(position.line);
    if (position.col === text.length) return this.rightOf(position);
    const match = /^[^\p{L}\p{N}_]*[\p{L}\p{N}_]+/u.exec(text.slice(position.col));
    return { line: position.line, col: match ? position.col + match[0].length : text.length };
  }

  moveLeft(): void {
    this.moveTo(this.leftOf(this.position));
  }

  moveRight(): void {
    this.moveTo(this.rightOf(this.position));
  }

  moveWordLeft(): void {
    this.moveTo(this.wordLeftOf(this.position));
  }

  moveWordRight(): void {
    this.moveTo(this.wordRightOf(this.position));
  }

  moveLineStart(): void {
    this.moveTo({ line: this.position.line, col: 0 });
  }

  moveLineEnd(): void {
    this.moveTo({ line: this.position.line, col: this.line(this.position.line).length });
  }

  moveDocumentStart(): void {
    this.moveTo({ line: 0, col: 0 });
  }

  moveDocumentEnd(): void {
    const line = this.lines.length - 1;
    this.moveTo({ line, col: this.line(line).length });
  }

  insert(text: string): void {
    if (text === "") return;
    const normalized = text.replace(/\r\n?/g, "\n");
    const single = !normalized.includes("\n") && normalized.length <= 2;
    this.record(single ? "type" : "other", single && /\s/.test(normalized));
    this.replaceRaw({ start: this.position, end: this.position }, normalized);
  }

  backspace(): void {
    this.deleteBetween(this.leftOf(this.position), this.cursor);
  }

  deleteForward(): void {
    this.deleteBetween(this.cursor, this.rightOf(this.position));
  }

  deleteWordLeft(): void {
    this.deleteBetween(this.wordLeftOf(this.position), this.cursor, "other");
  }

  deleteWordRight(): void {
    this.deleteBetween(this.cursor, this.wordRightOf(this.position), "other");
  }

  deleteToLineEnd(): void {
    const start = this.cursor;
    const lineEnd = { line: start.line, col: this.line(start.line).length };
    if (comparePositions(start, lineEnd) === 0) this.deleteForward();
    else this.deleteBetween(start, lineEnd, "other");
  }

  deleteToLineStart(): void {
    const end = this.cursor;
    this.deleteBetween({ line: end.line, col: 0 }, end, "other");
  }

  private deleteBetween(start: Position, end: Position, kind: EditKind = "delete"): void {
    if (comparePositions(start, end) === 0) return;
    this.record(kind);
    this.replaceRaw({ start, end }, "");
  }

  /** Replace a range as one undoable step; the cursor ends after the new text. */
  replaceRange(range: Range, text: string): void {
    this.record("other");
    this.replaceRaw(range, text.replace(/\r\n?/g, "\n"));
  }

  private replaceRaw(range: Range, text: string): void {
    const { start, end } = range;
    const head = this.line(start.line).slice(0, start.col);
    const tail = this.line(end.line).slice(end.col);
    const inserted = (head + text + tail).split("\n");
    this.lines.splice(start.line, end.line - start.line + 1, ...inserted);
    const lastLine = start.line + inserted.length - 1;
    this.position = { line: lastLine, col: this.line(lastLine).length - tail.length };
    this.version++;
  }

  /**
   * Save the state before an edit. Consecutive single-character edits of the
   * same kind share one undo step, cut at word boundaries.
   */
  private record(kind: EditKind, breaksRun = false): void {
    const continuesRun = kind !== "other" && kind === this.lastEdit && !breaksRun;
    if (!continuesRun) {
      this.undoStack.push({ lines: [...this.lines], cursor: this.cursor });
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    }
    this.redoStack = [];
    this.lastEdit = kind;
  }

  undo(): boolean {
    return this.restore(this.undoStack, this.redoStack);
  }

  redo(): boolean {
    return this.restore(this.redoStack, this.undoStack);
  }

  private restore(from: Snapshot[], to: Snapshot[]): boolean {
    const snapshot = from.pop();
    if (!snapshot) return false;
    to.push({ lines: [...this.lines], cursor: this.cursor });
    this.lines = snapshot.lines;
    this.position = snapshot.cursor;
    this.lastEdit = "other";
    this.version++;
    return true;
  }

  offsetOf(position: Position): number {
    let offset = 0;
    for (let i = 0; i < position.line; i++) offset += this.line(i).length + 1;
    return offset + position.col;
  }

  positionAt(offset: number): Position {
    let remaining = Math.max(0, offset);
    for (let line = 0; line < this.lines.length; line++) {
      const length = this.line(line).length;
      if (remaining <= length) return { line, col: remaining };
      remaining -= length + 1;
    }
    const last = this.lines.length - 1;
    return { line: last, col: this.line(last).length };
  }

  /** The block of consecutive non-blank lines around a line, or undefined on a blank line. */
  paragraphAt(line: number): { range: Range; text: string } | undefined {
    if (this.line(line).trim() === "") return undefined;
    let first = line;
    let last = line;
    while (first > 0 && this.line(first - 1).trim() !== "") first--;
    while (last < this.lines.length - 1 && this.line(last + 1).trim() !== "") last++;
    const range = {
      start: { line: first, col: 0 },
      end: { line: last, col: this.line(last).length },
    };
    return { range, text: this.lines.slice(first, last + 1).join("\n") };
  }

  /** The sentence under the cursor, within its paragraph. */
  sentenceAtCursor(): { range: Range; text: string } | undefined {
    const paragraph = this.paragraphAt(this.position.line);
    if (!paragraph) return undefined;
    const base = this.offsetOf(paragraph.range.start);
    const cursor = this.offsetOf(this.position) - base;
    let found: { index: number; segment: string } | undefined;
    // A line break inside a paragraph is a space to the reader, not a sentence end.
    for (const part of sentences.segment(paragraph.text.replaceAll("\n", " "))) {
      if (part.segment.trim() === "") continue;
      found = part;
      if (cursor < part.index + part.segment.length) break;
    }
    if (!found) return undefined;
    const length = found.segment.trimEnd().length;
    const text = paragraph.text.slice(found.index, found.index + length);
    return {
      range: {
        start: this.positionAt(base + found.index),
        end: this.positionAt(base + found.index + length),
      },
      text,
    };
  }

  /**
   * Replace `original` as one undoable step. Refused when it is absent or
   * appears more than once, since the wrong occurrence could be replaced.
   */
  replaceText(original: string, replacement: string): boolean {
    const text = this.getText();
    const offset = text.indexOf(original);
    if (offset === -1 || original === "" || text.indexOf(original, offset + 1) !== -1) return false;
    this.replaceRange(
      { start: this.positionAt(offset), end: this.positionAt(offset + original.length) },
      replacement,
    );
    return true;
  }
}
