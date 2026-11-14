import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ThemeName } from "../config.ts";

type Role =
  | "primary"
  | "focus"
  | "accent"
  | "success"
  | "highlight"
  | "error"
  | "muted"
  | "subtle"
  | "code";
type PillKind = "stage" | "neutral" | "draft" | "good" | "alert";

interface Palette {
  /** SGR parameters that turn each role on; an empty string leaves the text as it is. */
  roles: Record<Role, string>;
  /** SGR parameters of a pill, background and text together. */
  pills: Record<PillKind, string>;
  /** Ends of the title gradient as RGB, when the theme has 24-bit color. */
  gradient?: [number[], number[]];
}

const rgb = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
const fg = (hex: string) => `38;2;${rgb(hex).join(";")}`;
/** SGR parameters of text on a filled background, as pills use. */
const on = (background: string, text: string) => `48;2;${rgb(background).join(";")};${fg(text)}`;

// Names are charmtone's. Text colors were picked for a contrast of at least 4.5:1 against
// charmtone's Pepper (dark) or white (light), except where the comment says otherwise.
const CHARPLE = "#6B50FF";
const PEPPER = "#201F26";
const BUTTER = "#FFFAF1";

// Bright fills carry dark text in both variants, so the two share them.
const BRIGHT_PILLS = {
  stage: on(CHARPLE, BUTTER),
  draft: on("#E8FE96", PEPPER), // Zest
  good: on("#00FFB2", PEPPER), // Julep
  alert: on("#FF577D", PEPPER), // Coral
};

const PALETTES: Record<ThemeName, Palette> = {
  dark: {
    roles: {
      primary: fg("#8B75FF"), // Hazy; Charple itself is too dark for text on a dark terminal
      focus: fg(CHARPLE),
      accent: fg("#FF60FF"), // Dolly
      success: fg("#00FFB2"), // Julep
      highlight: fg("#E8FE96"), // Zest
      error: fg("#FF577D"), // Coral
      muted: fg("#A2A0AD"), // Steam
      subtle: fg("#605F6B"), // Oyster; borders only, deliberately faint
      code: fg("#4FBEFE"), // Sardine
    },
    pills: { ...BRIGHT_PILLS, neutral: on("#3A3943", "#BFBCC8") }, // Char, Smoke
    gradient: [rgb("#8B75FF"), rgb("#FF60FF")],
  },
  light: {
    roles: {
      primary: fg(CHARPLE),
      focus: fg(CHARPLE),
      accent: fg("#9C35E1"), // Prince; Dolly is unreadable on white
      success: fg("#00A475"), // Pickle, 3.2:1: charmtone has no darker green that still reads as one
      highlight: fg("#D36C64"), // Paprika, 3.4:1: used for marks and numbers, not sentences
      error: fg("#AB2454"), // Pom
      muted: fg("#605F6B"), // Oyster
      subtle: fg("#BFBCC8"), // Smoke
      code: fg("#007AB8"), // Damson
    },
    pills: { ...BRIGHT_PILLS, neutral: on("#ECEBF0", "#4D4C57") }, // Sash, Iron
    gradient: [rgb(CHARPLE), rgb("#C337E0")], // to Urchin
  },
  ansi: {
    roles: {
      primary: "36",
      focus: "36",
      accent: "36",
      success: "32",
      highlight: "33",
      error: "31",
      muted: "2",
      subtle: "2",
      code: "32",
    },
    pills: { stage: "7;36", neutral: "7;2", draft: "7;33", good: "7;32", alert: "7;31" },
  },
  plain: {
    roles: {
      primary: "",
      focus: "",
      accent: "",
      success: "",
      highlight: "1",
      error: "1",
      muted: "2",
      subtle: "2",
      code: "",
    },
    pills: { stage: "7", neutral: "7;2", draft: "7", good: "7", alert: "7;1" },
  },
};

let palette = PALETTES.ansi;

export function setTheme(name: ThemeName): void {
  palette = PALETTES[name];
}

/** The theme for a terminal: the configured one, or one that suits what the terminal reports. */
export function chooseTheme(
  setting: ThemeName | "auto",
  env: NodeJS.ProcessEnv,
  background?: { r: number; g: number; b: number },
): ThemeName {
  if (setting !== "auto") return setting;
  if (env.NO_COLOR) return "plain";
  if (!/truecolor|24bit/i.test(env.COLORTERM ?? "")) return "ansi";
  if (!background) return "dark";
  const luminance = (0.2126 * background.r + 0.7152 * background.g + 0.0722 * background.b) / 255;
  return luminance > 0.5 ? "light" : "dark";
}

