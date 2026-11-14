import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composeDocument,
  countWords,
  parseMeta,
  setFields,
  splitFrontMatter,
  withBody,
} from "../src/frontmatter.ts";

const YAML = `---
title: 'Hello there'
date: '2026-11-14T10:00:00+01:00'
draft: true
description: ''
tags: []
# Use the same translationKey in the French and English versions.
translationKey: 'hello-there'
---
Body text.
`;

const JSON_DOC = `{
  "title": "Déplacer des données",
  "date": "2015-11-23T12:00:00+01:00",
  "tags": ["Linux", "LVM"],
  "note": "a } brace in a string"
}

Corps de l'article.
`;

test("YAML front matter is split from the body and parsed", () => {
  const split = splitFrontMatter(YAML);
  assert.equal(split.format, "yaml");
  assert.equal(split.body, "Body text.\n");
  assert.deepEqual(parseMeta(YAML), {
    title: "Hello there",
    date: "2026-11-14T10:00:00+01:00",
    draft: true,
    description: "",
    tags: [],
    translationKey: "hello-there",
    slug: undefined,
  });
});

test("JSON front matter is parsed, and a missing draft field means published", () => {
  const split = splitFrontMatter(JSON_DOC);
  assert.equal(split.format, "json");
  assert.equal(split.body, "\nCorps de l'article.\n");
  const meta = parseMeta(JSON_DOC);
  assert.equal(meta.title, "Déplacer des données");
  assert.equal(meta.draft, false);
  assert.deepEqual(meta.tags, ["Linux", "LVM"]);
});

test("a document without front matter is all body", () => {
  assert.deepEqual(splitFrontMatter("Just text\n"), {
    format: "none",
    raw: "",
    body: "Just text\n",
  });
  assert.equal(parseMeta("Just text\n").draft, false);
});

test("TOML and unclosed front matter are refused", () => {
  assert.throws(() => splitFrontMatter("+++\ntitle = 'x'\n+++\n"), /TOML/);
  assert.throws(() => splitFrontMatter("---\ntitle: x\n"), /never closed/);
});

test("setFields changes only the named YAML fields and keeps comments and body", () => {
  const updated = setFields(YAML, { draft: false, description: "New" });
  assert.equal(parseMeta(updated).draft, false);
  assert.equal(parseMeta(updated).description, "New");
  assert.ok(updated.includes("# Use the same translationKey"));
  assert.ok(updated.includes("title: 'Hello there'"));
  assert.ok(updated.endsWith("---\nBody text.\n"));
});

test("setFields rewrites JSON front matter as JSON", () => {
  const updated = setFields(JSON_DOC, { draft: true });
  assert.equal(splitFrontMatter(updated).format, "json");
  assert.equal(parseMeta(updated).draft, true);
  assert.ok(updated.endsWith("}\n\nCorps de l'article.\n"));
});

test("composeDocument builds front matter even when the body starts like front matter", () => {
  const source = composeDocument(
    { title: "T", draft: true, tags: ["a"] },
    "---\n\nAfter a rule.\n",
  );
  assert.equal(parseMeta(source).title, "T");
  assert.equal(splitFrontMatter(source).body, "\n---\n\nAfter a rule.\n");
});

test("countWords ignores front matter and code blocks", () => {
  const source = `${YAML}\nDeux mots, c'est tout.\n\n\`\`\`sh\nls -la /tmp\n\`\`\`\n`;
  assert.equal(countWords(source), 2 + 4);
});

test("setFields removes a field set to undefined, in YAML and in JSON", () => {
  assert.ok(!setFields(YAML, { translationKey: undefined }).includes("translationKey:"));
  assert.ok(!setFields(JSON_DOC, { note: undefined }).includes('"note"'));
});

test("withBody keeps the front matter as written and swaps the body", () => {
  assert.equal(withBody(YAML, "\nNew body.\n"), YAML.replace("Body text.\n", "\nNew body.\n"));
  assert.equal(splitFrontMatter(withBody(JSON_DOC, "Corps.\n")).body, "\nCorps.\n");
  assert.equal(parseMeta(withBody(JSON_DOC, "Corps.\n")).title, "Déplacer des données");
});
