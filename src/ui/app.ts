import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type Component,
  type Focusable,
  type KeyId,
  matchesKey,
  type SelectItem,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Coach } from "../agent/coach.ts";
import { type CoachModels, loginOnTerminal, resolveModel } from "../agent/models.ts";
import { STAGES, type Stage, translateRequest, turnContext } from "../agent/prompt.ts";
import type { Workspace } from "../agent/tools.ts";
import type { Config } from "../config.ts";
import { TextBuffer } from "../editor/buffer.ts";
import { EditorView } from "../editor/view.ts";
import { countWords, type PostMeta, parseMeta, setFields, withBody } from "../frontmatter.ts";
import {
  commitSubject,
  draftBranch,
  type Repo,
  runInteractive,
  SigningLockedError,
} from "../git.ts";
import {
  articlePath,
  createPost,
  hugoDate,
  listPosts,
  type Post,
  parseArticleName,
  slugify,
} from "../posts.ts";
import { CoachPane, type Suggestion } from "./coach-pane.ts";
import { Dialogs } from "./dialogs.ts";
import { accent, fit, style } from "./theme.ts";

interface Comment {
  quote: string;
  note: string;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const WIDE_LAYOUT = 110;
const AUTOSAVE_MS = 2000;
const WORDS_PER_MINUTE = 220;
const SIGNED_OUT = "The coach is not signed in. Open the menu (ctrl+p) and choose Sign in.";

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export interface AppOptions {
  tui: TUI;
  config: Config;
  repo: Repo;
  models: CoachModels;
  onQuit: () => void;
}

/** The whole screen: article editor, coach conversation, and the commands that tie them to git. */
export class App implements Component, Focusable {
  /** Page keys reach the panes instead of scrolling the alternate screen. */
  readonly capturesViewportInput = true;

  private readonly tui: TUI;
  private readonly config: Config;
  private readonly repo: Repo;
  private readonly models: CoachModels;
  private readonly onQuit: () => void;
  private readonly dialogs: Dialogs;
  private readonly buffer = new TextBuffer();
  private readonly editor = new EditorView(this.buffer);
  private readonly pane = new CoachPane();

  private coach: Coach | undefined;
  private post: Post | undefined;
  private stage: Stage = "draft";
  private focus: "editor" | "coach" = "editor";
  private isFocused = false;
  private status: { text: string; error: boolean } = {
    text: "ctrl+p opens the menu",
    error: false,
  };
  private operating: string | undefined;

  /** Text of the article as last written to disk and as last pushed. */
  private diskText = "";
  private syncedText: string | undefined;
  private autosave: NodeJS.Timeout | undefined;

  private comments: Comment[] = [];
  private suggestions: Suggestion[] = [];
  private marksKey = "";
  private commentLines = new Map<Comment, { first: number; last: number }>();
  private pendingTranslation: string | undefined;
  private replyOpen = false;
  private pasteBuffer: string | undefined;
  private preview: ChildProcess | undefined;
  private stats = { version: -1, words: 0 };
  private editorRect: Rect | undefined;
  private coachRect: Rect | undefined;

  constructor(options: AppOptions) {
    this.tui = options.tui;
    this.config = options.config;
    this.repo = options.repo;
    this.models = options.models;
    this.onQuit = options.onQuit;
    this.dialogs = new Dialogs(options.tui);
    this.pane.onSubmit = (text) => void this.sendToCoach(text);
  }

  get focused(): boolean {
    return this.isFocused;
  }

  set focused(value: boolean) {
    this.isFocused = value;
    this.applyFocus();
  }

  private applyFocus(): void {
    this.editor.focused = this.isFocused && this.focus === "editor" && this.post !== undefined;
    this.pane.focused = this.isFocused && this.focus === "coach";
  }

  private setFocus(focus: "editor" | "coach"): void {
    this.focus = focus;
    this.applyFocus();
  }

  invalidate(): void {}

