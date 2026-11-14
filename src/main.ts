#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProcessTerminal, TuiAltScreen } from "@earendil-works/pi-tui";
import { createCoachModels, loginOnTerminal } from "./agent/models.ts";
import { authPath, configPath, dataDir, loadConfig } from "./config.ts";
import { FileCredentialStore } from "./credentials.ts";
import { Repo } from "./git.ts";
import { App } from "./ui/app.ts";
import { chooseTheme, setTheme } from "./ui/theme.ts";

const USAGE = `brouillon: write and publish articles with a writing coach

Usage:
  brouillon          open the writing desk
  brouillon login    sign in to the coach's model provider
  brouillon --help   show this help

Configuration: ${configPath()}`;

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  if (command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (command !== undefined && command !== "login") {
    console.error(`unknown command "${command}"\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  const config = await loadConfig();
  const models = createCoachModels(new FileCredentialStore(authPath()));
  if (command === "login") {
    await loginOnTerminal(models, config.provider);
    console.log("Signed in.");
    return;
  }

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
