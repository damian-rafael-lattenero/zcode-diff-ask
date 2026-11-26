# Diff Ask architecture

Depth document: what each piece does, how they connect, and **why** it is
the way it is. For the big picture, see the [README](../README.md). For the
tests, [TESTING.md](TESTING.md).

---

## 1. Component map

```
zcode-diff-ask/
├── diff-ask/                       ← the plugin (everything that installs)
│   ├── .zcode-plugin/plugin.json   manifest: mcpServers (stdio) + ui.surfaces
│   ├── server/server.mjs           MCP server (Node stdlib, ZERO deps)
│   ├── ui/
│   │   ├── src/lib.js              PURE LOGIC: word-diff, chars surgery,
│   │   │                           restoration, messages. No DOM. ~500 lines.
│   │   ├── src/main.js             DOM/IO shell of the panel. ~3,600 lines.
│   │   ├── src/panel.css           styles (light/dark) + overlay layers.
│   │   └── build.mjs               esbuild → dist/panel.html inline (~3.6 MB)
│   ├── skills/diff-ask/SKILL.md    how the MODEL routes anchored questions
│   └── dist/                       panel.html (build) + dev.html (harness)
├── tests/                          pyramid (see TESTING.md)
│   ├── *.test.mjs                  unit + integration (node --test)
│   ├── e2e/revert.e2e.mjs          e2e rig with a real mouse
│   └── diffs/                      fixture playground (committed base)
└── marketplace.json                dev marketplace manifest
```

## 2. Host integration (the ZCode fork)

The plugin does not live alone: it depends on four surfaces of the fork.
Understanding them explains several decisions.

| The fork provides | The plugin does with it |
|---|---|
| **Plugin runtime**: `.zcode-plugin/plugin.json` declares stdio `mcpServers`; the app brings it up via `ZCode Helper __zcode-plugin-host` | `server.mjs` speaks MCP over stdio (initialize/resources/tools/notifications) with pure Node |
| **MCP Apps SDK** (`@modelcontextprotocol/ext-apps`): persistent panel (`ui.surfaces`) with `App.sendMessage` and `app.callServerTool` | The panel sends questions as USER MESSAGES (anchored) and calls `write_file`/`get_diff` as tools |
| **Sandboxed panel host**: the HTML is served from the plugin cache inside a `zcode-sandbox://plugin-<id>` iframe | The bundle is INLINE (a single `panel.html` with no external assets), a host limit: 4 MiB |
| **Skill system** | `SKILL.md` teaches the model to recognize the "Diff Ask" blocks and to answer with `# Code comments:` |

Install chain (why it sometimes "does not update"):

```
repo (build) → ~/.zcode/cli/plugins/marketplaces/dev-…/   (marketplace copy)
            → ~/.zcode/cli/plugins/cache/dev-…/diff-ask/<version>/  (what IS SERVED)
            → ~/.zcode/cli/plugins/installed_plugins.json  (registry: version+installPath)
```

The app installs per version directory and serves from the registry's
`installPath`. Updating = refreshing the THREE things + restarting ZCode (the
panel loads at startup). Updating only one produces the classic "the old
version still runs" or "a mixed dist is served".

The diff is RENDERED with `@pierre/diffs` (the same lib as the app's native
diff): the `<diffs-container>` custom element mounts its **shadow DOM** with
the `[data-line]` rows, its own pierre-dark/light theme and the `Editor` for
editing. That shadow DOM is pierre's territory — see §6.

## 3. The server (`server/server.mjs`)

No dependencies: MCP over stdio by hand (JSON-RPC line by line), and all the
power is `git` + `fs.watch`.

