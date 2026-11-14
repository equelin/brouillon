import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitSubject, draftBranch, GitError } from "../src/git.ts";
import { fixture, git, PUBLISHED } from "./helpers.ts";

test("draftBranch uses letters and underscores only, and keeps numbers apart", () => {
  assert.equal(draftBranch("réclamer-espace-libre"), "post_reclamer_espace_libre");
  assert.match(draftBranch("rhel-6-template"), /^[a-z]+(_[a-z]+)*$/);
  assert.notEqual(draftBranch("rhel-6-template"), draftBranch("rhel-7-template"));
  assert.equal(draftBranch("---"), "post");
});

test("commitSubject stays under 72 characters", () => {
  assert.equal(commitSubject("Add", "Short title"), "Add article Short title");
  assert.ok(commitSubject("Update", "x".repeat(200)).length < 72);
});

test("save keeps a draft branch at one commit and pushes it", async () => {
  const { config, repo, origin } = fixture();
  const file = join(config.repoPath, "content/articles/new-post.fr.md");
  const branch = draftBranch("new-post");

  assert.equal(await repo.save(branch, "Add article New post"), "unchanged");
  assert.equal(await repo.currentBranch(), "master");

  writeFileSync(file, "---\ntitle: New post\ndraft: true\n---\n\nFirst version.\n");
  assert.equal(await repo.save(branch, "Add article New post"), "saved");
  assert.equal(await repo.currentBranch(), branch);

  writeFileSync(file, "---\ntitle: New post\ndraft: true\n---\n\nSecond version.\n");
  assert.equal(await repo.save(branch, "Add article New post"), "saved");
  assert.equal(await repo.save(branch, "Add article New post"), "unchanged");

  assert.equal(git(config.repoPath, "rev-list", "--count", `origin/master..${branch}`), "1");
  assert.equal(git(origin, "rev-list", "--count", `master..${branch}`), "1");
  assert.match(git(origin, "show", `${branch}:content/articles/new-post.fr.md`), /Second version/);
  assert.equal(git(origin, "log", "-1", "--format=%s", branch), "Add article New post");
});

test("a draft on another branch is listed with its files and readable without checkout", async () => {
  const { config, repo } = fixture();
  const file = join(config.repoPath, "content/articles/new-post.fr.md");
  writeFileSync(file, "---\ntitle: New post\n---\n\nText.\n");
  await repo.save(draftBranch("new-post"), "Add article New post");
  await repo.open(draftBranch("first-steps"));

  assert.equal(await repo.currentBranch(), "master");
  assert.deepEqual(await repo.draftBranches(), ["post_new_post"]);
  assert.deepEqual(await repo.changedFiles("post_new_post"), ["content/articles/new-post.fr.md"]);
  assert.match(await repo.show("post_new_post", "content/articles/new-post.fr.md"), /New post/);
  assert.equal(await repo.existsUpstream("content/articles/new-post.fr.md"), false);
  assert.equal(await repo.existsUpstream("content/articles/first-steps.fr.md"), true);
});

test("publish puts the draft on the publish branch and removes the draft branch", async () => {
  const { config, repo, origin } = fixture();
  const branch = draftBranch("first-steps");
  writeFileSync(
    join(config.repoPath, "content/articles/first-steps.fr.md"),
    PUBLISHED.replace("An opening", "A better opening"),
  );
  await repo.save(branch, "Update article First steps");
  await repo.publish(branch);

  assert.equal(await repo.currentBranch(), "master");
  assert.match(
    git(origin, "show", "master:content/articles/first-steps.fr.md"),
    /A better opening/,
  );
  assert.equal(git(origin, "log", "-1", "--format=%s", "master"), "Update article First steps");
  assert.equal(git(origin, "rev-list", "--count", "master"), "2");
  assert.equal(git(origin, "branch", "--list", branch), "");
  assert.deepEqual(await repo.draftBranches(), []);
});

test("publish rebases the draft when the publish branch moved, and refuses without a draft", async () => {
  const { config, repo, origin } = fixture();
  await assert.rejects(repo.publish(draftBranch("first-steps")), GitError);

  writeFileSync(join(config.repoPath, "content/articles/other.fr.md"), "---\ntitle: Other\n---\n");
  await repo.save(draftBranch("other"), "Add article Other");
  const elsewhere = join(config.repoPath, "..", "elsewhere");
  git(join(config.repoPath, ".."), "clone", "--quiet", origin, elsewhere);
  git(elsewhere, "config", "user.name", "Test");
  git(elsewhere, "config", "user.email", "test@example.org");
  git(elsewhere, "config", "commit.gpgsign", "false");
  writeFileSync(join(elsewhere, "README.md"), "hello\n");
  git(elsewhere, "add", "--all");
  git(elsewhere, "commit", "--quiet", "-m", "Add readme");
  git(elsewhere, "push", "--quiet", "origin", "master");

  await repo.publish(draftBranch("other"));
  assert.equal(git(origin, "log", "--format=%s", "master"), "Add article Other\nAdd readme\nSeed");
});

test("isPushed tells a draft commit that never reached origin from one that did", async () => {
  const { config, repo } = fixture();
  const branch = draftBranch("offline");
  writeFileSync(
    join(config.repoPath, "content/articles/offline.fr.md"),
    "---\ntitle: Offline\n---\n",
  );
  git(
    config.repoPath,
    "remote",
    "set-url",
    "--push",
    "origin",
    join(config.repoPath, "..", "nowhere.git"),
  );
  assert.equal(await repo.save(branch, "Add article Offline"), "saved-locally");
  assert.equal(await repo.isPushed(branch), false);
  git(config.repoPath, "remote", "set-url", "--push", "origin", config.repoUrl);
  assert.equal(await repo.save(branch, "Add article Offline"), "saved");
  assert.equal(await repo.isPushed(branch), true);
});
