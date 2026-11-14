import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultConfig, loadConfig, repoName, saveBlogSettings } from "../src/config.ts";

const scratch = () => join(mkdtempSync(join(tmpdir(), "brouillon-config-")), "config.json");

const BLOG = {
  repoUrl: "git@example.org:someone/notes.git",
  publishBranch: "trunk",
  articlesDir: "content/blog",
  languages: ["en", "de"],
  blogName: "Notes",
  blogDescription: "gardening",
};

test("repoName reads the clone's name from the usual URL shapes", () => {
  assert.equal(repoName("git@github.com:someone/someone.github.io.git"), "someone.github.io");
  assert.equal(repoName("https://example.org/someone/notes/"), "notes");
  assert.equal(repoName("/srv/git/blog.git"), "blog");
  assert.equal(repoName("example.org:notes"), "notes");
});

test("without a configured blog there is no configuration", async () => {
  const path = scratch();
  assert.equal(await loadConfig(path), undefined);
  writeFileSync(path, JSON.stringify({ theme: "dark" }));
  assert.equal(await loadConfig(path), undefined);
});

test("saved blog settings load back over the defaults and keep the file's other keys", async () => {
  const path = scratch();
  writeFileSync(path, JSON.stringify({ theme: "light", repoUrl: "old" }));
  await saveBlogSettings(BLOG, path);
  const config = await loadConfig(path);
  assert.deepEqual(config, { ...defaultConfig(BLOG.repoUrl), ...BLOG, theme: "light" });
  assert.ok(config?.repoPath.endsWith("/brouillon/notes"));
  assert.ok(readFileSync(path, "utf8").endsWith("}\n"));
});

test("a configuration that cannot work is refused with the reason", async () => {
  const path = scratch();
  writeFileSync(path, JSON.stringify({ ...BLOG, languages: [] }));
  await assert.rejects(loadConfig(path), /languages/);
  writeFileSync(path, JSON.stringify({ ...BLOG, theme: "neon" }));
  await assert.rejects(loadConfig(path), /theme/);
  writeFileSync(path, "{");
  await assert.rejects(loadConfig(path), /not valid JSON/);
});

test("setting up another repository forgets the clone path of the previous one", async () => {
  const path = scratch();
  writeFileSync(path, JSON.stringify({ ...BLOG, repoPath: "/srv/clones/notes" }));
  await saveBlogSettings(BLOG, path);
  assert.equal((await loadConfig(path))?.repoPath, "/srv/clones/notes");
  await saveBlogSettings({ ...BLOG, repoUrl: "git@example.org:someone/journal.git" }, path);
  assert.ok((await loadConfig(path))?.repoPath.endsWith("/brouillon/journal"));
});
