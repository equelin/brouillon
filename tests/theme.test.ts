import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { THEMES } from "../src/config.ts";
import {
  chooseTheme,
  color,
  frame,
  frameInner,
  gradient,
  pill,
  setTheme,
} from "../src/ui/theme.ts";

afterEach(() => setTheme("ansi"));

test("chooseTheme follows the setting, then NO_COLOR, color depth and background", () => {
  const truecolor = { COLORTERM: "truecolor" };
  assert.equal(chooseTheme("light", {}), "light");
  assert.equal(chooseTheme("auto", { ...truecolor, NO_COLOR: "1" }), "plain");
  assert.equal(chooseTheme("auto", {}), "ansi");
  assert.equal(chooseTheme("auto", truecolor), "dark");
  assert.equal(chooseTheme("auto", truecolor, { r: 20, g: 20, b: 30 }), "dark");
  assert.equal(chooseTheme("auto", truecolor, { r: 250, g: 250, b: 245 }), "light");
});

test("every theme keeps the text and the width of what it paints", () => {
  for (const theme of THEMES) {
    setTheme(theme);
    assert.equal(stripTerminalSequences(color.primary("text")), "text", theme);
    assert.equal(stripTerminalSequences(pill("draft", "draft")), " draft ", theme);
    assert.equal(stripTerminalSequences(gradient("My article")), "My article", theme);
    assert.equal(color.muted(""), "");
  }
});

test("the plain theme adds no color", () => {
  setTheme("plain");
  const painted = [color.primary("a"), color.error("b"), pill("c", "alert"), gradient("d")];
  // biome-ignore lint/suspicious/noControlCharactersInRegex: looks for SGR color parameters
  for (const text of painted) assert.doesNotMatch(text, /\x1b\[[0-9;]*(3[0-8]|4[0-8])[;m]/);
});

test("a colored span closes only what it opened, so it can sit inside bold text", () => {
  setTheme("dark");
  assert.ok(color.accent("x").endsWith("\x1b[39m"));
  setTheme("ansi");
  assert.ok(color.muted("x").endsWith("\x1b[22m"));
});

test("a frame is exactly as wide as asked and as high as its lines plus two", () => {
  for (const width of [12, 40]) {
    const inner = frameInner(width, 1);
    const lines = frame(["a".repeat(inner), " ".repeat(inner)], width, {
      title: "A title that is far too long for a narrow frame",
      label: "label",
      padLeft: 1,
    });
    assert.equal(lines.length, 4);
    for (const line of lines) assert.equal(visibleWidth(line), width);
  }
  assert.ok(
    stripTerminalSequences(frame([], 30, { title: "Coach" })[0] ?? "").startsWith("╭─ Coach ─"),
  );
});
