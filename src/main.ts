#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { createCoachModels, loginOnTerminal } from "./agent/models.ts";
import {
  authPath,
  type Config,
  configPath,
  DEFAULT_PROVIDER,
  dataDir,
  loadConfig,
  saveBlogSettings,
} from "./config.ts";
import { FileCredentialStore } from "./credentials.ts";
import { Repo, remoteDefaultBranch } from "./git.ts";
import { askBlogSettings } from "./setup.ts";
import { App } from "./ui/app.ts";
import { chooseTheme, setTheme } from "./ui/theme.ts";

const USAGE = `brouillon: write and publish articles with a writing coach

Usage:
  brouillon          open the writing desk
  brouillon setup    choose the blog to write for, or change its settings
  brouillon login    sign in to the coach's model provider
  brouillon --help   show this help

Configuration: ${configPath()}`;

/** Ask for the blog on the terminal, save the answers and return the configuration they give. */
async function setUpBlog(current: Config | undefined): Promise<Config> {
  if (!process.stdin.isTTY) {
    throw new Error(
      `the questions about your blog need a terminal: run brouillon in one, or write ${configPath()}`,
    );
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const terminal = { ask: (question: string) => readline.question(question), say: console.log };
    await saveBlogSettings(await askBlogSettings(terminal, remoteDefaultBranch, current));
  } finally {
    readline.close();
  }
  const config = await loadConfig();
  if (!config) throw new Error(`${configPath()} could not be read back`);
  console.log(`\nSaved to ${configPath()}.`);
  return config;
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (command !== undefined && command !== "login" && command !== "setup") {
    console.error(`unknown command "${command}"\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const saved = await loadConfig();
  const models = createCoachModels(new FileCredentialStore(authPath()));
  if (command === "login") {
    await loginOnTerminal(models, saved?.provider ?? DEFAULT_PROVIDER);
    console.log("Signed in.");
    return;
  }
  const config = saved && command !== "setup" ? saved : await setUpBlog(saved);
  if (command === "setup") return;

  if (!existsSync(config.repoPath)) {
    console.log(`Cloning ${config.repoUrl} into ${config.repoPath}…`);
    await Repo.clone(config.repoUrl, config.repoPath);
  }
  mkdirSync(join(config.repoPath, config.articlesDir), { recursive: true });
  // Images live in static/. `git add` fails on a path that matches nothing, hence the check.
  const assets = existsSync(join(config.repoPath, "static")) ? ["static"] : [];
  const contentPaths = [config.articlesDir, ...assets];
  const repo = new Repo(config.repoPath, config.publishBranch, contentPaths);

  const tui = new TuiAltScreen(new ProcessTerminal());
  const leave = (code: number) => {
    tui.stop({ preserveScreen: true });
    process.exit(code);
  };
  const app = new App({
    tui,
    config,
    repo,
    models,
    onQuit: () => leave(0),
    // OSC 52: the terminal sets the clipboard itself, which also works over ssh.
    copy: (text) => tui.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`),
    historyPath: join(dataDir(), "prompt-history.json"),
  });
  process.on("uncaughtException", (error) => {
    tui.stop({ preserveScreen: true });
    console.error(error);
    process.exit(1);
  });
  tui.addChild(app);
  tui.setFocus(app);
  tui.start();
  // The terminal can only be asked for its background once the interface owns it.
  const reported = await tui.queryTerminalColors({ timeoutMs: 200 }).catch(() => undefined);
  setTheme(chooseTheme(config.theme, process.env, reported?.background));
  tui.requestRender(true);
  await app.start();
}

main().catch((error) => {
  console.error(`brouillon: ${(error as Error).message}`);
  process.exit(1);
});
