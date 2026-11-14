import { BLOG_DEFAULTS, type BlogSettings, repoName } from "./config.ts";

export interface SetupTerminal {
  /** Ask one question; resolves with the answer as typed, possibly empty. */
  ask(question: string): Promise<string>;
  say(line: string): void;
}

/**
 * Ask what brouillon cannot guess about a blog. `current` gives the suggested answers when
 * the blog is set up again; `defaultBranch` looks up the branch a repository publishes from.
 */
export async function askBlogSettings(
  terminal: SetupTerminal,
  defaultBranch: (repoUrl: string) => Promise<string | undefined>,
  current?: BlogSettings,
): Promise<BlogSettings> {
  const answer = async (question: string, suggested: string) => {
    const typed = (
      await terminal.ask(suggested ? `${question} [${suggested}]: ` : `${question}: `)
    ).trim();
    return typed || suggested;
  };

  terminal.say(
    "brouillon needs to know which blog you write for. Enter keeps the value in brackets.",
  );
  terminal.say("");
  let repoUrl = "";
  while (!repoUrl) {
    repoUrl = await answer(
      "Git URL of the blog repository (you need push access)",
      current?.repoUrl ?? "",
    );
  }
  const sameRepo = repoUrl === current?.repoUrl;
  const branch =
    (sameRepo && current?.publishBranch) ||
    (await defaultBranch(repoUrl)) ||
    BLOG_DEFAULTS.publishBranch;
  const publishBranch = await answer("Branch whose pushes publish the site", branch);
  const articlesDir = (
    await answer(
      "Directory of the articles in the repository",
      current?.articlesDir ?? BLOG_DEFAULTS.articlesDir,
    )
  ).replace(/^\/+|\/+$/g, "");
  const languages = (
    await answer(
      "Languages of the site, the default one first",
      (current?.languages ?? BLOG_DEFAULTS.languages).join(" "),
    )
  )
    .split(/[\s,]+/)
    .filter(Boolean);
  const blogName = await answer(
    "Name of the blog",
    (sameRepo && current?.blogName) || repoName(repoUrl),
  );
  terminal.say("");
  terminal.say("The writing coach adapts to the blog's subject and readers.");
  const blogDescription = await answer(
    "What the blog is about, in a few words",
    current?.blogDescription ?? "",
  );
  return { repoUrl, publishBranch, articlesDir, languages, blogName, blogDescription };
}