  async start(): Promise<void> {
    await this.connectCoach();
    await this.chooseArticle();
  }

  private say(text: string, error = false): void {
    this.status = { text, error };
    this.tui.requestRender();
  }

  /** Run one command at a time, reporting its failure on the status line. */
  private async operation(label: string, task: () => Promise<void>): Promise<void> {
    if (this.operating) {
      this.say(`Still ${this.operating.toLowerCase()}…`);
      return;
    }
    this.operating = label;
    this.say(`${label}…`);
    try {
      await task();
    } catch (error) {
      this.say((error as Error).message, true);
    } finally {
      this.operating = undefined;
      this.tui.requestRender();
    }
  }

  /** Hand the terminal to another program, then take it back. */
  private async suspended<T>(task: () => Promise<T>): Promise<T> {
    this.tui.stop({ preserveScreen: true });
    try {
      return await task();
    } finally {
      this.tui.start();
      this.tui.setFocus(this);
      this.tui.requestRender(true);
    }
  }

  private readonly workspace: Workspace = {
    article: () =>
      this.post
        ? { path: this.post.path, lang: this.post.lang, text: this.buffer.getText() }
        : undefined,
    listPosts: async () =>
      (await listPosts(this.config)).map((post) => ({
        slug: post.slug,
        lang: post.lang,
        title: post.meta.title,
        date: post.meta.date,
        draft: post.meta.draft,
      })),
    readPost: (slug, lang) => {
      const name = basename(articlePath(this.config, slug, lang));
      if (!parseArticleName(this.config, name)) throw new Error(`no article ${slug} in ${lang}`);
      return readFile(join(this.config.repoPath, this.config.articlesDir, name), "utf8");
    },
    addComment: (quote, note) => {
      this.comments.push({ quote, note });
      this.marksKey = "";
      this.tui.requestRender();
    },
    addSuggestion: (original, alternatives, reason) => {
      const suggestion = { original, alternatives, reason };
      this.suggestions.push(suggestion);
      this.pane.addSuggestion(suggestion);
      this.replyOpen = false;
      this.tui.requestRender();
    },
    pendingTranslation: () => this.pendingTranslation,
    writeTranslation: async (title, description, body) => {
      const post = this.post;
      const target = this.pendingTranslation;
      if (!post || !target) throw new Error("no translation is pending");
      const path = articlePath(this.config, post.slug, target);
      // The translation keeps the article's other fields, except the redirects of its old URLs.
      const source = setFields(withBody(this.buffer.getText(), `${body.trim()}\n`), {
        title,
        description,
        translationKey: this.meta().translationKey ?? post.slug,
        aliases: undefined,
      });
      await writeFile(join(this.config.repoPath, path), source);
      this.pendingTranslation = undefined;
      this.syncedText = undefined;
      this.pane.add("note", `Translation written to ${path}. Open it from the menu to review it.`);
      this.replyOpen = false;
      return path;
    },
  };

  private async connectCoach(): Promise<void> {
    try {
      const model = await resolveModel(this.models, this.config);
      if (!model) {
        this.coach = undefined;
        this.pane.add("note", SIGNED_OUT);
        return;
      }
      this.coach = new Coach({
        models: this.models,
        model,
        thinkingLevel: this.config.thinkingLevel,
        workspace: this.workspace,
      });
      this.coach.subscribe((event) => {
        if (event.type === "start") {
          this.replyOpen = false;
          this.pane.activity = "thinking";
        } else if (event.type === "reply") {
          if (!this.replyOpen) this.pane.beginReply();
          this.replyOpen = true;
          this.pane.updateReply(event.text);
        } else if (event.type === "tool") {
          this.replyOpen = false;
          this.pane.activity = event.label.toLowerCase();
        } else if (event.type === "error") {
          this.pane.add("error", event.message);
        } else {
          this.pane.activity = undefined;
          this.pendingTranslation = undefined;
        }
        this.tui.requestRender();
      });
    } catch (error) {
      this.pane.add("error", `Coach unavailable: ${(error as Error).message}`);
    }
  }

