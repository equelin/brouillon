import assert from "node:assert/strict";
import { test } from "node:test";
import { TextBuffer } from "../src/editor/buffer.ts";

function typed(buffer: TextBuffer, text: string): void {
  for (const char of text) buffer.insert(char);
}

test("typing, newline and backspace edit at the cursor", () => {
  const buffer = new TextBuffer();
  typed(buffer, "ab");
  buffer.insert("\n");
  typed(buffer, "c");
  assert.equal(buffer.getText(), "ab\nc");
  buffer.backspace();
  buffer.backspace();
  assert.equal(buffer.getText(), "ab");
  assert.deepEqual(buffer.cursor, { line: 0, col: 2 });
});

test("undo removes a typed word at a time and redo restores it", () => {
  const buffer = new TextBuffer();
  typed(buffer, "hello world");
  assert.ok(buffer.undo());
  assert.equal(buffer.getText(), "hello");
  assert.ok(buffer.undo());
  assert.equal(buffer.getText(), "");
  assert.ok(!buffer.undo());
  assert.ok(buffer.redo());
  assert.ok(buffer.redo());
  assert.equal(buffer.getText(), "hello world");
});

test("consecutive backspaces undo together", () => {
  const buffer = new TextBuffer("abcdef");
  buffer.moveDocumentEnd();
  buffer.backspace();
  buffer.backspace();
  buffer.backspace();
  assert.equal(buffer.getText(), "abc");
  buffer.undo();
  assert.equal(buffer.getText(), "abcdef");
  assert.deepEqual(buffer.cursor, { line: 0, col: 6 });
});

test("a multi-code-unit grapheme moves and deletes as one character", () => {
  const family = "👨‍👩‍👧";
  const buffer = new TextBuffer(`a${family}b`);
  buffer.moveDocumentEnd();
  buffer.moveLeft();
  buffer.moveLeft();
  assert.equal(buffer.cursor.col, 1);
  buffer.deleteForward();
  assert.equal(buffer.getText(), "ab");
  buffer.reset(`a${family}b`);
  buffer.moveTo({ line: 0, col: 3 });
  assert.equal(buffer.cursor.col, 1 + family.length);
});

test("word movement and deletion stop at word boundaries, also with accents", () => {
  const buffer = new TextBuffer("déjà vu, encore");
  buffer.moveWordRight();
  assert.equal(buffer.cursor.col, 4);
  buffer.moveDocumentEnd();
  buffer.moveWordLeft();
  assert.equal(buffer.cursor.col, 9);
  buffer.deleteWordLeft();
  assert.equal(buffer.getText(), "déjà encore");
});

test("backspace at a line start joins the lines", () => {
  const buffer = new TextBuffer("one\ntwo");
  buffer.moveTo({ line: 1, col: 0 });
  buffer.backspace();
  assert.equal(buffer.getText(), "onetwo");
  assert.deepEqual(buffer.cursor, { line: 0, col: 3 });
});

test("offsets and positions convert both ways", () => {
  const buffer = new TextBuffer("ab\n\ncde");
  assert.equal(buffer.offsetOf({ line: 2, col: 1 }), 5);
  assert.deepEqual(buffer.positionAt(5), { line: 2, col: 1 });
  assert.deepEqual(buffer.positionAt(999), { line: 2, col: 3 });
});

test("paragraphAt returns the block around a line and nothing on a blank line", () => {
  const buffer = new TextBuffer("first\nstill first\n\nsecond");
  assert.equal(buffer.paragraphAt(1)?.text, "first\nstill first");
  assert.equal(buffer.paragraphAt(2), undefined);
  assert.equal(buffer.paragraphAt(3)?.text, "second");
});

test("sentenceAtCursor finds the sentence under the cursor across a line break", () => {
  const buffer = new TextBuffer("One sentence here. Another sentence\nfollows it. Last one.");
  buffer.moveTo({ line: 1, col: 2 });
  const sentence = buffer.sentenceAtCursor();
  assert.equal(sentence?.text, "Another sentence\nfollows it.");
  assert.deepEqual(sentence?.range.start, { line: 0, col: 19 });
});

test("replaceText swaps the first occurrence as one undo step", () => {
  const buffer = new TextBuffer("keep this. change this. keep that.");
  assert.ok(buffer.replaceText("change this.", "this is new."));
  assert.equal(buffer.getText(), "keep this. this is new. keep that.");
  assert.ok(!buffer.replaceText("absent", "x"));
  buffer.undo();
  assert.equal(buffer.getText(), "keep this. change this. keep that.");
});

test("replaceText refuses a passage that appears twice", () => {
  const buffer = new TextBuffer("same words. other. same words.");
  assert.ok(!buffer.replaceText("same words.", "new"));
  assert.equal(buffer.getText(), "same words. other. same words.");
});
