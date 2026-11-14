import { Document, isMap, parseDocument } from "yaml";

export type FrontMatterFormat = "yaml" | "json" | "none";

export interface SplitDocument {
  format: FrontMatterFormat;
  /** Front matter without its delimiters; for JSON, the object including its braces. */
  raw: string;
  /** Everything after the front matter. */
  body: string;
}

export interface PostMeta {
  title: string;
  date?: string;
  /** Hugo publishes a page unless `draft` is true. */
  draft: boolean;
  description: string;
  tags: string[];
  translationKey?: string;
  slug?: string;
}

type Fields = Record<string, unknown>;

export function splitFrontMatter(source: string): SplitDocument {
  if (source.startsWith("+++")) {
    throw new Error("TOML front matter is not supported; use YAML (---) or JSON ({})");
  }
  if (/^---\r?\n/.test(source)) {
    const closing = /\r?\n---[ \t]*(\r?\n|$)/.exec(source.slice(3));
    if (!closing) throw new Error("front matter opened with --- is never closed");
    const start = source.indexOf("\n") + 1;
    const end = 3 + closing.index;
    return {
      format: "yaml",
      raw: source.slice(start, Math.max(start, end)),
      body: source.slice(end + closing[0].length),
    };
  }
  if (source.startsWith("{")) {
    const end = jsonObjectEnd(source);
    if (end === -1) throw new Error("JSON front matter is never closed");
    return {
      format: "json",
      raw: source.slice(0, end),
      body: source.slice(end).replace(/^[ \t]*\r?\n/, ""),
    };
  }
  return { format: "none", raw: "", body: source };
}

/** Index just past the brace closing the object that opens at index 0, or -1. */
function jsonObjectEnd(source: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (inString) {
      if (char === "\\") i++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function readFields(split: SplitDocument): Fields {
  if (split.format === "none") return {};
  if (split.format === "json") return JSON.parse(split.raw) as Fields;
  const document = parseDocument(split.raw);
  if (document.errors.length > 0) {
    throw new Error(`invalid YAML front matter: ${document.errors[0]?.message}`);
  }
  const value: unknown = document.toJS();
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("front matter must be a mapping");
  }
  return value as Fields;
}

export function parseMeta(source: string): PostMeta {
  const fields = readFields(splitFrontMatter(source));
  const text = (value: unknown): string | undefined =>
    typeof value === "string" ? value : value instanceof Date ? value.toISOString() : undefined;
  return {
    title: text(fields.title) ?? "",
    date: text(fields.date),
    draft: fields.draft === true,
    description: text(fields.description) ?? "",
    tags: Array.isArray(fields.tags) ? fields.tags.map(String) : [],
    translationKey: text(fields.translationKey),
    slug: text(fields.slug),
  };
}

/**
 * Set front matter fields, leaving the rest of the document as written; a
 * field set to undefined is removed. A document without front matter gets a
 * YAML one.
 */
export function setFields(source: string, fields: Fields): string {
  const split = splitFrontMatter(source);
  if (split.format === "json") {
    const merged = { ...(JSON.parse(split.raw) as Fields), ...fields };
    return `${JSON.stringify(merged, null, 2)}\n\n${split.body.replace(/^\r?\n/, "")}`;
  }
  const parsed = parseDocument(split.raw);
  if (parsed.errors.length > 0) {
    throw new Error(`invalid YAML front matter: ${parsed.errors[0]?.message}`);
  }
  const document = isMap(parsed.contents) ? parsed : new Document({});
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) document.delete(key);
    else document.set(key, value);
  }
  return `---\n${document.toString({ lineWidth: 0 })}---\n${split.body}`;
}

/** The same front matter in front of another body. */
export function withBody(source: string, body: string): string {
  const split = splitFrontMatter(source);
  const head = source.slice(0, source.length - split.body.length);
  return `${head.trimEnd()}\n\n${body.replace(/^\s+/, "")}`;
}

export function composeDocument(fields: Fields, body: string): string {
  const document = new Document(fields);
  return `---\n${document.toString({ lineWidth: 0 })}---\n\n${body.replace(/^\s+/, "")}`;
}

/** Words of the body, ignoring front matter, code blocks and markdown punctuation. */
export function countWords(source: string): number {
  let body: string;
  try {
    body = splitFrontMatter(source).body;
  } catch {
    body = source;
  }
  const prose = body.replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, " ");
  return prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}