  /** The coach when it can take a message now; otherwise says why not. */
  private idleCoach(): Coach | undefined {
    if (!this.coach) this.say("The coach is not signed in: ctrl+p, then Sign in", true);
    else if (!this.post) this.say("Open an article first", true);
    else if (this.coach.busy) this.say("The coach is still answering (esc stops it)");
    else return this.coach;
    return undefined;
  }

  private async sendToCoach(text: string, stage = this.stage): Promise<void> {
    const coach = this.idleCoach();
    if (!coach || !this.post) return;
    const cursorLine = this.buffer.cursor.line;
    const context = turnContext({
      stage,
      path: this.post.path,
      lang: this.post.lang,
      words: countWords(this.buffer.getText()),
      cursorLine: cursorLine + 1,
      cursorParagraph: this.buffer.paragraphAt(cursorLine)?.text,
    });
    this.pane.add("author", text);
    this.tui.requestRender();
    await coach.send(`${context}\n\n${text}`);
  }

  private setStage(stage: Stage): void {
    this.stage = stage;
    const kickoff = STAGES.find((candidate) => candidate.id === stage)?.kickoff;
    if (kickoff && this.coach && this.post) void this.sendToCoach(kickoff);
    this.tui.requestRender();
  }

  private rephraseSentence(): void {
    const sentence = this.buffer.sentenceAtCursor();
    if (!sentence) {
      this.say("Put the cursor on a sentence first");
      return;
    }
    void this.sendToCoach(`Suggest alternative phrasings for this sentence: “${sentence.text}”`);
  }

  private resolveSuggestion(choice: number): void {
    const suggestion = this.suggestions.shift();
    if (!suggestion) return;
    const alternative = suggestion.alternatives[choice - 1];
    if (choice === 0 || !alternative) {
      this.pane.resolveSuggestion(suggestion, "dismissed");
    } else if (this.buffer.replaceText(suggestion.original, alternative)) {
      this.pane.resolveSuggestion(suggestion, "applied");
      this.touched();
    } else {
      this.pane.resolveSuggestion(suggestion, "dismissed");
      this.say("That passage has changed since; the suggestion was dropped");
    }
    this.tui.requestRender();
  }

  private refreshMarks(): void {
    const key = `${this.buffer.version}:${this.comments.length}`;
    if (key === this.marksKey) return;
    this.marksKey = key;
    const text = this.buffer.getText();
    this.commentLines.clear();
    // A comment whose quote was edited away has done its job.
    this.comments = this.comments.filter((comment) => {
      const offset = text.indexOf(comment.quote);
      if (offset === -1) return false;
      this.commentLines.set(comment, {
        first: this.buffer.positionAt(offset).line,
        last: this.buffer.positionAt(offset + comment.quote.length).line,
      });
      return true;
    });
    this.marksKey = `${this.buffer.version}:${this.comments.length}`;
    const marked = new Set<number>();
    for (const { first } of this.commentLines.values()) marked.add(first);
    this.editor.markedLines = marked;
  }

  private commentsAtCursor(): Comment[] {
    const paragraph = this.buffer.paragraphAt(this.buffer.cursor.line);
    const first = paragraph?.range.start.line ?? this.buffer.cursor.line;
    const last = paragraph?.range.end.line ?? this.buffer.cursor.line;
    return this.comments.filter((comment) => {
      const lines = this.commentLines.get(comment);
      return lines !== undefined && lines.first <= last && lines.last >= first;
    });
  }

  private dismissComment(): void {
    const [comment] = this.commentsAtCursor();
    if (!comment) return;
    this.comments = this.comments.filter((candidate) => candidate !== comment);
    this.marksKey = "";
  }