**Resources**
- `diff://workspace` — the complete diff: `working` (HEAD+untracked). Since
  0.10.0 the `unpushed` mode does not exist (the view was removed); what
  survives is the `upstream`/`ahead`/`behind` info travelling in EVERY working
  payload (the panel header's ↑/↓ chips). Per file the payload includes:
  status, COMPLETE before/after (when size allows), unified patch, and the
  parsed `hunks` with their `hunkContent` (the change-by-change structure the
  revert walks).
- `turn://list`, `diff://turn/<id|latest>` — the **turns v2** system: every
  user prompt (via the user-scope hook → `~/.zcode/diff-ask/turn-events.jsonl`)
  opens a prompt→stop window; while it is open an FSEvents watcher over $HOME
  accumulates the touched paths and at Stop the server groups by repo: the
  commits made IN the window + the files dirty at the end + the files touched
  outside any repo. One JSON per turn in `turns2/`, global across sessions;
  `latest` diffs the open turn against the LIVE tree.
  **Recording is a pure per-session fold (0.10.8, `turn-fold.mjs`)**: the
  inbox is an append-only log and the open state is its fold into ONE lane
  per sid — the reader's identity (the sticky request-context sid in the
  app, where ONE server serves every task) scopes READS, never the fold.
  Laws L1-L6 unit-tested (own-supersede, no cross-talk, zombie cap, boot
  heal, window slice, lanes cap). Inbox offsets are BYTE-exact (the old
  utf8-length offset reset to 0 on accented prompts and re-drained the
  whole history on every restart); drains run through a structured
  concurrency lane and clear/delete join it before wiping; boot reopens
  the log's still-open windows (a stop landing on the server's NEXT life
  completes the turn) and arms the watcher at startup. The panel stamps
  its sid (`turn://list?sid=`, `diff://turn/…?sid=`) so its view always
  follows its OWN task.
  **A turn's files are ZCode's own (0.10.10, `app-store.mjs` + `turn-files.mjs`)**:
  when the app knows the session, the turn's file list is the session's
  workspace checkpoints inside the prompt→stop window — the very list the
  app's end-of-turn summary shows (its `aggregateWorkspaceCheckpoints`
  ported, including the jsdiff-9 patch applier an Edit checkpoint needs
  because it stores no after-content), aggregated first-before →
  final-after per file. The edge reads the app's sqlite session store and
  tool-result artifacts read-only; a store it cannot read answers an honest
  null and the capture model below stays in charge (bot lines, the rig).
  The FSEvents tap + git capture therefore still runs ONLY for sessions the
  app does not know: commits and dirty files no longer inflate a turn that
  wrote nothing, and `suggest_workspace` follows the turn's written files.
  Known gap: the app's panel also hides generated-UI source files
  (`::visualize` references parsed from the reply) — not ported here.
- `log://commits`, `diff://commit/<hash>` — commit browser (pages of 10 +
  search by hash/title).
- `diff://turn/<id>?light=1`, `diff://file/<id>?path=<key>` (0.11.0) — the
  panel's turn view is LAZY. The light read carries the file list, statuses
  and counts (KBs, even for a 1.5 MB turn) with `light: true` and a
  `deferred` flag per file; each file's before/after rides its own read when
  the user expands it (or hovers it: prefetch). The server keeps the parsed
  entries of the last few turns (LRU 6, 30 s TTL) so a per-file read is a
  find + ONE file's content, never a turn rebuild. The internal `_src`
  (which carries the app item — the old payload shipped before/after TWICE)
  never rides the wire. Store reads are incremental too: parsed records are
  cached per file by (mtime, size), so a new turn re-reads ONE file instead
  of the whole store (~2 s → ~50 ms on the live 8.7k-record store).

**Reactivity**: `resources/subscribe` → `fs.watch` (worktree + `.git`,
600 ms debounce) → it only notifies if the **git signature** changed (status
+ numstat + HEAD + upstream). The panel re-reads the resource when it
receives `resources/updated`.

