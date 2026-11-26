# Testing Diff Ask

The pyramid, with real timings, how the e2e rig works inside, and the pits
we kept learning from (so we do not fall in again). For the architecture,
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## Summary

| Level | Files | What it covers | Count | Time (M1, mid-load) |
|---|---|---|---|---|
| Unit (pure lib) | `tests/lib.test.mjs`, `lib-frag`, `lib-merge` | tokenizers, LCS word-diff, `revertLines`/`revertFrags`/`surgeryLine`/`restoreOldWords`, space cuts, `wordRanges` | 80 total | **~7 s** |
| Unit (MCP server) | `tests/server-*.test.mjs` | diff modes, 📸 turns, `write_file` + conflicts/shelve, parsing — with REAL git repos in tmp | ↑ | ↑ |
| Integration | `tests/revert-integration.test.mjs` | lib → `writeFileGuarded` → `git diff` closes the circuit in a real tmp repo | ↑ | ↑ |
| E2E | `tests/e2e/revert.e2e.mjs` | the REAL panel (`dist/panel.html`) + REAL server, **real mouse and keyboard** via CDP, every revert verified against git | **100+ checks** | **~2 min** |

```bash
npm test          # 80/80 in ~7 s
npm run test:e2e  # 100+ checks in ~2 min (requires Google Chrome installed)
```

0.11.0 adds `tests/server-turns-light.test.mjs` (the light turn payload
carries no before/after; `buildTurnFile` answers one file byte-identical to
the full build; the turn store re-parses only the changed record) and the
e2e's section X now proves the LAZY turn end to end: the panel's payload says
`light: true` with `deferred` files and no content, expanding a file fetches
exactly that file's before/after, and the content is cached. The general
health block also asserts the progress bar and the skeleton animation are
wired.

## Why this shape

- **The pure logic does not know a browser exists.** All the revert algebra
  (offsets, chars surgery, region restoration, space rules) lives in
  `lib.js` without DOM — that is why 80 tests run in 7 seconds and every
  edge case ("double space", "half a word", "a lone letter") is a test with
  an exact-text assert, no timing or layout.
- **The e2e exists because half of this plugin's bugs were real
  integration bugs**: shadow DOM hit-testing, `caretRangeFromPoint`
  retargeting, native selection vs multiple selectionchange, the
  component's layout, the reactive refresh after writing. None of that can
  be simulated honestly — the rig uses the same input pipeline as the
  user's mouse (CDP's `Input.dispatchMouseEvent`).

## The e2e rig inside

```
revert.e2e.mjs
 ├─ apply-fixture-mods.mjs     resets tests/diffs/ from HEAD + 22
 │                             deterministic edits (unique marker words:
 │                             alpha, bravo, charlie, delta, echo, foxtrot)
 ├─ spawn server/server.mjs    the REAL MCP over stdio (ZCODE_WORKSPACE_ROOT=repo)
 ├─ http harness (127.0.0.1)   serves dist/panel.html + injects test mode:
 │     __DA_TEST__  = fixture + workspace
 │     __DA_E2E__   = bridge: fetch /mcp → the server's stdio; SSE /events
 │                    → resources/updated (the REAL reactivity)
 │     __DA_HL_READY = highlighter stub (hlColorize runs its pipeline)
 └─ REAL headless Chrome       --remote-debugging-port via CDP; mouse/keyboard
                                with Input.dispatchMouseEvent/KeyEvent
```

Key rig helpers (injected as `__E2E.*`):
- `locate(rel, needle, type?, noScroll?)` — finds the row, scrolls,
  **waits for the scroll to settle**, measures the needle with real Ranges
  and returns per-char rects. It skips hidden rows (degenerate rect) and
  resolves needles that end at the end of the row.
- `rowAt(rel, x, y)` — which row is REALLY under a point? (aiming
  diagnostics: `shadowRoot.elementFromPoint`).
- `frags(rel)` / `allFrags()` — what is painted, with text and offsets.
- `head(rel)` — the file header: scrolls to the CENTER (with
  `block:"start"` it stays under the sticky modebar and the click is
  lost), waits for settle, aims at the chevron.

The sections (A–O) follow Damian's gestures: double-click word,
triple-click line, drag left→right / right→left / ONE letter, gutter
boxes, Enter, brush mode with general rollback, coexistence, slow 1.7 s
drag, twin word, classic two-row diff + per-word boxes + toolbar order,
EXACT text after colorizing and refresh, and ✏️ editing with a real
keyboard (insertText + Backspace + autosave verified on disk).

