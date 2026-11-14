import {
  type Component,
  type Focusable,
  Input,
  type KeyId,
  matchesKey,
  type SelectItem,
  SelectList,
  type SelectListTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { color, fit, frame, frameInner, pill, style } from "./theme.ts";

const listTheme: SelectListTheme = {
  selectedPrefix: color.accent,
  selectedText: style.bold,
  description: color.muted,
  scrollInfo: color.muted,
  noMatch: color.muted,
};

const PAD = 1;

function framed(title: string, body: string[], width: number): string[] {
  const inner = frameInner(width, PAD);
  const lines = body.map((line) => fit(line, inner));
  return frame(lines, width, { title: pill(title, "stage"), focused: true, padLeft: PAD });
}

/** A filterable list in a frame. */
class Picker implements Component, Focusable {
  private readonly title: string;
  private readonly items: SelectItem[];
  private readonly onDone: (value: string | undefined) => void;
  private readonly maxVisible: number;
  private readonly input = new Input({ prompt: "› ", placeholder: "type to filter" });
  private list: SelectList;
  private isFocused = false;

  constructor(
    title: string,
    items: SelectItem[],
    onDone: (value: string | undefined) => void,
    maxVisible: number,
  ) {
    this.title = title;
    this.items = items;
    this.onDone = onDone;
    this.maxVisible = maxVisible;
    this.list = this.listOf(items);
  }

  private listOf(items: SelectItem[]): SelectList {
    const list = new SelectList(items, this.maxVisible, listTheme, {
      minPrimaryColumnWidth: 24,
      maxPrimaryColumnWidth: 64,
    });
    list.onSelect = (item) => this.onDone(item.value);
    list.onCancel = () => this.onDone(undefined);
    return list;
  }

  /** SelectList's own filter matches a prefix of the item's value, which the author never sees. */
  private filter(query: string): void {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = this.items.filter((item) => {
      const shown = `${item.label} ${item.description ?? ""}`.toLowerCase();
      return words.every((word) => shown.includes(word));
    });
    this.list = this.listOf(matches);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    const navigation: KeyId[] = ["up", "down", "pageUp", "pageDown", "enter", "escape", "ctrl+c"];
    if (navigation.some((key) => matchesKey(data, key))) {
      this.list.handleInput(data);
      return;
    }
    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) this.filter(this.input.getValue());
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const inner = frameInner(width, PAD);
    return framed(this.title, [...this.input.render(inner), ...this.list.render(inner)], width);
  }
}

/** A one-line question in a frame. */
class Prompt implements Component, Focusable {
  private readonly title: string;
  private readonly input: Input;
  private isFocused = false;

  constructor(title: string, initial: string, onDone: (value: string | undefined) => void) {
    this.title = title;
    this.input = new Input({ prompt: "› " });
    this.input.setValue(initial);
    this.input.onSubmit = (value) => onDone(value);
    this.input.onEscape = () => onDone(undefined);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.input.focused = value;
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
  }

  invalidate(): void {}

  render(width: number): string[] {
    return framed(this.title, this.input.render(frameInner(width, PAD)), width);
  }
}

/** Modal questions over the app; each resolves with undefined when cancelled. */
export class Dialogs {
  private readonly tui: TUI;

  constructor(tui: TUI) {
    this.tui = tui;
  }

  pick(title: string, items: SelectItem[]): Promise<string | undefined> {
    return new Promise((resolve) => {
      const maxVisible = Math.max(3, Math.min(14, this.tui.terminal.rows - 8));
      const picker = new Picker(
        title,
        items,
        (value) => {
          handle.hide();
          this.tui.requestRender();
          resolve(value);
        },
        maxVisible,
      );
      const handle = this.tui.showOverlay(picker, { width: "70%", minWidth: 40, anchor: "center" });
    });
  }

  ask(title: string, initial = ""): Promise<string | undefined> {
    return new Promise((resolve) => {
      const prompt = new Prompt(title, initial, (value) => {
        handle.hide();
        this.tui.requestRender();
        resolve(value?.trim() || undefined);
      });
      const handle = this.tui.showOverlay(prompt, { width: "70%", minWidth: 40, anchor: "center" });
    });
  }

  async confirm(question: string, yes = "Yes", no = "No"): Promise<boolean> {
    const answer = await this.pick(question, [
      { value: "yes", label: yes },
      { value: "no", label: no },
    ]);
    return answer === "yes";
  }
}
