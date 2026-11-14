import {
  type KeyId,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { TextBuffer } from "../editor/buffer.ts";
import { EditorView } from "../editor/view.ts";
import type { PromptHistory } from "./prompt-history.ts";
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

const MAX_PROMPT_ROWS = 8;
/** Rows the transcript keeps when a long prompt would otherwise take the pane. */
const MIN_TRANSCRIPT_ROWS = 6;
const PROMPT_HINT = "enter: send · alt+enter: new line";

/** Conversation with the coach: a scrolling transcript above a prompt that grows with its text. */
export class CoachPane {
  /** Called with a message to send; returns false when it cannot be sent now, which keeps it. */
  onSubmit?: (text: string) => boolean;

  private readonly history: PromptHistory;
  private readonly prompt = new TextBuffer();
  private readonly promptView = new EditorView(this.prompt, {
    plain: true,
    marker: style.cyan("› "),
  });
  /** Set while walking the history: steps back from the newest message, and the text left behind. */
  private recalled: { step: number; draft: string } | undefined;

  private readonly entries: Entry[] = [];
  private readonly cache = new Map<Entry, { key: string; lines: string[] }>();
  private activity: { label: string; since: number } | undefined;
  /** Lines scrolled up from the end of the transcript. */
  private scrollBack = 0;
  private pageSize = 10;
  /** First row of the prompt's text in the last frame. */
  private promptTop = 0;

  constructor(history: PromptHistory) {
    this.history = history;
  }

  get focused(): boolean {
    return this.promptView.focused;
  }

  set focused(value: boolean) {
    this.promptView.focused = value;
  }

  /** Say what the coach is doing, e.g. "reading the article"; undefined when it is done. */
  setActivity(label: string | undefined): void {
    this.activity = label ? { label, since: this.activity?.since ?? Date.now() } : undefined;
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

  private setPrompt(text: string): void {
    this.prompt.reset(text);
    this.prompt.moveDocumentEnd();
  }

  private submit(): void {
    const text = this.prompt.getText().trim();
    if (!text || !this.onSubmit?.(text)) return;
    this.history.add(text);
    this.recalled = undefined;
    this.setPrompt("");
  }

  /** Walk the history; positive steps go towards older messages. Returns false at either end. */
  private recall(steps: number): boolean {
    const step = (this.recalled?.step ?? -1) + steps;
    if (step < -1 || step >= this.history.length) return false;
    const draft = this.recalled?.draft ?? this.prompt.getText();
    this.recalled = step === -1 ? undefined : { step, draft };
    this.setPrompt(step === -1 ? draft : (this.history.at(step) ?? ""));
    return true;
  }

  handleInput(data: string): void {
    const scroll: [KeyId[], number][] = [
      [["pageUp"], this.pageSize],
      [["pageDown"], -this.pageSize],
      [["shift+up"], 1],
      [["shift+down"], -1],
    ];
    for (const [keys, delta] of scroll) {
      if (keys.some((key) => matchesKey(data, key))) {
        this.scrollBy(delta);
        return;
      }
    }
    // The arrows leave the prompt for the history only from its first and last rows.
    const edges = this.promptView.cursorEdges();
    if (matchesKey(data, "up") && edges.first && this.recall(1)) return;
    if (matchesKey(data, "down") && edges.last && this.recall(-1)) return;

    const before = this.prompt.version;
    this.edit(data);
    // An edited recalled message is a new draft: the next recall must keep it, not replace it.
    if (this.prompt.version !== before) this.recalled = undefined;
  }

  private edit(data: string): void {
    if (matchesKey(data, "alt+enter") || matchesKey(data, "shift+enter")) {
      this.prompt.insert("\n");
    } else if (matchesKey(data, "enter")) {
      const { line, col } = this.prompt.cursor;
      // Terminals that cannot tell shift+enter from enter still get new lines with a backslash.
      if (this.prompt.line(line).slice(0, col).endsWith("\\")) {
        this.prompt.backspace();
        this.prompt.insert("\n");
      } else {
        this.submit();
      }
    } else {
      this.promptView.handleInput(data);
    }
  }

  paste(text: string): void {
    this.promptView.paste(text.replace(/\r\n?/g, "\n"));
  }

  /** Place the prompt's cursor when the click, in cells of the last frame, lands on the prompt. */
  clickAt(x: number, y: number): void {
    if (y >= this.promptTop) this.promptView.clickAt(x, y - this.promptTop);
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
    } else if (entry.kind === "author") {
      lines = wrapTextWithAnsi(entry.text, Math.max(1, width - 2)).map(
        (line) => `${style.cyan("▌")} ${style.bold(line)}`,
      );
    } else {
      const paint = entry.kind === "note" ? style.dim : style.red;
      lines = wrapTextWithAnsi(paint(entry.text), width);
    }
    this.cache.set(entry, { key, lines });
    return lines;
  }

  /** The rule, the activity and the prompt, with the index of the prompt's first row. */
  private renderPrompt(width: number, height: number): { lines: string[]; textRow: number } {
    const rule = "─".repeat(width);
    const lines = [this.focused ? style.cyan(rule) : style.dim(rule)];
    if (this.activity) {
      const seconds = Math.floor((Date.now() - this.activity.since) / 1000);
      lines.push(style.dim(`… ${this.activity.label} · ${seconds}s (esc to stop)`));
    }
    const textRow = lines.length;
    if (!this.focused && this.prompt.getText() === "") {
      lines.push(style.dim("› Ask the coach (tab)"));
    } else {
      const maxRows = Math.max(1, Math.min(MAX_PROMPT_ROWS, height - MIN_TRANSCRIPT_ROWS));
      const rows = Math.min(this.promptView.rowCount(width), maxRows);
      lines.push(...this.promptView.render(width, rows));
    }
    if (this.focused) {
      lines.push(style.dim(this.history.length > 0 ? `${PROMPT_HINT} · ↑: history` : PROMPT_HINT));
    }
    return { lines, textRow };
  }

  /** Render exactly `height` lines, each exactly `width` cells wide. */
  render(width: number, height: number): string[] {
    const footer = this.renderPrompt(width, height);
    const room = Math.max(0, height - footer.lines.length);
    this.promptTop = room + footer.textRow;
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
    return [...visible, ...footer.lines].slice(0, height).map((line) => fit(line, width));
  }
}
