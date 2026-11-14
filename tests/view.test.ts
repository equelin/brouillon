import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { TextBuffer } from "../src/editor/buffer.ts";
import { EditorView, wrapLine } from "../src/editor/view.ts";

test("wrapLine breaks after spaces and splits words longer than the width", () => {
  const text = "alpha beta gamma";
  assert.deepEqual(
    wrapLine(text, 11).map((row) => text.slice(row.start, row.end)),
    ["alpha beta ", "gamma"],
  );
  assert.deepEqual(
    wrapLine("abcdefgh", 3).map((row) => "abcdefgh".slice(row.start, row.end)),
    ["abc", "def", "gh"],
  );
  assert.deepEqual(wrapLine("", 10), [{ start: 0, end: 0 }]);
});

test("wrapLine counts wide characters as two cells", () => {
  const text = "日本語のテキスト";
  for (const row of wrapLine(text, 6)) {
    assert.ok(visibleWidth(text.slice(row.start, row.end)) <= 6);
  }
});

test("render fills exactly the requested area and shows the cursor only when focused", () => {
  const buffer = new TextBuffer(`# Title\n\n${"word ".repeat(60)}\n\tTabbed`);
  const view = new EditorView(buffer);
  for (const width of [20, 47, 120]) {
    const lines = view.render(width, 9);
    assert.equal(lines.length, 9);
    for (const line of lines) assert.equal(visibleWidth(line), width);
  }
  assert.ok(!view.render(40, 9).join("").includes(CURSOR_MARKER));
  view.focused = true;
  assert.ok(view.render(40, 9).join("").includes(CURSOR_MARKER));
});

test("vertical movement follows wrapped rows and scrolling keeps the cursor visible", () => {
  const buffer = new TextBuffer(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"));
  const view = new EditorView(buffer);
  view.focused = true;
  view.render(30, 5);
  for (let i = 0; i < 20; i++) view.handleInput("\x1b[B");
  assert.equal(buffer.cursor.line, 20);
  const lines = view.render(30, 5);
  assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
});

test("typing through the view inserts text and reports unhandled control keys", () => {
  const buffer = new TextBuffer();
  const view = new EditorView(buffer);
  view.render(30, 5);
  assert.ok(view.handleInput("é"));
  assert.ok(view.handleInput("\r"));
  assert.ok(view.handleInput("x"));
  assert.equal(buffer.getText(), "é\nx");
  assert.ok(!view.handleInput("\x1b[99;5u"));
  assert.equal(buffer.getText(), "é\nx");
});

test("clicking places the cursor on the clicked cell", () => {
  const buffer = new TextBuffer("first line\nsecond line");
  const view = new EditorView(buffer);
  view.render(40, 5);
  view.clickAt(2 + 3, 1);
  assert.deepEqual(buffer.cursor, { line: 1, col: 3 });
});

test("tab indents to the next multiple of four and shift+tab removes one level", () => {
  const buffer = new TextBuffer("ab");
  const view = new EditorView(buffer);
  view.render(30, 5);
  buffer.moveTo({ line: 0, col: 1 });
  view.handleInput("\t");
  assert.equal(buffer.getText(), "a   b");
  buffer.reset("      code");
  buffer.moveTo({ line: 0, col: 8 });
  view.handleInput("\x1b[Z");
  assert.equal(buffer.getText(), "  code");
  assert.deepEqual(buffer.cursor, { line: 0, col: 4 });
  view.handleInput("\x1b[Z");
  view.handleInput("\x1b[Z");
  assert.equal(buffer.getText(), "code");
});
