# brouillon

Terminal writing desk for the okcomputer.cloud blog: a prose editor, a writing coach built
on the Pi libraries, and git publishing to the blog repository. It runs on the author's
machine as a single Node process; TypeScript is run directly by Node, with no build step.

## Commands

- `make setup`: trust and install tools, install dependencies.
- `make check`: `make lint` (Biome, then `tsc`) followed by `make test` (`node --test`).
- `make fmt`: apply the formatter.
- `make run`: start the app from this checkout. It needs a real terminal.
- `make install`: write the `brouillon` launcher into `~/.local/bin`.

## Layout

- `src/main.ts`: entry point and command line.
- `src/ui/`: `app.ts` is the whole screen and every command; `coach-pane.ts` (conversation
  and prompt), `selection.ts` (mouse selection inside one pane), `prompt-history.ts`,
  `dialogs.ts`, `theme.ts` (palettes, pills, gradient, rounded frames).
- `src/editor/`: `buffer.ts` (text, cursor, undo; no terminal code) and `view.ts` (wrapping,
  rendering, keys).
- `src/agent/`: `tools.ts` (everything the coach may do), `prompt.ts`, `coach.ts`, `models.ts`.
- `src/git.ts`, `src/posts.ts`, `src/frontmatter.ts`, `src/config.ts`, `src/credentials.ts`.
- `tests/helpers.ts` builds a throwaway blog repository with a bare origin.

## Invariants

- **The coach never edits the article.** `coachTools` in `src/agent/tools.ts` is the complete
  list of its tools; none writes the open article, and `suggest` refuses passages that are
  not in the article, span paragraphs or double in length. The author's goal is to write
  their own articles. Pinned by `tests/tools.test.ts` ("the coach has no tool that edits the
  article", "suggest refuses to write new material").
- **`write_translation` works only after the author asked for a translation.** Pinned by
  `tests/tools.test.ts`.
- **A draft branch holds exactly one commit**, rebuilt from the merge base on every save,
  and is pushed with `--force-with-lease`. Pinned by `tests/git.test.ts` ("save keeps a draft
  branch at one commit").
- **No git command may prompt.** The interface owns the terminal, so `gitEnv` disables
  prompts and `assertSigningReady` checks the signing key before any commit. A prompt behind
  the interface hangs, and a wedged pinentry blocks every later signature on the machine.
- **Every rendered line is exactly as wide as asked.** `pi-tui` throws on a wider line.
  Pinned by `tests/app.test.ts` and `tests/view.test.ts`.
- **TypeScript must stay erasable** (`erasableSyntaxOnly`): no enums, no parameter
  properties, because Node strips types without compiling.

## Pitfalls

- `pi-tui` components only receive a width. `App.render` returns exactly `terminal.rows`
  lines and lays out the panes itself; its `capturesViewportInput` keeps page keys from
  scrolling the alternate screen.
- The coach learns the application from `guideSection` in `src/agent/prompt.ts`. Keys that
  work in both panes and menu entries come from `App.shortcuts()` and `App.commands()`; the
  keys of the editor and of the prompt are prose there, to update with `view.ts` and
  `coach-pane.ts`. `FOOTER_KEYS` in `app.ts` and `EMPTY_HINT` in `coach-pane.ts` name keys
  by hand too.
- Colors are named by role in `src/ui/theme.ts` (`color.primary`, `color.muted`, …) and read
  the current theme when called, never at import: `setTheme` runs after the interface
  starts. A new color goes into all four palettes; tests run with `ansi`.
- `App.handleMouse` captures every left press on a pane and draws the selection itself:
  left alone, `pi-tui` selects whole screen rows, across both panes.
- `matchesKey("\n", "enter")` is true, so `ctrl+j` cannot mean "new line" in the prompt.
- `sliceByColumn` keeps the styles opened before the cut and does not close them.
- `displayable()` in `src/editor/view.ts` must keep one UTF-16 unit per unit of input, or
  cursor columns stop matching the text.
- `Agent.reset()` throws while a run is active: `Coach.reset` aborts and waits first.
- Stop the interface with `tui.stop({ preserveScreen: true })`; without it the whole frame
  is printed into the scrollback each time `$EDITOR` or the sign-in opens.
- Sign in with ChatGPT needs `getDeviceId` in the login options, the same UUID every time.
- Tests that touch git need `commit.gpgsign=false` in the throwaway clone, as
  `tests/helpers.ts` sets.

## Sources

- Pi packages: the READMEs under `node_modules/@earendil-works/*/README.md` and their
  `dist/*.d.ts` are the reference for the installed version (1.5.2).
- Blog repository: https://github.com/equelin/equelin.github.io (Hugo, deploys on push to
  `master`).