**Tools**: `get_diff` (opens the panel), `list_commits`,
`get_commit_diff`, `list_turns`/`get_turn_diff`, `delete_turn`/`clear_turns`,
`set_workspace` (switch repo: re-validates, re-arms the watchers),
`suggest_workspace` (0.10.0: the repo with the most changes in the last turn
— the default of the "Work per repository" tab), `list_git_projects` (📁
picker) and **`write_file`** — the only write door, with a conflict policy:

```
write_file(path, content, base)
  base = sha1 of the file when you read it
  ├─ matches → writes
  └─ differs (the agent touched the disk meanwhile) → DOES NOT OVERWRITE:
     shelve ~/.zcode/diff-ask/shelved/<ws>/<file>.{mine,patch} → "the agent wins"
```

Every panel write (reverts, ✏️ editing, discards) goes through here. The
policy is deliberate: the agent never loses work to a human edit in the
panel, and the human never loses theirs (it stays in the shelve).

## 4. The panel (`ui/src/main.js`) — the layer map

```
<section class="file">                       (panel light DOM)
  <div class="file-head">  [↩][＋][✏️][?][↩↩]  chev · path · counts
  <div class="file-body">
    <diffs-container>  ← pierre's shadow DOM: [data-line] rows, gutter,
    │                    syntax tokens, its own theme
    └── (ours, via shadowRoot): injected styles (.da-extra, ::selection)
    <div class="wc-layer">     ← ABSOLUTE overlay: per-word boxes (red/green)
    <div class="frag-layer">   ← ABSOLUTE overlay: painted stripes
    <div class="anchor-layer"> ← 💬 chips of anchored questions
```

**The decoration model**: pierre owns the diff DOM. The panel decorates ON TOP
with absolute layers positioned by measuring `Range.getClientRects()` of the
shadow's rows. It almost never writes pierre's DOM — the only exception is
`hlColorize` (§7) which replaces a row's content with colored tokens.
Everything else (boxes, stripes, space dots) lives in overlays.

**Loading (0.11.0)**: navigation paints a skeleton shell within a frame
(`paintPendingView`: modebar + shimmer file sections) and the clicked
row/tab spins; the top `#loadbar` runs while ANY bridge read/tool call is in
flight. Turn views render headers from the light payload; a file body shows
shimmer rows until its content lands, and a failed fetch leaves an honest
note + Retry. Caches: view payloads per URI (switch-back renders the
cached headers first — stale-while-revalidate, then the signature
short-circuit skips the rebuild when nothing changed) and file contents per
turn+path+REVISION (the app's write count rides the header, so a live turn
that gets another write fetches fresh content instead of a stale diff).
Hover prefetches (one turn read, at most two file reads). Highlighting is
skipped above 200 KB per side or 1,200 lines: content and diff stay complete,
only the colors are not painted.

