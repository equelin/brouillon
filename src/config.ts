import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface Config {
  /** Local clone of the blog repository. */
  repoPath: string;
  /** Remote the clone is created from when repoPath does not exist yet. */
  repoUrl: string;
  /** Branch whose pushes deploy the site. */
  publishBranch: string;
  /** Directory of the articles, relative to repoPath. */
  articlesDir: string;
  /** Languages of the site; the first one is the default for new articles. */
  languages: string[];
  provider: string;
  /** Model id; when unavailable, the first available model of the provider is used. */
  model: string;
  thinkingLevel: ThinkingLevel;
  /** External editor command; falls back to $VISUAL, $EDITOR, then vi. */
  editor?: string;
  /** Arguments passed to `hugo` for the local preview. */
  previewArgs: string[];
}

export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "brouillon");
}

export function dataDir(): string {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "brouillon");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function authPath(): string {
  return join(configDir(), "auth.json");
}

/**
 * Stable identifier of this installation, created on first use. Sign in with
 * ChatGPT requires one and expects the same value at every login.
 */
export function deviceId(): string {
  const path = join(configDir(), "device-id");
  try {
    return readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const id = randomUUID();
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${id}\n`, { mode: 0o600 });
  return id;
}

export function defaultConfig(): Config {
  return {
    repoPath: join(dataDir(), "equelin.github.io"),
    repoUrl: "git@github.com:equelin/equelin.github.io.git",
    publishBranch: "master",
    articlesDir: "content/articles",
    languages: ["fr", "en"],
    provider: "openai",
    model: "gpt-5.5",
    thinkingLevel: "low",
    previewArgs: ["server", "--buildDrafts"],
  };
}

export async function loadConfig(path = configPath()): Promise<Config> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const config = { ...defaultConfig(), ...(parsed as Partial<Config>) };
  if (!Array.isArray(config.languages) || config.languages.length === 0) {
    throw new Error(`${path}: "languages" must list at least one language`);
  }
  return config;
}
