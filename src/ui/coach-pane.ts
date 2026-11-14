import {
  Input,
  type KeyId,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { accent, fit, style } from "./theme.ts";

export interface Suggestion {
  original: string;
  alternatives: string[];
  reason: string;
}

type Entry =
  | { kind: "author" | "coach" | "note" | "error"; text: string }
  | { kind: "suggestion"; suggestion: Suggestion; state: "pending" | "applied" | "dismissed" };

const markdownTheme: MarkdownTheme = {
  heading: accent,
  link: style.underline,
  linkUrl: style.dim,
  code: style.green,
  codeBlock: style.green,
  codeBlockBorder: style.dim,
  quote: style.italic,
  quoteBorder: style.dim,
  hr: style.dim,
  listBullet: style.cyan,
  bold: style.bold,
  italic: style.italic,
  strikethrough: style.dim,
  underline: style.underline,
};

/** Conversation with the coach: a scrolling transcript above a one-line input. */
export class CoachPane {
  onSubmit?: (text: string) => void;
  /** Shown above the input while the coach works, e.g. "reading the article". */
  activity: string | undefined;

  private readonly input = new Input({ prompt: "› ", placeholder: "Ask the coach" });
  private readonly entries: Entry[] = [];
  private readonly cache = new Map<Entry, { key: string; lines: string[] }>();
  private isFocused = false;
  /** Lines scrolled up from the end of the transcript. */
  private scrollBack = 0;
  private pageSize = 10;

  constructor() {
    this.input.onSubmit = (value) => {
      const text = value.trim();
      if (!text) return;
      this.input.setValue("");
      this.onSubmit?.(text);
    };
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.input.focused = value;
  }

  add(kind: "author" | "note" | "error", text: string): void {
    this.entries.push({ kind, text });
    this.scrollBack = 0;
  }

  /** Start a coach reply; later `updateReply` calls fill it in. */
  beginReply(): void {
    this.entries.push({ kind: "coach", text: "" });
    this.scrollBack = 0;
  }

  updateReply(text: string): void {
    const last = this.entries.at(-1);
    if (last?.kind === "coach") last.text = text;
    else this.entries.push({ kind: "coach", text });
  }

  addSuggestion(suggestion: Suggestion): void {
    this.entries.push({ kind: "suggestion", suggestion, state: "pending" });
    this.scrollBack = 0;
  }

  resolveSuggestion(suggestion: Suggestion, state: "applied" | "dismissed"): void {
    for (const entry of this.entries) {
      if (entry.kind === "suggestion" && entry.suggestion === suggestion) entry.state = state;
    }
  }

  clear(): void {
    this.entries.length = 0;
    this.cache.clear();
    this.scrollBack = 0;
  }

  handleInput(data: string): void {
    const scroll: [KeyId[], number][] = [
      [["pageUp"], this.pageSize],
      [["pageDown"], -this.pageSize],
      [["up"], 1],
      [["down"], -1],
    ];
    for (const [keys, delta] of scroll) {
      if (keys.some((key) => matchesKey(data, key))) {
        this.scrollBy(delta);
        return;
      }
    }
    this.input.handleInput(data);
  }

  /** Scroll the transcript; positive values move towards older messages. */
  scrollBy(lines: number): void {
    this.scrollBack = Math.max(0, this.scrollBack + lines);
  }

  private renderEntry(entry: Entry, width: number): string[] {
    const key = entry.kind === "suggestion" ? `${width}:${entry.state}` : `${width}:${entry.text}`;
    const cached = this.cache.get(entry);
    if (cached?.key === key) return cached.lines;

    let lines: string[];
    if (entry.kind === "coach") {
      lines = entry.text ? new Markdown(entry.text, 0, 0, markdownTheme).render(width) : [];
    } else if (entry.kind === "suggestion") {
      const { suggestion, state } = entry;
      const label = state === "pending" ? "Alternatives" : `Alternatives (${state})`;
      lines = [
        accent(label),
        ...wrapTextWithAnsi(style.dim(`“${suggestion.original}”`), width),
        ...suggestion.alternatives.flatMap((alternative, index) =>
          wrapTextWithAnsi(`${style.yellow(`${index + 1}.`)} ${alternative}`, width),
        ),
        ...wrapTextWithAnsi(style.dim(suggestion.reason), width),
      ];
      if (state === "pending") {
        const keys = suggestion.alternatives.map((_, index) => `alt+${index + 1}`).join(", ");
        lines.push(style.dim(`${keys} to apply, alt+0 to dismiss`));
      }
    } else {
      const paint = { author: style.bold, note: style.dim, error: style.red }[entry.kind];
      const prefix = entry.kind === "author" ? "› " : "";
      lines = wrapTextWithAnsi(paint(prefix + entry.text), width);
    }
    this.cache.set(entry, { key, lines });
    return lines;
  }

  /** Render exactly `height` lines, each exactly `width` cells wide. */
  render(width: number, height: number): string[] {
    const footer: string[] = [];
    if (this.activity) footer.push(style.dim(`… ${this.activity} (esc to stop)`));
    footer.push(...this.input.render(width));

    const room = Math.max(0, height - footer.length);
    this.pageSize = Math.max(1, room - 1);
    const transcript: string[] = [];
    for (const entry of this.entries) {
      const lines = this.renderEntry(entry, width);
      if (lines.length === 0) continue;
      if (transcript.length > 0) transcript.push("");
      transcript.push(...lines);
    }
    this.scrollBack = Math.min(this.scrollBack, Math.max(0, transcript.length - room));
    const end = transcript.length - this.scrollBack;
    const visible = transcript.slice(Math.max(0, end - room), end);
    while (visible.length < room) visible.push("");
    if (this.scrollBack > 0 && room > 0) {
      visible[room - 1] = style.dim(`↓ ${this.scrollBack} more lines`);
    }
    return [...visible, ...footer].slice(0, height).map((line) => fit(line, width));
  }
}