  private nextComment(): void {
    this.refreshMarks();
    const lines = [...this.commentLines.values()].map((span) => span.first).sort((a, b) => a - b);
    if (lines.length === 0) {
      this.say("No notes from the coach");
      return;
    }
    const current = this.buffer.cursor.line;
    this.buffer.moveTo({
      line: lines.find((line) => line > current) ?? (lines[0] as number),
      col: 0,
    });
  }

  private meta(): PostMeta {
    try {
      return parseMeta(this.buffer.getText());
    } catch {
      return { title: this.post?.slug ?? "", draft: true, description: "", tags: [] };
    }
  }

  private touched(): void {
    clearTimeout(this.autosave);
    this.autosave = setTimeout(() => {
      this.writeToDisk().catch((error) =>
        this.say(`Cannot write the article: ${error.message}`, true),
      );
    }, AUTOSAVE_MS);
  }

  private async writeToDisk(): Promise<void> {
    clearTimeout(this.autosave);
    if (!this.post) return;
    const text = this.buffer.getText();
    if (text === this.diskText) return;
    await writeFile(join(this.config.repoPath, this.post.path), text);
    this.diskText = text;
  }

  private get unsynced(): boolean {
    return this.post !== undefined && this.buffer.getText() !== this.syncedText;
  }

  /** Retry a git task once after unlocking the signing key on the terminal. */
  private async withSigning<T>(task: () => Promise<T>): Promise<T> {
    try {
      return await task();
    } catch (error) {
      if (!(error instanceof SigningLockedError)) throw error;
      const unlock = await this.dialogs.confirm(
        "The commit signing key is locked",
        "Unlock it now",
        "Cancel",
      );
      if (!unlock) throw new Error("Not saved: the signing key is locked");
      const code = await this.suspended(() => {
        const terminal = execFileSync("tty", { stdio: ["inherit", "pipe", "ignore"] })
          .toString()
          .trim();
        const command = 'echo | gpg "$@" --sign >/dev/null';
        const keyArgs = error.key ? ["-u", error.key] : [];
        // pinentry draws on the terminal named by GPG_TTY, not on its own stdin.
        return runInteractive("sh", ["-c", command, "sh", ...keyArgs], {
          ...process.env,
          GPG_TTY: terminal,
        });
      });
      if (code !== 0) throw new Error("Not saved: the signing key is still locked");
      return task();
    }
  }

  private async sync(): Promise<void> {
    const post = this.post;
    if (!post) return;
    await this.writeToDisk();
    const text = this.buffer.getText();
    let published = false;
    for (const lang of this.config.languages) {
      published ||= await this.repo.existsUpstream(articlePath(this.config, post.slug, lang));
    }
    const subject = commitSubject(published ? "Update" : "Add", this.meta().title || post.slug);
    const result = await this.withSigning(() => this.repo.save(draftBranch(post.slug), subject));
    if (result !== "saved-locally") this.syncedText = text;
    const outcome = {
      saved: "Saved and pushed",
      unchanged: "Nothing new to save",
      "saved-locally": "Committed, but the push failed: check the network and save again",
    }[result];
    this.say(outcome, result === "saved-locally");
  }

  private async load(post: Post): Promise<void> {
    await this.repo.open(draftBranch(post.slug));
    const text = await readFile(join(this.config.repoPath, post.path), "utf8");
    this.post = post;
    this.buffer.reset(text);
    this.diskText = text;
    const branch = draftBranch(post.slug);
    const pushed = !(await this.repo.isDirty()) && (await this.repo.isPushed(branch));
    this.syncedText = pushed ? text : undefined;
    this.pendingTranslation = undefined;
    this.comments = [];
    this.suggestions = [];
    this.marksKey = "";
    this.stage = "draft";
    this.pane.clear();
    if (!this.coach) this.pane.add("note", SIGNED_OUT);
    await this.coach?.reset();
    this.setFocus("editor");
    this.say(post.path);
  }

  /** Save the open article before the working tree moves to another branch. */
  private async leaveArticle(): Promise<void> {
    if (!this.post) return;
    this.coach?.abort();
    await this.writeToDisk();
    if (this.unsynced || (await this.repo.isDirty())) await this.sync();
  }

