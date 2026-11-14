import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, defaultConfig } from "../src/config.ts";
import { Repo } from "../src/git.ts";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export const PUBLISHED = `---
title: First steps
date: 2026-01-10T09:00:00+01:00
draft: false
description: Where it all starts.
tags: [linux]
translationKey: first-steps
---

An opening paragraph that is
spread over two lines.

## Second part

One sentence here. Another sentence follows it. A third one ends the paragraph.
`;

/** A bare origin with one published article, and a clone of it that never signs commits. */
export function fixture(): { config: Config; repo: Repo; origin: string } {
  const root = mkdtempSync(join(tmpdir(), "brouillon-test-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=master", origin]);
  execFileSync("git", ["init", "--quiet", "--initial-branch=master", seed]);
  for (const cwd of [seed]) {
    git(cwd, "config", "user.name", "Test");
    git(cwd, "config", "user.email", "test@example.org");
    git(cwd, "config", "commit.gpgsign", "false");
  }
  mkdirSync(join(seed, "content", "articles"), { recursive: true });
  mkdirSync(join(seed, "static"));
  writeFileSync(join(seed, "static", ".keep"), "");
  writeFileSync(join(seed, "content", "articles", "first-steps.fr.md"), PUBLISHED);
  git(seed, "add", "--all");
  git(seed, "commit", "--quiet", "-m", "Seed");
  git(seed, "push", "--quiet", origin, "master");
  execFileSync("git", ["clone", "--quiet", origin, clone]);
  git(clone, "config", "user.name", "Test");
  git(clone, "config", "user.email", "test@example.org");
  git(clone, "config", "commit.gpgsign", "false");
  const config: Config = {
    ...defaultConfig(origin),
    repoPath: clone,
    publishBranch: "master",
    articlesDir: "content/articles",
    languages: ["fr", "en"],
    blogName: "The test blog",
    blogDescription: "testing things",
  };
  return { config, repo: new Repo(clone, "master", ["content/articles", "static"]), origin };
}
