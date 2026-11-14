import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export class GitError extends Error {}

/** The signing key needs its passphrase; nothing was committed. */
export class SigningLockedError extends GitError {
  readonly key: string | undefined;

  constructor(key: string | undefined) {
    super("the commit signing key is locked");
    this.key = key;
  }
}

const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/**
 * Branch of an article draft: letters separated by underscores. Digits are
 * spelled out so that slugs differing only by a number keep distinct branches.
 */
export function draftBranch(slug: string): string {
  const words = slug
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[0-9]/g, (digit) => `_${DIGITS[Number(digit)]}_`)
    .replace(/[^a-z]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return words ? `post_${words}` : "post";
}

export function commitSubject(verb: "Add" | "Update", title: string): string {
  const subject = `${verb} article ${title.trim() || "untitled"}`;
  return subject.length <= 71 ? subject : `${subject.slice(0, 70).trimEnd()}…`;
}

interface RunOptions {
  /** Return stdout even when git exits with one of these codes. */
  allow?: number[];
  input?: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // A credential or passphrase prompt would hang behind the full-screen UI.
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
    GIT_EDITOR: "true",
  };
}

function exec(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      { cwd: options.cwd, env: options.env, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === "string") {
          reject(new GitError(`cannot run ${command}: ${error.message}`));
          return;
        }
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
        });
      },
    );
    // A command that exits without reading its input would otherwise raise EPIPE.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });
}

export class Repo {
  readonly path: string;
  readonly publishBranch: string;
  private readonly contentPaths: string[];

  constructor(path: string, publishBranch: string, contentPaths: string[]) {
    this.path = path;
    this.publishBranch = publishBranch;
    this.contentPaths = contentPaths;
  }

  static async clone(url: string, path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const result = await exec("git", ["clone", "--quiet", url, path], { env: gitEnv() });
    if (result.code !== 0) throw new GitError(`git clone failed: ${result.stderr.trim()}`);
  }

