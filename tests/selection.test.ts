import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { highlightRange, rangeBetween, textInRange } from "../src/ui/selection.ts";
import { color, style } from "../src/ui/theme.ts";

const WIDTH = 12;
const lines = [`${style.bold("first")} line  `, `second ${color.primary("line")} `, "third line  "];

test("rangeBetween orders the two ends of a drag and includes both cells", () => {
  const forward = rangeBetween({ x: 2, y: 0 }, { x: 4, y: 1 });
  assert.deepEqual(forward, { start: { x: 2, y: 0 }, end: { x: 5, y: 1 } });
  assert.deepEqual(rangeBetween({ x: 4, y: 1 }, { x: 2, y: 0 }), forward);
  assert.deepEqual(rangeBetween({ x: 6, y: 0 }, { x: 1, y: 0 }), {
    start: { x: 1, y: 0 },
    end: { x: 7, y: 0 },
  });
});

test("textInRange returns the selected cells without styling or padding", () => {
  assert.equal(textInRange(lines, rangeBetween({ x: 0, y: 0 }, { x: 4, y: 0 }), WIDTH), "first");
  assert.equal(
    textInRange(lines, rangeBetween({ x: 6, y: 0 }, { x: 5, y: 2 }), WIDTH),
    "line\nsecond line\nthird",
  );
});

test("highlightRange keeps the text and the width of every line", () => {
  const shown = highlightRange(lines, rangeBetween({ x: 6, y: 0 }, { x: 5, y: 2 }), WIDTH);
  assert.deepEqual(shown.map(stripTerminalSequences), lines.map(stripTerminalSequences));
  for (const line of shown) assert.equal(visibleWidth(line), WIDTH);
  assert.ok(shown[0]?.includes(style.inverse("line  ")));
  assert.ok(shown[1]?.includes(style.inverse("second line ")));
});
