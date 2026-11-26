# Diff Ask — ZCode's live diff, queryable and revertible

A ZCode plugin (MCP App) with a side panel over the workspace's **live**
diff. Three capabilities over the same lines:

1. **Anchored asking**: hover any line → **＋** → the question reaches
   the conversation citing `file:line` + the exact lines. The agent
   answers about THAT line (and can pin the answer to the file with
   native `# Code comments:` cards).
2. **Surgical revert (the brush)**: you select words with the mouse —
   double-click a word, triple-click the line, drag a range of chars —
   and **paint** them; Enter or the toolbar's ↩↩ runs the revert of
   EXACTLY those characters, verified against git. It works on both
   sides: painting on the green row deletes those chars; painting on the
   red one **restores** that word in place.
3. **Live editing (✏️)**: the panel IS an editor — every keystroke
   re-diffs, autosave with debounce, conflicts resolved as "the agent
   wins".

```
┌──────────────────────────────────────────────┐
│ master @ 761da1d · 9 files           [↩file][＋][✏️][?][↩↩] │
│ ┌──────────────────────────────────────────┐ │
│ │ M  parser.py                   +6 −1     │ │
│ │  2 │ - Marker words: alpha (words), …    │ │ ← red: "words" highlighted
│ │  2 │ + Marker words: alpha (tokens), …   │ │ ← green: "tokens" highlighted
│ │        …                                 │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

- **Diff view**: classic line by line, like GitHub — the red row with the
  removed word highlighted, the green one below with the added one. One
  box per word (spaces stay clean between boxes), fill computed
  programmatically from the theme's real diff color.
- **Per-file toolbar** (in order): `↩` whole file · `＋` ask · `✏️` edit ·
  `?` brush mode ask · `↩↩` brush mode multiline revert (two stacked
  arrows).

In-depth docs:

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — module-by-module
  architecture, the brush/revert pipeline, patterns and design decisions
  (the why of each one).
- **[docs/TESTING.md](docs/TESTING.md)** — the test pyramid with real
  timings, how the e2e rig with a real mouse works, and the pits we kept
  learning from.

## What's in it (state 0.11.0)

| Feature | Where |
|---|---|
| Reactive live diff (fs.watch → git signature → SSE) | server + panel |
| 2 tabs (0.10.0): **Turns** (default — the last executed turn, grouped by repo AND folder, git vs "Outside git", list of 10 going back) / **Work per repository** (📁 selector only here; default = the repo with the most changes in the last turn via `suggest_workspace`; its **Commits** button opens the chosen repo's history) | server + panel |
| Turns v2: prompt→stop window via hooks (UserPromptSubmit/Stop), FSEvents over $HOME, commits of the window + dirty ones at the end, grouped by repo/worktree | `turns2/` + `turn-tap.nu` |
| **Lazy render** (0.10.0): each file mounts its diff only when expanded; collapsing destroys it — memory stays bounded to what is expanded and a 600-file turn does not freeze the panel | `hydrateFileDiff`/`dehydrateFileDiff` (panel) |
| **Lazy turn payload** (0.11.0): a turn arrives as headers + counts (`light`), each file's before/after rides its own read on expand/hover — 1.5 MB → ~10 KB per turn switch; per-file contents cached by turn+path+revision | `diff://turn?light=1` + `diff://file` (server), `loadFileContent` (panel) |
| **Loading feedback** (0.11.0): in-flight top bar, skeletons (pending view, lists, file body), spinner on the clicked row/tab, hover prefetch, stale-while-revalidate on switch-back, highlight skipped >200 KB/side | `paintPendingView` + `#loadbar` (panel) |
| **Incremental turn store** (0.11.0): parsed records cached per file (mtime+size) — a new turn re-reads one file, not 8.7k (~2 s → ~50 ms) | `readTurnFiles` (server) |
| **Big-file open fast** (0.11.1): the lib's tokenizer is capped (`tokenizeMaxLength` = 1,200 lines) so a 3.5k-line file renders plain in ~160 ms instead of blocking ~800 ms; colors are our deferred, memoized path (engine booted eagerly, `da-hl-ready` event); the file header shows a spinner while content loads | `hydrateFileDiff` + `hlColorize` + `vendor/shiki-subset` |
| **Zero sleep-based waits** (0.11.1): the panel/server have no blind sleeps; the e2e waits by condition (`waitForExpr` on the page's frame clock), event (`fs.watch`) or quiescence — only gesture cadence and hard deadlines use timers | `tests/e2e` |
| **Language badges + recount** (0.12.1): every file header shows its type next to the A/M/D chip — the **official vendorized icon** (devicon + simple-icons subset, 50 languages incl. Kotlin, Java, Haskell, Nushell, TS/JS, MD, JSON, YAML, SQL) with a `Language (.ext)` tooltip; languages without a mark keep a brand-colored monogram (PB) and unknown extensions keep their own (BF); the view header shows the counts by type with the full breakdown | `lang-icons.js` + `src/icons` + `npm run icons` |
| **Name-first headers + dark contrast** (0.13.0): the file NAME is the primary text and the directory rides to its right (full path in the tooltip); on dark themes glyph-only marks inherit the text color and dark-painted marks get a brightness lift, so no logo disappears | `renderFileInner` + `panel.css` + icon traits |
| Refresh with short-circuit: identical payload → the DOM is not rebuilt | `payloadSig` (panel) |
| ↑ahead/↓behind chips vs upstream in the working header (the "Unpushed" view was removed in 0.10.0; the info stays) | server (payload working) + panel |
| Anchored questions ＋ (line, box range, file) | panel + skill |
| Revert per line (right rail), per selection, per file | `revertLines` (lib) |
| **Surgical brush**: paint chars/words, coexistence by chars, Enter, cumulative brush without popups | `revertFrags` + `surgeryLine`/`restoreOldWords` (lib) |
| ✏️ live editing (autosave 900ms, ⌘Z, ↩ discard, agent wins) | pierre's Editor + `write_file` |
| Syntax highlighting (12 languages, shiki JS, no wasm — nushell since 0.9.19) | `hlColorize` (panel) |
| Composer draft survives the reactive refresh (text, focus, caret) | `keptComposers` (panel) |
| ⌘F, ＋/−/≡ filters, sticky toolbar, diff folder | panel |

## Architecture on one page

```
┌────────────────────────────── ZCode (fork, Electron) ──────────────────────────────┐
│  panel host (iframe zcode-sandbox://plugin-*)        ZCode Helper (__zcode-plugin- │
│ ┌───────────────────────────────────────────┐        -host, stdio)                │
│ │  diff-ask/dist/panel.html (inline bundle) │← MCP →┌───────────────────────────┐ │
│ │  · App SDK (ext-apps): sendMessage,       │       │ server/server.mjs        │ │
│ │    callServerTool                         │       │ (Node stdlib, 0 deps)    │ │
│ │  · <diffs-container> (@pierre/diffs,      │  SSE  │  git: diff/status/log/   │ │
│ │    shadow DOM: FileDiff + Editor)         │←──────│  hash-object/apply       │ │
│ │  · lib.js: ALL the pure revert logic      │       │  fs.watch → notifies     │ │
│ └───────────────────────────────────────────┘       │  turn-events.jsonl → 📸  │ │
│         skills/diff-ask/SKILL.md (model routing)    └───────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- **lib.js is pure** (no DOM): tokenizers, LCS word-diff, the chars
  surgery, old-side restoration, message assembly. All unit-tested
  without a browser.
- **main.js is the IO/DOM shell**: it decorates over pierre's shadow DOM
  with absolute layers measured with `Range.getClientRects()` — it almost
  never writes pierre's DOM (the one documented exception:
  `hlColorize`).
- **server.mjs with no dependencies**: it speaks MCP over stdio with pure
  Node; everything it does is `git` + `fs.watch` + JSON.

Key decisions (summary; the detail with the why in
[ARCHITECTURE.md](docs/ARCHITECTURE.md)):

- **Surgical always**: painting deletes/restores only the painted chars.
- **Native gestures define the semantics**: double-click = word,
  triple = line, drag = range. The panel does not invent selection modes.
- **A row's text is its file line**: char offsets live in the on-disk
  file's space; every coordinate conversion goes through single, tested
  utilities.
- **The editor rules alone**: in ✏️, no panel layer touches the file
  (the lesson of a real bug: the colorizer overwrote what was typed).
- **Derived colors, never fixed**: the row's real color is sampled (it
  may come as `lab()`) and the fill is computed with relative oklch /
  color-mix — no hand-parsing colors.
- **Write conflict = the agent wins**: the disk is never overwritten;
  your version goes to a shelve with a `.patch`.

## Testing (summary; details in [TESTING.md](docs/TESTING.md))

| Level | What | Count | Time |
|---|---|---|---|
| Unit | pure lib.js + MCP server (with real git repos in tmp) | 105 | **~9 s** |
| Integration | lib → `write_file` → `git diff` closes the circuit in a real tmp repo | (inside unit) | — |
| E2E | real Chromium + CDP, **real mouse and keyboard**, real dist panel + real server, every revert verified with git | 182 checks | **~2 min** (the mega-commit section adds the render of 600 sections) |

```bash
npm test          # 105 unit + integration (~9 s)
npm run test:e2e  # full rig with a real mouse (~2 min)
```

The e2e uses a deterministic fixture (`tests/diffs/` committed +
`apply-fixture-mods.mjs` which resets from HEAD and applies 22 edits),
and a 42-edit medley (`apply-fixture-rich.mjs`) for manual testing.

## Installation and development

```bash
npm install && npm run build   # → diff-ask/dist/panel.html (inline, ~3.6 MB)
```

Install via UI: ZCode → Plugin Marketplace → Add → point at this repo →
Personal → dev-zcode-diff-ask-… → Diff Ask → Install. Restart ZCode after
every update (the panel is served from the cache at startup).

Install via script (the whole chain, see
[TESTING.md](docs/TESTING.md#installing-a-new-version-the-whole-chain)): rsync
to the marketplace copy
(`~/.zcode/cli/plugins/marketplaces/dev-…/`), create
`~/.zcode/cli/plugins/cache/dev-…/diff-ask/<version>/`, and patch
`installed_plugins.json` (with a backup).

Other commands: `npm run check` (the server's MCP contract over stdio),
`diff-ask/dist/dev.html` (the panel's visual harness without the app).

## Roadmap

- [ ] `tools/patch-zcode.sh` — turn on the "＋" inside the app's NATIVE
  diff (asar patch + ad-hoc codesign; requires freezing auto-update).
