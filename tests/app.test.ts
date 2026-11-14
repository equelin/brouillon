import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  type Component,
  stripTerminalSequences,
  type TUI,
  type TuiMouseEvent,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { CoachModels } from "../src/agent/models.ts";
import { THEMES } from "../src/config.ts";
import { parseMeta } from "../src/frontmatter.ts";
import { App } from "../src/ui/app.ts";
import { setTheme } from "../src/ui/theme.ts";
import { fixture, git } from "./helpers.ts";

afterEach(() => setTheme("ansi"));

const ROWS = 40;
const KEY = {
  down: "\x1b[B",
  enter: "\r",
  ctrlG: "\x07",
  ctrlN: "\x0e",
  ctrlP: "\x10",
  ctrlX: "\x18",
};

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** An App on a terminal that only records the overlay on top of it. */
async function setup() {
  const { config, repo, origin } = fixture();
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const screen: { overlay?: Component; quit: boolean; copied?: string } = { quit: false };
  const tui = {
    terminal: { rows: ROWS, columns: 150 },
    requestRender: () => undefined,
    setFocus: () => undefined,
    showOverlay: (component: Component) => {
      screen.overlay = component;
      return {
        hide: () => {
          if (screen.overlay === component) screen.overlay = undefined;
        },
      };
    },
  } as unknown as TUI;
  const app = new App({
    tui,
    config: { ...config, provider: faux.provider.id },
    repo,
    models: models as CoachModels,
    onQuit: () => {
      screen.quit = true;
    },
    copy: (text) => {
      screen.copied = text;
    },
  });
  app.focused = true;

  const answer = async (...keys: string[]) => {
    await until(() => screen.overlay !== undefined, "a dialog");
    const overlay = screen.overlay as Component;
    for (const key of keys) overlay.handleInput?.(key);
  };
  const type = (text: string) => {
    for (const char of text) app.handleInput(char);
  };
  const text = (width = 150) => app.render(width).join("\n");
  const plain = () => stripTerminalSequences(text());
  const mouse = (type: TuiMouseEvent["type"], x: number, y: number) =>
    app.handleMouse({ type, button: "left", x, y } as TuiMouseEvent);
  /** Screen row and column of a piece of text in the current frame. */
  const locate = (needle: string) => {
    const rows = app.render(150).map(stripTerminalSequences);
    const y = rows.findIndex((row) => row.includes(needle));
    return { x: rows[y]?.indexOf(needle) ?? -1, y };
  };

  const started = app.start();
  await answer(KEY.down, KEY.enter);
  await started;
  await until(() => text().includes("First steps"), "the article to open");
  return { app, faux, config, repo, origin, screen, answer, type, text, plain, mouse, locate };
}

test("every frame fills the terminal exactly, in every layout and theme", async () => {
  const { app } = await setup();
  for (const theme of THEMES) {
    setTheme(theme);
    for (const width of [150, 110, 80, 40]) {
      const lines = app.render(width);
      assert.equal(lines.length, ROWS);
      for (const line of lines) assert.equal(visibleWidth(line), width);
    }
  }
});

test("a suggestion from the coach changes the text only when the author applies it", async () => {
  const { app, faux, type, text } = await setup();
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("suggest", {
          original: "Another sentence follows it.",
          alternatives: ["A second one comes next.", "Then a second one."],
          reason: "More direct.",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("Pick the one that sounds like you.")]),
  ]);
  app.handleInput(KEY.ctrlG);
  type("help me with that sentence");
  app.handleInput(KEY.enter);
  await until(() => text().includes("Pick the one that sounds"), "the coach's reply");

  assert.ok(text().includes("alt+1, alt+2 to apply"));
  assert.ok(text().includes("One sentence here. Another sentence follows it."));
  app.handleInput("\x1b2");
  assert.ok(text().includes("One sentence here. Then a second one. A third one"));
  assert.ok(text().includes("Alternatives (applied)"));
  assert.ok(text().includes("not pushed"));
});

test("a comment shows next to its paragraph until the author dismisses it", async () => {
  const { app, faux, type, text } = await setup();
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("comment", { quote: "An opening paragraph", note: "Says nothing yet." })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("One note left.")]),
  ]);
  app.handleInput(KEY.ctrlG);
  type("review");
  app.handleInput(KEY.enter);
  await until(() => text().includes("One note left."), "the coach's reply");

  assert.ok(!text().includes("Says nothing yet."));
  app.handleInput(KEY.ctrlN);
  assert.ok(text().includes("Says nothing yet."));
  app.handleInput(KEY.ctrlX);
  assert.ok(!text().includes("Says nothing yet."));
});

test("translating writes the other language next to the article, with shared metadata", async () => {
  const { app, faux, config, answer, text } = await setup();
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall("write_translation", {
          title: "Premiers pas",
          description: "Là où tout commence.",
          body: "Un paragraphe d'ouverture.",
        }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("Translation saved.")]),
  ]);
  app.handleInput(KEY.ctrlP);
  await answer(..."translate", KEY.enter);
  await until(() => text().includes("Translation saved."), "the coach's reply");

  const path = join(config.repoPath, "content/articles/first-steps.en.md");
  assert.ok(existsSync(path));
  const source = readFileSync(path, "utf8");
  assert.deepEqual(parseMeta(source), {
    title: "Premiers pas",
    date: "2026-01-10T09:00:00+01:00",
    draft: false,
    description: "Là où tout commence.",
    tags: ["linux"],
    translationKey: "first-steps",
    slug: undefined,
  });
  assert.ok(source.endsWith("---\n\nUn paragraphe d'ouverture.\n"));
});