**Big files & highlighting (0.11.1)**: expanding a 3.5k-line file used to
block the main thread ~800 ms INSIDE `FileDiff.render` — pierre's own
tokenizer ran on the whole diff (profile: `findNextMatchSync` + the TS
grammar's regexes). Fixes: (1) the FileDiff is constructed with
`tokenizeMaxLength = HL_MAX_LINES` — the lib's `isDiffMassive` threshold
makes it render plain and never start the tokenizer; (2) the highlight
engine is booted EAGERLY by the panel (vendor import) and announces itself
with a `da-hl-ready` event; (3) `hlColorize` is OUR single coloring path —
deferred to idle, memoized per content+theme, with a fast path that skips
tokenization when no row still needs the theme, and no caching of a failed
(token-less) pass. Expanding a big file is now ~160 ms wall-clock end to
end (measured), the diff itself ~10 ms. While a file's content is being
fetched, its header shows a spinner (`setEntryBusy`) and the body shows
skeleton rows.

**Language badges (0.12.x, `lang-icons.js` + `src/icons`)**: a file header
carries TWO chips — the status chip (green/yellow/red: what changed) and the
language badge (what kind of file). The language id comes from the lib's own
extension catalogue (`getFiletypeFromFileName`, hundreds of extensions) with a
few name overrides (`.env`, `package.json`, `.gitignore`). `styleForLang` is
pure and answers the VENDORED official mark (a 50-icon subset of devicon +
simple-icons, `src/icons/`, generated into `lang-svgs.generated.js` by
`npm run icons`); languages without a mark keep their brand-colored monogram
(PB), unknown ids keep their own extension (`.bf` → `BF`), no extension gets
`FILE` — no header is ever anonymous. Generated ids inside each SVG are
prefixed per icon (`da-kotlin-…`): inline SVGs share one document, so
duplicated gradient ids would leak between icons. The view header adds a
recount (`langCounts`) using the same marks with file counts, full breakdown
in the title. Sources and licenses: `src/icons/NOTICE.md`.

**Name-first headers + contrast (0.13.0)**: the header reads
`[chevron][status chip][language mark] NAME  directory…  +N −M` — the file
name is bold and primary, the directory is muted at its right (both truncate
independently; the tooltip keeps the full path, and a rename shows
`old → new` as the name). On dark themes the generator's traits keep every
mark visible: a mark that paints NOTHING (`mono`, e.g. devicon markdown) gets
`fill="currentColor"` injected so it inherits the text color, and a mark whose
BRIGHTEST paint is still dark (`dark`, e.g. YAML's dark red, Gradle's #02303a)
gets `filter: brightness(1.6) saturate(1.05)`. The traits are computed once by
`npm run icons` (paint colors only — never metadata like `color="#000"`),
not at runtime.

Every decoration pass (`markChangedWords`) is:
1. **Pre-gate** (ALWAYS runs): pair the same change's dels↔adds, reset the
   state of old builds.
2. Sampling of real colors (§8) → CSS custom properties.
3. **Signature gate** (`_wcSig`): if nothing changed (same rows/height/
   lengths), do not recompute rects — the layout did not change.
4. Recompute the boxes: `changedWordRanges` per pair → `wordRanges` splits
   each range into WORDS → one box per word, clean spaces between them.

## 5. The surgical brush — complete pipeline (the heart)

### 5.1 Gestures → selection

Native gestures define the semantics (decision: do not invent modes):

| Gesture | Selects | How it is detected |
|---|---|---|
| double-click | one word | `click.detail === 2` + a walk of Unicode word boundaries |
| triple-click | the whole line | `detail >= 3` (the native click knows the real count) |
| drag | exact char range | geometric path (below) |
| vertical drag | whole lines | Δy ≥ 14px and Δx < 8px |

**Geometric hit-testing**: `caretRangeFromPoint` RETARGETS to the shadow host
(useless), and `String(selection)` lies with Chromium's newlines. Instead:
`shadowRoot.elementFromPoint` does pierce the shadow, and the character offset
is resolved by **binary search over internal Range rects** (`offsetAtX`) — the
shadow's rects are real geometry even though the Selection does not expose
them. A gesture is represented as `dragPath`
`{x0,y0,x1,y1,at,live,detail}`: `at` = the gesture id (dedupe), `live` = the
last activity (human multi-line drags take >1.2 s; the geometric path must not
die mid-gesture). Repeated words in the row: the occurrence is chosen by
GEOMETRY (the rect closest to the release point), never by `indexOf`.

### 5.2 Selection → frags

A frag is **always character offsets against the FILE's line**:

```js
{ side: "new"|"old", line: <file line>, offA, offB }   // [a,b)
```

- Painting on the **green** row → `new` frag (offsets over the disk line).
- Painting on the **red** row → `old` frag (offsets over the OLD line).
- **Coexistence by chars**: painting a word does NOT unpaint neighboring
  painted ones unless they overlap characters with the new one (two words of
  the same row coexist; repainting exactly the same = unpainting on purpose).
- **One gesture = one paint**: the same gesture fires several
  `selectionchange` events (release → settle) and the first paint after
  release wins (lock by `dragPath.at`).

### 5.3 Frags → new file (`revertFrags` in lib.js)

It walks the hunks through their `hunkContent` (change/context blocks) keeping
the old↔new alignment. Per line:

- **New line with paintings (green side)** → `surgeryLine(after, before,
  sels)`: deletes exactly the painted chars that fall on ADDED tokens (LCS
  word-diff), with space rules so no double spaces or glued words are left.
  If the painting covers **the whole change** of the line
  (`coversFullChange`: the whole line or all the added ranges) → the line goes
  back to the ORIGINAL directly (the "I want this line as it was" shortcut).
- **Painted old line (red side, pair)** → `restoreOldWords(after, before,
  sels)`: it walks the pair by change REGIONS at the token level:
  - the whole containing old word painted → **swap**: the region goes back to
    the old text (painting the whole red = the original line);
  - some words painted → they come back and the replacement STAYS
    ("the quick brown fox"→"the slow fox" with "quick" → "the quick slow fox");
  - half a word → not restored (double-click paints whole words).
- **Old line WITHOUT a pair** (deleted whole) → comes back as is (there is no
  place to splice a lone word into).
- Red and green of the same pair both painted → red wins.

The result is the file's new lines → `write_file` with `base` → a conflict
impossible to override (§3) → the panel self-refreshes (do not wait for the
watcher: macOS fs.watch swallows events — a hard lesson).

### 5.4 Execution

- No mode: floating ＋/↩ popup next to the selection (single paint).
- **Brush mode** `?`/`↩↩`: accumulates N paints WITHOUT popups, and the
  toolbar button (second click) or **Enter** runs EVERYTHING in one write.

## 6. Live editing (✏️)

pierre's `Editor` hooked to the `FileDiff`: every keystroke re-diffs (the
editor keeps its own SPAN mirrors in the shadow, apart from the diff rows).
Autosave with a 900 ms debounce via `write_file`; native ⌘Z/⌘⇧Z; ↩ Discard
restores the content from before the ✏️. The reactive refresh stays paused
while you edit (an honest chip) and is applied on exit.

**The golden rule (0.9.9 lesson)**: in edit mode, NO panel layer touches the
file. The shadow's MutationObserver fires on every keystroke, and the
colorizer overwrote WHOLE rows with tokens from the OLD content
(`fileData.after` does not live-update) on top of the editor's live rows —
what you typed turned black/overwritten. Today `hlColorize` and the rAF loop
skip `entry.edit`, and the e2e watches it with `entry._hlRuns` (a run
counter).

## 7. Syntax highlighting

12 bundled languages (json, yaml, python, ts/js, markdown, html, css,
bash, kotlin, haskell, nushell) with shiki's JS engine (no wasm) — the subset
fits the 4 MiB limit. pierre's embedded renderer does not wire tokens in our
context, so the PANEL paints: `hlColorize` replaces the content of the WHOLE
row (`r.innerHTML`) with colored spans — a full replacement, not the first
span: pierre's tokens live in SEVERAL sibling spans and writing only the first
left the rest = **duplicated text** (a real 0.9.7 bug, invisible to the rig
until the rig learned to assert EXACT text). Idempotent per theme
(`dataset.hl`), re-painted on hunk expansion; in edit mode it does not run
(§6). Outside the subset → plain.

## 8. Box colors — derived, never fixed

The word boxes' fill is computed PROGRAMMATICALLY from the diff row's REAL
color (sampled with `getComputedStyle`; pierre exposes colors in modern syntax
— `lab(...)` — so they are not parsed: they are left as custom properties and
the browser resolves them):

```css
/* panel.css — the live formula */
background: oklch(from var(--wc-green) min(l + 0.22, 0.75)
                               min(max(c * 1.25, 0.13), 0.24) h / 0.42);
```

Why like this: over a **black** background, an `opacity` only MIXES TOWARD
BLACK — it can never glow. And a fixed color washed the text out in some
theme. The formula keeps the real theme's hue (`h`), lifts lightness/chroma
with ceilings and floors (without a chroma floor, the sampled faint colors
come out almost gray), and the alpha lets 58 % of the text through. One box
**per word** (clean spaces between boxes) so a line with many changes stays
readable.

## 9. Anchored questions

Line hover → the gutter's ＋ (or the gutter's boxes for ranges, or the head's
＋ for the file) → composer → `app.sendMessage` as a USER message with
`- \`path:line\` (Diff Ask · diff, lines a-b · side):` + the lines quoted
verbatim. The header names the scope (mode/turn/commit). The skill
(`SKILL.md`) teaches the model to answer ABOUT those lines and to pin answers
with `# Code comments:` (the app's native cards). The panel's 💬 are the
anchored questions, collapsed over their line.

---

## 10. Design decisions (the why, with the history)

1. **Surgical ALWAYS.** Painting deletes/restores exactly the painted chars.
   (0.9.1 tried "pure addition → delete the whole line": it reverted Damian's
   3 lines when he painted 3 words — immediate regression.)
2. **Classic two-row diff, GitHub style** (0.9.11, final spec). The path
   tried: one row per line with the red hidden (0.9.4) → the removals struck
   through INSIDE the green row (0.9.8) → both discarded: "the red line with
   the word in red, below the green one with the green one". The lesson:
   single-row models optimize pixels and lose readability.
3. **Native gestures rule** (double/triple/drag): the selection behaves like
   in an editor, which is where the user's hand lives.
4. **Offsets against the file, always** — and when we had to coexist with
   mixed DOM (the strike-through era), the space conversions live in single,
   tested utilities (`mergedOffToNew`, `newRangeToMergedSegs`). Today they
   remain as defense: with no strike-throughs, merged == new.
5. **Surgical red/green pairs on both sides** (0.9.14): painting a word of the
   red one restores it IN PLACE. Before: atomic pair (the painted red = the
   whole line back to the original). The atomic one survives as an edge case
   (painting everything = full swap) and for reds without a pair.
6. **Coexistence by chars, not by rows**: "painting the new unpainted the
   painted" was fixed by measuring CHARACTER overlap.
7. **The ✏️ editor is pierre's territory** (0.9.9): our own layers = render
   bugs over live rows. Total isolation.
8. **Sampled + derived colors** (0.9.10–0.9.15): parsing colors by hand failed
   twice (the `rgba?(` regex does not match `lab()`, and the canvas does not
   normalize them either). The relative oklch formula is short, correct in any
   future syntax, and adapts to the theme by itself.
9. **One box per word**: the word-diff returns merged ranges; with many
   changed words the continuous block was unreadable. The clean spaces
   between boxes restore legibility.
10. **The agent wins on write conflicts** + shelve: the least surprising
    policy for a human editing on top of an agent that is working.
11. **Reactive refresh + auto-refresh after writing**: macOS fs.watch loses
    events right after a write of our own (seen with 12 consecutive shelves);
    `writeReverted` refreshes itself.
12. **Pure lib.js, overlays, idempotence with a signature**: everything
    testable without a browser lives in lib; every decoration is an
    idempotent pass with a signature gate and its invariants BEFORE the gate
    (the invariants that ended up inside the gate were skipped on an identical
    content refresh — the paired red "duplicated itself").

## 11. Known limits

- The e2e can flake under system load (CDP timing) → retry.
- macOS `fs.watch`: the server's watcher may lose an event (mitigated:
  signature + post-write auto-refresh; the watcher test is the only known
  unit flaky one).
- Highlighting outside the 12-language subset → plain.
- Reverting a red WITHOUT a pair is atomic by design (there is no place to
  splice a lone word into a line that does not exist).
- `apply-fixture-mods.mjs` resets `tests/diffs/` from HEAD: any manual changes
  you have there are lost when the e2e runs.
