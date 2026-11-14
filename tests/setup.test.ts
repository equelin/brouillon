import assert from "node:assert/strict";
import { test } from "node:test";
import { askBlogSettings } from "../src/setup.ts";

/** A terminal that types the given answers in order and records what it was asked. */
function scripted(answers: string[]) {
  const asked: string[] = [];
  const terminal = {
    ask: async (question: string) => {
      asked.push(question);
      return answers.shift() ?? "";
    },
    say: () => undefined,
  };
  return { terminal, asked };
}

test("the first start asks for the repository until given, and suggests the rest", async () => {
  const { terminal, asked } = scripted([
    "",
    " git@example.org:someone/notes.git ",
    "",
    "",
    "",
    "",
    "",
  ]);
  const settings = await askBlogSettings(terminal, async () => "trunk");
  assert.deepEqual(settings, {
    repoUrl: "git@example.org:someone/notes.git",
    publishBranch: "trunk",
    articlesDir: "content/posts",
    languages: ["en"],
    blogName: "notes",
    blogDescription: "",
  });
  assert.equal(asked.length, 7);
  assert.match(asked[2] ?? "", /\[trunk\]/);
});

test("typed answers win, and languages and the directory are tidied", async () => {
  const { terminal } = scripted([
    "https://example.org/blog.git",
    "live",
    "/content/articles/",
    "fr, en",
    "Okay Computer",
    "infrastructure and automation",
  ]);
  const settings = await askBlogSettings(terminal, async () => undefined);
  assert.deepEqual(settings, {
    repoUrl: "https://example.org/blog.git",
    publishBranch: "live",
    articlesDir: "content/articles",
    languages: ["fr", "en"],
    blogName: "Okay Computer",
    blogDescription: "infrastructure and automation",
  });
});

test("setting the same blog up again suggests its current settings", async () => {
  const current = {
    repoUrl: "https://example.org/blog.git",
    publishBranch: "live",
    articlesDir: "posts",
    languages: ["fr", "en"],
    blogName: "Okay Computer",
    blogDescription: "infrastructure",
  };
  const { terminal } = scripted([]);
  assert.deepEqual(await askBlogSettings(terminal, async () => "main", current), current);
});