test("saving from the editor commits the typed text on the article's draft branch", async () => {
  const { app, type, text, origin } = await setup();
  app.handleInput("\x1b[1;5F");
  type("Typed last.");
  app.handleInput("\x13");
  await until(() => text().includes("Saved and pushed"), "the save to finish");
  assert.match(
    git(origin, "show", "post_first_steps:content/articles/first-steps.fr.md"),
    /the paragraph\.\nTyped last\.$/,
  );
  assert.equal(
    git(origin, "log", "-1", "--format=%s", "post_first_steps"),
    "Update article First steps",
  );
});

test("a translation request the coach cannot take leaves no permission to write behind", async () => {
  const { app, faux, config, answer, type, text } = await setup();
  faux.setResponses([fauxAssistantMessage([fauxText("Slow answer.")])]);
  app.handleInput(KEY.ctrlG);
  type("first question");
  app.handleInput(KEY.enter);
  app.handleInput(KEY.ctrlP);
  await answer(..."translate", KEY.enter);
  await until(() => text().includes("Slow answer."), "the first reply");

  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("write_translation", { title: "T", description: "", body: "B" })],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage([fauxText("Could not translate.")]),
  ]);
  type("second question");
  app.handleInput(KEY.enter);
  await until(() => text().includes("Could not translate."), "the second reply");
  assert.ok(!existsSync(join(config.repoPath, "content/articles/first-steps.en.md")));
});

test("a drag selects and copies text of the pane it started in only", async () => {
  const { app, faux, screen, type, text, mouse, locate } = await setup();
  faux.setResponses([fauxAssistantMessage([fauxText("Coach words.")])]);
  app.handleInput(KEY.ctrlG);
  type("hello");
  app.handleInput(KEY.enter);
  await until(() => text().includes("Coach words."), "the coach's reply");

  const article = locate("One sentence here.");
  mouse("press", article.x, article.y);
  mouse("drag", article.x + 2, article.y);
  mouse("release", article.x + 2, article.y);
  assert.equal(screen.copied, "One");

  const reply = locate("Coach words.");
  mouse("press", article.x, reply.y);
  mouse("drag", 149, reply.y);
  mouse("release", 149, reply.y);
  assert.ok(!screen.copied?.includes("Coach words."));

  mouse("press", reply.x + 11, reply.y);
  mouse("drag", 0, reply.y);
  mouse("release", 0, reply.y);
  assert.equal(screen.copied, "Coach words.");
  for (const line of app.render(150)) assert.equal(visibleWidth(line), 150);
});

test("a selection in the editor copies the article's text, not its wrapped rows", async () => {
  const { app, screen, type, mouse, locate } = await setup();
  app.handleInput("\x1b[1;5F");
  type(`${"word ".repeat(40)}end`);
  const first = locate("word word");
  mouse("press", first.x, first.y);
  mouse("drag", first.x + 3, first.y + 1);
  mouse("release", first.x + 3, first.y + 1);
  assert.match(screen.copied ?? "", /^(word )+word$/);
});

test("the prompt takes several lines and recalls earlier messages", async () => {
  const { app, faux, type, text, plain } = await setup();
  faux.setResponses([fauxAssistantMessage([fauxText("Noted.")])]);
  app.handleInput(KEY.ctrlG);
  type("first line");
  app.handleInput("\x1b\r");
  type("second line\\");
  app.handleInput(KEY.enter);
  type("third line");
  assert.ok(!text().includes("thinking"));
  app.handleInput(KEY.enter);
  await until(() => text().includes("Noted."), "the coach's reply");
  const sent = app.render(150).map(stripTerminalSequences);
  for (const line of ["▌ first line", "▌ second line", "▌ third line"]) {
    assert.ok(sent.some((row) => row.includes(line)));
  }

  type("draft");
  app.handleInput("\x1b[A");
  assert.ok(plain().includes("› first line"));
  app.handleInput("\x1b[B");
  app.handleInput("\x1b[B");
  app.handleInput("\x1b[B");
  assert.ok(plain().includes("› draft"));
});

test("a message sent while the coach answers stays in the prompt", async () => {
  const { app, faux, type, text, plain } = await setup();
  faux.setResponses([fauxAssistantMessage([fauxText("Slow answer.")])]);
  app.handleInput(KEY.ctrlG);
  type("first question");
  app.handleInput(KEY.enter);
  type("too early");
  app.handleInput(KEY.enter);
  assert.ok(plain().includes("› too early"));
  await until(() => text().includes("Slow answer."), "the reply");
  app.handleInput(KEY.enter);
  await until(() => !plain().includes("› too early"), "the kept message to go");
});

test("the coach is told the keys the application really binds", async () => {
  const { app, faux, type, text } = await setup();
  let instructions = "";
  faux.setResponses([
    (context) => {
      // The instructions travel as the leading system message of the request.
      instructions = JSON.stringify(context.messages[0]);
      return fauxAssistantMessage([fauxText("Answered.")]);
    },
  ]);
  app.handleInput(KEY.ctrlG);
  type("what is alt+1 for?");
  app.handleInput(KEY.enter);
  await until(() => text().includes("Answered."), "the coach's reply");
  for (const line of [
    "- ctrl+s: Save and push",
    "- ctrl+g: Switch between the article and the coach",
    "- alt+1: Apply alternative 1 of the oldest pending suggestion",
    "- Publish to the live site",
    "- Translate into the other language",
    "The author writes for The test blog.",
    "the blog is about: testing things",
  ]) {
    assert.ok(instructions.includes(line), line);
  }
});

test("tab indents the article and leaves the focus where it is", async () => {
  const { app, type, plain } = await setup();
  app.handleInput("\x1b[1;5F");
  app.handleInput("\t");
  type("indented");
  assert.ok(plain().includes("      indented"));
});
