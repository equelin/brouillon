import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { composeDocument, type PostMeta, parseMeta } from "./frontmatter.ts";

export interface Post {
  slug: string;
  lang: string;
  /** Path relative to the repository root. */
  path: string;
  meta: PostMeta;
}

export function slugify(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function articlePath(config: Config, slug: string, lang: string): string {
  return `${config.articlesDir}/${slug}.${lang}.md`;
}

/** Slug and language of `<slug>.<lang>.md`, or undefined for any other file. */
export function parseArticleName(
  config: Config,
  name: string,
): { slug: string; lang: string } | undefined {
  const match = /^(.+)\.([a-z]{2})\.md$/.exec(name);
  if (!match || match[1] === "_index" || !config.languages.includes(match[2] as string)) {
    return undefined;
  }
  return { slug: match[1] as string, lang: match[2] as string };
}

export async function listPosts(config: Config): Promise<Post[]> {
  const directory = join(config.repoPath, config.articlesDir);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const posts: Post[] = [];
  for (const name of names) {
    const parsed = parseArticleName(config, name);
    if (!parsed) continue;
    const source = await readFile(join(directory, name), "utf8");
    let meta: PostMeta;
    try {
      meta = parseMeta(source);
    } catch {
      meta = { title: name, draft: false, description: "", tags: [] };
    }
    posts.push({ ...parsed, path: `${config.articlesDir}/${name}`, meta });
  }
  return posts.sort((a, b) => (b.meta.date ?? "").localeCompare(a.meta.date ?? ""));
}

/** Local time with its UTC offset, the form Hugo writes in new content. */
export function hugoDate(now: Date): string {
  const pad = (value: number) => String(Math.abs(value)).padStart(2, "0");
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`
  );
}

export async function createPost(
  config: Config,
  title: string,
  lang: string,
  now = new Date(),
): Promise<Post> {
  const slug = slugify(title);
  if (!slug) throw new Error("the title must contain at least one letter or digit");
  const path = articlePath(config, slug, lang);
  const meta: PostMeta = {
    title,
    date: hugoDate(now),
    draft: true,
    description: "",
    tags: [],
    translationKey: slug,
  };
  const source = composeDocument({ ...meta }, "");
  // "wx" refuses to overwrite an article that already exists under this slug.
  await writeFile(join(config.repoPath, path), source, { flag: "wx" }).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${path} already exists`);
    }
    throw error;
  });
  return { slug, lang, path, meta };
}