/** The SGR parameters that undo `codes` and nothing else, so spans can sit inside one another. */
function closing(codes: string): string {
  const parts = codes.split(";").map(Number);
  const closes = new Set<number>();
  for (let at = 0; at < parts.length; at++) {
    const code = parts[at] ?? 0;
    if (code === 38 || code === 48) {
      closes.add(code + 1);
      // Skips the "2;r;g;b" that follows a 24-bit color.
      at += 4;
    } else if (code >= 30 && code <= 37) closes.add(39);
    else if (code === 1 || code === 2) closes.add(22);
    else if (code === 7) closes.add(27);
  }
  return [...closes].join(";");
}

const paint = (codes: string, text: string) =>
  text === "" || codes === "" ? text : `\x1b[${codes}m${text}\x1b[${closing(codes)}m`;
const attribute = (open: number, close: number) => (text: string) =>
  text === "" ? "" : `\x1b[${open}m${text}\x1b[${close}m`;

/** Text attributes; they hold in every theme. */
export const style = {
  bold: attribute(1, 22),
  italic: attribute(3, 23),
  underline: attribute(4, 24),
  inverse: attribute(7, 27),
};

const role = (name: Role) => (text: string) => paint(palette.roles[name], text);

/** Colors by what they mean; the current theme decides what they look like. */
export const color = {
  /** Brand color for text: the author's side of the conversation, bullets, prompts. */
  primary: role("primary"),
  /** Border of the pane that has the keyboard. */
  focus: role("focus"),
  accent: role("accent"),
  success: role("success"),
  /** What the coach wants looked at: notes and alternatives. */
  highlight: role("highlight"),
  error: role("error"),
  /** Secondary text that must stay readable. */
  muted: role("muted"),
  /** Borders and rules. */
  subtle: role("subtle"),
  code: role("code"),
};

/** A filled badge, one cell wider than its text on each side. */
export function pill(text: string, kind: PillKind): string {
  return paint(palette.pills[kind], ` ${text} `);
}

/** Bold text fading from the primary color to the accent, or just accented without 24-bit color. */
export function gradient(text: string): string {
  const ends = palette.gradient;
  const letters = [...new Intl.Segmenter().segment(text)].map(({ segment }) => segment);
  if (!ends || letters.length === 0) return style.bold(color.accent(text));
  const [from, to] = ends;
  const steps = Math.max(1, letters.length - 1);
  const painted = letters.map((letter, index) => {
    const mixed = from.map((start, channel) =>
      Math.round(start + (((to[channel] ?? start) - start) * index) / steps),
    );
    return `\x1b[38;2;${mixed.join(";")}m${letter}`;
  });
  return `\x1b[1m${painted.join("")}\x1b[39;22m`;
}

/** Truncate or pad a styled line to exactly `width` cells. */
export function fit(line: string, width: number): string {
  const shown = visibleWidth(line) > width ? truncateToWidth(line, width) : line;
  return shown + " ".repeat(Math.max(0, width - visibleWidth(shown)));
}

/** A rounded frame around lines that are each exactly as wide as the frame's inside. */
export function frame(
  lines: readonly string[],
  width: number,
  options: {
    /** Styled text set into the top edge. */
    title?: string;
    /** Styled text set into the right of the bottom edge. */
    label?: string;
    focused?: boolean;
    /** Blank cells between the left edge and the lines; the right edge always has one. */
    padLeft?: number;
  } = {},
): string[] {
  const border = options.focused ? color.focus : color.subtle;
  const room = Math.max(0, width - 6);
  const edge = (text: string | undefined) => {
    const shown = text && room > 0 ? ` ${truncateToWidth(text, room)}\x1b[0m ` : "";
    return { shown, fill: "─".repeat(Math.max(0, width - 3 - visibleWidth(shown))) };
  };
  const top = edge(options.title);
  const bottom = edge(options.label);
  const left = border("│") + " ".repeat(options.padLeft ?? 0);
  return [
    border("╭─") + top.shown + border(`${top.fill}╮`),
    ...lines.map((line) => `${left}${line} ${border("│")}`),
    border(`╰${bottom.fill}`) + bottom.shown + border("─╯"),
  ];
}

/** Width left for the lines of a frame that is `width` cells wide. */
export function frameInner(width: number, padLeft = 0): number {
  return Math.max(1, width - 3 - padLeft);
}
