import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const wrap = (open: number, close: number) => (text: string) =>
  text === "" ? "" : `\x1b[${open}m${text}\x1b[${close}m`;

/**
 * Styles limited to the terminal's own 16 colors and attributes, so the app
 * follows the user's light or dark terminal theme.
 */
export const style = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  underline: wrap(4, 24),
  inverse: wrap(7, 27),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
};

/** Truncate or pad a styled line to exactly `width` cells. */
export function fit(line: string, width: number): string {
  const shown = visibleWidth(line) > width ? truncateToWidth(line, width) : line;
  return shown + " ".repeat(Math.max(0, width - visibleWidth(shown)));
}

export const accent = (text: string) => style.bold(style.cyan(text));
