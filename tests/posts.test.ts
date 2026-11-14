import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parseMeta } from "../src/frontmatter.ts";
import { createPost, hugoDate, listPosts, parseArticleName, slugify } from "../src/posts.ts";
import { fixture } from "./helpers.ts";

test("slugify strips accents and punctuation", () => {
  assert.equal(
    slugify("Réclamer l'espace libre : ESXi & UNMAP !"),
    "reclamer-l-espace-libre-esxi-unmap",
  );
  assert.equal(slugify("  ---  "), "");
});

test("parseArticleName accepts slug.lang.md for configured languages only", () => {
  const { config } = fixture();
  assert.deepEqual(parseArticleName(config, "my-post.fr.md"), { slug: "my-post", lang: "fr" });
  assert.equal(parseArticleName(config, "_index.fr.md"), undefined);
  assert.equal(parseArticleName(config, "my-post.de.md"), undefined);
  assert.equal(parseArticleName(config, "notes.md"), undefined);
});

test("hugoDate carries the local UTC offset", () => {
  assert.match(hugoDate(new Date()), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
});

test("createPost writes a draft and refuses to overwrite it", async () => {
  const { config } = fixture();
  const post = await createPost(config, "Un Nouveau Départ", "fr");
  assert.equal(post.path, "content/articles/un-nouveau-depart.fr.md");
  const meta = parseMeta(readFileSync(join(config.repoPath, post.path), "utf8"));
  assert.equal(meta.title, "Un Nouveau Départ");
  assert.equal(meta.draft, true);
  assert.equal(meta.translationKey, "un-nouveau-depart");
  await assert.rejects(createPost(config, "Un Nouveau Départ", "fr"), /already exists/);
});

test("listPosts returns the articles of the working tree, newest first", async () => {
  const { config } = fixture();
  await createPost(config, "Later", "en", new Date("2026-06-01T00:00:00Z"));
  const posts = await listPosts(config);
  assert.deepEqual(
    posts.map((post) => `${post.slug}.${post.lang}`),
    ["later.en", "first-steps.fr"],
  );
});