  async run(args: string[], options: RunOptions = {}): Promise<string> {
    const result = await exec("git", args, {
      cwd: this.path,
      env: gitEnv(),
      input: options.input,
    });
    if (result.code !== 0 && !options.allow?.includes(result.code)) {
      const detail = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-3).join(" ");
      throw new GitError(`git ${args[0]} failed: ${detail}`);
    }
    return result.stdout;
  }

  private async succeeds(args: string[]): Promise<boolean> {
    const result = await exec("git", args, { cwd: this.path, env: gitEnv() });
    return result.code === 0;
  }

  async currentBranch(): Promise<string> {
    return (await this.run(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  }

  private upstream(): string {
    return `origin/${this.publishBranch}`;
  }

  /** Whether tracked content differs from HEAD or untracked content exists. */
  async isDirty(): Promise<boolean> {
    const status = await this.run(["status", "--porcelain", "--", ...this.contentPaths]);
    return status.trim() !== "";
  }

  /** Whether origin holds the current commit of a draft branch that is checked out. */
  async isPushed(branch: string): Promise<boolean> {
    if ((await this.currentBranch()) !== branch) return true;
    const refs = await this.run(["rev-parse", "HEAD", `refs/remotes/origin/${branch}`], {
      allow: [128],
    });
    const [head, remote] = refs.trim().split("\n");
    return head !== undefined && head === remote;
  }

  /** Fetch from origin; returns false when the remote cannot be reached. */
  async fetch(): Promise<boolean> {
    return this.succeeds(["fetch", "--quiet", "--prune", "origin"]);
  }

  private hasRef(ref: string): Promise<boolean> {
    return this.succeeds(["show-ref", "--verify", "--quiet", ref]);
  }

  /** Draft branches, local or on origin, without duplicates. */
  async draftBranches(): Promise<string[]> {
    const refs = await this.run([
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads/post_*",
      "refs/remotes/origin/post_*",
    ]);
    const names = refs
      .split("\n")
      .filter(Boolean)
      .map((ref) => ref.replace(/^refs\/(heads|remotes\/origin)\//, ""));
    return [...new Set(names)].sort();
  }

  /** The local draft branch when it exists, its copy on origin otherwise. */
  private async draftRef(branch: string): Promise<string> {
    return (await this.hasRef(`refs/heads/${branch}`)) ? branch : `origin/${branch}`;
  }

  /** Content of a file as a draft branch has it. */
  async show(branch: string, path: string): Promise<string> {
    return this.run(["show", `${await this.draftRef(branch)}:${path}`]);
  }

  /** Whether the publish branch on origin already has this file. */
  existsUpstream(path: string): Promise<boolean> {
    return this.succeeds(["cat-file", "-e", `${this.upstream()}:${path}`]);
  }

  /** Article files a draft branch changes relative to the publish branch. */
  async changedFiles(branch: string): Promise<string[]> {
    const ref = await this.draftRef(branch);
    const names = await this.run([
      "diff",
      "--name-only",
      "-z",
      `${this.upstream()}...${ref}`,
      "--",
      ...this.contentPaths,
    ]);
    return names.split("\0").filter(Boolean);
  }

  /**
   * Check out the draft branch of an article when one exists, the publish
   * branch otherwise. The draft branch itself is only created by `save`.
   */
  async open(branch: string): Promise<void> {
    if ((await this.currentBranch()) === branch) return;
    if (await this.hasRef(`refs/heads/${branch}`)) {
      await this.run(["checkout", "--quiet", branch]);
    } else if (await this.hasRef(`refs/remotes/origin/${branch}`)) {
      await this.run(["checkout", "--quiet", "-b", branch, "--track", `origin/${branch}`]);
    } else {
      await this.run(["checkout", "--quiet", this.publishBranch]);
      // Fails when the local publish branch has diverged; `publish` reports that.
      await this.succeeds(["merge", "--quiet", "--ff-only", this.upstream()]);
    }
  }

  /**
   * Fail with SigningLockedError when commits are signed with an OpenPGP key
   * that would need a passphrase prompt, which cannot be shown from here.
   */
  async assertSigningReady(): Promise<void> {
    const signs = (
      await this.run(["config", "--type=bool", "--get", "commit.gpgsign"], { allow: [1] })
    ).trim();
    if (signs !== "true") return;
    const format = (await this.run(["config", "--get", "gpg.format"], { allow: [1] })).trim();
    if (format && format !== "openpgp") return;
    const key = (await this.run(["config", "--get", "user.signingkey"], { allow: [1] })).trim();
    const program = (await this.run(["config", "--get", "gpg.program"], { allow: [1] })).trim();
    const args = ["--batch", "--pinentry-mode", "error", ...(key ? ["-u", key] : []), "--sign"];
    const result = await exec(program || "gpg", args, { input: "\n" });
    if (result.code !== 0) throw new SigningLockedError(key || undefined);
  }

  /**
   * Record the content as the single commit of the draft branch and push it.
   * Returns "unchanged" when the branch already holds exactly this content.
   */
  async save(branch: string, subject: string): Promise<"saved" | "saved-locally" | "unchanged"> {
    const current = await this.currentBranch();
    if (current === this.publishBranch) {
      if (!(await this.isDirty())) return "unchanged";
      await this.run(["checkout", "--quiet", "-b", branch]);
    } else if (current !== branch) {
      throw new GitError(`expected to be on ${branch}, but the repository is on ${current}`);
    }

    await this.run(["add", "--all", "--", ...this.contentPaths]);
    const base = (await this.run(["merge-base", this.upstream(), "HEAD"])).trim();
    const staged = !(await this.succeeds(["diff", "--cached", "--quiet", base]));
    if (!staged) return "unchanged";

    const head = (await this.run(["rev-parse", "HEAD"])).trim();
    const sameTree = await this.succeeds(["diff", "--cached", "--quiet", "HEAD"]);
    const sameSubject = (await this.run(["log", "-1", "--format=%s"])).trim() === subject;
    if (head !== base && sameTree && sameSubject) {
      const remote = await this.run(["rev-parse", "--verify", "--quiet", `origin/${branch}`], {
        allow: [1],
      });
      if (remote.trim() === head) return "unchanged";
    } else {
      await this.assertSigningReady();
      // Rebuilding from the merge base keeps the branch at exactly one commit.
      await this.run(["reset", "--quiet", "--soft", base]);
      await this.run(["commit", "--quiet", "-m", subject]);
    }

    const pushed = await this.succeeds([
      "push",
      "--quiet",
      "--force-with-lease",
      "--set-upstream",
      "origin",
      branch,
    ]);
    return pushed ? "saved" : "saved-locally";
  }

  /**
   * Put the draft branch's commit on top of the publish branch, push it,
   * which deploys the site, and delete the draft branch.
   */
  async publish(branch: string): Promise<void> {
    if ((await this.currentBranch()) !== branch) {
      throw new GitError(`nothing to publish: there is no draft on ${branch}`);
    }
    if (await this.isDirty()) throw new GitError("save the article before publishing");
    if (!(await this.fetch())) throw new GitError("cannot reach origin");
    await this.assertSigningReady();

    try {
      await this.run(["rebase", "--quiet", this.upstream()]);
    } catch (error) {
      await this.succeeds(["rebase", "--abort"]);
      throw new GitError(
        `the draft conflicts with ${this.upstream()}; rebase ${branch} by hand (${(error as Error).message})`,
      );
    }
    await this.run(["checkout", "--quiet", this.publishBranch]);
    try {
      await this.run(["merge", "--quiet", "--ff-only", this.upstream()]);
      await this.run(["merge", "--quiet", "--ff-only", branch]);
      await this.run(["push", "--quiet", "origin", this.publishBranch]);
    } catch (error) {
      await this.run(["checkout", "--quiet", branch]);
      throw error;
    }
    await this.run(["branch", "--quiet", "-D", branch]);
    await this.succeeds(["push", "--quiet", "origin", "--delete", branch]);
  }
}

/** Run a command on the user's terminal; resolves with its exit code. */
export function runInteractive(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}