**Every revert is verified by reading the file on disk** (and the panel's
state after its reactive refresh) — we never trust the DOM state alone.

### Medley for manual testing

`node tests/e2e/apply-fixture-rich.mjs` — 42 quite diverse edits
(multi-word, mixed, intra-word, twins) to test by hand. The e2e always
starts from the standard fixture (it resets itself on start).

## Flake policy (read it before cursing)

- **Zero `sleep` as synchronization (0.11.1)**: the rig waits by CONDITION
  (a promise in the page that resolves on the frame the state arrives,
  `waitForExpr`), by EVENT (`fs.watch` for disk writes and for Chrome's
  port) or by QUIESCENCE (`quiesce`: two frames without tick/file/scroll
  changes). The only timers are hard deadlines (a dead server or Chrome
  must fail loud, not hang) and `pace(...)` inside the gestures: the
  interval of a double-click or the rhythm of a slow drag IS part of the
  gesture being emulated. Rule: if a test needs "wait for something to
  happen", the condition exists and is waited on; it never sleeps blindly.
- **The e2e is sensitive to system load**: CDP input + reactive refresh.
  Under high load (>3) 2–6 checks in DIFFERENT sections may fail between
  runs — **retry** before investigating. If the SAME thing fails twice in
  a row, then there is a bug (that is how we found them all).
- The watcher test (macOS `fs.watch`) is the only known unit flake — same
  treatment.
- **Never weaken an assertion to make it pass**: text checks use EXACT
  (`textContent ===`), not substrings — a text-duplication bug went
  unnoticed for weeks because the assertions used `includes`. And every
  block that measures gestures cleans the state the previous ones left
  (`fragSel.clear()` + refresh) instead of trusting timing.
- Rig gestures: start drags INSIDE characters, not on borders or in no
  man's land between words (under load they select nothing); a click's
  point must be measured AFTER the scroll settles.

## Pits learned (the index of pain)

1. `caretRangeFromPoint` RETARGETS to the shadow host — useless.
   Geometric hit-testing with `shadowRoot.elementFromPoint` + binary search
   over Range rects.
2. The same gesture fires SEVERAL `selectionchange` events — without a
   per-gesture lock, the second unpainted what the first painted.
3. macOS `fs.watch` swallows events right after a write of our own → the
   panel self-refreshes after writing (do not wait for the watcher).
4. pierre exposes colors in `lab()`; parsing colors by hand fails (regex,
   canvas). Use relative `color-mix`/oklch and let the browser resolve it.
5. pierre's renderer paints tokens in SEVERAL sibling spans — writing the
   line into the first duplicates the text (the rig caught it when it
   learned to assert exact text; the highlighter stub must also actually
   LOAD — a literal `\n` silently broke the injected script).
6. In ✏️ edit mode, no panel layer touches the file: the MutationObserver
   fires per keystroke and the colorizer overwrote live rows with old
   tokens ("what you type turns black"). The e2e watches with
   `entry._hlRuns`.
7. The hidden paired red row lives EARLIER in the DOM and matches needles:
   filter `getComputedStyle(r).display !== "none"` when looking for rows.
8. `installed_plugins.json` is the registry that decides which version is
   served: updating only the cache without the registry (or the other way
   around) = "the old one still runs".

## Installing a new version (the whole chain)

```bash
npm run build                     # 1) new bundle
# 2) marketplace copy (the app reinstalls from here):
rsync -a --delete --exclude node_modules diff-ask/ \
  ~/.zcode/cli/plugins/marketplaces/dev-zcode-diff-ask-<id>/diff-ask/
cp marketplace.json ~/.zcode/cli/plugins/marketplaces/dev-zcode-diff-ask-<id>/
# 3) per-version cache (what IS SERVED):
mkdir -p ~/.zcode/cli/plugins/cache/dev-zcode-diff-ask-<id>/diff-ask/<version>/
rsync -a --delete --exclude node_modules diff-ask/ …/diff-ask/<version>/
# 4) registry (WITH A BACKUP): version + installPath of the diff-ask@dev-… entry
cp ~/.zcode/cli/plugins/installed_plugins.json ~/.zcode/cli/plugins/installed_plugins.json.bak
# …and edit the JSON (version, installPath, updatedAt)
# 5) restart ZCode (the panel is served from the cache at startup).
```

Alternative via UI: version bump in `plugin.json` + `marketplace.json` →
`npm run build` → ZCode → Personal → dev-… → Update. Restart anyway.
