import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { coachTools, type Workspace } from "../src/agent/tools.ts";

const ARTICLE = `---
title: Test
---

The first paragraph has a sentence that is
wrapped over two lines. It has a second sentence.

The second paragraph is short.
`;

function setup(overrides: Partial<Workspace> = {}) {
  const calls: {
    comments: [string, string][];
    suggestions: [string, string[]][];
    written: string[];
  } = { comments: [], suggestions: [], written: [] };
  const workspace: Workspace = {
    article: () => ({ path: "content/articles/test.fr.md", lang: "fr", text: ARTICLE }),
    listPosts: async () => [
      { slug: "old", lang: "fr", title: "Old", date: "2015-01-01", draft: false },
    ],
    readPost: async () => "old text",
    addComment: (quote, note) => calls.comments.push([quote, note]),
    addSuggestion: (original, alternatives) => calls.suggestions.push([original, alternatives]),
    pendingTranslation: () => undefined,
    writeTranslation: async (title) => {
      calls.written.push(title);
      return "content/articles/test.en.md";
    },
    ...overrides,
  };
  const tools = new Map(coachTools(workspace).map((tool) => [tool.name, tool as AgentTool]));
  const call = async (name: string, params: object) => {
    const result = await (tools.get(name) as AgentTool).execute("id", params);
    return result.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  };
  return { calls, call, names: [...tools.keys()] };
}

test("the coach has no tool that edits the article", () => {
  assert.deepEqual(setup().names, [
    "read_article",
    "list_posts",
    "read_post",
    "comment",
    "suggest",
    "write_translation",
  ]);
});

test("read_article numbers the lines", async () => {
  const text = await setup().call("read_article", {});
  assert.match(text, /^content\/articles\/test\.fr\.md \(fr\)/);
  assert.match(text, /\n {3}5 {2}The first paragraph/);
});

test("tools fail when no article is open", async () => {
  const { call } = setup({ article: () => undefined });
  await assert.rejects(call("read_article", {}), /No article is open/);
});

test("comment anchors on the article's own words, across its line breaks", async () => {
  const { call, calls } = setup();
  await call("comment", { quote: "a sentence that is wrapped over", note: "Too long." });
  assert.deepEqual(calls.comments, [["a sentence that is\nwrapped over", "Too long."]]);
  await assert.rejects(
    call("comment", { quote: "not in the text", note: "x" }),
    /not in the article/,
  );
  await assert.rejects(
    call("comment", { quote: "short", note: "x".repeat(500) }),
    /at most 400 characters/,
  );
});

test("suggest accepts rephrasings of a passage inside one paragraph", async () => {
  const { call, calls } = setup();
  await call("suggest", {
    original: "It has a second sentence.",
    alternatives: ["A second sentence follows.", "Then comes a second sentence."],
    reason: "Stronger verb.",
  });
  assert.equal(calls.suggestions.length, 1);
  assert.equal(calls.suggestions[0]?.[0], "It has a second sentence.");
});

test("suggest refuses to write new material", async () => {
  const { call, calls } = setup();
  const alternatives = ["One.", "Two."];
  await assert.rejects(
    call("suggest", { original: "words that are absent", alternatives, reason: "r" }),
    /not in the article/,
  );
  await assert.rejects(
    call("suggest", {
      original: "It has a second sentence.\n\nThe second paragraph is short.",
      alternatives,
      reason: "r",
    }),
    /within one paragraph/,
  );
  await assert.rejects(
    call("suggest", {
      original: "It has a second sentence.",
      alternatives: ["Only one."],
      reason: "r",
    }),
    /two or three/,
  );
  await assert.rejects(
    call("suggest", {
      original: "It has a second sentence.",
      alternatives: ["Fine.", "long ".repeat(60)],
      reason: "r",
    }),
    /must not add paragraphs or double its length/,
  );
  assert.equal(calls.suggestions.length, 0);
});

test("write_translation only works after the author asked for a translation", async () => {
  const params = { title: "Test", description: "", body: "Text." };
  const refused = setup();
  await assert.rejects(
    refused.call("write_translation", params),
    /has not asked for a translation/,
  );
  assert.deepEqual(refused.calls.written, []);

  const allowed = setup({ pendingTranslation: () => "en" });
  assert.match(await allowed.call("write_translation", params), /test\.en\.md/);
  assert.deepEqual(allowed.calls.written, ["Test"]);
});

test("suggest refuses a passage that appears more than once", async () => {
  const text = "Twice here. Something else. Twice here.\n";
  const { call, calls } = setup({ article: () => ({ path: "a.fr.md", lang: "fr", text }) });
  await assert.rejects(
    call("suggest", { original: "Twice here.", alternatives: ["One.", "Two."], reason: "r" }),
    /more than once/,
  );
  assert.equal(calls.suggestions.length, 0);
});