  private async chooseArticle(): Promise<void> {
    type Entry = { post: Post; pending: boolean };
    const entries = new Map<string, Entry>();
    await this.operation("Loading the articles", async () => {
      await this.writeToDisk();
      await this.repo.fetch();
      for (const post of await listPosts(this.config))
        entries.set(post.path, { post, pending: false });
      for (const branch of await this.repo.draftBranches()) {
        for (const path of await this.repo.changedFiles(branch)) {
          const parsed = parseArticleName(this.config, basename(path));
          if (!parsed || path !== articlePath(this.config, parsed.slug, parsed.lang)) continue;
          try {
            const meta = parseMeta(await this.repo.show(branch, path));
            entries.set(path, { post: { ...parsed, path, meta }, pending: true });
          } catch {
            // The draft deletes this file or holds front matter that does not parse.
          }
        }
      }
      this.say("ctrl+p opens the menu");
    });

    const items: SelectItem[] = [
      { value: "", label: "New article", description: "start from a title" },
      ...[...entries.values()]
        .sort((a, b) => (b.post.meta.date ?? "").localeCompare(a.post.meta.date ?? ""))
        .map(({ post, pending }) => ({
          value: post.path,
          label: `${post.meta.title || post.slug} [${post.lang}]`,
          description: [
            post.meta.date?.slice(0, 10),
            post.meta.draft ? "draft" : "published",
            pending ? "unpublished changes" : undefined,
          ]
            .filter(Boolean)
            .join(" · "),
        })),
    ];
    const choice = await this.dialogs.pick("Open an article", items);
    if (choice === undefined) return;
    if (choice === "") {
      await this.newArticle();
      return;
    }
    const entry = entries.get(choice);
    if (!entry) return;
    await this.operation("Opening", async () => {
      await this.leaveArticle();
      await this.load(entry.post);
    });
  }

  private async newArticle(): Promise<void> {
    const title = await this.dialogs.ask("Title of the new article");
    if (!title) return;
    let lang = this.config.languages[0] as string;
    if (this.config.languages.length > 1) {
      const picked = await this.dialogs.pick(
        "Language",
        this.config.languages.map((code) => ({ value: code, label: code })),
      );
      if (!picked) return;
      lang = picked;
    }
    await this.operation("Creating the article", async () => {
      await this.leaveArticle();
      // With no draft of that slug yet, this checks out the publish branch, where articles start.
      await this.repo.open(draftBranch(slugify(title)));
      const post = await createPost(this.config, title, lang);
      await this.load(post);
      this.buffer.moveDocumentEnd();
      this.stage = "angle";
    });
  }

  private async publish(): Promise<void> {
    const post = this.post;
    if (!post) return;
    const siblings: string[] = [];
    for (const lang of this.config.languages) {
      if (lang === post.lang) continue;
      const path = articlePath(this.config, post.slug, lang);
      if (await exists(join(this.config.repoPath, path))) siblings.push(path);
    }
    const versions = [
      post.lang,
      ...siblings.map((path) => parseArticleName(this.config, basename(path))?.lang),
    ];
    const confirmed = await this.dialogs.confirm(
      `Publish “${this.meta().title || post.slug}” (${versions.join(", ")}) to the live site?`,
      "Publish",
      "Cancel",
    );
    if (!confirmed) return;

    await this.operation("Publishing", async () => {
      let firstPublication = true;
      for (const path of [post.path, ...siblings]) {
        if (await this.repo.existsUpstream(path)) firstPublication = false;
      }
      // An article drafted over weeks goes out dated the day it is published.
      const fields = { draft: false, ...(firstPublication ? { date: hugoDate(new Date()) } : {}) };
      this.buffer.setText(setFields(this.buffer.getText(), fields));
      for (const path of siblings) {
        const file = join(this.config.repoPath, path);
        await writeFile(file, setFields(await readFile(file, "utf8"), fields));
      }
      this.syncedText = undefined;
      await this.sync();
      await this.withSigning(() => this.repo.publish(draftBranch(post.slug)));
      this.say("Published: GitHub is deploying the site");
    });
  }

