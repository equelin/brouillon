import type { AgentTool } from "@earendil-works/pi-agent-core";
import { arr, obj, str } from "@earendil-works/pi-schema";

/** What the coach may see and do. Every method that changes something is listed here. */
export interface Workspace {
  /** The open article, or undefined when none is open. */
  article(): { path: string; lang: string; text: string } | undefined;
  listPosts(): Promise<
    { slug: string; lang: string; title: string; date?: string; draft: boolean }[]
  >;
  readPost(slug: string, lang: string): Promise<string>;
  addComment(quote: string, note: string): void;
  addSuggestion(original: string, alternatives: string[], reason: string): void;
  /** Target language of the translation the author asked for, if one is pending. */
  pendingTranslation(): string | undefined;
  /** Write the translation next to the article; returns the path written. */
  writeTranslation(title: string, description: string, body: string): Promise<string>;
}

export const SUGGEST_MAX_ORIGINAL = 600;
export const COMMENT_MAX_NOTE = 400;

const text = (value: string) => ({
  content: [{ type: "text" as const, text: value }],
  details: undefined,
});

function openArticle(workspace: Workspace) {
  const article = workspace.article();
  if (!article) throw new Error("No article is open. Ask the author to open or create one.");
  return article;
}

/** Collapse whitespace so a quote matches across the author's line breaks. */
function locate(haystack: string, quote: string): string | undefined {
  if (haystack.includes(quote)) return quote;
  const pattern = quote
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  if (!pattern) return undefined;
  return new RegExp(pattern).exec(haystack)?.[0];
}

export function coachTools(workspace: Workspace): AgentTool[] {
  const readArticle: AgentTool = {
    name: "read_article",
    label: "Read article",
    description: "Read the article being written, front matter included, with line numbers.",
    parameters: obj({}),
    execute: async () => {
      const article = openArticle(workspace);
      const numbered = article.text
        .split("\n")
        .map((line, index) => `${String(index + 1).padStart(4)}  ${line}`)
        .join("\n");
      return text(`${article.path} (${article.lang})\n\n${numbered}`);
    },
  };

  const listPosts: AgentTool = {
    name: "list_posts",
    label: "List posts",
    description: "List the articles of the blog: slug, language, date, title, draft status.",
    parameters: obj({}),
    execute: async () => {
      const posts = await workspace.listPosts();
      if (posts.length === 0) return text("The blog has no articles yet.");
      return text(
        posts
          .map(
            (post) =>
              `${post.slug} [${post.lang}] ${post.date?.slice(0, 10) ?? "undated"}${post.draft ? " (draft)" : ""}: ${post.title}`,
          )
          .join("\n"),
      );
    },
  };

  const readPostParameters = obj({
    slug: str({ description: "Slug of the article, as list_posts reports it" }),
    lang: str({ description: "Language code, as list_posts reports it" }),
  });
  const readPost: AgentTool<typeof readPostParameters> = {
    name: "read_post",
    label: "Read post",
    description: "Read another article of the blog, as a reference for the author's voice.",
    parameters: readPostParameters,
    execute: async (_id, params) => text(await workspace.readPost(params.slug, params.lang)),
  };

  const commentParameters = obj({
    quote: str({
      description: "Exact words from the article the note is about, one sentence at most",
    }),
    note: str({
      description: "The problem and why a reader stumbles on it. Not the rewritten text.",
    }),
  });
  const comment: AgentTool<typeof commentParameters> = {
    name: "comment",
    label: "Comment",
    description:
      "Attach a note to a passage of the article. The author sees it next to the text. Use it for problems, not for rewrites.",
    parameters: commentParameters,
    execute: async (_id, params) => {
      const article = openArticle(workspace);
      const quote = locate(article.text, params.quote);
      if (!quote)
        throw new Error("The quote is not in the article. Quote the article's exact words.");
      if (params.note.length > COMMENT_MAX_NOTE) {
        throw new Error(
          `A note is at most ${COMMENT_MAX_NOTE} characters: name the problem, not the fix.`,
        );
      }
      workspace.addComment(quote, params.note.trim());
      return text("Note attached.");
    },
  };

  const suggestParameters = obj({
    original: str({
      description: "Exact passage from the article: a sentence, or a few within one paragraph",
    }),
    alternatives: arr(str(), { description: "Two or three alternative phrasings of that passage" }),
    reason: str({ description: "One sentence: what the alternatives improve" }),
  });
  const suggest: AgentTool<typeof suggestParameters> = {
    name: "suggest",
    label: "Suggest",
    description:
      "Offer alternative phrasings of a passage the author wrote. The author picks one or none; nothing changes without them.",
    parameters: suggestParameters,
    execute: async (_id, params) => {
      const article = openArticle(workspace);
      const original = locate(article.text, params.original);
      if (!original) {
        throw new Error(
          "The original passage is not in the article. Quote the article's exact words.",
        );
      }
      if (article.text.indexOf(original, article.text.indexOf(original) + 1) !== -1) {
        throw new Error("That passage appears more than once. Quote enough of it to be unique.");
      }
      if (original.length > SUGGEST_MAX_ORIGINAL || /\n\s*\n/.test(original)) {
        throw new Error(
          `Suggestions work on a passage within one paragraph, at most ${SUGGEST_MAX_ORIGINAL} characters. Narrow it down.`,
        );
      }
      const alternatives = params.alternatives
        .map((alternative) => alternative.trim())
        .filter(Boolean);
      if (alternatives.length < 2 || alternatives.length > 3) {
        throw new Error("Give two or three alternatives.");
      }
      const limit = Math.max(original.length * 2, original.length + 120);
      if (
        alternatives.some(
          (alternative) => alternative.length > limit || /\n\s*\n/.test(alternative),
        )
      ) {
        throw new Error(
          "An alternative rephrases the passage; it must not add paragraphs or double its length.",
        );
      }
      workspace.addSuggestion(original, alternatives, params.reason.trim());
      return text("Alternatives shown to the author, who decides.");
    },
  };

  const translationParameters = obj({
    title: str({ description: "Translated title" }),
    description: str({ description: "Translated description; empty when the article has none" }),
    body: str({ description: "Translated markdown body, without front matter" }),
  });
  const writeTranslation: AgentTool<typeof translationParameters> = {
    name: "write_translation",
    label: "Write translation",
    description:
      "Save the translation of the article in the language the author asked for. Only available after the author requested a translation.",
    parameters: translationParameters,
    execute: async (_id, params) => {
      if (!workspace.pendingTranslation()) {
        throw new Error(
          "The author has not asked for a translation. They request one from the command palette.",
        );
      }
      const path = await workspace.writeTranslation(params.title, params.description, params.body);
      return text(`Translation saved to ${path}.`);
    },
  };

  return [readArticle, listPosts, readPost, comment, suggest, writeTranslation];
}
