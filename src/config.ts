import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * "dark" and "light" use Charm's charmtone palette in 24-bit color; "ansi" keeps to the
 * terminal's own 16 colors, so it follows any terminal theme; "plain" uses no color at all.
 */
export const THEMES = ["dark", "light", "ansi", "plain"] as const;
export type ThemeName = (typeof THEMES)[number];

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

/** What brouillon has to be told about a blog; the first start asks for it. */
export interface BlogSettings {
  /** Remote the clone is created from when repoPath does not exist yet. */
  repoUrl: string;
  /** Branch whose pushes deploy the site. */
  publishBranch: string;
  /** Directory of the articles, relative to repoPath. */
  articlesDir: string;
  /** Languages of the site; the first one is the default for new articles. */
  languages: string[];
  /** Name of the blog and what it is about, as the coach is told. */
  blogName: string;
  blogDescription: string;
}

export interface Config extends BlogSettings {
  /** Local clone of the blog repository. */
  repoPath: string;
  provider: string;
  /** Model id; when unavailable, the first available model of the provider is used. */
  model: string;
  thinkingLevel: ThinkingLevel;
  /** Colors of the interface; "auto" picks one from what the terminal reports. */
  theme: ThemeName | "auto";
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

/** Last part of a repository URL or path, without ".git": the name of its clone. */
export function repoName(repoUrl: string): string {
  return (
    basename(
      repoUrl
        .replace(/[/:]+$/, "")
        .replace(/\.git$/, "")
        .replace(/:/g, "/"),
    ) || "blog"
  );
}

export const DEFAULT_PROVIDER = "openai";

/** What the first start suggests for a blog, and what a configuration without the key gets. */
export const BLOG_DEFAULTS = {
  publishBranch: "main",
  articlesDir: "content/posts",
  languages: ["en"],
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function defaultConfig(repoUrl: string): Config {
  const name = repoName(repoUrl);
  return {
    repoPath: join(dataDir(), name),
    repoUrl,
    ...BLOG_DEFAULTS,
    blogName: name,
    blogDescription: "",
    provider: DEFAULT_PROVIDER,
    model: "gpt-6.1-sol",
    thinkingLevel: "low",
    theme: "auto",
    previewArgs: ["server", "--buildDrafts"],
  };
}

/** The configuration, or undefined when no blog has been set up yet. */
export async function loadConfig(path = configPath()): Promise<Config | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  if (!isJsonObject(parsed)) throw new Error(`${path} must contain a JSON object`);
  const { repoUrl } = parsed as Partial<Config>;
  if (repoUrl === undefined) return undefined;
  if (typeof repoUrl !== "string" || repoUrl === "") {
    throw new Error(`${path}: "repoUrl" must be the URL of the blog repository`);
  }
  const config = { ...defaultConfig(repoUrl), ...(parsed as Partial<Config>) };
  if (!Array.isArray(config.languages) || config.languages.length === 0) {
    throw new Error(`${path}: "languages" must list at least one language`);
  }
  if (config.theme !== "auto" && !THEMES.includes(config.theme)) {
    throw new Error(`${path}: "theme" must be auto, ${THEMES.join(", ")}`);
  }
  return config;
}

/** Write the blog's settings, keeping whatever else the file already sets. */
export async function saveBlogSettings(settings: BlogSettings, path = configPath()): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isJsonObject(parsed)) existing = parsed;
  } catch {
    // No file yet, or one that cannot be read as JSON: the settings start a new one.
  }
  // A clone path set for another repository would keep brouillon working on the old blog.
  if (existing.repoUrl !== settings.repoUrl) delete existing.repoPath;
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ ...existing, ...settings }, null, 2)}\n`);
}