  private async translate(): Promise<void> {
    const post = this.post;
    if (!post || !this.idleCoach()) return;
    const others = this.config.languages.filter((lang) => lang !== post.lang);
    let target = others[0];
    if (others.length > 1) {
      target = await this.dialogs.pick(
        "Translate into",
        others.map((lang) => ({ value: lang, label: lang })),
      );
    }
    if (!target) return;
    const path = articlePath(this.config, post.slug, target);
    if (await exists(join(this.config.repoPath, path))) {
      const overwrite = await this.dialogs.confirm(
        `${path} exists. Replace it?`,
        "Replace",
        "Cancel",
      );
      if (!overwrite) return;
    }
    // A turn that started while the dialogs were open must not receive the permission to write.
    if (!this.idleCoach()) return;
    this.pendingTranslation = target;
    await this.sendToCoach(translateRequest(post.lang, target), "translate");
  }

  private async openExternalEditor(): Promise<void> {
    const post = this.post;
    if (!post) return;
    await this.operation("Editing elsewhere", async () => {
      await this.writeToDisk();
      const file = join(this.config.repoPath, post.path);
      const command = this.config.editor || process.env.VISUAL || process.env.EDITOR || "vi";
      await this.suspended(() => runInteractive("sh", ["-c", `${command} "$1"`, "sh", file]));
      const text = await readFile(file, "utf8");
      this.buffer.setText(text);
      this.diskText = text;
      this.say(post.path);
    });
  }

  private async signIn(): Promise<void> {
    await this.operation("Signing in", async () => {
      await this.suspended(() => loginOnTerminal(this.models, this.config.provider));
      await this.connectCoach();
      this.say(
        this.coach ? `Signed in: ${this.coach.modelName}` : "Sign-in did not complete",
        !this.coach,
      );
    });
  }

  private togglePreview(): void {
    if (this.preview) {
      this.preview.kill();
      this.preview = undefined;
      this.say("Preview stopped");
      return;
    }
    const child = spawn("hugo", this.config.previewArgs, {
      cwd: this.config.repoPath,
      stdio: ["ignore", "pipe", "ignore"],
    });
    this.preview = child;
    child.on("error", (error) => {
      this.preview = undefined;
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      this.say(missing ? "hugo is not installed on this machine" : error.message, true);
    });
    child.on("exit", () => {
      if (this.preview === child) this.preview = undefined;
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      const url = /https?:\/\/\S+/.exec(chunk.toString());
      if (url) this.say(`Preview at ${url[0]}`);
    });
    this.say("Starting the preview…");
  }

  private async quit(): Promise<void> {
    await this.writeToDisk().catch(() => undefined);
    if (this.unsynced) {
      const choice = await this.dialogs.pick("The article has changes that are not pushed", [
        { value: "sync", label: "Save, push, then quit" },
        { value: "quit", label: "Quit", description: "changes stay in the local clone" },
        { value: "stay", label: "Cancel" },
      ]);
      if (choice === undefined || choice === "stay") return;
      if (choice === "sync") {
        await this.operation("Saving", () => this.sync());
        if (this.unsynced) return;
      }
    }
    this.coach?.abort();
    this.preview?.kill();
    this.onQuit();
  }

