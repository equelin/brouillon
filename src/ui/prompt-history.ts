import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_ENTRIES = 200;

/** Messages sent to the coach, oldest first, kept in a file when given a path. */
export class PromptHistory {
  private readonly path: string | undefined;
  private entries: string[] = [];

  constructor(path?: string) {
    this.path = path;
    if (!path) return;
    try {
      const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(stored)) {
        this.entries = stored.filter((entry) => typeof entry === "string").slice(-MAX_ENTRIES);
      }
    } catch {
      // No history yet, or an unreadable file: start empty and overwrite it on the next message.
    }
  }

  get length(): number {
    return this.entries.length;
  }

  /** The message `back` steps before the newest one; 0 is the newest. */
  at(back: number): string | undefined {
    return this.entries[this.entries.length - 1 - back];
  }

  add(text: string): void {
    if (this.entries.at(-1) === text) return;
    this.entries = [...this.entries, text].slice(-MAX_ENTRIES);
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, JSON.stringify(this.entries), { mode: 0o600 });
    } catch {
      // Recall still works for this session; losing it across restarts is not worth an error.
    }
  }
}
