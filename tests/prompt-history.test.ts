import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PromptHistory } from "../src/ui/prompt-history.ts";

test("messages are recalled newest first and survive a restart", () => {
  const path = join(mkdtempSync(join(tmpdir(), "brouillon-history-")), "nested", "history.json");
  const history = new PromptHistory(path);
  history.add("first");
  history.add("second");
  history.add("second");
  assert.equal(history.length, 2);
  assert.equal(history.at(0), "second");
  assert.equal(history.at(1), "first");
  assert.equal(history.at(2), undefined);

  const reopened = new PromptHistory(path);
  assert.equal(reopened.at(0), "second");
  assert.equal(reopened.length, 2);
});

test("an unreadable history file starts an empty history", () => {
  const path = join(mkdtempSync(join(tmpdir(), "brouillon-history-")), "history.json");
  writeFileSync(path, "not json");
  assert.equal(new PromptHistory(path).length, 0);
});