  /** Every command of the menu; those with a key also run from the keyboard. */
  private commands(): (SelectItem & { key?: KeyId; run: () => unknown })[] {
    const other = this.config.languages.filter((lang) => lang !== this.post?.lang).join("/");
    const commands: { label: string; key?: KeyId; description?: string; run: () => unknown }[] = [
      { label: "Open or create an article", run: () => this.chooseArticle() },
      {
        label: "Save and push",
        key: "ctrl+s",
        run: () => this.operation("Saving", () => this.sync()),
      },
      ...STAGES.map((stage) => ({
        label: `Stage: ${stage.label}`,
        description: stage.description,
        run: () => this.setStage(stage.id),
      })),
      {
        label: "Review this paragraph",
        key: "ctrl+r",
        run: () => this.sendToCoach("Review the paragraph under my cursor."),
      },
      { label: "Rephrase this sentence", key: "ctrl+t", run: () => this.rephraseSentence() },
      { label: `Translate into ${other}`, run: () => this.translate() },
      { label: "Publish to the live site", run: () => this.publish() },
      { label: "Edit in $EDITOR", key: "ctrl+o", run: () => this.openExternalEditor() },
      {
        label: this.preview ? "Stop the preview" : "Preview with hugo",
        run: () => this.togglePreview(),
      },
      { label: "Sign in to the coach", run: () => this.signIn() },
      { label: "Quit", key: "ctrl+q", run: () => this.quit() },
    ];
    return commands.map((command, index) => ({
      ...command,
      value: String(index),
      description: command.description ?? command.key,
    }));
  }

  private async openMenu(): Promise<void> {
    const commands = this.commands();
    const choice = await this.dialogs.pick("Menu", commands);
    await commands.find((command) => command.value === choice)?.run();
  }

  handleInput(data: string): void {
    if (this.focus !== "editor") {
      this.handleKey(data);
      return;
    }
    let rest = data;
    if (this.pasteBuffer === undefined) {
      const start = rest.indexOf(PASTE_START);
      if (start === -1) {
        this.handleKey(rest);
        return;
      }
      if (start > 0) this.handleKey(rest.slice(0, start));
      this.pasteBuffer = "";
      rest = rest.slice(start + PASTE_START.length);
    }
    this.pasteBuffer += rest;
    const end = this.pasteBuffer.indexOf(PASTE_END);
    if (end === -1) return;
    const content = this.pasteBuffer.slice(0, end);
    const remaining = this.pasteBuffer.slice(end + PASTE_END.length);
    this.pasteBuffer = undefined;
    if (this.post) {
      this.editor.paste(content);
      this.touched();
    }
    if (remaining) this.handleInput(remaining);
    this.tui.requestRender();
  }

  private handleKey(data: string): void {
    const globals: [KeyId, () => unknown][] = [
      ...this.commands().flatMap((command): [KeyId, () => unknown][] =>
        command.key ? [[command.key, command.run]] : [],
      ),
      ["ctrl+p", () => this.openMenu()],
      ["ctrl+n", () => this.nextComment()],
      ["ctrl+x", () => this.dismissComment()],
      ["tab", () => this.setFocus(this.focus === "editor" ? "coach" : "editor")],
      ["alt+0", () => this.resolveSuggestion(0)],
      ["alt+1", () => this.resolveSuggestion(1)],
      ["alt+2", () => this.resolveSuggestion(2)],
      ["alt+3", () => this.resolveSuggestion(3)],
    ];
    for (const [key, action] of globals) {
      if (matchesKey(data, key)) {
        void action();
        this.tui.requestRender();
        return;
      }
    }
    if (matchesKey(data, "escape") && this.coach?.busy) {
      this.coach.abort();
    } else if (this.focus === "coach") {
      this.pane.handleInput(data);
    } else if (this.post) {
      const before = this.buffer.version;
      this.editor.handleInput(data);
      if (this.buffer.version !== before) this.touched();
    }
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const inside = (rect: Rect | undefined): rect is Rect =>
      rect !== undefined &&
      event.x >= rect.x &&
      event.x < rect.x + rect.width &&
      event.y >= rect.y &&
      event.y < rect.y + rect.height;
    const overEditor = inside(this.editorRect);
    if (!overEditor && !inside(this.coachRect)) return undefined;
    if (event.type === "wheel") {
      const delta = Math.sign(event.wheelDelta ?? 0) * 3;
      if (overEditor) this.editor.scrollBy(delta);
      else this.pane.scrollBy(-delta);
      return { handled: true };
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    this.setFocus(overEditor ? "editor" : "coach");
    if (overEditor && this.editorRect) {
      this.editor.clickAt(event.x - this.editorRect.x, event.y - this.editorRect.y);
    }
    return { handled: true };
  }

  private header(width: number): string {
    if (!this.post) return fit(accent(" brouillon"), width);
    if (this.stats.version !== this.buffer.version) {
      this.stats = { version: this.buffer.version, words: countWords(this.buffer.getText()) };
    }
    const meta = this.meta();
    const minutes = Math.max(1, Math.round(this.stats.words / WORDS_PER_MINUTE));
    const parts = [
      accent(` ${meta.title || this.post.slug}`),
      style.dim(`[${this.post.lang}]`),
      meta.draft ? style.yellow("draft") : style.green("published"),
      style.dim(`${this.stats.words} words · ${minutes} min`),
      style.dim(`stage: ${this.stage}`),
      this.unsynced ? style.yellow("● not pushed") : style.dim("pushed"),
    ];
    return fit(parts.join("  "), width);
  }

  private footer(width: number): string {
    const hints = "^P menu  tab coach  ^S save  ^R review  ^T rephrase  ^Q quit";
    const text = this.status.error ? style.red(this.status.text) : this.status.text;
    const room = width - visibleWidth(hints) - 2;
    // The status line says what just happened; hints give way to it on a narrow terminal.
    if (room < visibleWidth(text) + 2) return fit(` ${text}`, width);
    return `${fit(` ${text}`, room)}  ${style.dim(hints)}`;
  }

  private renderEditor(width: number, height: number): string[] {
    if (!this.post) {
      const lines = Array.from({ length: height }, () => " ".repeat(width));
      const message = "No article open: ctrl+p opens the menu";
      lines[Math.floor(height / 2)] = fit(`  ${style.dim(message)}`, width);
      return lines;
    }
    this.refreshMarks();
    const notes = this.commentsAtCursor().flatMap((comment) =>
      wrapTextWithAnsi(`${style.yellow("●")} ${comment.note}`, Math.max(10, width - 2)),
    );
    const panel =
      notes.length === 0
        ? []
        : [
            style.dim("─".repeat(width)),
            ...notes.slice(0, 5),
            style.dim("ctrl+x dismisses the note · ctrl+n jumps to the next one"),
          ];
    const editorHeight = Math.max(1, height - panel.length);
    return [
      ...this.editor.render(width, editorHeight),
      ...panel.slice(0, height - editorHeight).map((line) => fit(line, width)),
    ];
  }

  render(width: number): string[] {
    const height = Math.max(4, this.tui.terminal.rows);
    const bodyHeight = height - 2;
    let body: string[];
    if (width >= WIDE_LAYOUT) {
      const coachWidth = Math.max(36, Math.floor(width * 0.36));
      const editorWidth = width - coachWidth - 3;
      const left = this.renderEditor(editorWidth, bodyHeight);
      const right = this.pane.render(coachWidth, bodyHeight);
      const bar = this.focus === "coach" ? style.cyan("│") : style.dim("│");
      body = left.map((line, row) => `${line} ${bar} ${right[row] ?? ""}`);
      this.editorRect = { x: 0, y: 1, width: editorWidth, height: bodyHeight };
      this.coachRect = { x: editorWidth + 3, y: 1, width: coachWidth, height: bodyHeight };
    } else if (this.focus === "coach") {
      body = this.pane.render(width, bodyHeight);
      this.editorRect = undefined;
      this.coachRect = { x: 0, y: 1, width, height: bodyHeight };
    } else {
      body = this.renderEditor(width, bodyHeight);
      this.editorRect = { x: 0, y: 1, width, height: bodyHeight };
      this.coachRect = undefined;
    }
    return [this.header(width), ...body, this.footer(width)];
  }
}
