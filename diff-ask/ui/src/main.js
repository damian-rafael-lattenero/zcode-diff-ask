// Diff Ask panel — vanilla JS, rendered inside ZCode's session webview.
//
// Flow: connect to the host (App from the MCP Apps SDK), subscribe to the
// server's diff://workspace resource (reactive — no polling), and render each
// changed file with @pierre/diffs' FileDiff (the same library the host's own
// diff panel uses) with the gutter utility ON: hover a line → "+" → composer →
// app.sendMessage carries the question to the conversation anchored to
// path:line with the exact lines quoted.
//
// Shell: the diff scrolls in #root; below it live the pile (#pile, pending
// questions, editable in place) and the askbar (#askbar, always-visible box
// for free questions — Enter adds to the pile). "+" anchors exist at line
// level (gutter), file level (file header) and selection level (select text
// inside a rendered diff). "Send all" (⌘↵) sends ONE message with every
// pending question.

import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/core";
import { FileDiff, parsePatchFiles, isHighlighterLoaded, isHighlighterLoading, isHighlighterNull, getFiletypeFromFileName } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";
// Eager boot of the highlight engine (0.11.1): colors must not depend on the
// lib's lazy backend load. With the massive-diff cap big files never trigger
// it, and files opened before it landed used to stay plain forever.
import "../vendor/shiki-subset.mjs";
import {
  esc, extractLines, rangeLabel, quoteFor, diffTotals, buildAskMessage,
  compressRuns, linesLabel, quoteForRanges, revertLines, revertFrags,
  changedWordRanges, mergedOffToNew, newRangeToMergedSegs, wordRanges,
  anchorStillValid,
} from "./lib.js";
import { styleForLang, extOf, nameLangOf, langCounts } from "./lang-icons.js";

const DIFF_URI = "diff://workspace";
const app = new App({ name: "diff-ask", version: "0.1.0" }, {});

// Panel modes (0.10.0: TWO tabs — Damian's spec 22/11):
//   turns     → TURNS: the LAST executed turn with ALL its files (grouped by
//               repo and folder, git vs "Outside git" separated); the list
//               pages 10 at a time into the past.
//   working   → WORK PER REPOSITORY: the 📁 selector lives only here; the
//               default is the repo with the MOST changes of the last turn
//               (suggest_workspace); no suggestion → "select
//               repository…". The "Commits" button (internal sub-view, no
//               tab of its own) opens the chosen repo's history.
const MODES = [
  { id: "turns", label: "Turns", title: "Turn by turn: the files each one wrote — the same ones ZCode's end-of-turn summary lists, grouped by repo and folder (the last one, live)" },
  { id: "working", label: "Work per repository", title: "Uncommitted changes of the repository chosen with 📁 (vs HEAD + untracked); its Commits button opens the history" },
];
let mode = "turns";
let commitSel = null; // hash en vista de diff de commit (null = lista)
let turnSel = "latest"; // turn id in view (null = list; "latest" = live/last)
let turnsState = { list: [], skip: 0, hasMore: false, total: 0, sessionFilter: null };
let commitsState = { query: "", skip: 0, list: [], hasMore: false };
// In-flight flags for the two LIST views (0.11.0): while the first page is on
// its way the list renders skeleton rows instead of a blank/"No …" state.
let turnsLoading = false;
let commitsLoading = false;
let subscribedUri = null;
// Repo label (the server's OUTSIDE_LABEL — keep in sync) for files touched
// outside any git repo: the turns view renders this group as "Outside git".
const OUTSIDE_LABEL = "~";
// Collapsed turn-repo group labels — survives reactive re-renders.
const collapsedGroups = new Set();

// This panel's task sid, learned from whoami at boot (0.10.8). resources/
// read carries NO request context, so the server's cached sid is whoever
// called ANY tool last — in a multi-task app that silently re-scoped the
// panel's turn reads. Stamping it on the turn URIs pins OUR task's view.
let sessionSid = "";

const sidQ = (q) => (sessionSid ? `&sid=${encodeURIComponent(sessionSid)}` : "");
// Turn view, LIGHT (0.11.0): headers + counts only (KBs); each file's
// content rides `diff://file/…` when the user actually reaches it.
const turnViewUri = (id) => `diff://turn/${encodeURIComponent(id)}?light=1${sidQ()}`;
const turnFileUri = (turnId, path) =>
  `diff://file/${encodeURIComponent(turnId ?? "latest")}?path=${encodeURIComponent(path)}${sidQ()}`;

function diffUriFor() {
  if (mode === "turns" && turnSel) return turnViewUri(turnSel);
  if (mode === "commits" && commitSel) return `diff://commit/${encodeURIComponent(commitSel)}`;
  return DIFF_URI;
}

// Message scope: so the agent knows WHICH diff is being asked about.
function scopeLabel() {
  if (mode === "turns" && diffData?.turn) {
    const tn = diffData.turn;
    const repos = (tn.repos ?? []).map((r) => r.label).join(", ");
    return `turn ${tn.at?.slice(11, 16) ?? ""}${tn.isLive ? " (live)" : ""}${repos ? ` — repos: ${repos}` : ""}`.trim();
  }
  if (mode === "commits" && diffData?.commit) return `commit ${diffData.commit.short} ${diffData.commit.subject ?? ""}`.trim();
  return "";
}

// ------------------------------------------------- diff folder (📁)
// The server diffs its ACTIVE workspace (starts at the session's and is
// changed with the set_workspace tool). The chip shows which one it is and
// lets you switch to any local repo — switching clears ALL anchored state
// (collapsed files, pile, commits) because it belonged to the old folder.
let currentWorkspace = null;
// Has a repo actually been CHOSEN for the repo tab (by the last-turn
// suggestion or by the user)? Until it is, the repo tab shows its picker
// prompt instead of diffing whatever repo the session happens to live in
// (spec 22/11: an all-outside last turn ⇒ "select repository…").
let wsChosen = false;
// One in-flight suggestion at a time (refresh storms must not stampede
// suggest_workspace) — and ONE attempt per panel life: re-firing it on every
// reactive refresh of an unchosen repo tab was 0.10.0's freeze (each failed
// attempt cost a full turn-store parse server-side).
let wsSuggesting = false;
let wsSuggestTried = false;

function wsLabel() {
  if (!currentWorkspace) return "…";
  const parts = currentWorkspace.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? currentWorkspace;
}

function openWorkspaceEditor() {
  document.querySelectorAll(".ws-picker, .ws-editor").forEach((n) => n.remove());
  const card = document.createElement("div");
  card.className = "ws-editor";
  card.innerHTML = `
    <div class="ie-head"><span class="anchor">📁 Carpeta del diff</span><button class="ghost close" title="Cancel">✕</button></div>
    <input type="text" spellcheck="false">
    <div class="ie-actions"><span class="hint">Local path of a git repo · Enter applies · Esc cancels</span><button class="primary ok">Change</button></div>`;
  const input = card.querySelector("input");
  input.value = currentWorkspace ?? "";
  const close = () => card.remove();
  card.querySelector(".close").onclick = close;
  async function apply() {
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    if (await applyWorkspace(v)) close();
  }
  card.querySelector(".ok").onclick = apply;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); apply(); }
    if (e.key === "Escape") { e.preventDefault(); close(); }
  });
  document.body.appendChild(card);
  input.focus();
  input.select();
}

// Repo picker of the 📁 chip (spec Damian 28/10: "a small tree that I
// can go up and that filters only the folders with .git" [translated]). Starts at
// the PARENT of the current workspace, ⬆ goes up one level, and on every side lists ONLY
// git repos — bounded recursion, resolved by the SERVER (list_git_projects:
// the panel lives sandboxed and cannot read the disk). Live text filter on
// top of the list; "by hand" opens the usual path editor.
function wsParentOf(p) {
  if (!p) return null;
  const up = p.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
  return up === p ? null : (up || "/");
}

function openWorkspacePicker() {
  document.querySelectorAll(".ws-picker, .ws-editor").forEach((n) => n.remove());
  const card = document.createElement("div");
  card.className = "ws-picker";
  card.innerHTML = `
    <div class="ie-head">
      <button class="ghost up" title="Subir un nivel">⬆</button>
      <span class="crumb"></span>
      <button class="ghost close" title="Close">✕</button>
    </div>
    <input type="text" spellcheck="false" placeholder="filtrar por nombre…">
    <div class="ws-list"></div>
    <div class="ie-actions">
      <span class="hint">git folders only · click changes the diff</span>
      <button class="ghost manual">escribir la ruta a mano…</button>
    </div>`;
  const list = card.querySelector(".ws-list");
  const crumb = card.querySelector(".crumb");
  const upBtn = card.querySelector(".up");
  const filter = card.querySelector("input");
  const close = () => { card.remove(); document.removeEventListener("pointerdown", outside, true); };
  const outside = (e) => { if (!card.contains(e.target) && !e.target.closest?.("button.ws")) close(); };
  card.querySelector(".close").onclick = close;
  card.querySelector(".manual").onclick = () => { close(); openWorkspaceEditor(); };
  card.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } });

  let root = wsParentOf(currentWorkspace) ?? currentWorkspace ?? "~";
  let repos = [];

  const renderRows = () => {
    const q = filter.value.trim().toLowerCase();
    const hits = q ? repos.filter((r) => r.path.toLowerCase().includes(q)) : repos;
    // agent worktrees (hidden .worktrees container) jump to the TOP with a
    // tag: they are exactly what you come looking for and as plain rows they
    // drowned at the bottom of the depth-1 group (0.9.23)
    const ordered = hits.slice().sort((a, b) => (b.worktree ? 1 : 0) - (a.worktree ? 1 : 0));
    list.textContent = "";
    if (!ordered.length) {
      const d = document.createElement("div");
      d.className = "ws-empty";
      d.textContent = repos.length ? "nothing matches the filter" : "no git repos here — try ⬆";
      list.appendChild(d);
      return;
    }
    for (const r of ordered.slice(0, 120)) {
      const b = document.createElement("button");
      b.className = "ws-row" + (r.path === currentWorkspace ? " current" : "");
      if (r.worktree) {
        const tag = document.createElement("i");
        tag.className = "wt";
        tag.textContent = r.worktree; // container name sent by the server
        b.append(tag);
      }
      const name = document.createElement("b");
      name.textContent = r.name;
      const sub = document.createElement("span");
      const rel = r.path.startsWith(root + "/") ? r.path.slice(root.length + 1) : r.path;
      sub.textContent = r.depth ? `  ·${"…".repeat(Math.min(r.depth, 3))} ${rel}` : "";
      b.append(name, sub);
      b.onclick = () => applyWorkspace(r.path).then((ok) => { if (ok) close(); });
      list.appendChild(b);
    }
    if (ordered.length > 120) {
      const d = document.createElement("div");
      d.className = "ws-empty";
      d.textContent = `…and ${ordered.length - 120} more — narrow the filter`;
      list.appendChild(d);
    }
  };

  const load = async () => {
    crumb.textContent = root;
    const parent = wsParentOf(root);
    upBtn.disabled = !parent;
    upBtn.title = parent ? `Go up to ${parent}` : "You are already at the root";
    list.textContent = "";
    const d = document.createElement("div");
    d.className = "ws-empty";
    d.textContent = "searching repos…";
    list.appendChild(d);
    try {
      const res = await callTool("list_git_projects", { under: root });
      const sc = res?.structuredContent;
      if (!sc?.ok) throw new Error(sc?.message ?? "could not list");
      repos = sc.repos ?? [];
    } catch (e) {
      repos = [];
      chip(`⚠ ${e?.message ?? e}`);
    }
    renderRows();
  };

  upBtn.onclick = () => {
    const up = wsParentOf(root);
    if (!up || up === root) return;
    root = up;
    filter.value = "";
    load();
  };
  filter.addEventListener("input", renderRows);
  document.body.appendChild(card);
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  load();
  filter.focus();
}

async function applyWorkspace(p, { silent = false } = {}) {
  try {
    const res = await callTool("set_workspace", { path: p });
    const sc = res?.structuredContent;
    if (!sc?.ok) throw new Error(sc?.message ?? "could not change the folder");
    currentWorkspace = sc.workspace;
    wsChosen = true;
    collapsedPaths.clear();
    seenPaths.clear();
    pendingAsks.length = 0;
    commitsState = { query: "", skip: 0, list: [], hasMore: false };
    turnsState = { list: [], skip: 0, hasMore: false, total: 0, sessionFilter: null };
    commitSel = null;
    turnSel = mode === "turns" ? "latest" : null;
    await endAllEdits();
    renderPile();
    // Feedback: switching repo always reads the new tree (git status/diff).
    paintPendingView(`Loading ${wsLabel()}…`);
    await refresh(true);
    if (!silent) chip(`📁 ${wsLabel()}`);
    return true;
  } catch (e) {
    chip(`⚠ ${e?.message ?? e}`);
    return false;
  }
}

/** @type {any} */ let diffData = null;
/** @type {Map<string, {section: HTMLElement, body: HTMLElement, fd: import("@pierre/diffs").FileDiff|null, patch: string}>} */
const rendered = new Map();
// Pending question pile — kind: "line" (anchors path:lines), "file"
// (anchors the whole file) or "free" (no anchor, from the askbar). Survives
// live-diff refreshes; "Send all" (⌘↵) sends ONE single message.
/** @type {{kind:"line"|"file"|"free", path?:string, start?:number, lines?:string, label?:string, quoteLines?:string[], question:string}[]} */
const pendingAsks = [];
// Files collapsed by path — persists during the session across re-renders.
// Every NEW file (including at boot) is born COLLAPSED: the panel's initial
// state is all closed; what you open stays open across refreshes.
const collapsedPaths = new Set();
const seenPaths = new Set();
let theme = "light";

// ------------------------------------------------------------- diff text


// Colors of lines with a pending question: the row IS painted (style injected
// into pierre's shadow DOM) by its nature — very dark green/white
// (additions), very dark red/white (deletions), light gray/black (context).
const QA_STYLE = [
  // bg on the row; color on the row AND on all its spans (pierre's tokens
  // carry their own theme color and stay unreadable if not overridden).
  // CSS vars that inherit into the shadow DOM → they change with the theme.
  '[data-qa="add"]{background:var(--da-qa-add-bg,#0E4429) !important;box-shadow:inset 3px 0 0 var(--da-qa-add-bar,#3DD68C) !important;}',
  '[data-qa="add"],[data-qa="add"] *{color:var(--da-qa-add-fg,#FFFFFF) !important;}',
  '[data-qa="del"]{background:var(--da-qa-del-bg,#5A1E22) !important;box-shadow:inset 3px 0 0 var(--da-qa-del-bar,#F87171) !important;}',
  '[data-qa="del"],[data-qa="del"] *{color:var(--da-qa-del-fg,#FFFFFF) !important;}',
  '[data-qa="ctx"]{background:var(--da-qa-ctx-bg,#EBEBEF) !important;box-shadow:inset 3px 0 0 var(--da-qa-ctx-bar,#8B95A8) !important;}',
  '[data-qa="ctx"],[data-qa="ctx"] *{color:var(--da-qa-ctx-fg,#101014) !important;}',
].join("\n");

// The NUMBER is the checkbox (0.2.16): click on the gutter adds/removes the
// line; selected = cell filled with the number visible in contrast (you keep
// counting lines). Numbers +20% (1.2em) so they read as counters.
const SEL_STYLE = [
  "[data-gutter] > [data-line-index]{font-size:1.2em !important;}",
  "[data-gutter] > [data-line-index][data-da-sel]{background:var(--accent,#4268d8) !important;color:var(--accent-contrast,#ffffff) !important;font-weight:700 !important;border-radius:4px !important;}",
  "[data-gutter] > [data-line-index][data-da-sel] span{color:var(--accent-contrast,#ffffff) !important;}",
].join("\n");

function ensureShadowSelStyle(entry) {
  const sr = entry.body.querySelector("diffs-container")?.shadowRoot;
  if (!sr || sr.querySelector("style.da-sel")) return;
  const st = document.createElement("style");
  st.className = "da-sel";
  st.textContent = SEL_STYLE;
  sr.appendChild(st);
}

// ------------------------------------------- visibility filters + ⌘F
// Toggles per line type: the gutter cell carries the SAME
// data-line-type as its row, so hiding by selector hides row and
// number together (aligned columns). Hunk separators exist for
// collapsed context: with context hidden they go too.
// [data-da-find]: ⌘F search highlight (hit = row with a match,
// cur = current match).
const lineFilter = { add: true, del: true, ctx: true };
const EXTRA_STYLE = [
  ':host(.da-hide-add) [data-line-type="change-addition"]{display:none !important;}',
  ':host(.da-hide-del) [data-line-type="change-deletion"]{display:none !important;}',
  // context: TWO classes — pierre marks "context" the rendered threshold and
  // "context-expanded" the one the user expanded from a separator. Hiding
  // both = zero unchanged lines (otherwise expanded ones stay hanging).
  ':host(.da-hide-ctx) [data-line-type="context"]{display:none !important;}',
  ':host(.da-hide-ctx) [data-line-type="context-expanded"]{display:none !important;}',
  ':host(.da-hide-ctx) [data-separator]{display:none !important;}',
  // text selection with real contrast on both themes (pierre ships its own
  // muted one and on top it competes with the green/red row backgrounds)
  '::selection{background:var(--accent,#4268d8) !important;color:var(--accent-contrast,#ffffff) !important;}',
  '[data-da-find="hit"]{background:var(--da-find-hit,#E9C46A4D) !important;}', 
  '[data-da-find="cur"]{background:var(--da-find-cur,#E9C46AAA) !important;box-shadow:inset 3px 0 0 var(--accent,#4268d8) !important;}',
].join("\n");

function shadowHostOf(entry) {
  return entry.body.querySelector("diffs-container") ?? null;
}

function ensureShadowExtraStyle(entry) {
  const sr = shadowHostOf(entry)?.shadowRoot;
  if (!sr || sr.querySelector("style.da-extra")) return;
  const st = document.createElement("style");
  st.className = "da-extra";
  st.textContent = EXTRA_STYLE;
  sr.appendChild(st);
}

// Applies the current filters to a file (or all of them) and refreshes the
// header buttons. The classes live in the HOST (our light DOM): the
// shadow sees them via :host() and they survive its internal re-renders.
function applyLineFilter(entry = null) {
  const targets = entry ? [entry] : [...rendered.values()];
  for (const e of targets) {
    ensureShadowExtraStyle(e);
    const host = shadowHostOf(e);
    if (!host) continue;
    host.classList.toggle("da-hide-add", !lineFilter.add);
    host.classList.toggle("da-hide-del", !lineFilter.del);
    host.classList.toggle("da-hide-ctx", !lineFilter.ctx);
  }
  if (!entry) {
    document.querySelectorAll(".filt").forEach((b) => {
      const on = lineFilter[b.dataset.filt];
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }
}

// Is this row's line type hidden by the filter? (so ⌘F does not
// "find" invisible matches)
function rowHiddenByFilter(row) {
  const t = row.dataset.lineType;
  if (t === "change-addition") return !lineFilter.add;
  if (t === "change-deletion") return !lineFilter.del;
  if (t === "context" || t === "context-expanded") return !lineFilter.ctx;
  return false;
}

// ------------------------------------------------- live editing (✏️)
// The panel IS an editor: ✏️ hooks pierre's Editor onto that file's diff
// and every keystroke re-diffs LIVE (green/red instantly — the library's
// edit session re-renders hunk by hunk). IntelliJ-style saving
// (save-all-always): autosave with a 900ms debounce through the server's
// write_file tool, the editor's native ⌘Z, and "↩ Discard"
// restores the content from the moment of the ✏️. Conflict = AGENT WINS:
// if the file changed on disk, it is not overwritten — the panel's version
// goes to a shelve and the edit closes. While an edit is open, the reactive
// refresh stays PAUSED (the editor cannot survive a re-render);
// when it ends, it refreshes on its own.
function editingCount() {
  let n = 0;
  for (const e of rendered.values()) if (e.edit) n++;
  return n;
}

// Can this file be edited in the CURRENT view? Only the repo tab's working
// tree view, and only with full content.
function editableNow(f) {
  if (typeof f.after !== "string" || f.binary || f.status === "D") return false;
  if (mode === "working") return true;
  // turns are CROSS-REPO (files from worktrees of other repos, path
  // namespaced "<repo>/<path>"): the inline editor writes through the active
  // workspace and would hit the wrong repo — read-only there.
  return false;
}

function ensureEditBanner() {
  if (document.getElementById("editbanner")) return;
  const b = document.createElement("div");
  b.id = "editbanner";
  b.hidden = true;
  b.innerHTML = `<span class="msg"></span><button class="ghost close" title="Close">✕</button>`;
  b.querySelector(".close").onclick = () => (b.hidden = true);
  document.body.prepend(b);
}

function showEditBanner(msg, sticky = false) {
  ensureEditBanner();
  const b = document.getElementById("editbanner");
  b.querySelector(".msg").textContent = msg;
  b.hidden = false;
  clearTimeout(b._t);
  if (!sticky) b._t = setTimeout(() => (b.hidden = true), 8000);
}

function ensurePausedChip() {
  if (document.getElementById("pausedchip")) return;
  const c = document.createElement("div");
  c.id = "pausedchip";
  c.hidden = true;
  c.textContent = "✏️ editing — automatic refresh stays paused; it updates itself when you finish";
  document.body.prepend(c);
}

function updateEditUI() {
  ensurePausedChip();
  const paused = editingCount() === 0 && pendingRefresh;
  document.getElementById("pausedchip").hidden = editingCount() === 0;
  // last edit closed → apply the deferred refresh
  if (paused && pendingRefresh) {
    pendingRefresh = false;
    refresh();
  }
  const header = document.querySelector(".header");
  if (!header) return;
  let btn = header.querySelector(".discard-btn");
  const n = editingCount();
  if (n > 0) {
    if (!btn) {
      btn = document.createElement("button");
      btn.className = "ghost danger discard-btn";
      header.querySelector(".filt")?.before(btn);
    }
    btn.textContent = `↩ Discard (${n})`;
    btn.title = "Discard ALL my edits (goes back to the content from before each ✏️)";
    btn.onclick = discardAllEdits;
  } else if (btn) btn.remove();
}

async function startEditing(entry) {
  if (entry.edit || !entry.fd) return;
  try {
    if (typeof entry.fd.prepareForEditing === "function") await entry.fd.prepareForEditing();
  } catch { /* diff completo de entrada — no necesita hidratar */ }
  const origin = entry.fileData.after;
  const editor = new Editor("file-diff", {
    onChange: () => scheduleSave(entry),
  });
  const detach = editor.edit(entry.fd);
  entry.edit = { editor, detach, origin, lastSaved: origin, timer: null };
  // edit mode = PURE editor: no selections and no hover for THIS file
  setBoxSel(entry, new Set());
  hideHoverPlus();
  const chip = document.createElement("span");
  chip.className = "editing-chip";
  chip.textContent = "✏️ editando";
  entry.section.querySelector(".file-head .fplus")?.after(chip);
  entry.section.classList.add("editing");
  entry.editBtn?.classList.add("on");
  if (entry.editBtn) entry.editBtn.title = "Leave edit mode (saves)";
  editor.focus();
  updateEditUI();
}

function scheduleSave(entry) {
  const e = entry.edit;
  if (!e) return;
  clearTimeout(e.timer);
  e.timer = setTimeout(() => saveEntry(entry), 900);
}

async function saveEntry(entry) {
  const e = entry.edit;
  if (!e) return;
  const content = e.editor.getText();
  if (content === e.lastSaved) return;
  try {
    const res = await callTool("write_file", { path: entry.path, content, base: e.lastSaved });
    const sc = res?.structuredContent;
    if (sc?.ok) {
      e.lastSaved = content;
      return;
    }
    if (sc?.conflict) return handleConflict(entry, sc);
    throw new Error(sc?.message ?? "write_file with no response");
  } catch (err) {
    showEditBanner(`⚠ No pude guardar ${entry.path}: ${err?.message ?? err}`);
  }
}

// THE AGENT WINS: I close the editing session (discard the local session) and say where
// my version ended up (the server already shelved it with its .patch).
function handleConflict(entry, sc) {
  endEdit(entry, "discard");
  showEditBanner(sc.message ?? "The file changed on disk while you were editing (the agent wins).", true);
  if (editingCount() === 0) refresh();
}

function endEdit(entry, cleanUpMode = "complete") {
  const e = entry.edit;
  if (!e) return;
  clearTimeout(e.timer);
  try { e.detach(); } catch { /* ya desmontado */ }
  try { e.editor.cleanUp(cleanUpMode); } catch { /* idem */ }
  entry.edit = null;
  entry.section.classList.remove("editing");
  entry.section.querySelector(".editing-chip")?.remove();
  entry.editBtn?.classList.remove("on");
  if (entry.editBtn) entry.editBtn.title = "Edit this file right here (autosave, ⌘Z, ↩ discard)";
  updateEditUI();
}

async function saveAllEditing() {
  await Promise.all([...rendered.values()].filter((e) => e.edit).map((e) => saveEntry(e)));
}

// Termina TODAS las sesiones (tras guardar) y aplica el refresh diferido.
async function endAllEdits() {
  await saveAllEditing();
  for (const e of [...rendered.values()]) endEdit(e, "complete");
}

// "↩ Discard (N)": returns every file to the content from the moment of its ✏️.
// If the agent changed it in the meantime, the agent wins (drop, no shelve —
// my edits are no longer on disk, there is nothing to discard).
async function discardAllEdits() {
  for (const entry of [...rendered.values()]) {
    if (!entry.edit) continue;
    try {
      const res = await callTool("write_file", {
        path: entry.path,
        content: entry.edit.origin,
        base: entry.edit.lastSaved,
        on_conflict: "drop",
      });
      if (res?.structuredContent?.conflict)
        showEditBanner(`${entry.path}: ${res.structuredContent.message}`);
    } catch (err) {
      showEditBanner(`⚠ discard ${entry.path}: ${err?.message ?? err}`);
    }
    endEdit(entry, "discard");
  }
  refresh(true);
}

// ------------------------------------------------------- revert (↩)
// "Leave it as the original", IDE style (revert chunk / discard changes):
// by SELECTION (the checkboxes — green or red, same thing: the hunk covering
// those lines goes back to its before version) and by WHOLE file. The write
// goes through write_file → same AGENT WINS policy (conflict = shelve/notice,
// never overwrites). Reverting while the file is in ✏️ edit mode is blocked
// (the editor has its own document state).
async function writeReverted(entry, content, label) {
  try {
    const res = await callTool("write_file", { path: entry.path, content, base: entry.fileData.after });
    const sc = res?.structuredContent;
    if (sc?.ok) {
      setBoxSel(entry, new Set());
      chip(label);
      // the revert's OWN reload: do not wait for the reactive watcher (fs.watch
      // can swallow the event on macOS and the view kept the old
      // base → the next revert collided with disk and got shelved)
      refresh();
      return;
    }
    if (sc?.conflict) return showEditBanner(sc.message ?? "The file changed on disk (the agent wins).", true);
    throw new Error(sc?.message ?? "write_file with no response");
  } catch (e) {
    chip(`⚠ revert ${entry.path}: ${e?.message ?? e}`);
  }
}

function revertGuard(entry) {
  if (entry.edit) {
    chip("⚠ close the ✏️ edit of this file before reverting");
    return false;
  }
  if (typeof entry.fileData?.after !== "string" || typeof entry.fileData?.before !== "string") {
    chip("⚠ this file has no complete content (binary/large?)");
    return false;
  }
  return true;
}

// Revert the WHOLE file to its original version.
async function revertWholeFile(entryIn) {
  if (refreshInFlight) await refreshInFlight.catch(() => {});
  const entry = rendered.get(entryIn.path) ?? entryIn;
  if (!revertGuard(entry)) return;
  await writeReverted(entry, entry.fileData.before, `↩ ${entry.path} vuelto al original`);
}

// Revert EXACTLY the given lines (checkboxes or hover): the selected red
// ones come back (selOld), the selected green ones go away (selNew),
// the rest is untouched. The rebuild is revertLines (pure, tested)
// over the internal diff's hunkContent alignment.
async function revertKeys(entryIn, keys) {
  // The 0.6.1 race: the user edited (autosave to disk) but
  // the re-render may still be IN FLIGHT — with the old alignment, their
  // new lines were "context" (not revertible) or the base hash did not match
  // and the conflict fired against their own edit. We wait for the refresh and
  // re-resolve the file from the NEW render (the keys are new-side line
  // numbers: still valid).
  if (refreshInFlight) await refreshInFlight.catch(() => {});
  const entry = rendered.get(entryIn.path) ?? entryIn;
  if (!revertGuard(entry)) return;
  const diff = entry.fd?.getInputDiff?.();
  if (!diff || diff.isPartial || !Array.isArray(diff.hunks)) {
    chip("⚠ I do not have this file's alignment");
    return;
  }
  const selOld = new Set();
  const selNew = new Set();
  for (const k of keys) {
    const n = parseInt(k.slice(2), 10);
    if (k[0] === "A") selNew.add(n);
    else selOld.add(n);
  }
  if (!selOld.size && !selNew.size) return;
  const afterLines = entry.fileData.after.split("\n");
  const beforeLines = entry.fileData.before.split("\n");
  const newLines = revertLines(beforeLines, afterLines, diff.hunks, selOld, selNew);
  if (!newLines) {
    chip("⚠ I could not rebuild the revert (inconsistent alignment)");
    return;
  }
  // HONEST chip: if the rebuild is identical, those lines had no
  // changes to revert (e.g. context selected on its own).
  if (newLines.join("\n") === entry.fileData.after) {
    chip("⚠ those lines have no changes to revert");
    return;
  }
  const n = selOld.size + selNew.size;
  await writeReverted(entry, newLines.join("\n"), `↩ ${n} line${n === 1 ? "" : "s"} reverted`);
}

async function revertSelection(entry) {
  revertKeys(entry, selKeysOf(entry));
}


// ------------------------------------------------- syntax highlighting
// Languages of the bundled subset (vendor/shiki-subset) + aliases.
const HL_LANGS = new Set([
  "json", "yaml", "python", "typescript", "javascript", "markdown",
  "html", "css", "bash", "shellscript", "kotlin", "haskell",
  "yml", "py", "ts", "js", "md", "sh", "shell", "zsh", "kt", "hs",
  // nushell (0.9.19): the grammar registers BOTH ids and pierre maps
  // .nu → "nushell" — the panel asks through either of the two
  "nu", "nushell",
]);
// The engine (vendor/shiki-subset) tokenizes; pierre's RENDERER does not wire
// those tokens into our embedded context — so we paint the rows
// ourselves: every plain row has ONE content <span>; we replace it
// with spans colored per token. Idempotent per theme (data-hl); it re-
// paints in the anchors rAF (hunk expansion included) and when the
// theme changes. The quote/selection still read textContent (untouched).
const HL_THEME = () => (theme === "dark" ? "pierre-dark" : "pierre-light");
// Above this size the highlighter (JS regex engine, whole file per side)
// costs more than it gives: the file renders plain — content and diff are
// unchanged, only the colors are skipped. Bytes AND lines: a 3.5k-line file
// is ~200KB and its tokenization blocked the main thread for ~800 ms on the
// click (measured 23/11, real shiki + TS grammar).
const HL_MAX_CHARS = 200_000;
const HL_MAX_LINES = 1200;

// A file within the highlight budget? (bytes AND lines, both sides).
function hlAllowed(entry) {
  const f = entry.fileData;
  if (!f) return false;
  if ((f.after?.length ?? 0) > HL_MAX_CHARS || (f.before?.length ?? 0) > HL_MAX_CHARS) return false;
  const lines = Math.max(entry.afterLines?.length ?? 0, entry.beforeLines?.length ?? 0);
  return lines <= HL_MAX_LINES;
}

function hlColorize(entry, lang) {
  // IN EDIT MODE pierre's editor rules ALONE: its rows live re-rendering
  // on every keystroke (with SPAN mirrors hanging off the host) and fileData.after goes STALE
  // while editing — rewriting their innerHTML with tokens from the previous
  // content corrupted the render (what you typed showed black/overwritten, report
  // Damian 28/10). It was also the root of the old "duplicate edit".
  if (entry.edit) return;
  const api = globalThis.__DA_HL_READY;
  if (!api?.has(lang) || !hlAllowed(entry)) return;
  const themeName = HL_THEME();
  const content = shadowHostOf(entry)?.shadowRoot?.querySelector("[data-content]");
  if (!content) return;
  // FAST PATH before any tokenization: no row still waiting for THIS theme →
  // nothing to paint. Without this the whole file was re-tokenized on every
  // anchors pass (rAF after each shadow mutation) — the big-file freeze.
  const pending = [];
  for (const r of content.children)
    if (r.hasAttribute("data-line") && r.dataset.hl !== themeName) pending.push(r);
  if (!pending.length) return;
  // Tokenize ONCE per content+theme (memo on the entry): a later pass only
  // paints the NEW rows from the memo — no second tokenization of the file.
  const f = entry.fileData;
  const key = `${themeName}|${f.after?.length ?? -1}|${f.before?.length ?? -1}`;
  if (entry._hlCache?.key !== key) {
    const _t0 = performance.now();
    const afterTok = typeof f.after === "string" ? api.lines(f.after, lang, themeName) : null;
    const beforeTok = typeof f.before === "string" ? api.lines(f.before, lang, themeName) : null;
    // No theme registered yet (the lib sets it on its first tokenization):
    // do NOT cache the failure — a later pass retries once the theme lands.
    if (!afterTok && !beforeTok) return;
    entry._hlCache = { key, afterTok, beforeTok, ms: Math.round(performance.now() - _t0) };
    window.__DA_LAST_HL = { path: entry.path, ms: entry._hlCache.ms, lines: afterTok?.length ?? 0, at: Date.now() };
  }
  const { afterTok, beforeTok } = entry._hlCache;
  if (!afterTok && !beforeTok) return;
  entry._hlRuns = (entry._hlRuns ?? 0) + 1; // e2e rig telemetry (section O)
  for (const r of pending) {
    const isDel = r.dataset.lineType === "change-deletion";
    const toks = (isDel ? beforeTok : afterTok)?.[parseInt(r.dataset.line, 10) - 1];
    if (!toks) continue;
    if (!r.querySelector("span")) continue;
    // Replace the content of the WHOLE ROW, not of the first span: pierre's
    // tokens live in SEVERAL sibling spans and writing the whole line
    // into the first left the remaining originals = DUPLICATED
    // text ("kind: note: note", Damian's report in the app; the rig
    // did not see it because the assertions were substring-based).
    r.innerHTML = toks
      .map((tk) => (tk.color ? `<span style="color:${tk.color}">${esc(tk.content)}</span>` : esc(tk.content)))
      .join("");
    r.dataset.hl = themeName;
  }
}

// First paint of the colors is DEFERRED (idle): the diff must be on screen
// before the tokenizer runs — expanding a big file never blocks the click.
// requestIdleCallback is not in every webview: setTimeout(0) is the same
// "after paint" intent without a fixed delay.
function scheduleHighlight(entry, lang) {
  if (entry._hlScheduled || entry._hlCache) return;
  entry._hlScheduled = true;
  const run = () => {
    entry._hlScheduled = false;
    if (entry.fd && !entry.edit) hlColorize(entry, lang);
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 300 });
  else setTimeout(run, 0);
}

// The engine announces itself when it finishes loading (vendor/shiki-subset):
// files already on screen — or opened while it was loading — get their colors
// THEN. Reactive, no polling: expanding a file never waits on the engine.
window.addEventListener("da-hl-ready", () => {
  for (const entry of rendered.values()) {
    if (!entry.fd || !entry.fileData || entry.edit) continue;
    const l = getFiletypeFromFileName(entry.fileData.oldPath ?? entry.fileData.path);
    if (l && HL_LANGS.has(l)) scheduleHighlight(entry, l);
  }
});

// ------------------------------------------------------------ ⌘F search
// The webview has no native find (and the shadow DOM would break it anyway):
// our own bar. Match = row whose text contains the query
// (case-insensitive); the ROW is highlighted (hit) and the current one (cur, with the accent
// bar), Enter/⇧Enter cycle and scrollIntoView. If the row is in
// a collapsed file, it expands on jump.
const find = { q: "", hits: [], cur: -1, timer: null };

function ensureFindbar() {
  if (document.getElementById("findbar")) return;
  const bar = document.createElement("div");
  bar.id = "findbar";
  bar.hidden = true;
  bar.innerHTML = `
    <input id="findbar-input" type="search" placeholder="Buscar en el diff…">
    <span id="findbar-count" class="count"></span>
    <button class="ghost" id="findbar-prev" title="Coincidencia anterior (⇧Enter)">↑</button>
    <button class="ghost" id="findbar-next" title="Coincidencia siguiente (Enter)">↓</button>
    <button class="ghost" id="findbar-close" title="Close (Esc)">✕</button>`;
  document.body.prepend(bar);
  const input = bar.querySelector("#findbar-input");
  input.addEventListener("input", () => {
    clearTimeout(find.timer);
    find.timer = setTimeout(() => runFind(input.value), 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      findGo(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFindbar();
    }
  });
  bar.querySelector("#findbar-prev").onclick = () => findGo(-1);
  bar.querySelector("#findbar-next").onclick = () => findGo(1);
  bar.querySelector("#findbar-close").onclick = closeFindbar;
}

function clearFindMarks() {
  for (const entry of rendered.values()) {
    const sr = shadowHostOf(entry)?.shadowRoot;
    sr?.querySelectorAll("[data-da-find]").forEach((r) => r.removeAttribute("data-da-find"));
  }
}

function runFind(q, jump = true) {
  find.q = (q ?? "").trim();
  clearFindMarks();
  find.hits = [];
  find.cur = -1;
  const needle = find.q.toLowerCase();
  if (needle) {
    for (const entry of rendered.values()) {
      for (const row of contentRowsOf(entry)) {
        if (rowHiddenByFilter(row)) continue;
        if (row.textContent.toLowerCase().includes(needle)) find.hits.push({ entry, row });
      }
    }
  }
  const count = document.getElementById("findbar-count");
  if (count)
    count.textContent = find.q
      ? jump
        ? find.hits.length
          ? `1/${find.hits.length}`
          : "0/0"
        : `${find.hits.length}`
      : "";
  if (jump && find.hits.length) findGo(1, true);
  else if (!jump)
    find.hits.forEach(({ row }) => row.isConnected && row.setAttribute("data-da-find", "hit"));
}

function findGo(dir, first = false) {
  if (!find.hits.length) return;
  if (first) find.cur = 0;
  else find.cur = (find.cur + dir + find.hits.length) % find.hits.length;
  find.hits.forEach(({ row }) => {
    if (row.isConnected) row.setAttribute("data-da-find", "hit");
  });
  const cur = find.hits[find.cur];
  if (cur.row.isConnected) {
    cur.row.setAttribute("data-da-find", "cur");
    // the hit can live in a collapsed file: expand it
    if (cur.entry.section.classList.contains("collapsed")) {
      cur.entry.section.classList.remove("collapsed");
      collapsedPaths.delete(cur.entry.path);
      hydrateFileDiff(cur.entry);
      scheduleAnchors();
    }
    cur.row.scrollIntoView({ block: "center" });
  }
  const count = document.getElementById("findbar-count");
  if (count) count.textContent = `${find.cur + 1}/${find.hits.length}`;
}

function openFindbar() {
  ensureFindbar();
  const bar = document.getElementById("findbar");
  bar.hidden = false;
  const input = document.getElementById("findbar-input");
  input.focus();
  input.select();
}

function closeFindbar() {
  const bar = document.getElementById("findbar");
  if (bar) bar.hidden = true;
  find.q = "";
  clearFindMarks();
}

// ⌘F/ctrl+F opens the bar (even when focus is in the askbar); Esc closes it.
// Note: it arrives as key "f" and in the app's webview the event does arrive.
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    openFindbar();
    return;
  }
  if (e.key === "Escape" && !document.getElementById("findbar")?.hidden) closeFindbar();
});

function gutterCellsOf(entry) {
  const g = entry.body.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-gutter]");
  return g ? [...g.children].filter((c) => c.hasAttribute("data-line-index")) : [];
}

function gutterCellOf(entry, row) {
  return (
    gutterCellsOf(entry).find(
      (c) => c.getAttribute("data-line-index") === row.getAttribute("data-line-index"),
    ) ?? null
  );
}

function applyQuestionMarks() {  for (const [entryPath, entry] of rendered.entries()) {
    (entry.qaRows ?? []).forEach((el) => el.removeAttribute("data-qa"));
    entry.qaRows = [];
    const sr = entry.body.querySelector("diffs-container")?.shadowRoot;
    if (!sr) continue;
    if (!sr.querySelector("style.da-qa")) {
      const st = document.createElement("style");
      st.className = "da-qa";
      st.textContent = QA_STYLE;
      sr.appendChild(st);
    }
    const content = sr.querySelector("[data-content]");
    if (!content) continue;
    const crows = [...content.children].filter((r) => r.hasAttribute("data-line"));
    const grows = [...(sr.querySelector("[data-gutter]")?.children ?? [])].filter((r) =>
      r.hasAttribute("data-line-index"),
    );
    for (const a of pendingAsks) {
      // the GESTURE's span(s) rule: exactly the covered rows are painted
      // (multi-select = several runs). Fallback (asks without span):
      // anchors by number OF THE SIDE (no crossings).
      if (a.kind !== "line" || a.path !== entryPath) continue;
      const side = a.side ?? "additions";
      const end = a.end ?? a.start;
      let pairs = a.spans?.map((s) => [s.first, s.last]);
      if (!pairs && a.span) pairs = [{ first: a.span.first, last: a.span.last }].map((s) => [s.first, s.last]);
      if (!pairs) {
        // numeric fallback (multi-range if any, else start..end)
        const numRanges = a.ranges ?? [{ start: a.start, end }];
        pairs = numRanges.map((rg) => {
          let first = -1;
          let last = -1;
          crows.forEach((r, i) => {
            const t = r.dataset.lineType;
            const num =
              t === "context" && side === "deletions"
                ? parseInt(r.dataset.altLine ?? r.dataset.line, 10)
                : parseInt(r.dataset.line, 10);
            const belongs = t === "change-deletion" ? side === "deletions" : side === "additions";
            if (belongs && num >= rg.start && num <= rg.end) {
              if (first === -1) first = i;
              last = i;
            }
          });
          return first === -1 ? null : [first, last];
        }).filter(Boolean);
      }
      for (const [first, last] of pairs) {
        for (let i = first; i <= last; i++) {
          const r = crows[i];
          if (!r || entry.qaRows.includes(r)) continue;
          const t = r.dataset.lineType;
          const qa = t === "change-deletion" ? "del" : t === "change-addition" ? "add" : "ctx";
          r.setAttribute("data-qa", qa);
          entry.qaRows.push(r);
          const g = grows.find((x) => x.getAttribute("data-line-index") === r.getAttribute("data-line-index"));
          if (g) {
            g.setAttribute("data-qa", qa);
            entry.qaRows.push(g);
          }
        }
      }
    }
  }
}

// ------------------------------------------------------------------ ask

function chip(text) {
  const host = document.getElementById("pile") ?? document.getElementById("root");
  host.style.display = "";
  const c = document.createElement("div");
  c.className = "sent-chip sent";
  c.textContent = text;
  host.appendChild(c);
  setTimeout(() => {
    c.remove();
    renderPile();
  }, 10_000);
}

function flushFreeInput() {
  const input = document.getElementById("askbar-input");
  if (!input) return;
  const q = input.value.trim();
  if (!q) return;
  pendingAsks.push({ kind: "free", question: q });
  input.value = "";
  renderPile();
}

async function sendAllPending() {
  flushFreeInput();
  if (!pendingAsks.length) return;
  await saveAllEditing(); // save-all-always: nothing of mine is left unsaved
  const { n, text } = buildAskMessage(pendingAsks, scopeLabel());
  try {
    const res = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
    if (res && res.isError) throw new Error("host rejected sendMessage");
    chip(`✓ ${n} question${n === 1 ? "" : "s"} in the chat`);
  } catch {
    await app.updateModelContext({ content: [{ type: "text", text }] });
    chip(`↪ context ready (${n} question${n === 1 ? "" : "s"}) — send your message`);
  }
  pendingAsks.length = 0;
  renderPile();
  renderAnchors();
}

// span = {first, last} DOM indices of the EXACT rows the gesture covered
// (drag/hover/selection) — those and no others are painted. spans = list of
// spans for asks about SEVERAL fragments (the brush): the EXACT rows of each
// frag are marked, not the whole range in between (bug Damian 28/10).
function queueQuestion(path, range, quoteLines, question, span, spans, labelOverride) {
  if (!range) {
    // Ask anchored to the whole file: the "quote" is its mini-summary.
    pendingAsks.push({ kind: "file", path, label: "file", quoteLines, question });
  } else {
    const { side, lines, label } = rangeLabel(range);
    pendingAsks.push({
      kind: "line", path, start: range.start, end: range.end, lines,
      label: labelOverride ?? label, side, quoteLines, question, span, spans,
    });
  }
  renderPile();
  renderAnchors();
}

// ------------------------------------------------------------------ shell

// #root scrolls; #pile and #askbar live below, outside the scroll — the box
// stays ALWAYS visible at the bottom. It is created once and survives renderAll.
function ensureShell() {
  if (document.getElementById("askbar")) return;
  // Top progress bar (0.11.0): visible only while a read/tool call is in
  // flight (html[data-busy]); CSS owns the 150 ms delay + animation.
  const loadbar = document.createElement("div");
  loadbar.id = "loadbar";
  loadbar.setAttribute("aria-hidden", "true");
  const pile = document.createElement("div");
  pile.id = "pile";
  const askbar = document.createElement("div");
  askbar.id = "askbar";
  askbar.innerHTML = `
    <textarea id="askbar-input" rows="2" placeholder="Ask something about the diff (no anchor)…"></textarea>
    <div class="askbar-actions">
      <span class="hint">Enter adds to the pile · Shift+Enter line break · ⌘↵ sends everything</span>
      <button class="ghost danger" id="askbar-clear" title="Delete every pending question">🗑 Delete all</button>
      <button class="primary" id="askbar-send" disabled>Send all (⌘↵)</button>
      <span class="ver" title="Panel version — to know which build you are running"></span>
    </div>`;
  document.body.append(loadbar, pile, askbar);
  const input = askbar.querySelector("#askbar-input");
  const send = askbar.querySelector("#askbar-send");
  input.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      sendAllPending();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      flushFreeInput();
    }
  });
  send.onclick = () => sendAllPending();
  askbar.querySelector(".ver").textContent = `v${window.__DA_BUILD ?? "?"}`;
  askbar.querySelector("#askbar-clear").onclick = () => clearAllAsks();
}

// One ask out, everywhere: the pile item AND its painted marks/chips. The
// old pile ✕ only re-rendered the pile — the row highlight stayed painted
// forever after the agent edited the code (Damian's report 16/11: a selection
// could never be deleted again once the line had changed).
function removeAsk(i) {
  if (i < 0 || i >= pendingAsks.length) return;
  pendingAsks.splice(i, 1);
  renderPile();
  renderAnchors();
}

// The bottom trash: drop EVERY pending ask (line/file/free) and every mark.
function clearAllAsks() {
  pendingAsks.length = 0;
  renderPile();
  renderAnchors();
}

// The pile: every pending item is a card editable in place (click and type).
function renderPile() {
  const pile = document.getElementById("pile");
  if (!pile) return;
  const send = document.getElementById("askbar-send");
  if (send) {
    send.disabled = !pendingAsks.length;
    send.textContent = pendingAsks.length
      ? `Send all (${pendingAsks.length}) (⌘↵)`
      : "Send all (⌘↵)";
  }
  const hasChip = pile.querySelector(".sent-chip");
  pile.textContent = "";
  if (hasChip) pile.appendChild(hasChip);
  if (!pendingAsks.length && !hasChip) {
    pile.style.display = "none";
    return;
  }
  pile.style.display = "";
  if (!pendingAsks.length) return;

  const head = document.createElement("div");
  head.className = "pile-head";
  head.innerHTML = `<span class="pile-title"></span><button class="ghost pile-clear">Clear</button>`;
  head.querySelector(".pile-title").textContent =
    `${pendingAsks.length} question${pendingAsks.length === 1 ? "" : "s"} in the pile`;
  head.querySelector(".pile-clear").onclick = () => clearAllAsks();
  pile.appendChild(head);

  pendingAsks.forEach((a, i) => {
    const card = document.createElement("div");
    card.className = "pile-item";
    card.innerHTML = `
      <div class="pile-top"><span class="anchor"></span><button class="ghost rm" title="Quitar">✕</button></div>
      <textarea class="q-edit" rows="1"></textarea>`;
    const anchor = card.querySelector(".anchor");
    anchor.textContent =
      a.kind === "free" ? "💬 free" : a.kind === "file" ? `${a.path} · file` : `${a.path}:${a.lines}`;
    anchor.title = anchor.textContent;
    const ta = card.querySelector(".q-edit");
    ta.value = a.question;
    const fit = () => {
      ta.style.height = "auto";
      ta.style.height = `${ta.scrollHeight}px`;
    };
    ta.addEventListener("input", () => {
      a.question = ta.value;
      fit();
    });
    fit();
    card.querySelector(".rm").onclick = () => removeAsk(i);
    pile.appendChild(card);
  });
}

// The agent edited the code: pending LINE asks whose quoted line no longer
// matches the fresh content auto-drop (Damian's rule: once the line was
// edited the anchor is dead). Only POSITIVE mismatches drop — a missing row
// (collapsed hunk) keeps the ask and its head chip, and `free` asks never
// drop. Runs at the end of every renderAll, so a reactive refresh right after
// an agent write reconciles the pile by itself. ONLY in live-tree modes:
// asks anchor the working diff, so browsing Commits/Turns must not judge
// (let alone drop) them against other content.
function pruneStaleAsks() {
  if (!pendingAsks.length) return;
  if (diffData?.mode !== "working") return;
  let dropped = 0;
  for (let i = pendingAsks.length - 1; i >= 0; i--) {
    const a = pendingAsks[i];
    if (a.kind === "free") continue;
    const entry = rendered.get(a.path);
    if (!entry) { pendingAsks.splice(i, 1); dropped++; continue; } // file left the diff
    if (a.kind !== "line") continue;
    const row = findRow(entry, a.start, a.side);
    if (!row) continue; // hunk collapsed / row not rendered: keep + head chip
    if (!anchorStillValid(a.quoteLines, row.textContent)) { pendingAsks.splice(i, 1); dropped++; }
  }
  if (dropped) chip(`💬 ${dropped} question${dropped === 1 ? "" : "s"} dropped: the line changed`);
}

document.addEventListener("keydown", (e) => {
  if (
    (e.metaKey || e.ctrlKey) && e.key === "Enter" && pendingAsks.length &&
    !e.target.closest?.("textarea")
  ) {
    e.preventDefault();
    sendAllPending();
  }
});

// Enter = the popup's ↩ when there are painted words (spec Damian 27/10:
// "I press enter on the rollback" [translated] — confirm the surgical revert without going to look for
// the floating button). If focus is in a control (input, button,
// composer, findbar), Enter does its own thing and nothing here is touched.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  if (e.target?.closest?.("input, textarea, select, button, [contenteditable], .composer, #findbar")) return;
  if (document.querySelector(".composer")) return;
  const fb = document.getElementById("findbar");
  if (fb && !fb.hidden) return;
  const entry = lastPaintedEntry && rendered.get(lastPaintedEntry.path) ? lastPaintedEntry : null;
  if (!entry || entry.edit || !fragSel.get(entry.path)?.length) return;
  e.preventDefault();
  hideSelPop("enter");
  revertPainted(entry);
});

// -------------------------------------------------------------- composer
// DOM span of a range: the gesture's if "up to" was not touched; if it was
// extended by hand, first/last are re-anchored by number OF THE SIDE (the extension is
// numeric by definition).
function spanForRange(entry, range, baseSpan, origEnd) {
  if (baseSpan && range.end === origEnd) return baseSpan;
  const crows = contentRowsOf(entry);
  const side = range.side ?? "additions";
  const num = (r) => {
    const t = r.dataset.lineType;
    if (t === "context" && side === "deletions") return parseInt(r.dataset.altLine ?? r.dataset.line, 10);
    return parseInt(r.dataset.line, 10);
  };
  let first = -1;
  let last = -1;
  crows.forEach((r, i) => {
    const v = num(r);
    if (v >= range.start && v <= range.end) {
      if (first === -1) first = i;
      last = i;
    }
  });
  return first === -1 ? undefined : { first, last };
}

// The composer appears RIGHT BELOW the selected line (context in
// view), not at the bottom of the file. Hidden row → fallback to the body's bottom.
function positionComposerAtRow(entry, card, row) {
  entry.body.appendChild(card);
  card.classList.add("anchored");
  const bodyRect = entry.body.getBoundingClientRect();
  const top = row
    ? row.getBoundingClientRect().bottom - bodyRect.top + 6
    : 4; // no row (file ＋): glued to the top of the body, under the head
  card.style.top = `${top}px`;
  card.scrollIntoView({ block: "nearest" });
}



function openComposer(entry, path, range, opts = {}) {
  // working: the range can be EXTENDED in the composer ("up to line") — so
  // multi-line does not depend on drag: click a line and type how far.
  const working = { ...range };
  if (entry.fd)
    entry.fd?.setSelectedLines({ start: working.start, end: working.end, side: working.side, endSide: working.endSide });
  closeComposer(entry);
  const { label } = rangeLabel(working);
  const card = document.createElement("div");
  card.className = "composer";
  card.innerHTML = `
    <div class="composer-head">
      <span class="anchor"></span>
      <span class="range-ext" title="Extend the question up to that line">hasta <input type="number" min="${working.start}" step="1"></span>
      <button class="ghost close" title="Cancel">✕</button>
    </div>
    <textarea rows="3" placeholder="Ask about ${label}…"></textarea>
    <div class="composer-actions">
      <span class="hint">⌘↵ sends</span>
      <button class="ghost cancel">Cancel</button>
      <button class="primary ask">Ask</button>
    </div>`;
  const anchor = card.querySelector(".anchor");
  const paint = () => {
    anchor.textContent = `${path}:${rangeLabel(working).lines}`;
    ta.placeholder = `Ask about ${rangeLabel(working).label}…`;
  };
  const ext = card.querySelector(".range-ext input");
  ext.value = working.end;
  ext.addEventListener("input", () => {
    const v = parseInt(ext.value, 10);
    if (!Number.isNaN(v) && v >= working.start) {
      working.end = v;
      paint();
      entry.fd?.setSelectedLines({ start: working.start, end: working.end, side: working.side });
    }
  });
  const ta = card.querySelector("textarea");
  const ask = card.querySelector(".ask");
  const close = () => {
    card.remove();
    entry.fd?.setSelectedLines(null);
  };
  card.querySelector(".close").onclick = close;
  card.querySelector(".cancel").onclick = close;
  paint();

  function submit() {
    const q = ta.value.trim();
    if (!q) { ta.focus(); return; }
    // verbatim is valid only if the range was not extended by hand
    const verbatim = working.end === range.end ? opts.verbatim : null;
    queueQuestion(path, working, quoteFor(entry, working, verbatim), q, spanForRange(entry, working, opts.span, range.end));
    close();
  }
  ask.onclick = submit;
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
  });
  positionComposerAtRow(entry, card, opts.row ?? findRow(entry, range.end ?? range.start, range.side ?? "additions"));
  ta.focus();
}

function closeComposer(entry) {
  entry.section.querySelectorAll(".composer").forEach((n) => n.remove());
}

// ------------------------------------------------------------ selection
// ONE single selection model: the gutter CHECKBOXES (0.2.15). Click = add or
// remove a line; click and drag = paint/unpaint in paint mode; you
// can mark several scattered runs; the big ＋ lives below the
// LAST painted checkbox and opens the composer for the whole selection. The mouse
// text selection feeds the same model (with a VERBATIM quote).

// The <diffs-container> (our light DOM) containing the node, crossing
// the shadow root boundary — null if the selection is not from a diff.
function containerOf(node) {
  let root = node?.getRootNode?.();
  while (root instanceof ShadowRoot) {
    if (root.host?.tagName?.toLowerCase?.() === "diffs-container") return root.host;
    root = root.host.getRootNode();
  }
  return null;
}

// diagSel: persistent top-right chip narrating the selection→popup flow.
// TEST/E2E ONLY (18/11): in the real app it overlaid controls — it exists
// only under the harnesses (or ?diag=1); otherwise a silent no-op.
const diagSel = (() => {
  if (!(window.__DA_TEST__ || window.__DA_E2E__ || new URLSearchParams(window.location.search).has("diag")))
    return () => {};
  let el = null;
  return (msg) => {
    if (!el) {
      el = document.createElement("div");
      el.className = "diag-chip";
      document.body.appendChild(el);
    }
    el.__log = [...(el.__log ?? []), `${new Date().toLocaleTimeString()}.${String(Date.now() % 1000).padStart(3, "0")} ${msg}`].slice(-14);
    el.textContent = el.__log.join(" ⏐ ");
  };
})();

function selectionAsk() {
  const sel = document.getSelection();
  // WARNING: Chromium RETARGETS selections inside shadow roots — isCollapsed
  // returns true and the range stays in light DOM with 0×0 rects, BUT the text survives
  // (complete String(sel)). isCollapsed can NO LONGER decide alone: there is text, there is a selection.
  const text = sel?.toString() ?? "";
  if (!sel || !text.trim()) return diagNull("collapsed/empty text");
  if (sel.rangeCount) {
    const range = sel.getRangeAt(0);
    const host = containerOf(range.startContainer);
    if (host && containerOf(range.endContainer) === host) {
      const content = host.shadowRoot?.querySelector("[data-content]");
      if (content) {
        const rows = [...content.children].filter((r) => r.hasAttribute("data-line"));
        const selRows = rows.filter((r) => range.intersectsNode(r));
        if (selRows.length) {
          for (const e of rendered.values()) {
            if (e.body.contains(host)) {
              diagSel(`selchg → ${selRows.length} rows in ${e.path}`);
              return { entry: e, rows: selRows, text };
            }
          }
        }
      }
    }
  }
  // Path B (real Chromium): no usable range — match the TEXT against the
  // rows. The retargeted anchorNode stays in the file's light DOM: it tells us
  // which entry to look in first.
  return selectionFromText(sel, text);
}

// Line-by-line match: every line of the selected text corresponds to ONE
// diff row (the order is respected, a contiguous run starting at some row).
// Partial lines (half first/half last) match by mutual text
// inclusion; empty lines match any row (they do not discriminate).
function matchRowsToLines(rows, lines, near = -1) {
  // The retargeted String(sel) can arrive INFLATED (it brings extra content,
  // e.g. the whole file) and empty lines match any row. Empty
  // ones do NOT count: the run length = lines with content, and the
  // empty ones of the text can fall on any row of the run.
  const real = lines.map((l) => l.trim()).filter(Boolean);
  if (!real.length || real.length > rows.length) return null;
  const match1 = (line, row) => {
    const rowText = (row.textContent ?? "").trim();
    // Empty lines are NEVER a wildcard. The old behavior line.includes("") was always true,
    // so any line of text could match an empty line (e2e measured: double-clicking a Chinese ADR line ended up
    // pinning the frag on an empty line). Empty lines take no part in text matching.
    if (!rowText || !line) return false;
    // Single-line short content + includes direction = random hit (e2e measured: selecting
    // file-header text, 1-3 char short lines are all substrings of the file name, ghost frags
    // sprouted from nowhere and Esc only cleared the current file). Multi-line matching is already a strong signal, so no cap.
    if (real.length === 1 && rowText.length < 8 && line.length >= 8) return rowText === line;
    return rowText === line || rowText.includes(line) || line.includes(rowText);
  };
  const runs = [];
  for (let start = 0; start + real.length <= rows.length; start++) {
    let ok = true;
    for (let li = 0; li < real.length; li++) {
      if (!match1(real[li], rows[start + li])) { ok = false; break; }
    }
    if (ok) runs.push(start);
  }
  if (!runs.length) return null;
  // repeated or inflated text: the run CLOSEST to where you released
  // the mouse wins (real geometry), and among ties the SHORTEST one in
  // distance
  let start = runs[0];
  let best = Infinity;
  for (const r of runs) {
    const d = near >= 0 ? Math.abs(r + real.length / 2 - near) : r === 0 ? 0 : Infinity;
    if (d < best) { best = d; start = r; }
  }
  return rows.slice(start, start + real.length);
}

function selectionFromText(sel, text) {
  const lines = text.split("\n");
  const candidates = [...rendered.values()];
  // retargeted anchorNode (light DOM): if it falls in an entry, that is the file
  const an = sel.anchorNode;
  const byAnchor = an ? candidates.filter((e) => e.body === an || e.body.contains?.(an) || an.contains?.(e.body)) : [];
  for (const e of [...new Set([...byAnchor, ...candidates])]) {
    if (e.edit) continue;
    const rows = contentRowsOf(e);
    // geometric hint: the row under this file's last pointerup
    const near = selPopAt ? rows.indexOf(rowFromPoint(selPopAt.x, selPopAt.y, e)) : -1;
    const matched = matchRowsToLines(rows, lines, near);
    if (matched) {
      diagSel(`selchg → ${matched.length} rows by TEXT (retarget) in ${e.path}`);
      return { entry: e, rows: matched, text };
    }
  }
  return diagNull("text with no contiguous match in the rows");
}

function diagNull(gate) {
  diagSel(`selchg → null (${gate})`);
  return null;
}

// boxSel: Map<path, Set<key>> — key "A:<n>" (additions/context, new
// number) | "D:<n>" (deletions, old number). entry.selVerbatim: verbatim quote
// while the selection came from the mouse over text (a checkbox invalidates it).
const boxSel = new Map();

function keyOfRow(row) {
  return row.dataset.lineType === "change-deletion"
    ? `D:${row.dataset.line}`
    : `A:${row.dataset.line}`;
}

function selKeysOf(entry) {
  return boxSel.get(entry.path) ?? new Set();
}

function setBoxSel(entry, keys, verbatim = null) {
  if (keys.size) boxSel.set(entry.path, keys);
  else {
    boxSel.delete(entry.path);
    hideSelPop(); // selection cleared by any path → no popup left hanging
  }
  entry.selVerbatim = verbatim;
  renderSelUI(entry);
}

function selectedRowsOf(entry) {
  const keys = selKeysOf(entry);
  if (!keys.size) return [];
  return contentRowsOf(entry).filter((r) => keys.has(keyOfRow(r)));
}

// Paints a file's selection: tinted stripe per row + filled NUMBER
// (the checkbox IS the number) + big ＋ below the last selected one.
function renderSelUI(entry) {
  if (!entry.fd) {
    entry.body.querySelector(".sel-layer")?.remove(); // lazy: no rows to paint
    return;
  }
  let layer = entry.body.querySelector(".sel-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "sel-layer";
    entry.body.appendChild(layer);
  }
  layer.textContent = "";
  ensureShadowSelStyle(entry);
  // number fill: clear the old ones, mark the selected ones
  for (const cell of gutterCellsOf(entry)) cell.removeAttribute("data-da-sel");
  if (entry.section.classList.contains("collapsed")) return;
  const rows = contentRowsOf(entry);
  if (!rows.length) return;
  const keys = selKeysOf(entry);
  const bodyRect = entry.body.getBoundingClientRect();
  let last = null;
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const k = keyOfRow(row);
    if (!keys.has(k)) continue;
    const r = row.getBoundingClientRect();
    const stripe = document.createElement("div");
    stripe.className = "drag-stripe";
    stripe.dataset.k = k;
    stripe.style.top = `${r.top - bodyRect.top}px`;
    stripe.style.height = `${r.height}px`;
    frag.appendChild(stripe);
    gutterCellOf(entry, row)?.setAttribute("data-da-sel", "");
    last = row;
  }
  layer.appendChild(frag);
  if (!last) return;
  const big = document.createElement("button");
  big.className = "big-plus";
  big.textContent = "＋";
  big.title = "Ask about the selection";
  const br = last.getBoundingClientRect();
  big.style.top = `${br.bottom - bodyRect.top + 3}px`;
  big.style.left = "2px"; // left rail (the number no longer takes its own checkbox)
  big.onclick = () => openComposerMulti(entry);
  layer.appendChild(big);
  // Chunk revert (IDE-style): the blocks covered by the selection go back to
  // the original. Needs full before content; only the repo tab's working
  // view writes (turns/commits are read-only views).
  if (typeof entry.fileData?.before === "string" && mode === "working") {
    const rev = document.createElement("button");
    rev.className = "big-plus big-revert";
    rev.textContent = "↩";
    rev.title = "Revert the selection to the original (green and red alike)";
    rev.style.top = big.style.top;
    rev.style.left = "36px";
    rev.onclick = () => revertSelection(entry);
    layer.appendChild(rev);
  }
}

// In-place change of one selected line (no rebuild: drag stays fluid).
function applyBoxState(entry, key, on, row) {
  const keys = selKeysOf(entry);
  if (on) keys.add(key);
  else keys.delete(key);
  if (keys.size) boxSel.set(entry.path, keys);
  else boxSel.delete(entry.path);
  entry.selVerbatim = null; // touched a number: the quote comes from the lines
  if (row) {
    const cell = gutterCellOf(entry, row);
    if (on) cell?.setAttribute("data-da-sel", "");
    else cell?.removeAttribute("data-da-sel");
  }
  const layer = entry.body.querySelector(".sel-layer");
  const stripe = layer?.querySelector(`.drag-stripe[data-k="${CSS.escape(key)}"]`);
  if (on && row && !stripe) {
    const st = document.createElement("div");
    st.className = "drag-stripe";
    st.dataset.k = key;
    const r = row.getBoundingClientRect();
    const bodyRect = entry.body.getBoundingClientRect();
    st.style.top = `${r.top - bodyRect.top}px`;
    st.style.height = `${r.height}px`;
    layer.appendChild(st);
  } else if (!on && stripe) stripe.remove();
}

// Gesture over the GUTTER: click on a number = select/deselect
// that line; drag = paint mode (paints or unpaints, according to the state of the
// number where it started) everything traversed.
let boxDrag = null;
document.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const body = e.target.closest?.(".file-body");
  if (!body) return;
  // edit mode: the gutter belongs to the editor — no checkboxes and no own drag
  {
    let en = null;
    for (const cand of rendered.values()) if (cand.body === body) { en = cand; break; }
    if (en?.edit) return;
  }
  // do not intervene on our own UI
  if (e.target.closest?.(".inline-editor, .line-marker, .head-marker, .composer, .big-plus, .hover-plus, .sel-layer")) return;
  let entry = null;
  for (const en of rendered.values()) if (en.body === body) { entry = en; break; }
  if (!entry) return;
  const g = entry.body.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-gutter]");
  if (!g) return;
  const gr = g.getBoundingClientRect();
  if (e.clientX < gr.left - 4 || e.clientX > gr.right + 14) return; // numbers zone only
  const row = rowFromPoint(e.clientX, e.clientY, entry);
  if (!row) return;
  hideHoverPlus();
  e.stopPropagation(); // the session is ours: the lib does not start its own
  e.preventDefault(); // no native text selection left hanging after the drag
  const key = keyOfRow(row);
  const mode = !selKeysOf(entry).has(key);
  boxDrag = { entry, mode, x0: e.clientX, y0: e.clientY, moved: false };
  applyBoxState(entry, key, mode, row);
}, true);

document.addEventListener("pointermove", (e) => {
  if (!boxDrag) return;
  if (Math.hypot(e.clientX - boxDrag.x0, e.clientY - boxDrag.y0) > 4) boxDrag.moved = true;
  if (!boxDrag.moved) return;
  const row = rowFromPoint(e.clientX, e.clientY, boxDrag.entry);
  if (row) applyBoxState(boxDrag.entry, keyOfRow(row), boxDrag.mode, row);
});

function endBoxDrag(e) {
  if (!boxDrag) return;
  const { entry } = boxDrag;
  boxDrag = null;
  renderSelUI(entry); // franjas + ＋ grande recalculados al terminar el gesto
  // 0.7.3: the floating popup also for the CHECKBOX selection (the panel's
  // classic gesture) — not only for mouse text. Anchor: the point where
  // you released (pointerup coords — selPopAt is not updated yet: this
  // listener runs before the anchoring one) + rect of the last painted row.
  const keys = selKeysOf(entry);
  if (!keys.size || entry.edit) return hideSelPop();
  const rows = selectedRowsOf(entry);
  const lastRect = rows.length ? rows[rows.length - 1].getBoundingClientRect() : null;
  showSelPop(entry, {
    x: e?.clientX ?? 100,
    y: e?.clientY ?? 100,
    top: lastRect ? lastRect.top : 0,
    bottom: lastRect ? lastRect.bottom : 0,
  });
}
document.addEventListener("pointerup", endBoxDrag, true);
document.addEventListener("pointercancel", endBoxDrag, true);

// Mouse text selection → the SAME checkbox model (with verbatim)
// and the floating ＋/↩ popup anchored to where the gesture ended.
let selTimer = null;
document.addEventListener("selectionchange", () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(paintCurrentSelection, 150);
});

// SINGLE painting flow (0.8.4): 1) drag geometry (caret over the
// shadow — immune to Chromium's retargeting); 2) text match (fallback);
// 3) nothing. Before, selectionAsk was the gatekeeper and if its inflated text did not
// match, painting died even when the drag geometry was perfect.
function paintCurrentSelection() {
  if (dragActive) return; // mid-drag we do not paint: the selection decides on RELEASE
  // click on our UI (↩/＋/modes): the selectionchange that follows is the
  // click's settle with the OLD selection hanging — do not repaint (stray)
  if (lastUiPointer) return;
  const sel = document.getSelection();
  if (!sel || !String(sel).trim()) {
    if (!boxSel.size && !fragSelTotal()) hideSelPop("selected nothing");
    return;
  }
  // 1) known drag → entry by hit-test of the starting point, frag by carets
  if (dragPath && Date.now() - dragPath.live < 1500) {
    const A = pointToRowInfo(dragPath.x0, dragPath.y0, true);
    diagSel(`caret A=${A?.fail ?? A?.entry?.path.slice(-18) + "@" + A?.idx ?? "fuera"} drag=${dragPath.x0},${dragPath.y0}`);
    const entry = A?.entry && rendered.get(A.entry.path) ? A.entry : null;
    if (entry && !entry.edit) {
      const byCaret = caretFrag(entry);
      if (byCaret) return void toggleFrag(entry, byCaret);
      diagSel("caretFrag ✗ over the drag entry (falls back to text match)");
    }
  }
  // 2) fallback: selection → rows by range/text → derived offsets
  const info = selectionAsk();
  if (info && !info.entry.edit) paintFromSelection(info.entry, info.rows, info.text);
  else if (info?.entry?.edit) diagSel("selchg → file in edit mode, ignored");
}

// 0.7.4 backup: if for whatever reason the selectionchange never arrives (odd
// webview, focus, IME), pointerup retries the same flow 180ms later.
// It NEVER HIDES: with no selection it does nothing (the gutter popup
// just created by endBoxDrag must survive this path).
document.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return;
  // click on our UI (↩/＋ popup, buttons): the selection left
  // hanging is the gesture's OLD one — do not repaint it by text (stray)
  if (e.target?.closest?.(".sel-pop, .hover-plus, .big-plus, .fmode, .composer, button")) return;
  setTimeout(() => {
    if (selPop) return;
    if (dragActive) return;
    const sel = document.getSelection();
    if (!sel || !String(sel).trim()) return; // retarget: no confiar en isCollapsed
    const before = fragSelTotal();
    paintCurrentSelection();
    if (fragSelTotal() > before) diagSel("pointerup fallback → painted");
  }, 180);
}, true);

// --------------------------------- floating ＋/↩ popup of the selection
// When you release the mouse over diff text the TWO buttons appear floating
// glued to where the gesture ended: ＋ asks about the selection, ↩ reverts
// ONLY what is selected. They do exactly the same as the big ＋ and the big ↩
// that stay under the last line — the popup is the immediate shortcut,
// the big ones remain the anchor when you scroll. It goes away on its own: scroll, click
// outside, Esc, new/collapsed selection or re-render.
let selPop = null;
let selPopAt = null;

function hideSelPop(why = "") {
  if (selPop && why) diagSel(`popup fuera (${why})`);
  selPop?.remove();
  selPop = null;
}

// last mouse position: it is the popup's natural anchor (where you released)
document.addEventListener("pointerup", (e) => {
  if (e.button === 0) selPopAt = { x: e.clientX, y: e.clientY };
}, true);

// anchor (optional): {x, y, top, bottom} — for the CHECKBOX selection, which
// has no native selection (collapsed range rect = 0 and the gate kills it).
function showSelPop(entry, anchor = null, actions = null) {
  let rect;
  let p;
  if (anchor?.row) {
    // END-OF-SELECTION anchor (spec Damian): the last selected row, glued
    // to the right edge of ITS TEXT (the content span; the row is the whole
    // file width and would send the popup to the right margin) — it floats IN the
    // text area, not on the rails.
    const rr = anchor.row.querySelector("span")?.getBoundingClientRect() ?? anchor.row.getBoundingClientRect();
    rect = { top: rr.top, bottom: rr.bottom, left: rr.left, right: rr.right, width: rr.width, height: rr.height };
    p = null;
  } else if (anchor) {
    rect = { top: anchor.top, bottom: anchor.bottom, left: anchor.x, right: anchor.x, width: 1, height: 1 };
    p = { x: anchor.x, y: anchor.y };
  } else {
    const sel = document.getSelection();
    rect = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    if (!rect || (!rect.width && !rect.height)) {
      diagSel("showSelPop → rect 0×0, no popup (selection retargeted?)");
      return;
    }
    p = selPopAt;
  }
  hideSelPop();
  const pop = document.createElement("div");
  pop.className = "sel-pop";
  const ask = document.createElement("button");
  ask.textContent = "＋";
  ask.title = "Ask about the selection";
  ask.onclick = () => { hideSelPop(); actions?.frag ? openFragComposer(entry) : openComposerMulti(entry); };
  pop.appendChild(ask);
  // ↩ only if there is an original to go back to (a new file has none)
  if (typeof entry.fileData?.before === "string") {
    const rev = document.createElement("button");
    rev.className = "rev";
    rev.textContent = "↩";
    rev.title = "Revert the selection to the original";
    rev.onclick = () => { hideSelPop(); actions?.frag ? revertPainted(entry) : revertSelection(entry); };
    pop.appendChild(rev);
  }
  // own pointerdown without collapsing the native selection when touching a button
  pop.addEventListener("pointerdown", (e) => e.preventDefault());
  document.body.appendChild(pop);
  selPop = pop;
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let x;
  let y;
  if (anchor?.row) {
    // at the end of the last line: glued to the text's right edge, above
    x = rect.right - w + 10;
    y = rect.top - h - 6;
  } else if (p && p.y >= rect.top - 60 && p.y <= rect.bottom + 60) {
    x = p.x - w / 2;
    y = p.y - h - 10;
  } else {
    x = rect.right - w;
    y = rect.top - h - 6;
  }
  x = Math.min(Math.max(6, x), Math.max(6, window.innerWidth - w - 6));
  if (y < 6) y = Math.min(rect.bottom + 8, Math.max(6, window.innerHeight - h - 6));
  pop.style.left = `${Math.round(x)}px`;
  pop.style.top = `${Math.round(y)}px`;
  diagSel(`popup ＋${pop.children.length > 1 ? "↩" : ""} @${Math.round(x)},${Math.round(y)} (${anchor?.row ? "selection end" : anchor ? "gutter" : "text"})`);
}

// the popup loses its anchor when scrolling: it goes away (the big ones stay)
document.addEventListener("scroll", () => hideSelPop("scroll"), { capture: true, passive: true });
document.addEventListener("pointerdown", (e) => {
  if (selPop && !selPop.contains(e.target)) hideSelPop("click afuera");
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideSelPop("esc");
});

// ------------------------------------------------ surgical painting
// 0.8.0 — text selection is its OWN channel, separate from the gutter
// checkboxes (which stay exactly as they were). frags per file:
// {firstRowIdx, lastRowIdx, offA, offB, text} — flat offsets [A,B) over
// the first/last row's text (intermediate ones go whole).
// Per-file mode (?/↩ buttons next to ✏️): neutral = SINGLE paint with
// immediate popup; mode = cumulative with toggle (painting over painted
// unpaints); the button becomes ✓-execute; Esc unpaints the active file's.
const fragSel = new Map(); // path → [frag...]
const fragModes = new Map(); // path → "ask" | "rev"
let lastPaintedEntry = null;

function fragSelTotal() {
  let n = 0;
  for (const v of fragSel.values()) n += v.length;
  return n;
}

// Internal range over a row's span for flat offsets [a,b]. The
// ROOT CAUSE of 0.8.6: CHARACTER offsets must be resolved down to the
// real TEXT node (highlight tokens are nested spans — `code`
// with backticks, markdown bold — and setStart/setEnd on an ELEMENT
// interprets the offset as a CHILD INDEX: "no child at offset N"). The
// recursive locator walks down the subtrees accumulating length.
function locatePlain(node, target, posRef) {
  if (node.nodeType === 3) {
    if (posRef.pos + node.data.length >= target) {
      return { node, offset: Math.max(0, Math.min(target - posRef.pos, node.data.length)) };
    }
    posRef.pos += node.data.length;
    return null;
  }
  for (const c of node.childNodes) {
    const r = locatePlain(c, target, posRef);
    if (r) return r;
  }
  return null;
}

function plainOffsetToRange(span, a, b) {
  const len = span.textContent.length;
  a = Math.max(0, Math.min(a, len));
  b = Math.max(a, Math.min(b, len));
  const A = locatePlain(span, a, { pos: 0 }) ?? { node: span, offset: span.childNodes.length };
  const B = locatePlain(span, b, { pos: 0 }) ?? { node: span, offset: span.childNodes.length };
  const range = document.createRange();
  range.setStart(A.node, A.offset);
  try {
    range.setEnd(B.node, B.offset);
  } catch {
    range.setEnd(span, span.childNodes.length);
  }
  return range;
}

// ----------------------------------------------------- row spaces
// A pair's green row carries the REMOVED text struck inline (spans
// [data-da-del], spec 0.9.8 "I also want to read what was there before" [translated]): its
// textContent is NO LONGER the file's line. Two offset spaces coexist:
//   merged = the whole textContent (what hit-tests and locatePlain measure)
//   new    = text WITHOUT the strikethroughs — the line on disk; new-side frags
//            and the revert surgery ALWAYS speak this language
// rowSpaces maps each struck run to its merged range [mStart,mEnd).
function rowSpaces(row) {
  let txt = "";
  const dels = [];
  const walk = (node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) txt += c.data;
      else if (c.nodeType === 1) {
        const s = txt.length;
        walk(c);
        if (c.hasAttribute?.("data-da-del")) dels.push({ el: c, mStart: s, mEnd: txt.length, text: txt.slice(s) });
      }
    }
  };
  walk(row);
  return { merged: txt, dels };
}
const isDelEl = (n) => n.nodeType === 1 && n.hasAttribute?.("data-da-del");
// the row's new text (without the struck runs)
function rowNewText(row) {
  const { merged, dels } = rowSpaces(row);
  if (!dels.length) return merged;
  let out = "";
  let cur = 0;
  for (const d of dels) { out += merged.slice(cur, d.mStart); cur = d.mEnd; }
  return out + merged.slice(cur);
}
// merged → new (surgery offset): subtract the struck chars before mOff
function mergedToNew(row, mOff) {
  return mergedOffToNew(rowSpaces(row).dels, mOff);
}
// new [a,b) → merged segments (split by the struck runs in between):
// stripes and boxes paint the new text WITHOUT invading the strikethroughs
function newToMergedSegs(row, a, b) {
  const { merged, dels } = rowSpaces(row);
  return newRangeToMergedSegs(dels, merged.length, a, b);
}
function locatePlainNS(node, target, posRef) {
  if (node.nodeType === 3) {
    if (posRef.pos + node.data.length >= target) {
      return { node, offset: Math.max(0, Math.min(target - posRef.pos, node.data.length)) };
    }
    posRef.pos += node.data.length;
    return null;
  }
  if (isDelEl(node)) return null; // el run tachado no existe en espacio new
  for (const c of node.childNodes) {
    const r = locatePlainNS(c, target, posRef);
    if (r) return r;
  }
  return null;
}
// Range over offsets in NEW space: on rows without strikethroughs it is identical to
// plainOffsetToRange (that is why the checkboxes/dots ALWAYS use this one)
function plainOffsetToRangeNS(span, a, b) {
  const len = rowNewText(span).length;
  a = Math.max(0, Math.min(a, len));
  b = Math.max(a, Math.min(b, len));
  const A = locatePlainNS(span, a, { pos: 0 }) ?? { node: span, offset: span.childNodes.length };
  const B = locatePlainNS(span, b, { pos: 0 }) ?? { node: span, offset: span.childNodes.length };
  const range = document.createRange();
  range.setStart(A.node, A.offset);
  try {
    range.setEnd(B.node, B.offset);
  } catch {
    range.setEnd(span, span.childNodes.length);
  }
  return range;
}

// Text drag path: the gesture's start and end points. With Chromium's
// retargeting neither the range nor (sometimes) the newlines of
// String(sel) are reliable — caretRangeFromPoint over THESE points does
// cross the shadow root and gives exact row+offset.
let dragPath = null;
let dragActive = false; // button held: no painting mid-gesture
let lastUiPointer = false; // the last pointerdown fell on the panel's UI
document.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  // detail: 1=single, 2=double (word), 3+=triple (line) — the NATIVE mouse
  // gesture defines the painting semantics, just like in an editor.
  // "at" = gesture birth (stable id for the toggle dedupe);
  // "live" = last activity — a human multi-line drag takes >1.2s and the
  // geometric path cannot die mid-gesture (it fell back to text
  // matching: twin paints + "hard to select").
  dragPath = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, at: Date.now(), live: Date.now(), detail: e.detail || 1 };
  dragActive = true;
  lastFragPaint = null;
  lastUiPointer = !!e.target?.closest?.(".sel-pop, .hover-plus, .big-plus, .fmode, .composer, button");
}, true);
// native click: the click's detail is the browser's REAL count (the
// synthetic/CDP pointerdown sometimes carries detail=1 on the third click of a
// triple-click — the click does know it was the third).
document.addEventListener("click", (e) => {
  if (e.detail > 1 && dragPath) dragPath.detail = Math.max(dragPath.detail || 1, e.detail);
}, true);
document.addEventListener("pointerup", (e) => {
  if (e.button === 0) { dragActive = false; if (dragPath) dragPath.live = Date.now(); }
}, true);
document.addEventListener("pointercancel", () => { dragActive = false; }, true);
document.addEventListener("pointermove", (e) => {
  if (dragPath && (e.buttons & 1)) { dragPath.x1 = e.clientX; dragPath.y1 = e.clientY; dragPath.live = Date.now(); }
}, true);

// geometric frag: hit-test of the drag's ends against the shadow DOM
// (shadowRoot.elementFromPoint DOES return the inner element — and the
// highlighting spans are tokens, so summing previous siblings gives an offset
// with word precision). caretRangeFromPoint does NOT work: it retargets.
// character offset inside the span whose horizontal position ≈ x, by
// binary search over getBoundingClientRect of internal ranges (shadow
// rects ARE real geometry even when the Selection retargets).
function offsetAtX(span, x) {
  const len = span.textContent.length;
  if (!len) return 0;
  const sr = span.getBoundingClientRect();
  if (x <= sr.left) return 0;
  if (x >= sr.right) return len;
  let lo = 0;
  let hi = len;
  try {
    for (let i = 0; i < 18 && hi - lo > 1; i++) {
      const mid = (lo + hi) >> 1;
      const r = plainOffsetToRange(span, 0, mid).getBoundingClientRect();
      if (!r.width && !r.height) { lo = mid; continue; }
      if (r.right < x) lo = mid;
      else hi = mid;
    }
  } catch { /* binaria interrumpida: devolvemos lo mejor visto */ }
  return lo;
}

function pointToRowInfo(x, y, why = false) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return why ? { fail: "coords" } : null;
  for (const e of rendered.values()) {
    const host = e.body.querySelector("diffs-container");
    if (!host?.shadowRoot) continue;
    const r = host.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const inner = host.shadowRoot.elementFromPoint(x, y);
    if (!inner) {
      if (why) return { fail: "sin inner " + e.path.slice(-16) };
      continue; // try the next file — it is not its fault
    }
    let node = inner;
    while (node && !node.hasAttribute?.("data-line")) node = node.parentElement;
    if (!node?.hasAttribute?.("data-line")) return why ? { fail: "walk sin DL desde " + inner.nodeName } : null;
    const rows = contentRowsOf(e);
    const idx = rows.indexOf(node);
    if (idx < 0) return why ? { fail: "idx -1 en " + e.path.slice(-16) } : null;
    // Offsets must be computed against the whole line's text. Before 0.8.6 the offset was relative to the first
    // span/token: when a double-click landed on a later token (e.g. **bold**, backticks) the walk could
    // not find a direct child of the first span, the offset was pinned to the end of the first token,
    // and caretFrag got a==b and failed outright. locatePlain/offsetAtX already recurse down
    // the whole subtree, so a binary search over the row gives the exact char offset in the whole-line coordinate system.
    const rowText = node.textContent ?? "";
    let off = 0;
    if (rowText.trim()) {
      try {
        off = offsetAtX(node, x);
      } catch {
        off = 0;
      }
    }
    return { entry: e, idx, off };
  }
  return null;
}

function caretFrag(entry) {
  if (!dragPath || Date.now() - dragPath.live > 1200) return null; // frescura = actividad, no nacimiento
  const A = pointToRowInfo(dragPath.x0, dragPath.y0);
  const B = pointToRowInfo(dragPath.x1, dragPath.y1);
  if (!A || !B || A.entry !== entry || B.entry !== entry) {
    diagSel(`caretFrag ✗ A=${A ? A.entry.path.slice(-14) : "null"} B=${B ? B.entry.path.slice(-14) : "null"} (falls back to text match)`);
    return null;
  }
  // NATIVE gesture: double-click = word, triple-click = line, drag = range.
  // "moved" separates click (no drag, jitter ≤3px) from a real drag — a right-to-
  // left drag on the SAME row must not fall into the word branch.
  const moved = Math.abs(dragPath.x1 - dragPath.x0) > 3 || Math.abs(dragPath.y1 - dragPath.y0) > 3;
  const triple = (dragPath.detail || 1) >= 3;
  if (!moved && !triple && A.idx === B.idx) {
    // double-click / click without drag: WORD under the caret (spec Damian —
    // before this it fell back to text matching and painted the WHOLE LINE)
    // rowText takes the whole line's textContent (across tokens), word boundaries use Unicode classes
    // (\p{L} covers CJK and accented letters), otherwise a CJK line can never select a word.
    const row = contentRowsOf(entry)[A.idx];
    const sp = rowSpaces(row ?? document.createElement("div"));
    const rowText = sp.merged;
    const isWord = (ch) => /[\p{L}\p{N}_]/u.test(ch);
    // the walk must NOT cross the edge of a struck run: "beta̶gamma" (del
    // glued to add) would be ONE single word and the double-click would paint
    // BOTH sides together (restore + delete at once)
    const edge = (x) => sp.dels.some((d) => d.mStart === x || d.mEnd === x);
    let a = Math.min(A.off, rowText.length);
    let b = a;
    while (a > 0 && !edge(a) && isWord(rowText[a - 1])) a--;
    while (b < rowText.length && !edge(b) && isWord(rowText[b])) b++;
    if (b <= a) return null;
    const run = sp.dels.find((d) => d.mStart <= a && b <= d.mEnd);
    if (run) return [oldFragOf(entry, A.idx, row, run)]; // palabra TACHADA → restaurar
    return [{ side: "new", firstRowIdx: A.idx, lastRowIdx: A.idx, offA: mergedToNew(row, a), offB: mergedToNew(row, b), text: rowText.slice(a, b) }];
  }
  const first = A.idx <= B.idx ? A : B;
  const last = A.idx <= B.idx ? B : A;
  const rows = contentRowsOf(entry);
  const rowText = (i) => rows[i]?.textContent ?? "";
  // VERTICAL drag (the natural gesture for "these whole lines"): whole
  // rows — the horizontal component discriminates nothing useful
  // vertical = clearly a whole-lines gesture: it went down half a line (14px) or
  // more and almost without a horizontal component. Short word diagonals no longer
  // classify (before, they painted the whole row).
  const vertical = Math.abs(dragPath.y1 - dragPath.y0) >= 14 && Math.abs(dragPath.x1 - dragPath.x0) < 8;
  let offA;
  let offB;
  if (triple || vertical) {
    offA = 0;
    offB = rowText(last.idx).length;
  } else if (first.idx === last.idx) {
    // drag INSIDE one row: right→left gives A.off > B.off — it is
    // normalized (same result as left→right, like the editor).
    offA = Math.min(first.off, last.off);
    offB = Math.max(first.off, last.off);
  } else {
    offA = Math.min(first.off, rowText(first.idx).length);
    offB = Math.min(last.off, rowText(last.idx).length);
  }
  return fragsFromMergedRange(entry, first.idx, last.idx, offA, offB);
}

// OLD-side frag of a struck run in row idx: painting it restores the
// ORIGINAL line and removes its paired green one (atomic-pair semantics of revertFrags:
// "red painted → full pair"). offA/offB on the OLD line; line = the
// old FILE's line number (dataset.daOldLine, fixed when pairing).
function oldFragOf(entry, idx, row, run) {
  const oldLine = row.dataset.daOld ?? "";
  let offA = oldLine.indexOf(run.text);
  if (offA < 0) offA = 0;
  return {
    side: "old", firstRowIdx: idx, lastRowIdx: idx,
    line: parseInt(row.dataset.daOldLine || row.dataset.line || "1", 10),
    offA, offB: offA + run.text.length, text: run.text,
    m0: run.mStart, m1: run.mEnd,
  };
}

// Merged selection [offA,offB) of rows firstIdx..lastIdx → LIST of
// frags: the non-struck text is ONE new frag (surgery offsets, new
// spaces per row) and each covered struck run contributes its old frag. A drag that
// spans struck and new text paints BOTH sides (coexistence, spec 0.9.3).
function fragsFromMergedRange(entry, firstIdx, lastIdx, offA, offB) {
  const rows = contentRowsOf(entry);
  const out = [];
  const newParts = [];
  let nFirst = -1;
  let nLast = -1;
  let nA = 0;
  let nB = 0;
  for (let i = firstIdx; i <= lastIdx; i++) {
    const row = rows[i];
    if (!row) continue;
    const sp = rowSpaces(row);
    const mA = i === firstIdx ? Math.min(offA, sp.merged.length) : 0;
    const mB = i === lastIdx ? Math.min(offB, sp.merged.length) : sp.merged.length;
    for (const d of sp.dels) {
      if (d.mStart < mB && d.mEnd > mA && d.text.trim()) out.push(oldFragOf(entry, i, row, d));
    }
    const nt = rowNewText(row);
    const a = mergedToNew(row, mA);
    const b = mergedToNew(row, mB);
    const s = i === firstIdx ? a : 0;
    const e = i === lastIdx ? b : nt.length;
    if (e > s) {
      if (nFirst < 0) { nFirst = i; nA = s; }
      nLast = i;
      nB = e;
      newParts.push(nt.slice(s, e));
    }
  }
  if (newParts.length) out.unshift({ side: "new", firstRowIdx: nFirst, lastRowIdx: nLast, offA: nA, offB: nB, text: newParts.join("\n") });
  // selection of pure spaces (or empty after splitting by strikethroughs): paints nothing
  // (same criterion the drag had: !t.trim() → null)
  return out.some((f) => f.text.trim()) ? out : [];
}

// Selection → frag. FIRST geometry (drag path + carets, exact);
// if there is no usable path, match the text against the rows (fallback).
function paintFromSelection(entry, rows, text) {
  const byCaret = caretFrag(entry);
  if (byCaret) return toggleFrag(entry, byCaret);
  if (entry.edit) return;
  const crows = contentRowsOf(entry);
  const idxOf = new Map(crows.map((r, i) => [r, i]));
  const first = idxOf.get(rows[0]);
  const last = idxOf.get(rows[rows.length - 1]);
  if (first == null || last == null || last < first) return;
  const lines = text.split("\n");
  const firstText = crows[first]?.textContent ?? "";
  const lastText = crows[last]?.textContent ?? "";
  // empty line = the selection starts/ends AT the row's edge (not an
  // "endsWith('')" that would send the offset to the other end)
  const firstLine = lines[0] ?? "";
  const lastLine = lines[lines.length - 1] ?? "";
  // OCCURRENCE by GEOMETRY, not by text order: if the word repeats
  // in the row, indexOf/endsWith paint some arbitrary twin ("it
  // selects all identical words"). We choose the occurrence whose
  // rect is closest to the point where you released the mouse.
  const occurrenceAt = (rowEl, line, nearX) => {
    const t = rowEl?.textContent ?? "";
    const hits = [];
    let i = t.indexOf(line);
    while (i >= 0 && hits.length < 64) { hits.push(i); i = t.indexOf(line, i + Math.max(1, line.length)); }
    if (hits.length <= 1) return hits[0] ?? -1;
    if (!Number.isFinite(nearX)) return hits[0];
    let best = hits[0];
    let bestD = Infinity;
    for (const h of hits) {
      try {
        const r = plainOffsetToRange(rowEl, h, h + line.length).getBoundingClientRect();
        if (!r.width && !r.height) continue;
        const d = nearX < r.left ? r.left - nearX : nearX > r.right ? nearX - r.right : 0;
        if (d < bestD) { bestD = d; best = h; }
      } catch { /* degenerate rect: we try the others */ }
    }
    return best;
  };
  const nearX = selPopAt?.x;
  let offA = 0;
  if (firstLine) {
    const hit = occurrenceAt(crows[first], firstLine, nearX);
    offA = hit >= 0 ? hit : (firstText.endsWith(firstLine) ? firstText.length - firstLine.length : Math.max(0, firstText.indexOf(firstLine)));
  }
  let offB = lastText.length;
  if (rows.length === 1) {
    if (lastLine) {
      const hit2 = occurrenceAt(crows[last], lastLine, nearX);
      offB = hit2 >= 0 ? hit2 + lastLine.length : firstText.length;
    } else offB = firstText.length;
  } else if (lastLine) {
    const hit3 = occurrenceAt(crows[last], lastLine, nearX);
    offB = hit3 >= 0 ? hit3 + lastLine.length : (lastText.startsWith(lastLine) ? lastLine.length : Math.max(0, lastText.indexOf(lastLine)) + lastLine.length);
  }
  if (offB <= offA) offB = firstText.length;
  const frags = fragsFromMergedRange(entry, first, last, offA, offB);
  if (frags.length) toggleFrag(entry, frags);
}

let lastFragPaint = null; // {gesture} — un gesto pinta UNA vez
function toggleFrag(entry, fragsIn) {
  const fragList = Array.isArray(fragsIn) ? fragsIn : [fragsIn];
  if (!fragList.length) return;
  // One same gesture generates SEVERAL selectionchange events (release → settle) and each
  // one can repaint: the same frag unpainted it (toggle), a DIFFERENT frag
  // (caret vs text fallback) left strays (e2e: "them"+"cit" from the same
  // drag). Lock per gesture: the first paint after release wins; a NEW
  // gesture (pointerdown) resets. Between gestures the toggle still holds
  // (repainting the same on purpose = unpaint, spec).
  const gesture = dragPath?.at ?? 0;
  if (lastFragPaint?.gesture === gesture) return;
  lastFragPaint = { gesture };
  diagSel(`toggle ${fragList.map((f) => `[${f.side ?? "new"} ${f.firstRowIdx}-${f.lastRowIdx} @${f.offA}-${f.offB}] "${f.text.slice(0, 10)}"`).join(" ")} g=${gesture}`);
  lastPaintedEntry = entry;
  const list = fragSel.get(entry.path) ?? [];
  // The brush ALWAYS accumulates (spec: pick one word then another, both stay).
  // The old neutral branch used a single replacement (fragSel.set([frag])), so the user saw
  // "the first word is erased when I pick the second". The mode switch only changes the execution entry, not the accumulation semantics.
  // COEXISTENCE per char (spec Damian 27/10: "what is painted gets unpainted when
  // painting the new" [translated] + "3 separate words on one line have to stay
  // all 3" [translated]): only what OVERLAPS chars with the new one is replaced — and the
  // overlap is measured in MERGED space (strikethroughs included as their own
  // territory: a run's old frag shares no chars with the new frag around
  // it, so a mixed drag does not eat its own siblings).
  const mSegsOf = (f) => {
    const rows = contentRowsOf(entry);
    const out = [];
    for (let i = f.firstRowIdx; i <= f.lastRowIdx; i++) {
      const row = rows[i];
      if (!row) continue;
      if (f.side === "old") {
        if (i !== f.firstRowIdx) continue;
        const oldLine = row.dataset.daOld ?? "";
        for (const d of rowSpaces(row).dels) {
          const at = oldLine.indexOf(d.text);
          if (at >= 0 && at < f.offB && at + d.text.length > f.offA) out.push([i, d.mStart, d.mEnd]);
        }
        continue;
      }
      const nt = rowNewText(row);
      const a = i === f.firstRowIdx ? f.offA : 0;
      const b = i === f.lastRowIdx ? Math.min(f.offB, nt.length) : nt.length;
      if (b > a) for (const [s, e] of newToMergedSegs(row, a, b)) out.push([i, s, e]);
    }
    return out;
  };
  const fSegs = fragList.flatMap(mSegsOf);
  const overlaps = (f) => fSegs.some(([i, a, b]) => mSegsOf(f).some(([j, c, d]) => i === j && a < d && c < b));
  const sameFrag = (f, g) => !!f && !!g && f.side === g.side && f.firstRowIdx === g.firstRowIdx && f.lastRowIdx === g.lastRowIdx && f.offA === g.offA && f.offB === g.offB;
  let next;
  const eqs = fragList.map((g) => list.find((f) => sameFrag(f, g)));
  if (eqs.length && eqs.every(Boolean)) next = list.filter((f) => !eqs.includes(f)); // repainting the SAME on purpose = unpaint
  else {
    next = list.filter((f) => !overlaps(f));
    next.push(...fragList);
    next.sort((a, b) => a.firstRowIdx - b.firstRowIdx || a.offA - b.offA);
  }
  if (next.length) fragSel.set(entry.path, next);
  else fragSel.delete(entry.path);
  renderFragUI(entry);
  renderFragBadge(entry);
  // In brush mode (?/↩) there is NO floating popup: the header button IS the
  // executor and Enter too (spec Damian 27/10: the floating question and
  // rollback buttons must not be in paint mode). Without mode:
  // single paint + immediate popup.
  if (fragModes.get(entry.path)) return hideSelPop("modo brocha");
  if (fragSel.get(entry.path)?.length) {
    const rows = contentRowsOf(entry);
    const f = fragSel.get(entry.path).at(-1);
    showSelPop(entry, { row: rows[f.lastRowIdx] }, { frag: true });
  } else {
    hideSelPop("despintado");
  }
}

// stripes of what is painted: real rects of the [a,b) portion of each row
function renderFragUI(entry) {
  let layer = entry.body.querySelector(".frag-layer");
  const frags = fragSel.get(entry.path) ?? [];
  if (!frags.length) { layer?.remove(); return; }
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "frag-layer";
    entry.body.appendChild(layer);
  }
  layer.textContent = "";
  try {
    renderFragRows(entry, layer, frags);
  } catch (err) {
    // throw telemetry: exact row/data that cause it
    const rows = contentRowsOf(entry);
    const dump = frags.flatMap((f) => {
      const out = [];
      for (let i = f.firstRowIdx; i <= f.lastRowIdx && out.length < 4; i++) {
        const c = rows[i];
        out.push({ i, has: !!c, span: !!c?.querySelector("span"), tc: (c?.textContent ?? "").length, offA: f.offA, offB: f.offB, type: c?.dataset?.lineType });
      }
      return out;
    });
    diagSel(`fragUI THROW ${err.message} ⟵ ${String(err.stack ?? "").split("\n").slice(1, 3).join(" ;; ").slice(0, 200)} ;; ${JSON.stringify(dump).slice(0, 160)}`);
  }
}

function renderFragRows(entry, layer, frags) {
  const crows = contentRowsOf(entry);
  const bodyRect = entry.body.getBoundingClientRect();
  const frag = document.createDocumentFragment();
  for (const f of frags) {
    for (let i = f.firstRowIdx; i <= f.lastRowIdx; i++) {
      // row by row, bulletproof: one odd row cannot take down the whole
      // painting (and if it blows up, the dump says exactly what it was)
      try {
        const row = crows[i];
        if (!row) continue;
        // Row text and highlight rects are both computed over the whole line (consistent offset space);
        // an empty line has no char rect, so fall back to the whole row's rect — the selection never breaks visually across empty lines.
        // old side → stripe over the STRUCK run(s); new side → merged
        // segments of the new text (split by the strikethroughs, without invading them)
        const nt = rowNewText(row);
        let rects = [];
        if (f.side === "old") {
          if (i !== f.firstRowIdx) continue;
          const oldLine = row.dataset.daOld ?? "";
          for (const d of rowSpaces(row).dels) {
            const at = oldLine.indexOf(d.text);
            if (!(at >= 0 && at < f.offB && at + d.text.length > f.offA)) continue;
            try {
              const r = document.createRange();
              r.selectNodeContents(d.el);
              rects.push(...r.getClientRects());
            } catch { /* run desmontado: sin franja */ }
          }
        } else {
          const a = i === f.firstRowIdx ? f.offA : 0;
          const b = i === f.lastRowIdx ? Math.min(f.offB, nt.length) : nt.length;
          if (b <= a && nt.trim()) continue;
          for (const [s, e] of newToMergedSegs(row, Math.min(a, b), Math.max(a, b))) {
            try { rects.push(...plainOffsetToRange(row, s, e).getClientRects()); } catch { /* segmento raro */ }
          }
        }
        if (!rects.length) rects = [row.getBoundingClientRect()];
        for (const r of rects) {
          if (!r.width && !r.height) continue;
          const d = document.createElement("div");
          d.className = "frag-stripe";
          d.style.top = `${r.top - bodyRect.top}px`;
          d.style.left = `${r.left - bodyRect.left}px`;
          d.style.width = `${r.width}px`;
          d.style.height = `${r.height}px`;
          frag.appendChild(d);
        }
      } catch (err) {
        const c = crows[i];
        diagSel(`row ${i} THROW ${err.message} ⟵ nodeType=${c?.nodeType} tc=${typeof c?.textContent} span=${!!c?.querySelector?.("span")} kids=${c?.childNodes?.length}`);
      }
    }
  }
  layer.appendChild(frag);
}

// 4px dot for added whitespace (a contiguous run
// of spaces = one dot, not a row of dots). Offsets in NEW space
function wcAddDot(frag, row, a, b, bodyRect, cls) {
  try {
    const rects = plainOffsetToRangeNS(row, a, b).getClientRects();
    const r = rects[rects.length - 1];
    if (!r || (!r.width && !r.height)) return;
    const d = document.createElement("div");
    d.className = cls;
    d.style.left = `${r.left - bodyRect.left + r.width / 2 - 2}px`;
    d.style.top = `${r.top - bodyRect.top + r.height / 2 - 2}px`;
    frag.appendChild(d);
  } catch { /* skip */ }
}

// ---- shim box: inline word-level change highlight (spec: a whole red/green line keeps
// its base background; rows with just a few changed words get those words marked with a
// more visible red/green box) ----
// The pairing unit is same-order del↔add rows inside a hunk; unpaired rows (pure addition /
// pure deletion residue) are not marked — a whole new line = whole red/green, exactly what
// the spec asks for.
function wcAddRects(frag, row, a, b, bodyRect, cls) {
  try {
    // offsets in NEW space: the row's strikethroughs do not exist for the
    // boxes of the added text
    const rects = plainOffsetToRangeNS(row, a, b).getClientRects();
    for (const r of rects) {
      if (!r.width && !r.height) continue;
      const d = document.createElement("div");
      d.className = cls;
      // 1px of air per side: with ONE BOX PER WORD and clean space
      // between them, neighbor boxes no longer touch (padX 2 overlapped them
      // by 4px when many words changed — spec 28/10 "hard to read")
      const padX = 1;
      const padY = 1.5;
      d.style.top = `${Math.max(0, r.top - bodyRect.top - padY)}px`;
      d.style.left = `${Math.max(0, r.left - bodyRect.left - padX)}px`;
      d.style.width = `${r.width + padX * 2}px`;
      d.style.height = `${r.height + padY * 2}px`;
      frag.appendChild(d);
    }
  } catch { /* weird row structure: skip that mark */ }
}

function markChangedWords(entry) {
  // Edit mode is a pure editing view (spec), it draws no overlay at all.
  if (entry.edit) return;
  const rows = contentRowsOf(entry);
  const bodyRect = entry.body.getBoundingClientRect();
  let layer = entry.body.querySelector(".wc-layer");
  if (!rows.length) { layer?.remove(); entry._wcSig = null; return; }
  // Idempotent signature: line count + total length of changed row text + host height. Height is key:
  // with the file collapsed the row rects are all 0 (all marks are skipped but the signature was already recorded), and after
  // expanding only a height change can invalidate the signature and recompute (e2e measured: after expanding, the shims never appeared).
  // Also retry on an empty layer — equal signature but no mark ever succeeded is most likely a layout that is not ready yet.
  // Length is measured in NEW space (without strikethroughs): inserting the
  // runs does not change the signature — the insertion is idempotent and stable.
  const host = entry.body.querySelector("diffs-container");
  const hostH = Math.round(host?.getBoundingClientRect().height ?? -1);
  let sig = `${rows.length}:${hostH}`;
  for (const r of rows) if (r.dataset.lineType === "change-deletion" || r.dataset.lineType === "change-addition") sig += ":" + rowNewText(r).length;
  // ONE row per line: OBSOLETE — FINAL spec Damian 28/10: "I want to see a
  // normal diff, line by line, like on GitHub: the red line with the word
  // highlighted in red, and BELOW the green line with the word in green
  // highlighted" [translated]. BOTH rows always visible; no strikethroughs and no collapse. The
  // reset stays in case an old build left rows hidden/struck.
  const groups = [];
  {
    let i = 0;
    while (i < rows.length) {
      if (rows[i]?.dataset?.lineType === "change-deletion") {
        const dels = [];
        const adds = [];
        while (i < rows.length && rows[i].dataset.lineType === "change-deletion") dels.push(rows[i++]);
        while (i < rows.length && rows[i].dataset.lineType === "change-addition") adds.push(rows[i++]);
        if (dels.length && adds.length) groups.push({ dels, adds });
      } else i++;
    }
  }
  for (const r of rows) {
    if (r._daHidden) { r.style.display = ""; delete r._daHidden; }
    if (r.dataset.daOld) delete r.dataset.daOld;
    if (r.dataset.daOldLine) delete r.dataset.daOldLine;
    if (r.querySelector?.("[data-da-del]")) {
      r.querySelectorAll("[data-da-del]").forEach((el) => el.remove());
      delete r.dataset.daMergeKey;
    }
  }
  // the boxes' color is the REAL GREEN/RED of the diff: we sample the
  // backgroundColor of a (+/-) row of the component itself (respects light/dark
  // theme). Pierre exposes the color in MODERN syntax (lab(...) —
  // seen in the e2e) and NO classic normalization flattens it (canvas
  // included): nothing is parsed, the boxes use var(--wc-*) with opacity
  // 0.25 and the browser resolves (spec Damian: "the highlighted word, 25%
  // stronger than the row" [translated]).
  const solid = (row) => {
    if (!row) return null;
    const raw = getComputedStyle(row).backgroundColor;
    return raw && raw !== "transparent" && raw !== "rgba(0, 0, 0, 0)" ? raw : null;
  };
  const g = solid(rows.find((r) => r.dataset.lineType === "change-addition"));
  const d = solid(rows.find((r) => r.dataset.lineType === "change-deletion"));
  if (g) entry.body.style.setProperty("--wc-green", g);
  if (d) entry.body.style.setProperty("--wc-red", d);
  if (layer) {
    if (g) layer.style.setProperty("--wc-green", g);
    if (d) layer.style.setProperty("--wc-red", d);
  }
  if (entry._wcSig === sig && layer && layer.childElementCount > 0) return;
  entry._wcSig = sig;
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "wc-layer";
    entry.body.appendChild(layer);
  }
  layer.textContent = "";
  // GitHub-style: the RED row carries its removed word highlighted in red,
  // the GREEN row its added word in green (changedWordRanges per pair
  // of the same change). ONE BOX PER WORD (spec 28/10): the merged range
  // covers "word1 word2 word3" whole = one continuous block that is hard to read
  // when many words change; splitting per word leaves clean space
  // between boxes and the line reads.
  const frag = document.createDocumentFragment();
  for (const g of groups) {
    const n = Math.min(g.dels.length, g.adds.length);
    for (let k = 0; k < n; k++) {
      const redText = g.dels[k].textContent ?? "";
      const greenText = g.adds[k].textContent ?? "";
      const r = changedWordRanges(redText, greenText);
      if (!r) continue;
      for (const [a, b] of r.del) for (const [wa, wb] of wordRanges(redText, a, b)) wcAddRects(frag, g.dels[k], wa, wb, bodyRect, "wc-del");
      for (const [a, b] of r.add) for (const [wa, wb] of wordRanges(greenText, a, b)) wcAddRects(frag, g.adds[k], wa, wb, bodyRect, "wc-add");
      for (const [a, b] of r.delWs ?? []) wcAddDot(frag, g.dels[k], a, b, bodyRect, "wc-ws-del");
      for (const [a, b] of r.addWs ?? []) wcAddDot(frag, g.adds[k], a, b, bodyRect, "wc-ws-add");
    }
  }
  layer.textContent = "";
  layer.appendChild(frag);
}

// (The inline strikethroughs of 0.9.8 and the hover bubble were REMOVED in
// 0.9.11: final spec Damian — classic line-by-line diff like GitHub, the
// RED row visible with its word highlighted and the GREEN one below with its own.)

function clearFrags(entry) {
  fragSel.delete(entry.path);
  renderFragUI(entry);
  renderFragBadge(entry);
  hideSelPop("esc unpaints");
}

function renderFragBadge(entry) {
  const n = fragSel.get(entry.path)?.length ?? 0;
  const mode = fragModes.get(entry.path);
  for (const [btn, m] of [[entry.fragAskBtn, "ask"], [entry.fragRevBtn, "rev"]]) {
    if (!btn) continue;
    const active = mode === m;
    btn.classList.toggle("on", active);
    if (m === "ask") btn.textContent = active ? (n ? "?✓" : "?") : "?";
    // STACKED DOUBLE ↩ (spec Damian 28/10): distinguishes the MULTI-LINE
    // rollback (surgical, two arrows) from the FILE rollback (one)
    else btn.innerHTML = '<span class="dbl">↩</span><span class="dbl">↩</span>' + (active && n ? '<span class="ok">✓</span>' : "");
    btn.title = active
      ? (n ? `Run on ${n} painted fragment${n === 1 ? "" : "s"} (Esc unpaints)` : "Paint mode to ask — select fragments")
      : m === "ask"
        ? "Brush mode: paint fragments and then ask"
        : "Brush mode: paint fragments and then revert (surgical)";
  }
}

function setFragMode(entry, m) {
  const cur = fragModes.get(entry.path);
  if (cur === m) {
    // already active: with paints = RUN; without paints = turn off
    const n = fragSel.get(entry.path)?.length ?? 0;
    if (n && m === "ask") return openFragComposer(entry);
    if (n && m === "rev") return revertPainted(entry);
    fragModes.delete(entry.path);
  } else {
    fragModes.set(entry.path, m);
  }
  renderFragBadge(entry);
}

// ---- executors ----
function fragsToLib(entry) {
  const crows = contentRowsOf(entry);
  const out = [];
  for (const f of fragSel.get(entry.path) ?? []) {
    // old frag (painted strikethrough): restore the old line — line/offA/offB
    // already come in the BEFORE file's language (fixed when painting the run)
    if (f.side === "old") {
      if (Number.isFinite(f.line)) out.push({ side: "old", line: f.line, offA: f.offA, offB: f.offB });
      continue;
    }
    for (let i = f.firstRowIdx; i <= f.lastRowIdx; i++) {
      const row = crows[i];
      if (!row) continue;
      // Same coordinate space as renderFragRows — offsets in NEW space
      // (without the struck runs inserted in the row): it is the language of
      // afterLines/beforeLines, which guarantees the revert touches the
      // chars THAT ARE SEEN painted.
      const nt = rowNewText(row);
      const a = i === f.firstRowIdx ? f.offA : 0;
      const b = i === f.lastRowIdx ? Math.min(f.offB, nt.length) : nt.length;
      if (b <= a) continue;
      const line = parseInt(row.dataset.line, 10);
      const side = row.dataset.lineType === "change-deletion" ? "old" : "new";
      out.push({ side, line, offA: a, offB: b });
    }
  }
  return out;
}

function fragRangeOf(entry) {
  const crows = contentRowsOf(entry);
  let start = Infinity;
  let end = -1;
  for (const f of fragSel.get(entry.path) ?? []) {
    for (let i = f.firstRowIdx; i <= f.lastRowIdx; i++) {
      const row = crows[i];
      if (!row || row.dataset.lineType === "change-deletion") continue;
      const n = parseInt(row.dataset.line, 10);
      start = Math.min(start, n);
      end = Math.max(end, n);
    }
  }
  return start === Infinity ? null : { start, end, side: "additions" };
}

async function openFragComposer(entry) {
  const frags = fragSel.get(entry.path) ?? [];
  if (!frags.length) return;
  const range = fragRangeOf(entry);
  const lines = frags.map((f) => f.text.split("\n")).flat();
  closeComposer(entry);
  const card = document.createElement("div");
  card.className = "composer";
  card.innerHTML = `
    <div class="composer-head">
      <span class="anchor"></span>
      <button class="ghost close" title="Cancel">✕</button>
    </div>
    <textarea rows="3"></textarea>
    <div class="composer-actions">
      <span class="hint">⌘↵ sends</span>
      <button class="ghost cancel">Cancel</button>
      <button class="primary ask">Ask</button>
    </div>`;
  card.querySelector(".anchor").textContent = `${entry.path} · ${frags.length} fragmento${frags.length === 1 ? "" : "s"}`;
  const ta = card.querySelector("textarea");
  ta.placeholder = `Ask about ${frags.length} painted fragment${frags.length === 1 ? "" : "s"}…`;
  entry.section.appendChild(card);
  const close = () => card.remove();
  card.querySelector(".close").onclick = close;
  card.querySelector(".cancel").onclick = close;
  const submit = () => {
    const q = ta.value.trim();
    if (!q) { ta.focus(); return; }
    // verbatim quote: the fragments concatenated with a ⋯ separator
    const quote = [];
    frags.forEach((f, i) => {
      if (i) quote.push("⋯");
      quote.push(...f.text.split("\n"));
    });
    // EXACT MARKS (bug Damian 28/10: two words from distant rows
    // underlined ALL the rows in between): the anchor carries the EXACT rows
    // of every frag (spans) and names the lines one by one — the
    // min-max range stays only as a numeric fallback.
    const rows = contentRowsOf(entry);
    const spans = frags.map((f) => ({ first: f.firstRowIdx, last: f.lastRowIdx }));
    const labelLines = spans
      .map((s) => {
        const a = parseInt(rows[s.first]?.dataset.line ?? "0", 10);
        const b = parseInt(rows[s.last]?.dataset.line ?? String(a), 10);
        return a === b ? String(a) : `${a}-${b}`;
      })
      .join(", ");
    queueQuestion(entry.path, range ?? { start: 1, end: 1, side: "additions" }, quote, q, null, spans, `lines ${labelLines}`);
    close();
  };
  card.querySelector(".ask").onclick = submit;
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
  });
  ta.focus();
}

async function revertPainted(entry) {
  if (entry.edit) return;
  const uiFrags = fragSel.get(entry.path) ?? [];
  if (!uiFrags.length) return;
  const diff = entry.fd?.getInputDiff?.();
  if (!diff || !Array.isArray(diff.hunks)) return chip("⚠ I do not have this file's alignment");
  const libFrags = fragsToLib(entry);
  diagSel(`rev input: ${JSON.stringify(libFrags).slice(0, 150)}`);
  const res = revertFrags(entry.beforeLines, entry.afterLines, diff.hunks, libFrags);
  diagSel(`rev res: ${res?.noDiff ? "noDiff" : res?.lines ? "lines:" + res.lines.length : String(res)}`);
  if (!res) return chip("⚠ I could not rebuild the revert (inconsistent alignment)");
  if (res.noDiff) {
    clearFrags(entry);
    return miniNotice("no diff selected");
  }
  const n = uiFrags.length;
  await writeReverted(entry, res.lines.join("\n"), `↩ surgical: ${n} fragment${n === 1 ? "" : "s"}`);
  clearFrags(entry);
}

// ephemeral mini notice (e.g. "no diff selected") — tiny, bottom corner
function miniNotice(msg) {
  const d = document.createElement("div");
  d.className = "mini-notice";
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2200);
}

// Cascading Esc: composer → findbar → active paint → editing (discard)
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const composer = document.querySelector(".composer");
  if (composer) { composer.remove(); return; }
  const fb = document.getElementById("findbar");
  if (fb && !fb.hidden) { closeFindbar(); return; }
  const entry = lastPaintedEntry && rendered.get(lastPaintedEntry.path) ? lastPaintedEntry : null;
  if (entry && (fragSel.get(entry.path)?.length || fragModes.get(entry.path))) {
    // Esc also collapses the native selection — if not, the selection turns zombie: afterwards
    // any selectionchange (clicking a file header/button) lets text matching repaint the old word
    // (e2e measured: a Spanish test word came back as a ghost frag in another file).
    try { document.getSelection()?.removeAllRanges(); } catch { /* a read-only selection does not matter */ }
    clearFrags(entry);
    fragModes.delete(entry.path);
    renderFragBadge(entry);
    return;
  }
  const editing = entry?.edit ? entry : [...rendered.values()].find((en) => en.edit);
  if (editing) {
    // ✏️ same contract as ?: pressing again accepts, Esc DISMISSES everything
    discardAllEdits();
  }
});

// ------------------------------------------------ hover-＋ (left rail)
// Hover on a line → small ＋ glued to the LEFT (over the numbers,
// never over selectable text). It goes with the mouse. Click → composer
// for that line. A single global button that lives in its file's body.
let hoverPlus = null;
let hoverRevert = null;
let hoverRow = null;

function hideHoverPlus() {
  hoverPlus?.remove();
  hoverRevert?.remove();
  hoverPlus = null;
  hoverRevert = null;
  hoverRow = null;
}

function rangeOfRow(row) {
  const t = row.dataset.lineType;
  const n = parseInt(row.dataset.line, 10);
  if (t === "change-deletion") return { start: n, end: n, side: "deletions" };
  return { start: n, end: n, side: "additions" };
}

function showHoverPlus(entry, row) {
  // Edit mode (✏️ pressed) is a pure editing view — the spec requires no
  // overlay at all. The old hover ＋/↩ floated anyway, looking like "the text
  // selection popup ran into edit mode".
  if (entry.edit) return hideHoverPlus();
  if (row === hoverRow && hoverPlus?.isConnected) return;
  hideHoverPlus();
  hoverRow = row;
  hoverPlus = document.createElement("button");
  hoverPlus.className = "hover-plus";
  hoverPlus.textContent = "＋";
  hoverPlus.title = "Ask about this line";
  hoverPlus.onclick = () => {
    hideHoverPlus();
    const idx = contentRowsOf(entry).indexOf(row);
    openComposer(entry, entry.path, rangeOfRow(row), { row, span: { first: idx, last: idx } });
  };
  entry.body.appendChild(hoverPlus);
  // ↩ per line on the RIGHT rail (where the 💬 live): only CHANGED rows
  // (an added one is removed / a deleted one comes back). Coexists with the left ＋.
  const t = row.dataset.lineType;
  if (t === "change-addition" || t === "change-deletion") {
    hoverRevert = document.createElement("button");
    hoverRevert.className = "hover-plus hover-revert";
    hoverRevert.textContent = "↩";
    hoverRevert.title = "Revert this line to the original";
    hoverRevert.onclick = () => {
      const key = keyOfRow(row);
      hideHoverPlus();
      revertKeys(entry, new Set([key]));
    };
    entry.body.appendChild(hoverRevert);
  }
  const bodyRect = entry.body.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  hoverPlus.style.top = `${r.top - bodyRect.top + (r.height - hoverPlus.offsetHeight) / 2}px`;
  if (hoverRevert) hoverRevert.style.top = hoverPlus.style.top;
}

document.addEventListener("pointermove", (e) => {
  if (boxDrag) { hideHoverPlus(); return; }
  if (e.target.closest?.(".hover-plus")) return; // standing on the ＋: it stays
  const body = e.target.closest?.(".file-body");
  if (!body) { hideHoverPlus(); return; }
  let entry = null;
  for (const en of rendered.values()) if (en.body === body) { entry = en; break; }
  if (!entry || entry.edit) { hideHoverPlus(); return; } // editing = pure editor
  const row = rowFromPoint(e.clientX, e.clientY, entry);
  if (!row) { hideHoverPlus(); return; }
  showHoverPlus(entry, row);
});
document.documentElement.addEventListener("pointerleave", hideHoverPlus);

// ------------------------------------------------- shadow DOM rows
// Access to pierre's rows (shadow DOM) for hover-＋ and checkboxes:
// document.elementFromPoint does NOT cross the shadow (it returns the host), you have to
// ask the diffs-container's shadowRoot directly.
function contentRowsOf(entry) {
  const content = entry.body.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-content]");
  return content ? [...content.children].filter((r) => r.hasAttribute("data-line")) : [];
}

// Row under a point: GEOMETRY over the content rows' rects.
// Classic hit-testing does not work here: our overlays (checkboxes, stripes,
// hover-＋) cover the point and elementFromPoint returns them — measuring
// rects is immune to whatever is on top (and does not depend on the shadow DOM).
function rowFromPoint(x, y, entry) {
  for (const r of contentRowsOf(entry)) {
    const rect = r.getBoundingClientRect();
    if (y >= rect.top && y <= rect.bottom) return r;
  }
  return null;
}

// Anchor side of a set of rows: if it touches something not-deleted it is the
// new side; if it is all deletions, the old one (same criterion as the rest).
function rangeFromRows(rows) {
  const news = [];
  const olds = [];
  for (const r of rows) {
    const ty = r.dataset.lineType;
    const n = parseInt(r.dataset.line, 10);
    if (ty === "change-deletion") olds.push(n);
    else if (ty === "change-addition") news.push(n);
    else { news.push(n); olds.push(parseInt(r.dataset.altLine ?? n, 10)); }
  }
  const byNew = news.length > 0;
  const nums = byNew ? news : olds;
  if (!nums.length) return null;
  return { start: Math.min(...nums), end: Math.max(...nums), side: byNew ? "additions" : "deletions" };
}

// Composer for the multi SELECTION: selected rows → runs → numeric
// ranges per side; the big ＋ (below the last checkbox) opens this.
function openComposerMulti(entry) {
  const rows = selectedRowsOf(entry);
  if (!rows.length) return;
  const crows = contentRowsOf(entry);
  const runs = compressRuns(rows.map((r) => crows.indexOf(r)));
  const side = rangeFromRows(rows)?.side ?? "additions";
  const ranges = [];
  for (const run of runs) {
    const nums = [];
    for (const r of crows.slice(run.first, run.last + 1)) {
      if (side === "deletions") {
        if (r.dataset.lineType === "change-deletion") nums.push(parseInt(r.dataset.line, 10));
      } else if (r.dataset.lineType !== "change-deletion") nums.push(parseInt(r.dataset.line, 10));
    }
    if (nums.length) ranges.push({ start: Math.min(...nums), end: Math.max(...nums) });
  }
  if (!ranges.length) return;
  const lines = linesLabel(ranges);
  const verbatim = entry.selVerbatim ?? null;
  const spans = runs.map((r) => ({ first: r.first, last: r.last }));
  closeComposer(entry);
  const card = document.createElement("div");
  card.className = "composer";
  card.innerHTML = `
    <div class="composer-head">
      <span class="anchor"></span>
      <button class="ghost close" title="Cancel">✕</button>
    </div>
    <textarea rows="3"></textarea>
    <div class="composer-actions">
      <span class="hint">⌘↵ sends</span>
      <button class="ghost cancel">Cancel</button>
      <button class="primary ask">Ask</button>
    </div>`;
  card.querySelector(".anchor").textContent = `${entry.path}:${lines}`;
  const ta = card.querySelector("textarea");
  ta.placeholder = `Ask about lines ${lines}…`;
  const close = () => card.remove();
  card.querySelector(".close").onclick = close;
  card.querySelector(".cancel").onclick = close;
  function submit() {
    const q = ta.value.trim();
    if (!q) { ta.focus(); return; }
    const quoteLines = verbatim ? verbatim.split("\n") : quoteForRanges(entry, ranges, side);
    pendingAsks.push({
      kind: "line", path: entry.path,
      start: ranges[0].start, end: ranges[ranges.length - 1].end,
      lines, label: `lines ${lines} · ${side}`, side, quoteLines, question: q, spans, ranges,
    });
    close();
    setBoxSel(entry, new Set()); // the ask got anchored: selection back to zero
    renderPile();
    renderAnchors();
  }
  card.querySelector(".ask").onclick = submit;
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
  });
  positionComposerAtRow(entry, card, rows[rows.length - 1]);
  ta.focus();
}

// REACTIVE anchor re-positioning: a single rAF coalesces any
// number of triggers (onHunkExpand, structural observer, collapse) —
// zero "wait N ms to see if it settled".
let anchorsScheduled = false;
function scheduleAnchors() {
  if (anchorsScheduled) return;
  anchorsScheduled = true;
  requestAnimationFrame(() => {
    anchorsScheduled = false;
    const _a0 = performance.now();
    const _stage = [];
    renderAnchors();
    const _a1 = performance.now();
    // new rows (expansion) or engine just ready → repaint syntax.
    // File in EDIT mode ✏️: NOTHING of ours touches it — the MutationObserver fires
    // on every editor keystroke and our layers (tokens, strikethroughs, stripes)
    // would write over live rows with stale content.
    for (const entry of rendered.values()) {
      if (!entry.fd || !entry.fileData || entry.edit) continue; // lazy: skip not-hydrated
      const _e0 = performance.now();
      const l = getFiletypeFromFileName(entry.fileData.oldPath ?? entry.fileData.path);
      if (l && HL_LANGS.has(l)) hlColorize(entry, l);
      const _e1 = performance.now();
      if (fragSel.has(entry.path)) renderFragUI(entry); // overlays tras repaint
      try { markChangedWords(entry); } catch { /* word-level marking failure does not affect the main render */ }
      const _e2 = performance.now();
      _stage.push({ path: entry.path, hl: Math.round(_e1 - _e0), mark: Math.round(_e2 - _e1) });
    }
    // Expanding a separator brings NEW rows: re-mark the active search
    // without moving the scroll (the match could be in the collapsed
    // context and until now it was invisible to ⌘F).
    if (find.q && !document.getElementById("findbar")?.hidden) runFind(find.q, false);
    window.__DA_ANCHORS = { anchors: Math.round(_a1 - _a0), total: Math.round(performance.now() - _a0), entries: _stage, at: Date.now() };
  });
}

// The lib re-arranges rows when expanding separators / a theme re-render: the
// shadowRoot observer reacts to those structural changes.
function attachStructureObserver(entry) {
  if (entry.structureObserver) return;
  const sr = entry.body.querySelector("diffs-container")?.shadowRoot;
  if (!sr) return;
  const mo = new MutationObserver(() => scheduleAnchors());
  mo.observe(sr, { childList: true, subtree: true });
  entry.structureObserver = mo;
}

// ------------------------------------------------- inline anchors (0.2.1)
// Every ANCHORED ask lives collapsed over its line: a 💬 on the row's right
// edge (chip in the file-head for a file/hidden line).
// Click → in-place editor (edit / delete). Free questions go to the pile.

function ensureLayer(entry) {
  let layer = entry.body.querySelector(".anchor-layer");
  if (!layer) {
    entry.body.classList.add("has-anchors");
    layer = document.createElement("div");
    layer.className = "anchor-layer";
    entry.body.appendChild(layer);
  }
  layer.textContent = "";
  return layer;
}

// The shadow DOM row that shows that line (according to the anchor's side).
function findRow(entry, start, side) {
  const host = entry.body.querySelector("diffs-container");
  const content = host?.shadowRoot?.querySelector("[data-content]");
  if (!content) return null;
  const want = String(start);
  for (const r of content.children) {
    if (!r.hasAttribute("data-line") || r.dataset.line !== want) continue;
    const t = r.dataset.lineType;
    if (side === "deletions" ? t === "change-deletion" : t !== "change-deletion") return r;
  }
  return null;
}

function addHeadChip(entry, i, note) {
  if (entry.section.querySelector(".head-marker")) return;
  const chip = document.createElement("button");
  chip.className = "head-marker";
  chip.textContent = "💬";
  const a = pendingAsks[i];
  chip.title = note ? `${a.path}:${a.lines} (line not visible — expand it)` : `${a.path} · file`;
  chip.onclick = () => openInlineEditor(i, chip);
  entry.section.querySelector(".file-head .fplus").after(chip);
}

function renderAnchors() {
  document.querySelectorAll(".inline-editor").forEach((n) => n.remove());
  document.querySelectorAll(".head-marker").forEach((n) => n.remove());
  for (const entry of rendered.values()) {
    ensureLayer(entry);
    renderSelUI(entry); // checkboxes + stripes + big ＋ survive the re-render
  }
  pendingAsks.forEach((a, i) => {
    if (a.kind === "free") return;
    const entry = rendered.get(a.path);
    if (!entry) return;
    if (a.kind === "file") { addHeadChip(entry, i); return; }
    const row = findRow(entry, a.start, a.side);
    if (!row || entry.section.classList.contains("collapsed")) {
      addHeadChip(entry, i, !row);
      return;
    }
    const bodyRect = entry.body.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const mk = document.createElement("button");
    mk.className = "line-marker";
    mk.textContent = "💬";
    mk.title = `${a.path}:${a.lines} — ${a.question.slice(0, 100)}`;
    mk.onclick = () => openInlineEditor(i, mk);
    const layer = entry.body.querySelector(".anchor-layer");
    layer.appendChild(mk);
    mk.style.top = `${r.top - bodyRect.top + (r.height - mk.offsetHeight) / 2}px`;
  });
  applyQuestionMarks();
}

// In-place editor of the anchor: edit the question or delete it, right there.
function openInlineEditor(i, at) {
  document.querySelectorAll(".inline-editor").forEach((n) => n.remove());
  const a = pendingAsks[i];
  if (!a) return;
  const card = document.createElement("div");
  card.className = "inline-editor";
  card.innerHTML = `
    <div class="ie-head"><span class="anchor"></span><button class="ghost danger ie-del" title="Delete this question">🗑 Delete</button></div>
    <textarea rows="2"></textarea>
    <div class="ie-actions"><span class="hint">Enter saves · Shift+Enter line break</span><button class="primary ie-ok">Done</button></div>`;
  card.querySelector(".anchor").textContent =
    a.kind === "file" ? `${a.path} · file` : `${a.path}:${a.lines}`;
  const ta = card.querySelector("textarea");
  ta.value = a.question;
  ta.addEventListener("input", () => { a.question = ta.value; });
  const close = () => { card.remove(); renderAnchors(); };
  card.querySelector(".ie-del").onclick = () => { card.remove(); removeAsk(i); };
  card.querySelector(".ie-ok").onclick = close;
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); close(); }
  });
  document.body.appendChild(card);
  const r = at.getBoundingClientRect();
  card.style.left = `${Math.max(8, Math.min(r.left - 300, window.innerWidth - 340))}px`;
  card.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 150)}px`;
  ta.focus();
}

// Note: clicks on OUR UI (💬, editor, composer, ＋) trigger
// nothing — re-positioning arrives through events (onHunkExpand, observer), not
// through clicks guessed with timers (the 0.2.4 setTimeout calls, gone).
// The floating editor closes on scroll (it is far from its line).
document.getElementById("root").addEventListener("scroll", () => {
  document.querySelectorAll(".inline-editor").forEach((n) => n.remove());
});

// --------------------------------------------------------------- render

// DRAFTS that survive a refresh (URGENT Damian 28/10: "I am
// typing and if a new change shows up it wipes my box and what
// I wrote" [translated]): clearRendered destroys the sections and with them the open
// composers — they are stashed with their file and renderAll RE-HANGS them in the
// new section, text and focus included. Typing while the folder
// changes has to be possible.
let keptComposers = []; // { path, node, focus }
function stashComposersOf(entry) {
  for (const card of entry.section.querySelectorAll(".composer")) {
    const ta = card.querySelector("textarea");
    keptComposers.push({
      path: entry.path,
      node: card,
      focus: document.activeElement && card.contains(document.activeElement) ? ta : null,
    });
  }
}

function clearRendered() {
  clearRenderedExcept(new Set());
}

// Reconciliation (0.10.4): the destroy-and-rebuild-everything render made
// the panel freeze whenever the agent worked in the watched repo — every
// write notification re-rendered ALL sections and re-diffed every expanded
// file (renderer at 167% CPU measured). Sections whose file content is
// IDENTICAL now keep their mounted FileDiff; only changed/new files render.
function clearRenderedExcept(keep) {
  boxDrag = null;
  hideHoverPlus();
  hideSelPop("re-render"); // the rows the popup anchors to are about to die
  for (const entry of rendered.values()) stashComposersOf(entry);
  for (const entry of rendered.values()) {
    if (keep.has(entry)) continue;
    endEdit(entry, "complete");
    try { entry.fd?.cleanUp(); } catch { /* already gone */ }
    entry.structureObserver?.disconnect();
    entry.section.remove();
  }
  for (const [p, e] of [...rendered]) if (!keep.has(e)) rendered.delete(p);
}

// Header of one repo group in the turns view: icon + label + counts; click
// collapses/expands the group's sections (applyGroupCollapse does the DOM).
function turnRepoHead(label, repo) {
  const head = document.createElement("div");
  head.className = "turn-repo-head" + (collapsedGroups.has(label) ? " closed" : "");
  const outside = label === OUTSIDE_LABEL;
  head.dataset.group = label;
  head.innerHTML = `<span class="trh-chev"></span><span class="trh-icon"></span><span class="trh-label"></span><span class="trh-counts"></span>`;
  head.querySelector(".trh-chev").textContent = collapsedGroups.has(label) ? "▸" : "▾";
  head.querySelector(".trh-icon").textContent = outside ? "📄" : "🗂";
  head.querySelector(".trh-label").textContent = outside ? "Outside git" : label || "(no repo)";
  // An app-backed turn (0.10.10) knows every file's before and after; the
  // captured model only meets loose files as they are now.
  head.title = outside
    ? diffData?.turn?.source === "app"
      ? "Files the turn wrote outside any git repository (with their content before and after)."
      : "Files the turn touched outside any git repository (shown whole in green; there is no way to know how they were before)."
    : `Every file in this group belongs to the repository ${repo?.path ?? label}`;
  const bits = [];
  if (repo?.files !== undefined) bits.push(`${repo.files} file${repo.files === 1 ? "" : "s"}`);
  if (repo?.commits) bits.push(`${repo.commits} commit${repo.commits === 1 ? "" : "s"}`);
  if (repo?.dirty) bits.push(`${repo.dirty} sucio${repo.dirty === 1 ? "" : "s"}`);
  if (repo?.dirtyHidden) bits.push(`+${repo.dirtyHidden} ruido oculto`);
  if (repo?.outside) bits.push(`${repo.outside} fuera de git`);
  head.querySelector(".trh-counts").textContent = bits.join(" · ");
  head.onclick = () => {
    if (collapsedGroups.has(label)) collapsedGroups.delete(label);
    else collapsedGroups.add(label);
    head.classList.toggle("closed", collapsedGroups.has(label));
    head.querySelector(".trh-chev").textContent = collapsedGroups.has(label) ? "▸" : "▾";
    applyGroupCollapse(document.getElementById("root"));
  };
  return head;
}

// Folder sub-header inside a turn's repo group (spec 22/11: files
// "categorizados por repositorios y carpetas"). Collapsible like repo heads,
// keyed "label:dir" so the same folder in different repos stays independent.
function turnFolderHead(label, dir) {
  const key = `${label}:${dir}`;
  const head = document.createElement("div");
  head.className = "turn-folder-head" + (collapsedGroups.has(key) ? " closed" : "");
  head.dataset.group = key;
  head.innerHTML = `<span class="trh-chev"></span><span class="tfh-label"></span>`;
  head.querySelector(".trh-chev").textContent = collapsedGroups.has(key) ? "▸" : "▾";
  head.querySelector(".tfh-label").textContent = dir || "(root)";
  head.title = dir ? `Carpeta ${dir}` : "Files at the repository root";
  head.onclick = () => {
    if (collapsedGroups.has(key)) collapsedGroups.delete(key);
    else collapsedGroups.add(key);
    head.classList.toggle("closed", collapsedGroups.has(key));
    head.querySelector(".trh-chev").textContent = collapsedGroups.has(key) ? "▸" : "▾";
    applyGroupCollapse(document.getElementById("root"));
  };
  return head;
}

// The folder a turn file belongs to (relative to its repo root). Git-repo
// files ride "label/relPath"; outside files ride "~/rel" or an absolute path.
function turnFolderOf(f) {
  let p = f.path;
  if (f.repoLabel && f.repoLabel !== OUTSIDE_LABEL && p.startsWith(`${f.repoLabel}/`))
    p = p.slice(f.repoLabel.length + 1);
  else if (f.repoLabel === OUTSIDE_LABEL && p.startsWith("~/")) p = p.slice(2);
  const cut = p.lastIndexOf("/");
  return cut < 0 ? "" : p.slice(0, cut);
}

// Display order for the turns view: keep the server's REPO blocks (outside
// git last) but sort files by path inside each block so folder sub-headers
// group contiguous siblings. Display-only — the payload order is untouched.
function turnFilesForDisplay(files) {
  const out = [];
  let i = 0;
  while (i < files.length) {
    let j = i;
    const label = files[i].repoLabel ?? "";
    while (j < files.length && (files[j].repoLabel ?? "") === label) j++;
    out.push(...files.slice(i, j).sort((a, b) => a.path.localeCompare(b.path)));
    i = j;
  }
  return out;
}

// Hide the file sections under collapsed group headers (repo AND folder
// heads walk the siblings; a collapsed repo head hides its folder heads too).
function applyGroupCollapse(root) {
  let hideAll = false; // a collapsed repo head hides its folders too
  let group = null;
  for (const el of root.children) {
    if (el.classList?.contains("turn-repo-head")) {
      hideAll = collapsedGroups.has(el.dataset.group ?? "");
      group = null;
      el.style.display = "";
      continue;
    }
    if (el.classList?.contains("turn-folder-head")) {
      if (hideAll) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "";
      group = el.dataset.group ?? null;
      continue;
    }
    if (el.classList?.contains("file"))
      el.style.display = group !== null && collapsedGroups.has(group) ? "none" : "";
  }
}

// ------------------------------------------------- lazy file content (0.11.0)
// A turn view arrives LIGHT: headers, statuses and counts, no before/after.
// Each file's content is fetched when the user reaches it (expand, focus,
// hover-prefetch) and cached per turn+path — going back to a turn or
// re-expanding a file never asks the server twice.
const fileContents = new Map(); // `${turnId}\0${path}` -> content payload
const FILE_CONTENT_MAX = 120;
const fileLoads = new Map(); // key -> in-flight promise (expand + hover share ONE read)
const FILE_LOAD_CONCURRENCY = 2;
let fileLoadCount = 0;

// The cache key carries the file's CONTENT REVISION (the app's write count +
// counts ride the light header): a live turn that gets another write changes
// its note/counts → new key → fresh content, never a stale diff. Saved turns
// never change, so their key is stable.
const contentKey = (entry) => `${entry.turnId ?? ""}\0${entry.path}\0${entry.rev ?? ""}`;

// Per-file "something is happening" (0.11.1): the header's spinner + a
// progress cursor. Visible while the content is being fetched and while the
// diff is being mounted; never a modal, never a blocking overlay.
function setEntryBusy(entry, busy) {
  if (!entry) return;
  entry.busy = Boolean(busy);
  entry.section?.classList.toggle("loading", entry.busy);
  const s = entry.section?.querySelector(".fh-spin");
  if (s) s.hidden = !entry.busy;
}

function rememberFileContent(key, content) {
  fileContents.delete(key);
  fileContents.set(key, content);
  while (fileContents.size > FILE_CONTENT_MAX) fileContents.delete(fileContents.keys().next().value);
}

// Skeleton rows: the panel's answer to "something is loading" — same shapes
// for the pending view, the turn list and a file body.
function skLine(widthClass = "") {
  const d = document.createElement("div");
  d.className = `sk-line ${widthClass}`.trim();
  return d;
}
function skFileSection() {
  const sec = document.createElement("div");
  sec.className = "sk-file";
  sec.appendChild(skLine("w40"));
  for (let i = 0; i < 3; i++) sec.appendChild(skLine(i === 1 ? "w85" : "w70"));
  return sec;
}
// List placeholder while the first page is on its way (turns/commits).
function paintListSkeleton(root) {
  const list = document.createElement("div");
  list.className = "commit-list sk-list";
  for (let i = 0; i < 8; i++) {
    const row = document.createElement("div");
    row.className = "sk-row";
    row.appendChild(skLine("w25"));
    row.appendChild(skLine("w60"));
    row.appendChild(skLine("w15"));
    list.appendChild(row);
  }
  root.appendChild(list);
}

function paintBodySkeleton(entry) {
  if (!entry.body) return;
  entry.body.textContent = "";
  const box = document.createElement("div");
  box.className = "sk-body";
  for (let i = 0; i < 6; i++) box.appendChild(skLine(i % 3 === 0 ? "w40" : i % 3 === 1 ? "w85" : "w70"));
  entry.body.appendChild(box);
}

function paintBodyError(entry, err) {
  if (!entry.body) return;
  entry.body.textContent = "";
  const box = document.createElement("div");
  box.className = "plain-note";
  box.textContent = `I could not load this file's content (${err?.message ?? err}).`;
  const retry = document.createElement("button");
  retry.className = "ghost";
  retry.textContent = "Reintentar";
  retry.onclick = () => {
    entry.contentState = "idle";
    entry.body.textContent = "";
    loadFileContent(entry);
  };
  box.appendChild(document.createElement("br"));
  box.appendChild(retry);
  entry.body.appendChild(box);
}

function mergeFileContent(entry, c) {
  const f = entry.fileData;
  f.before = typeof c.before === "string" ? c.before : undefined;
  f.after = typeof c.after === "string" ? c.after : undefined;
  if (c.patch) f.patch = c.patch;
  if (c.binary) f.binary = true;
  if (c.gone) f.gone = true;
  entry.beforeLines = typeof f.before === "string" ? f.before.split("\n") : null;
  entry.afterLines = typeof f.after === "string" ? f.after.split("\n") : null;
  entry.pendingContent = false;
}

// The one path that fetches a file's content: a cache hit merges instantly, a
// miss paints the skeleton (first expand) and shares ONE read between the
// expand and any hover prefetch of the same file.
function loadFileContent(entry) {
  if (!entry?.pendingContent) return null;
  const key = contentKey(entry);
  const cached = fileContents.get(key);
  if (cached) {
    rememberFileContent(key, cached); // LRU touch
    mergeFileContent(entry, cached);
    entry.contentState = "ready";
    if (entry.body) entry.body.textContent = "";
    if (!entry.section.classList.contains("collapsed")) hydrateFileDiff(entry);
    return null;
  }
  if (fileLoads.has(key)) return fileLoads.get(key);
  entry.contentState = "loading";
  setEntryBusy(entry, true);
  paintBodySkeleton(entry);
  fileLoadCount++;
  const load = withTimeout(app.readServerResource({ uri: turnFileUri(entry.turnId, entry.path) }), "file", 15_000)
    .then((res) => {
      const c = JSON.parse(res?.contents?.[0]?.text ?? "{}");
      if (c?.error) throw new Error(c.message ?? c.error);
      rememberFileContent(key, c);
      // The section may have been replaced (re-render/turn switch): apply only
      // to the entry that still owns this path.
      if (rendered.get(entry.path) === entry) {
        mergeFileContent(entry, c);
        entry.contentState = "ready";
        entry.body.textContent = "";
        if (!entry.section.classList.contains("collapsed")) hydrateFileDiff(entry);
      }
    })
    .catch((e) => {
      if (rendered.get(entry.path) === entry) {
        entry.contentState = "error";
        paintBodyError(entry, e);
      }
    })
    .finally(() => {
      fileLoads.delete(key);
      fileLoadCount = Math.max(0, fileLoadCount - 1);
      setEntryBusy(entry, false);
    });
  fileLoads.set(key, load);
  return load;
}

// Hover prefetch: by the time the click lands the content is usually here.
// Bounded (2 in flight) — sweeping the mouse across a big turn must not
// stampede the bridge.
function prefetchFileContent(entry) {
  if (!entry?.pendingContent) return;
  if (entry.contentState === "loading" || entry.contentState === "ready") return;
  if (fileContents.has(contentKey(entry))) return loadFileContent(entry);
  if (fileLoadCount >= FILE_LOAD_CONCURRENCY) return;
  loadFileContent(entry);
}


function renderFile(f) {
  try {
    renderFileInner(f);
  } catch (e) {
    const note = document.createElement("div");
    note.className = "state error";
    note.textContent = `render error (${f.path}): ${e?.message ?? e}\n${e?.stack?.split("\n")[1] ?? ""}`;
    document.getElementById("root").appendChild(note);
  }
}

// Language id used for the badge: our own special names (.env, .gitignore,
// package.json…) first, then the lib's extension catalogue (hundreds of
// extensions); "" when neither knows the file (generic FILE badge).
function langIdOf(f) {
  const p = f.oldPath ?? f.path;
  const base = String(p ?? "").split("/").pop() ?? "";
  return nameLangOf(base) || getFiletypeFromFileName(p) || "";
}

function renderFileInner(f) {  const section = document.createElement("section");
  section.className = "file" + (collapsedPaths.has(f.path) ? " collapsed" : "");
  document.getElementById("root").appendChild(section);
  const head = document.createElement("div");
  head.className = "file-head";
  const status = f.status ?? "M";
  // Language badge (0.12.0): the status chip says WHAT changed (A/M/D color);
  // this one says WHAT KIND of file it is (brand color + monogram), so a
  // glance over the headers separates a .ts from a .md from a .nu.
  const langId = langIdOf(f);
  const ext = extOf(f.path);
  const badge = styleForLang(langId, ext);
  head.innerHTML = `<span class="chev">▾</span><span class="chip s-${status === "?" ? "A" : status}"></span>
    <span class="lang-chip"></span>
    <span class="path"><span class="fname"></span><span class="fdir"></span></span>
    <span class="counts"></span>
    <span class="fh-spin" hidden title="Loading the file content…"></span>
    <button class="ghost fplus" title="Ask about this file">＋</button>`;
  const langChip = head.querySelector(".lang-chip");
  if (badge.svg) {
    // Official vendored mark (static, trusted strings — see lang-icons.js).
    langChip.classList.add("has-icon");
    if (badge.dark) langChip.classList.add("is-dark"); // lifted on dark themes
    if (badge.monoIcon) langChip.classList.add("is-mono"); // inherits currentColor
    langChip.innerHTML = badge.svg;
  } else {
    langChip.textContent = badge.mono;
    langChip.style.setProperty("--lang", badge.color);
  }
  langChip.title = `${badge.label}${ext ? ` (.${ext})` : ""}`;
  // NAME primary, full directory to its right (0.13.0). The whole path stays
  // in the tooltip; a rename shows "old → new" as the name.
  const baseOf = (p) => String(p ?? "").split("/").pop() ?? "";
  const dirOf = (p) => {
    const s = String(p ?? "");
    return s.slice(0, Math.max(0, s.length - baseOf(s).length)).replace(/\/+$/, "");
  };
  const pathEl = head.querySelector(".path");
  pathEl.title = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
  pathEl.querySelector(".fname").textContent = f.oldPath ? `${baseOf(f.oldPath)} → ${baseOf(f.path)}` : baseOf(f.path);
  pathEl.querySelector(".fdir").textContent = dirOf(f.path);
  const counts = head.querySelector(".counts");
  if (f.added !== undefined || f.deleted !== undefined)
    counts.textContent = `+${f.added ?? 0} −${f.deleted ?? 0}`;
  const entry = {
    section, body: null, fd: null, path: f.path, patch: f.patch ?? "", fileData: f,
    beforeLines: typeof f.before === "string" ? f.before.split("\n") : null,
    afterLines: typeof f.after === "string" ? f.after.split("\n") : null,
    // LIGHT payload (0.11.0): this file's content is behind diff://file/…
    turnId: diffData?.turn?.id ?? null,
    pendingContent: Boolean(f.deferred),
    contentState: f.deferred ? "idle" : "ready",
    rev: `${f.note ?? ""}|${f.added ?? ""}|${f.deleted ?? ""}`,
  };
  head.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    if (section.classList.toggle("collapsed")) {
      collapsedPaths.add(f.path);
      dehydrateFileDiff(entry);
    } else {
      collapsedPaths.delete(f.path);
      hydrateFileDiff(entry);
    }
    scheduleAnchors(); // rAF: re-position once the layout has changed
  });
  // Hover = prefetch (0.11.0): expanding a file right after pointing at it
  // finds the content already cached.
  head.addEventListener("pointerenter", () => prefetchFileContent(entry));
  section.appendChild(head);

  const body = document.createElement("div");
  body.className = "file-body";
  section.appendChild(body);
  entry.body = body;

  rendered.set(f.path, entry);
  // ✏️ live edit (working-tree views with full content only). TOGGLE: enter
  // edit mode; when already editing THIS file, save (final autosave,
  // IntelliJ style) and leave.
  if (editableNow(f)) {
    const editBtn = document.createElement("button");
    editBtn.className = "ghost fedit";
    editBtn.textContent = "✏️";
    editBtn.title = "Edit this file right here (autosave, ⌘Z, ↩ discard)";
    editBtn.onclick = (e) => {
      e.stopPropagation();
      if (entry.edit) saveEntry(entry).finally(() => endEdit(entry, "complete"));
      else {
        // editing needs the diff mounted: expand + hydrate first
        entry.section.classList.remove("collapsed");
        collapsedPaths.delete(entry.path);
        hydrateFileDiff(entry);
        startEditing(entry);
      }
    };
    entry.editBtn = editBtn;
    head.querySelector(".fplus").after(editBtn);
  }
  // (The brush-mode "?" and "↩↩" buttons were REMOVED — Damian's spec 28/10.
  // The flows remain: painting accumulates with char-level coexistence, the
  // ＋/↩ popup shows after each paint, Enter runs the revert of everything
  // painted and the popup's ＋ asks about the painted fragments.)
  // Whole-file revert (only modified files with full before content; only
  // the repo tab's working view writes — turns/commits are read-only views).
  if (typeof f.before === "string" && f.status !== "A" && f.status !== "?" && mode === "working") {
    const revBtn = document.createElement("button");
    revBtn.className = "ghost frev";
    revBtn.textContent = "↩";
    revBtn.title = "Revert this WHOLE file to the original";
    revBtn.onclick = (e) => {
      e.stopPropagation();
      revertWholeFile(entry);
    };
    head.querySelector(".fplus").before(revBtn); // PRIMERO del toolbar
  }

  // File-level ＋: anchors the whole file, quote = mini-summary.
  head.querySelector(".fplus").onclick = (e) => {
    e.stopPropagation();
    const summary = `${status}${f.oldPath ? ` · ${f.oldPath} → ${f.path}` : ""} · +${f.added ?? "?"} −${f.deleted ?? "?"}`;
    openComposerFile(entry, f.path, summary);
  };

  if (f.binary) {
    entry.noDiff = true;
    const info = document.createElement("div");
    info.className = "plain-note";
    info.textContent = "Binary file — no text diff.";
    body.appendChild(info);
    return;
  }

  // Touched outside git and gone by view time (created+deleted inside the
  // window): no content ever existed to diff — an honest note instead of an
  // empty FileDiff box.
  if (f.gone) {
    entry.noDiff = true;
    const info = document.createElement("div");
    info.className = "plain-note";
    info.textContent = "Touched in the turn and no longer exists (outside git) — no previous content to show.";
    body.appendChild(info);
    return;
  }

  // Lazy body (0.10.0 perf): the FileDiff is constructed on FIRST expand —
  // a 600-file payload must not build 600 diffs up front. Files that were
  // already open (seenPaths policy) re-hydrate right away.
  if (!section.classList.contains("collapsed")) hydrateFileDiff(entry);
}

// Construct the pierre FileDiff for one entry, on demand (expand, focus,
// edit). Synchronous on purpose: deterministic for the e2e rig.
function hydrateFileDiff(entry) {
  if (entry.fd || entry.noDiff || !entry.body) return;
  // Light payload: the content is not here yet — the fetch paints the
  // skeleton and re-enters here once it lands (0.11.0).
  if (entry.pendingContent) {
    loadFileContent(entry);
    return;
  }
  const f = entry.fileData;
  const fd = new FileDiff({
    themeType: theme,
    diffStyle: "unified",
    // The gutter is OURS (own drag below): the lib's native ＋ and selection
    // never start in the app's webview, and its hover covered the grab zone.
    // Click/drag over the numbers = our system.
    lineHoverHighlight: "both",
    // 10 context lines around each change; longer stretches become an
    // expandable separator (click = see more code, read-only).
    hunkSeparators: "line-info",
    collapsedContextThreshold: 10,
    // SINGLE highlight path (0.11.1): pierre's "massive diff" threshold is a
    // LINE count (isDiffMassive) — above it the lib renders plain and never
    // runs the tokenizer, which is exactly what keeps a 3.5k-line file's
    // click instant (measured 23/11: ~800 ms inside render before this).
    // Colors below the cap come from our deferred, memoized hlColorize.
    tokenizeMaxLength: HL_MAX_LINES,
    // Reactive: pierre reports separator expansion (previously: wait 250ms
    // and hope the rows moved). rAF coalesces multiple events.
    onHunkExpand: () => scheduleAnchors(),
  });
  entry.fd = fd;
  // <diffs-container> carries the shadow-DOM shell + core styles the
  // FileDiff renders into — a plain div renders unstyled.
  const container = document.createElement("diffs-container");
  entry.body.appendChild(container);
  applyLineFilter(entry); // the fresh file is born with the current filters

  // Highlight language (module-level HL_LANGS): the lib does not infer it
  // from contents at render time — without this it paints plain.
  const hlLang = (() => {
    const l = getFiletypeFromFileName(f.oldPath ?? f.path);
    return l && HL_LANGS.has(l) ? l : undefined;
  })();

  if (typeof f.before === "string" || typeof f.after === "string") {
    // Full content: local expandable diff (the gutter's line numbers are the
    // real file's; quotes come straight from here).
    const _r0 = performance.now();
    fd.render({
      fileContainer: container,
      oldFile:
        f.before !== undefined && f.before !== null
          ? { name: f.oldPath ?? f.path, contents: f.before, cacheKey: `da-old:${f.path}:${f.before.length}`, lang: hlLang }
          : null,
      newFile:
        f.after !== undefined && f.after !== null
          ? { name: f.path, contents: f.after, cacheKey: `da-new:${f.path}:${f.after.length}`, lang: hlLang }
          : null,
    });
    const _r1 = performance.now();
    fd.setThemeType(theme);
    attachStructureObserver(entry);
    if (hlLang) scheduleHighlight(entry, hlLang);
    const _r2 = performance.now();
    entry._hydrateMs = { render: Math.round(_r1 - _r0), hl: 0, total: Math.round(_r2 - _r0) };
    window.__DA_LAST_HYDRATE = { path: f.path, ...entry._hydrateMs, at: Date.now() };
    return;
  }

  if (!f.patch) {
    entry.noDiff = true;
    const info = document.createElement("div");
    info.className = "plain-note";
    info.textContent =
      f.status === "R" ? "Rename with no content changes." : "No patch (large file or no text changes).";
    entry.body.appendChild(info);
    return;
  }

  const parsed = parsePatchFiles(f.patch, `da-${rendered.size}`);
  const meta = parsed[0]?.files?.[0];
  if (!meta) {
    entry.noDiff = true;
    const info = document.createElement("div");
    info.className = "plain-note";
    info.textContent = "This file's patch could not be parsed.";
    entry.body.appendChild(info);
    return;
  }
  fd.render({ fileContainer: container, fileDiff: meta });
  fd.setThemeType(theme);
  attachStructureObserver(entry);
}

// Collapse DESTROYS the FileDiff: memory stays bounded by the expanded set
// (a long browsing session used to accumulate hundreds of live shadow-DOM
// diffs). Content stays in fileData — re-expanding re-diffs one file.
function dehydrateFileDiff(entry) {
  if (!entry.fd) return;
  try { entry.fd.cleanUp(); } catch { /* already gone */ }
  entry.structureObserver?.disconnect();
  entry.structureObserver = null;
  entry.body.textContent = ""; // drops the diffs-container + every layer
  entry.fd = null;
  entry._wcSig = null;
}

// Composer of the per-file ＋: same look, no setSelectedLines (there is no
// range). It also works COLLAPSED: the box lives under the header (the
// body is display:none — the composer cannot go there).
function openComposerFile(entry, path, summary) {
  closeComposer(entry);
  const card = document.createElement("div");
  card.className = "composer";
  card.innerHTML = `
    <div class="composer-head">
      <span class="anchor"></span>
      <button class="ghost close" title="Cancel">✕</button>
    </div>
    <textarea rows="3" placeholder="Ask about this file…"></textarea>
    <div class="composer-actions">
      <span class="hint">⌘↵ sends</span>
      <button class="ghost cancel">Cancel</button>
      <button class="primary ask">Ask</button>
    </div>`;
  const anchor = card.querySelector(".anchor");
  anchor.textContent = `${path} · file`;
  const ta = card.querySelector("textarea");
  const ask = card.querySelector(".ask");
  const close = () => card.remove();
  card.querySelector(".close").onclick = close;
  card.querySelector(".cancel").onclick = close;
  function submit() {
    const q = ta.value.trim();
    if (!q) { ta.focus(); return; }
    queueQuestion(path, null, [summary], q);
    close();
  }
  ask.onclick = submit;
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
  });
  if (entry.section.classList.contains("collapsed")) {
    // collapsed: under the head, static — the body is hidden.
    card.classList.add("under-head");
    entry.section.appendChild(card);
    card.scrollIntoView({ block: "nearest" });
  } else {
    positionComposerAtRow(entry, card, null);
  }
  ta.focus();
}

// The mode bar lives ALWAYS on top (in error states too, so a broken repo
// can never trap the user in a dead-end view).
function renderModebar(root) {
  const modebar = document.createElement("div");
  modebar.className = "modebar";
  // "commits" is an internal sub-view of the repo tab: the TAB stays active.
  const activeMode = mode === "commits" ? "working" : mode;
  for (const m of MODES) {
    const b = document.createElement("button");
    b.dataset.mode = m.id;
    b.textContent = m.label;
    b.title = m.title;
    if (m.id === activeMode) b.classList.add("active");
    b.onclick = () => setMode(m.id);
    modebar.appendChild(b);
  }
  // 📁 repo selector + Commits button: ONLY in the repo tab (and its Commits
  // sub-view). Turns is global — there is no single repo to pick there.
  if (mode === "working" || mode === "commits") {
    const ws = document.createElement("button");
    ws.className = "ghost ws" + (wsChosen ? "" : " empty");
    ws.textContent = wsChosen ? `📁 ${wsLabel()}` : "📁 select repository...";
    ws.title = wsChosen && currentWorkspace
      ? `${currentWorkspace}\n(click to change the diff folder)`
      : "Choose the repository whose work you want to see";
    ws.onclick = openWorkspacePicker;
    modebar.appendChild(ws);
    if (wsChosen) {
      const cb = document.createElement("button");
      cb.className = "ghost ws-commits";
      cb.textContent = "Commits";
      cb.title = "Commit history of this repository";
      if (mode === "commits") cb.classList.add("active");
      cb.onclick = () => openCommits();
      modebar.appendChild(cb);
    }
  }
  root.appendChild(modebar);
}

// The repo tab with NO repo chosen (yet): an explicit picker prompt — NOT a
// diff of whatever repo the session happens to live in (spec 22/11).
function renderRepoPickerPrompt() {
  const root = document.getElementById("root");
  hideSelPop("re-render"); // replaces the rows any popup anchors to
  dropRenderedSig(); // the DOM no longer shows the stored payload's view
  root.textContent = "";
  renderModebar(root);
  const box = document.createElement("div");
  box.className = "state";
  const p = document.createElement("div");
  p.textContent = "No repository chosen: the last turn left no changes in any git repo (or there are no turns).";
  const b = document.createElement("button");
  b.className = "ghost ws-switch";
  b.textContent = "📁 select repository…";
  b.title = "Choose the repository whose work you want to see";
  b.onclick = openWorkspacePicker;
  box.append(p, b);
  root.appendChild(box);
  document.documentElement.dataset.repo = "no";
}

// Repo-tab entry without a chosen repo: ask the server which repo the LAST
// turn changed the most and adopt it (spec 22/11). No suggestion (no turns /
// all outside git / repo gone) or a failed apply → stay unchosen and show
// the picker prompt until the user picks by hand.
async function ensureWorkspaceForRepoTab() {
  if (wsChosen || wsSuggesting || wsSuggestTried) return;
  wsSuggestTried = true;
  wsSuggesting = true;
  try {
    const res = await callTool("suggest_workspace", {});
    const sc = res?.structuredContent;
    if (sc?.ok && sc.workspace) {
      if (await applyWorkspace(sc.workspace, { silent: true }))
        chip(`📁 ${wsLabel()} — the repo with the most changes in the last turn`);
      else renderRepoPickerPrompt();
      return;
    }
    renderRepoPickerPrompt();
  } catch (e) {
    chip(`⚠ sugerencia: ${e?.message ?? e}`);
    renderRepoPickerPrompt();
  } finally {
    wsSuggesting = false;
  }
}

// Fatal workspace state (folder deleted/corrupt, read failed): WARN and always
// leave a way out — the mode bar (with the 📁 chip) plus an explicit "pick
// another folder" button. A dead repo must never brick the panel into a dead
// end where no control works.
function renderRepoError(root, message) {
  hideSelPop("re-render"); // replaces the rows any popup anchors to
  dropRenderedSig(); // the DOM no longer shows the stored payload's view
  renderModebar(root);
  const box = document.createElement("div");
  box.className = "state error";
  const p = document.createElement("div");
  p.textContent = message;
  const b = document.createElement("button");
  b.className = "ghost ws-switch";
  b.textContent = "📁 Pick another folder";
  b.title = "The current workspace does not exist or is not a git repo — switch to a valid folder";
  b.onclick = openWorkspacePicker;
  box.append(p, b);
  root.appendChild(box);
}

function renderAll() {
  renderTick++;
  // Reconcile BEFORE clearing: entries whose file content is byte-identical
  // survive (their mounted FileDiff is the expensive part). Error/empty
  // payloads keep nothing (files = []) and clear fully, as before.
  const reuseCheck = new Map();
  const filesNow = (!diffData || diffData.error) ? [] : (diffData.files ?? []);
  for (const f of filesNow) {
    const prev = rendered.get(f.path);
    // A LIGHT file's content is not in the payload: the mounted entry may
    // already hold richer (hydrated) content, so the content comparison is
    // skipped — the metadata below still decides.
    const sameContent =
      f.deferred ||
      (prev?.fileData &&
        prev.fileData.before === f.before &&
        prev.fileData.after === f.after &&
        prev.fileData.patch === f.patch);
    reuseCheck.set(
      f.path,
      Boolean(
        prev?.fileData &&
          prev.fileData.status === f.status &&
          (prev.fileData.oldPath ?? null) === (f.oldPath ?? null) &&
          (prev.fileData.added ?? null) === (f.added ?? null) &&
          (prev.fileData.deleted ?? null) === (f.deleted ?? null) &&
          (prev.fileData.note ?? "") === (f.note ?? "") &&
          (prev.fileData.repoLabel ?? "") === (f.repoLabel ?? "") &&
          sameContent,
      ),
    );
  }
  const keep = new Set(
    [...rendered.entries()].filter(([p]) => reuseCheck.get(p)).map(([, e]) => e),
  );
  clearRenderedExcept(keep);
  const root = document.getElementById("root");
  root.textContent = "";

  if (!diffData || diffData.error) {
    // "no turns yet" is an EMPTY state, not a broken repo: no switch-repo
    // call-to-action, just the message (the tab stays usable).
    if (diffData?.error === "no_turns") {
      renderModebar(root);
      const st = document.createElement("div");
      st.className = "state";
      st.textContent = diffData.message ?? "No turns yet.";
      root.appendChild(st);
      return;
    }
    renderRepoError(root, diffData?.message ?? "No diff data.");
    return;
  }

  // Toolbar STICKY: barra de modos + header siempre visibles al scrollear.
  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  renderModebar(toolbar);

  const header = document.createElement("div");
  header.className = "header";
  header.innerHTML = `
    <div class="meta"></div>
    ${mode === "commits" || mode === "turns" ? `<button class="ghost back" title="Back to the list">${mode === "commits" ? "← Commits" : "← Turns"}</button>` : ""}
    <button class="ghost filt" data-filt="add" title="Show/hide added lines">＋</button>
    <button class="ghost filt" data-filt="del" title="Show/hide removed lines">−</button>
    <button class="ghost filt" data-filt="ctx" title="Show/hide context lines (no change)">≡</button>
    <button class="ghost fold" title="Collapse every file">⊟</button>
    <button class="ghost unfold" title="Expand every file">⊞</button>
    <button class="ghost refresh" title="Refresh the diff now">⟳</button>`;
  // REAL diff summary (the numbers on the app's Git card are its own
  // calculation): +/- lines and new/modified/deleted
  // files. Extras per mode: upstream/📸/commit.
  const t = diffTotals(diffData.files);
  const bits = [];
  if (mode === "commits" && diffData.commit) {
    const c = diffData.commit;
    bits.push(`<b>${esc(c.short)}</b> ${esc(c.subject)}`);
    if (c.author || c.date) bits.push(esc([c.author, c.date].filter(Boolean).join(" · ")));
    if (diffData.isMerge) bits.push('<span class="tot-m">merge (vs first parent)</span>');
  } else if (mode === "turns" && diffData.turn) {
    const tn = diffData.turn;
    const from = tn.at?.slice(11, 16) ?? "";
    const to = tn.stoppedAt ? ` → ${esc(tn.stoppedAt.slice(11, 16))}` : "";
    bits.push(`<b>turn ${esc(from)}${to}</b>`);
    if (tn.isLive) bits.push('<span class="tot-a">live</span>');
    if (tn.interrupted) bits.push('<span class="tot-m">interrupted by the next prompt</span>');
    for (const r of tn.repos ?? []) {
      // An app-backed turn counts the files it wrote (0.10.10); the captured
      // model counts commits and dirty files.
      const fl = r.files !== undefined ? ` · ${r.files} file${r.files === 1 ? "" : "s"}` : "";
      const c = r.commits ? ` · ${r.commits} commit${r.commits === 1 ? "" : "s"}` : "";
      const d = r.dirty ? ` · ${r.dirty} dirty` : "";
      const h = r.dirtyHidden ? ` (+${r.dirtyHidden} hidden noise)` : "";
      bits.push(`<b>${esc(r.label)}</b>${fl}${c}${d}${h}`);
    }
    if (!(tn.repos ?? []).length)
      bits.push(`<span class="tot-m">${tn.source === "app" ? "no files written" : "no repos touched"}</span>`);
    bits.push(`${diffData.fileCount} file${diffData.fileCount === 1 ? "" : "s"}`);
    bits.push(`<span class="tot-a">+${t.added}</span>`, `<span class="tot-d">−${t.deleted}</span>`);
  } else {
    bits.push(`${esc(diffData.branch)} @ ${esc(diffData.head)}`);
    // Upstream chips ride the working header since 0.10.0 (the "Unpushed"
    // tab is gone — the info stays, the dedicated view doesn't).
    if (diffData.upstream) {
      const ab = [];
      if (diffData.ahead !== undefined) ab.push(`<span class="tot-a">↑${diffData.ahead}</span>`);
      if (diffData.behind !== undefined) ab.push(`<span class="tot-d">↓${diffData.behind}</span>`);
      bits.push(`${ab.join(" ")} vs ${esc(diffData.upstream)}`);
    }
    bits.push(`${diffData.fileCount} file${diffData.fileCount === 1 ? "" : "s"}`);
    bits.push(`<span class="tot-a">+${t.added}</span>`, `<span class="tot-d">−${t.deleted}</span>`);
    if (t.newFiles) bits.push(`<span class="tot-a">${t.newFiles} new</span>`);
    if (t.modFiles) bits.push(`<span class="tot-m">${t.modFiles} modified</span>`);
    if (t.delFiles) bits.push(`<span class="tot-d">${t.delFiles} deleted</span>`);
    if (t.renamed) bits.push(`${t.renamed} renamed`);
  }
  header.querySelector(".meta").innerHTML = bits.join(` <span class="dot">·</span> `);
  // Language recount (0.12.0): how many files of each type this view holds —
  // the same badges as the file headers, with the full breakdown in the title.
  const countsByLang = langCounts(filesNow.map((f) => ({ lang: langIdOf(f), ext: extOf(f.path) })));
  if (countsByLang.length) {
    const sum = document.createElement("span");
    sum.className = "lang-sum";
    sum.title = countsByLang.map((c) => `${c.label}: ${c.n}`).join("\n");
    for (const c of countsByLang.slice(0, 6)) {
      const s = document.createElement("span");
      s.className = "ls";
      if (c.svg) {
        s.classList.add("has-icon");
        if (c.dark) s.classList.add("is-dark");
        if (c.monoIcon) s.classList.add("is-mono");
        s.innerHTML = c.svg;
      } else {
        s.style.setProperty("--lang", c.color);
        const t = document.createElement("span");
        t.textContent = c.mono;
        s.appendChild(t);
      }
      const n = document.createElement("span");
      n.className = "ls-n";
      n.textContent = String(c.n);
      s.appendChild(n);
      sum.appendChild(s);
    }
    if (countsByLang.length > 6) {
      const more = document.createElement("span");
      more.className = "ls ls-more";
      more.textContent = `+${countsByLang.length - 6}`;
      sum.appendChild(more);
    }
    header.querySelector(".meta").appendChild(sum);
  }
  const backBtn = header.querySelector(".back");
  if (backBtn)
    backBtn.onclick = () => {
      endAllEdits().finally(() => {
        commitSel = null;
        turnSel = null;
        paintPendingView(mode === "commits" ? "Loading commits…" : "Loading turns…");
        refresh(true);
      });
    };
  header.querySelector(".refresh").onclick = (e) => {
    const btn = e.currentTarget;
    btn.classList.remove("spinning");
    requestAnimationFrame(() => btn.classList.add("spinning"));
    btn.addEventListener("animationend", () => btn.classList.remove("spinning"), { once: true });
    endAllEdits().finally(() => refresh(true));
  };
  header.querySelector(".fold").onclick = () => {
    for (const f of diffData.files) collapsedPaths.add(f.path);
    for (const [p, e] of rendered) {
      e.section.classList.toggle("collapsed", collapsedPaths.has(p));
      if (collapsedPaths.has(p)) dehydrateFileDiff(e); // lazy: collapsed = unmounted
    }
  };
  header.querySelector(".unfold").onclick = () => {
    collapsedPaths.clear();
    // ⊞ is an explicit "show everything": hydrate all (the one deliberate
    // mass-mount — browsing stays lazy everywhere else).
    for (const e of rendered.values()) {
      e.section.classList.remove("collapsed");
      hydrateFileDiff(e);
    }
  };
  header.querySelectorAll(".filt").forEach((b) => {
    b.onclick = () => {
      lineFilter[b.dataset.filt] = !lineFilter[b.dataset.filt];
      applyLineFilter();
    };
  });
  toolbar.appendChild(header);
  root.appendChild(toolbar);


  const hint = document.createElement("div");
  hint.className = "hint-bar";
  hint.textContent = "Modes above: Turns (the files each turn wrote — the same ones ZCode's end-of-turn summary lists; the last one live, grouped by repo and folder) · Work per repository (uncommitted vs HEAD, from the repo chosen with 📁 — its Commits button opens the history). ⌘F searches within the diff (Enter cycles) · ＋/−/≡ filter added/removed/context lines. Click a NUMBER = select it (drag to paint several, skipped ones too) → the big ＋ opens the question · hover a line → ＋ · the header ＋ = file. Below: free-form; ⌘↵ sends everything together.";
  root.appendChild(hint);

  if (!diffData.files.length) {
    const clean = document.createElement("div");
    clean.className = "state clean";
    clean.textContent =
      mode === "turns" && diffData.turn?.source === "app"
        ? "This turn wrote no files: ZCode's end-of-turn summary lists none either."
        : `Clean tree — no changes against ${diffData.baseLabel ?? "HEAD"}.`;
    root.appendChild(clean);
    keptComposers = []; // the diff came out empty: anchored asks have no anchor
    return;
  }
  if (diffData.truncated) {
    const tr = document.createElement("div");
    tr.className = "state warn";
    tr.textContent = diffData.light
      ? `Very large diff: showing the first ${diffData.files.length} of ${diffData.fileCount} files (content loads when you open them).`
      : `Very large diff: showing the first ${diffData.files.length} of ${diffData.fileCount} files and some patches were omitted.`;
    root.appendChild(tr);
  }
  for (const f of diffData.files) {
    if (!seenPaths.has(f.path)) {
      seenPaths.add(f.path);
      collapsedPaths.add(f.path); // nace colapsado
    }
  }
  // Turns: files arrive grouped by repo (contiguous — the server emits them
  // repo by repo, the non-git "~" group LAST). A header per group makes each
  // file's repo visible at a glance — ALWAYS, even with a single repo — and
  // (0.10.0) a folder sub-header inside each group sorts the browsing
  // ("categorizados por repositorios y carpetas"). Groups collapse on click.
  const repoCounts = new Map(
    (diffData.turn?.repos ?? []).map((r) => [r.label, r]),
  );
  // Emit a file section: REUSED entries re-parent their existing section in
  // emission order (FileDiff untouched); changed/new files render fresh.
  const emitFileSection = (f) => {
    const kept = rendered.get(f.path);
    if (kept) {
      // Light metadata refresh on a kept (possibly hydrated) entry: counts,
      // status and note come from the fresh payload; the content the entry
      // already holds is NEVER downgraded to the light "not here yet" state.
      if (f.deferred) {
        kept.fileData.status = f.status;
        kept.fileData.added = f.added;
        kept.fileData.deleted = f.deleted;
        kept.fileData.note = f.note;
        kept.fileData.repoLabel = f.repoLabel;
        kept.fileData.binary = f.binary;
        kept.fileData.gone = f.gone;
        if (typeof kept.fileData.before === "string" || typeof kept.fileData.after === "string")
          kept.pendingContent = false;
      }
      rendered.delete(f.path);
      rendered.set(f.path, kept); // emission order = map order
      root.appendChild(kept.section);
      return;
    }
    renderFile(f);
  };
  if (mode === "turns" && diffData.turn) {
    let lastLabel = null;
    let lastDir = null;
    for (const f of turnFilesForDisplay(diffData.files)) {
      const label = f.repoLabel ?? "";
      if (label !== lastLabel) {
        lastLabel = label;
        lastDir = null;
        root.appendChild(turnRepoHead(label, repoCounts.get(label)));
      }
      const dir = turnFolderOf(f);
      if (dir !== lastDir) {
        lastDir = dir;
        root.appendChild(turnFolderHead(label, dir));
      }
      emitFileSection(f);
    }
    applyGroupCollapse(root);
  } else {
    for (const f of diffData.files) emitFileSection(f);
  }
  applyLineFilter();
  // DRAFTS (see keptComposers): the open composers go back to their
  // section — text, listeners and focus untouched. If the file left the
  // diff (it was reverted whole), the question lost its anchor: it is dropped.
  if (keptComposers.length) {
    const refocus = keptComposers.find((k) => k.focus);
    for (const k of keptComposers) {
      const e = rendered.get(k.path);
      if (e) e.section.appendChild(k.node);
      else k.node.remove();
    }
    keptComposers = [];
    if (refocus) {
      const ta = refocus.focus;
      requestAnimationFrame(() => {
        ta.focus();
        try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch { /* input type raro */ }
      });
    }
  }
  // re-render: restore overlays/paint modes (they survive by path)
  for (const [p] of fragSel) {
    const e = rendered.get(p);
    if (e) { renderFragUI(e); renderFragBadge(e); }
  }
  // The agent may have just edited lines under pending asks: reconcile NOW,
  // with the sections' fresh rows (auto-drop, see pruneStaleAsks).
  pruneStaleAsks();
  // One-shot panel focus (the fork's end-of-turn file click → server
  // requestTurnFocus): expand the section + its group, scroll to it, flash it.
  if (diffData.focusPath) {
    const e = rendered.get(diffData.focusPath);
    if (e) {
      // FOCUS = ONLY this file open (0.14.0): the host clicked one file in
      // the end-of-turn summary, so every OTHER section collapses (and its
      // FileDiff is destroyed — memory stays bounded), then the target opens,
      // scrolls into view and flashes.
      for (const [p, other] of rendered) {
        if (p === e.path) continue;
        collapsedPaths.add(p);
        other.section.classList.add("collapsed");
        dehydrateFileDiff(other);
      }
      collapsedPaths.delete(diffData.focusPath);
      e.section.classList.remove("collapsed");
      collapsedGroups.delete(e.fileData.repoLabel ?? "");
      collapsedGroups.delete(`${e.fileData.repoLabel ?? ""}:${turnFolderOf(e.fileData)}`);
      applyGroupCollapse(root);
      hydrateFileDiff(e); // lazy: the focused file mounts now
      e.section.scrollIntoView({ behavior: "smooth", block: "start" });
      e.section.classList.add("focus-flash");
      setTimeout(() => e.section.classList.remove("focus-flash"), 2400);
    }
  }
  // With an active search, re-mark over the new rows WITHOUT jumping the
  // scroll (a reactive refresh must not move anyone's reading).
  if (find.q && !document.getElementById("findbar")?.hidden) runFind(find.q, false);
}

// --------------------------------------------------------------- commits
// Commits mode list: search box (hash or subject text, Enter), rows
// [hash · subject · author · date] and "…" to bring 10 more. A click opens
// that commit's diff (commitSel → refresh renders files).

async function loadCommits(reset = false) {
  if (reset) commitsState = { query: commitsState.query, skip: 0, list: [], hasMore: false };
  commitsLoading = true;
  const gen = refreshGen;
  const uri = `log://commits?skip=${commitsState.skip}&limit=10&q=${encodeURIComponent(commitsState.query)}`;
  let res;
  try {
    res = await withTimeout(app.readServerResource({ uri }), "commits");
  } finally {
    commitsLoading = false;
  }
  if (gen !== refreshGen) return; // superseded: don't render a stale list
  const data = JSON.parse(res?.contents?.[0]?.text ?? "{}");
  if (data.workspace) currentWorkspace = data.workspace;
  document.documentElement.dataset.repo = data?.error ? "no" : "yes";
  if (data.error) {
    const root = document.getElementById("root");
    root.textContent = "";
    renderRepoError(root, data.message ?? "I could not read the log.");
    return;
  }
  const seen = new Set(commitsState.list.map((c) => c.hash));
  for (const c of data.commits ?? []) if (!seen.has(c.hash)) commitsState.list.push(c);
  commitsState.skip += (data.commits ?? []).length;
  commitsState.hasMore = Boolean(data.hasMore);
  diffData = null; // the active view is the list, not a diff
  dropRenderedSig();
  renderCommits();
  resubscribe("log://commits");
}

function renderCommits() {
  const root = document.getElementById("root");
  hideSelPop("re-render"); // replaces the rows any popup anchors to
  root.textContent = "";

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  renderModebar(toolbar);

  const bar = document.createElement("div");
  bar.className = "commits-search";
  bar.innerHTML = `<input type="search" placeholder="Hash or title text… (Enter searches)">`;
  const back = document.createElement("button");
  back.className = "ghost back-ws";
  back.textContent = "← Trabajo del repo";
  back.title = `Back to the working tree of ${wsLabel()}`;
  back.onclick = () => backToWorking();
  bar.prepend(back);
  const input = bar.querySelector("input");
  input.value = commitsState.query;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitsState.query = input.value.trim();
      loadCommits(true);
    }
  });
  toolbar.appendChild(bar);
  root.appendChild(toolbar);

  if (!commitsState.list.length) {
    if (commitsLoading) return paintListSkeleton(root, "commits");
    const st = document.createElement("div");
    st.className = "state";
    st.textContent = commitsState.query
      ? `Nothing for “${commitsState.query}”. Try a shorter hash or part of the title.`
      : "Sin commits.";
    root.appendChild(st);
    return;
  }
  const list = document.createElement("div");
  list.className = "commit-list";
  for (const c of commitsState.list) {
    const row = document.createElement("button");
    row.className = "commit-row";
    row.innerHTML = `<span class="hash-chip"></span><span class="commit-subject"></span><span class="commit-meta"></span>`;
    row.querySelector(".hash-chip").textContent = c.short;
    row.querySelector(".commit-subject").textContent = c.subject;
    row.querySelector(".commit-meta").textContent = [c.author, c.date].filter(Boolean).join(" · ");
    row.title = `${c.hash}\n${c.subject}`;
    row.onclick = () => {
      commitSel = c.hash;
      row.classList.add("loading");
      endAllEdits().finally(() => {
        paintPendingView("Loading commit…");
        refresh(true).finally(() => row.classList.remove("loading"));
      });
    };
    list.appendChild(row);
  }
  root.appendChild(list);
  if (commitsState.hasMore) {
    const more = document.createElement("button");
    more.className = "more-btn";
    more.textContent = "…";
    more.title = "Load 10 more commits";
    more.onclick = () => {
      more.classList.add("loading");
      more.textContent = "loading…";
      loadCommits().finally(() => {
        more.classList.remove("loading");
        more.textContent = "…";
      });
    };
    root.appendChild(more);
  }
}

// ---------------------------------------------------------------- turns
// Turns mode list: one row per user message — [time] [trimmed
// prompt] [💬 full prompt] [✕ delete]. The top one with "live" is
// the last turn (against the current working tree). "Delete all" asks for
// inline confirmation (one click arms it, the second confirms).

// Turns list, paginated like Commits (Damian 22/11: 2000+ rows froze the
// panel; 0.10.0: pages of 10 — spec "de a diez hacia el pasado"). reset=true
// re-reads page 1 (reactive refresh + entry points); reset=false appends the
// next 10 (the "…" button).
async function loadTurns(reset = false) {
  if (reset) turnsState = { list: [], skip: 0, hasMore: false, total: 0, sessionFilter: null };
  turnsLoading = true;
  const gen = refreshGen;
  const uri = `turn://list?skip=${turnsState.skip}&limit=10${sessionSid ? `&sid=${encodeURIComponent(sessionSid)}` : ""}`;
  let res;
  try {
    res = await withTimeout(app.readServerResource({ uri }), "turns");
  } finally {
    turnsLoading = false;
  }
  if (gen !== refreshGen) return; // superseded: don't render a stale list
  const data = JSON.parse(res?.contents?.[0]?.text ?? "{}");
  if (data.workspace) currentWorkspace = data.workspace;
  turnsState.sessionFilter = data.sessionFilter ?? null;
  document.documentElement.dataset.repo = data?.error ? "no" : "yes";
  if (data.error) {
    const root = document.getElementById("root");
    root.textContent = "";
    renderRepoError(root, data.message ?? "I could not read the turns.");
    return;
  }
  // Append with dedupe ("latest" can overlap pages); skip advances by what is
  // actually held.
  const seen = new Set(turnsState.list.map((t) => t.id));
  for (const t of data.turns ?? []) if (!seen.has(t.id)) turnsState.list.push(t);
  turnsState.skip = turnsState.list.length;
  turnsState.hasMore = Boolean(data.hasMore);
  turnsState.total = data.count ?? turnsState.list.length;
  diffData = null;
  dropRenderedSig();
  // pendingTurnFocus (the fork's end-of-turn file click): the LIST view also
  // honors the hint — jump straight to the focused turn's diff.
  const nav = data.pendingTurnFocus;
  if (nav) {
    turnSel = nav.turn ?? "latest";
    refresh(true);
    return;
  }
  renderTurns();
  resubscribe("turn://list");
}

function openPromptCard(turn) {
  document.querySelectorAll(".prompt-card").forEach((n) => n.remove());
  const card = document.createElement("div");
  card.className = "prompt-card";
  card.innerHTML = `
    <div class="ie-head"><span class="anchor"></span><button class="ghost close" title="Close (Esc)">✕</button></div>
    <pre></pre>`;
  card.querySelector(".anchor").textContent = `Turn ${turn.at?.slice(11, 16) ?? ""} — prompt and summary`;
  card.querySelector("pre").textContent = [turn.prompt || "(sin texto)", turn.reply ? `\n— resumen del agente —\n${turn.reply}` : ""].join("");
  card.querySelector(".close").onclick = () => card.remove();
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { card.remove(); document.removeEventListener("keydown", esc); }
  });
  document.body.appendChild(card);
}

async function deleteTurnById(id) {
  try {
    const res = await callTool("delete_turn", { id });
    if (!res?.structuredContent?.ok) throw new Error(res?.structuredContent?.message ?? "could not delete");
    loadTurns(true);
  } catch (e) {
    chip(`⚠ ${e?.message ?? e}`);
  }
}

function renderTurns() {
  const root = document.getElementById("root");
  hideSelPop("re-render"); // replaces the rows any popup anchors to
  root.textContent = "";

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  renderModebar(toolbar);

  const bar = document.createElement("div");
  bar.className = "commits-search turns-actions";
  const count = document.createElement("span");
  count.className = "turns-count";
  count.textContent = turnsState.total
    ? `${turnsState.total} turn${turnsState.total === 1 ? "" : "s"} of this task · showing ${turnsState.list.length}${turnsState.sessionFilter ? "" : " (all)"}`
    : "";
  const clear = document.createElement("button");
  clear.className = "ghost danger";
  clear.textContent = "🗑 Delete all";
  clear.title = "Delete ALL turns (global, every session)";
  clear.onclick = () => {
    if (clear.dataset.armed) {
      callTool("clear_turns", {})
        .then(() => loadTurns())
        .catch((e) => chip(`⚠ ${e?.message ?? e}`));
      return;
    }
    clear.dataset.armed = "1";
    clear.textContent = "Sure? DELETE EVERYTHING";
    setTimeout(() => {
      delete clear.dataset.armed;
      clear.textContent = "🗑 Delete all";
    }, 4000);
  };
  bar.append(count, clear);
  toolbar.appendChild(bar);
  root.appendChild(toolbar);

  if (!turnsState.list.length) {
    if (turnsLoading) return paintListSkeleton(root, "turns");
    const st = document.createElement("div");
    st.className = "state";
    st.textContent = "No turns yet. Every message in the session opens a turn and the end of the answer closes it: each one lists the files it wrote, just like ZCode's end-of-turn summary.";
    root.appendChild(st);
    return;
  }
  const list = document.createElement("div");
  list.className = "commit-list turn-list";
  // Day dividers: rows arrive newest-first — a small header per day keeps
  // scrolling oriented (Today / Yesterday / dd/mm/yyyy).
  let lastDay = null;
  for (const t of turnsState.list) {
    const day = t.at?.slice(0, 10) ?? "";
    if (day !== lastDay) {
      lastDay = day;
      const divider = document.createElement("div");
      divider.className = "turn-day";
      divider.textContent = dayLabel(day);
      list.appendChild(divider);
    }
    const row = document.createElement("div");
    row.className = "commit-row turn-row";
    const time = t.at?.slice(11, 16) ?? "";
    row.innerHTML = `
      <span class="turn-time"></span>
      <span class="turn-prompt"></span>
      <span class="commit-meta turn-meta"></span>
      <span class="turn-live"></span>
      <button class="ghost turn-prompt-btn" title="See the prompt and the turn summary">💬</button>
      <button class="ghost danger turn-del" title="Delete this turn">✕</button>`;
    row.querySelector(".turn-time").textContent = time;
    row.querySelector(".turn-prompt").textContent = (t.prompt || "(sin texto)").split("\n")[0];
    row.querySelector(".turn-prompt").title = [t.prompt, t.reply].filter(Boolean).join("\n\n");
    const meta = [];
    if (t.repoCount) meta.push(`${t.repoCount} repo${t.repoCount === 1 ? "" : "s"}`);
    if (t.fileCount) meta.push(`${t.fileCount} file${t.fileCount === 1 ? "" : "s"}`);
    if (t.reply) meta.push(`💬 ${t.reply.split("\n")[0].slice(0, 90)}`);
    row.querySelector(".turn-meta").textContent = meta.join(" · ");
    if (t.isLive) row.querySelector(".turn-live").textContent = "live";
    else row.querySelector(".turn-del").remove(); // live row has no file to delete
    if (t.interrupted) row.querySelector(".turn-live").textContent = "interrumpido";
    row.querySelector(".turn-prompt-btn").onclick = (e) => {
      e.stopPropagation();
      openPromptCard(t);
    };
    const delBtn = row.querySelector(".turn-del");
    if (delBtn)
      delBtn.onclick = (e) => {
        e.stopPropagation();
        deleteTurnById(t.id);
      };
    row.onclick = () => navigateToTurn(t.id, row);
    // Hover prefetch: the light payload is already here when the click lands.
    row.addEventListener("pointerenter", () => prefetchView(turnViewUri(t.id)));
    list.appendChild(row);
  }
  root.appendChild(list);
  if (turnsState.hasMore) {
    const more = document.createElement("button");
    more.className = "more-btn";
    more.textContent = "…";
    more.title = "Load 10 more turns";
    more.onclick = () => {
      more.classList.add("loading");
      more.textContent = "loading…";
      loadTurns().finally(() => {
        more.classList.remove("loading");
        more.textContent = "…";
      });
    };
    root.appendChild(more);
  }
}

// Label of a turn-list day divider (rows arrive newest-first).
function dayLabel(day) {
  if (!day) return "(sin fecha)";
  const iso = (d) => new Date(d).toISOString().slice(0, 10);
  if (day === iso(Date.now())) return "Today";
  if (day === iso(Date.now() - 86_400_000)) return "Yesterday";
  return day.split("-").reverse().join("/");
}

// ------------------------------------------------------------ data flow

// REACTIVE subscription to the CURRENT mode's URI: on a mode/view change the
// old one is dropped and the new one subscribed (the server's git signature notifies
// subscribers; the manual ⟳ still exists as a fallback).
async function resubscribe(uri) {
  if (uri === subscribedUri) return;
  try {
    if (subscribedUri)
      await app.request({ method: "resources/unsubscribe", params: { uri: subscribedUri } });
    await app.request({ method: "resources/subscribe", params: { uri } });
    subscribedUri = uri;
  } catch {
    /* sin updates reactivos — manual ⟳ still works */
  }
}

// Open one turn: the click paints the shell + skeletons within a frame (the
// row spins), then the LIGHT read lands and the headers take over (0.11.0).
function navigateToTurn(id, row = null) {
  turnSel = id;
  row?.classList.add("loading");
  paintPendingView(id === "latest" ? "Loading the live turn…" : "Loading turn…");
  const run = refresh(true);
  if (row) run?.finally?.(() => row.classList.remove("loading"));
  return run;
}

// Mode switch (top tabs). Leaving Commits/Turns clears the selection and the
// search; entering Turns opens the LAST turn directly (live if one is open).
// Same-tab click = explicit re-entry: a stuck view must always have a way
// out (report 22/11: repo tab unresponsive, clicking its own tab did
// nothing).
async function setMode(m) {
  if (m === mode) {
    // Re-entry on Turns ALWAYS means the last turn again (0.14.1): the tab
    // used to only refresh whatever was on screen, so after opening an older
    // turn from the list — or coming back to the list — clicking "Turns"
    // kept showing that old turn and the latest one seemed to never load.
    if (m === "turns" && turnSel !== "latest") {
      turnSel = "latest";
      paintPendingView("Loading the live turn…");
    }
    refresh(true);
    return;
  }
  await endAllEdits();
  mode = m;
  commitSel = null;
  turnSel = m === "turns" ? "latest" : null;
  commitsState = { query: "", skip: 0, list: [], hasMore: false };
  turnsState = { list: [], skip: 0, hasMore: false, total: 0, sessionFilter: null };
  document.querySelectorAll(".modebar button[data-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === m);
  });
  // Immediate feedback: entering Turns always hits the server (last turn);
  // the repo tab does unless it still has to choose a repo (instant prompt).
  if (m === "turns") paintPendingView("Loading the live turn…");
  else if (wsChosen) paintPendingView(`Loading ${wsLabel()}…`);
  await refresh(true);
}

// The repo tab's Commits sub-view: reached ONLY through its button (keeps
// the chosen workspace); backToWorking returns to the same repo's tree.
async function openCommits() {
  if (!wsChosen || mode === "commits") return;
  await endAllEdits();
  mode = "commits";
  commitSel = null;
  commitsState = { query: "", skip: 0, list: [], hasMore: false };
  document.querySelectorAll(".modebar button[data-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === "working");
  });
  if (wsChosen) paintPendingView("Loading commits…");
  await refresh(true);
}

async function backToWorking() {
  if (mode !== "commits") return;
  await endAllEdits();
  mode = "working";
  commitSel = null;
  document.querySelectorAll(".modebar button[data-mode]").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === "working");
  });
  if (wsChosen) paintPendingView(`Loading ${wsLabel()}…`);
  await refresh(true);
}

let pendingRefresh = false;
let refreshInFlight = null;
let refreshGen = 0;
// Stable signature of the payload behind the current DOM: volatile timestamps
// stripped (generatedAt changes on EVERY server read; a live turn's
// stoppedAt is "now"). Two reads of unchanged data compare equal → refresh
// skips the destroy/rebuild instead of re-diffing every FileDiff. Keyed by
// URI: switching views and back must re-render even if the payload matches
// the PREVIOUS view's stored signature.
const payloadSig = (raw) => raw.replace(/"(generatedAt|stoppedAt)":"[^"]+"/g, "");
let lastRendered = { uri: null, sig: null };
// A list/prompt/error render replaces the DOM without going through the diff
// branch: drop the stored signature so the next diff read re-renders even if
// the payload is unchanged (the DOM no longer shows that payload's view).
const dropRenderedSig = () => {
  lastRendered = { uri: null, sig: null };
};

// Stale-while-revalidate (0.11.0): the last READ payloads, per URI. A light
// turn payload is KBs, so going BACK to a turn paints its headers instantly
// from here while the fresh read reconciles (the signature short-circuit
// skips the rebuild when nothing changed).
const viewCache = new Map(); // uri -> raw
const VIEW_CACHE_MAX = 6;
function rememberView(uri, raw) {
  if (!uri || !raw) return;
  viewCache.delete(uri);
  viewCache.set(uri, raw);
  while (viewCache.size > VIEW_CACHE_MAX) viewCache.delete(viewCache.keys().next().value);
}

// Prefetch the turn under the mouse (one read in flight, once per URI).
const prefetchState = { busy: false, done: new Set() };
async function prefetchView(uri) {
  if (!uri || viewCache.has(uri) || prefetchState.busy || prefetchState.done.has(uri)) return;
  prefetchState.busy = true;
  try {
    const res = await withTimeout(app.readServerResource({ uri }), "prefetch", 10_000, { quiet: true });
    const raw = res?.contents?.[0]?.text ?? "";
    if (raw) {
      rememberView(uri, raw);
      prefetchState.done.add(uri);
    }
  } catch {
    /* prefetch is best-effort — the click still reads */
  } finally {
    prefetchState.busy = false;
  }
}

// Immediate feedback on navigation (0.11.0): paint the shell + skeleton rows
// BEFORE awaiting the read, so every click has an answer within a frame.
// Rendered entries die here — navigation was already committed (mode/selection
// set by the caller).
function paintPendingView(label) {
  const root = document.getElementById("root");
  if (!root) return;
  hideSelPop("navegar");
  dropRenderedSig();
  clearRendered();
  diffData = null; // the pending view has no payload yet (tests/rig agree)
  root.textContent = "";
  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  renderModebar(toolbar);
  const head = document.createElement("div");
  head.className = "header";
  head.innerHTML = `<div class="meta"><span class="spinner"></span><span class="pend-label"></span></div>`;
  head.querySelector(".pend-label").textContent = label;
  toolbar.appendChild(head);
  root.appendChild(toolbar);
  for (let i = 0; i < 8; i++) root.appendChild(skFileSection());
  root.scrollTop = 0;
}

// Does the current target actually hit the server? (The repo tab with no repo
// chosen renders its picker prompt instantly — no skeleton needed.)
function targetReads() {
  if (mode === "working" || mode === "commits") return wsChosen;
  return true;
}

// Every server read gets a hard client-side timeout: a hung read must never
// wedge the panel — on timeout the catch below renders an error state WITH
// the mode bar, so the next click recovers.
const READ_TIMEOUT_MS = 25_000;

// In-flight feedback (0.11.0): every bridge read/tool call bumps this
// counter, and the top bar shows while it is non-zero (CSS delays it ~150 ms
// so fast reads never flash). A slow server now LOOKS slow instead of dead.
let busyCount = 0;
function pushBusy() {
  busyCount++;
  document.documentElement.dataset.busy = "1";
}
function popBusy() {
  busyCount = Math.max(0, busyCount - 1);
  if (!busyCount) delete document.documentElement.dataset.busy;
}

function withTimeout(p, what, ms = READ_TIMEOUT_MS, { quiet = false } = {}) {
  if (!quiet) pushBusy();
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${what}: no response in ${Math.round(ms / 1000)}s`)),
      ms,
    );
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  }).finally(() => {
    if (!quiet) popBusy();
  });
}

// Every panel→server TOOL call is bounded too (0.10.3): reads already had a
// timeout, but tool calls (suggestion, set_workspace, picker, write_file…)
// could hang forever on a stalled bridge — the repo tab froze with the
// server itself healthy (report 22/11, survived reopening the panel).
const TOOL_TIMEOUT_MS = 20_000;
const callTool = (name, args = {}, ms = TOOL_TIMEOUT_MS) =>
  withTimeout(app.callServerTool({ name, arguments: args }), `${name}()`, ms);

// Target of the current view. refresh() only coalesces SAME-target calls; a
// different target means the user navigated (mode/commit/workspace changed)
// and the new run SUPERSEDES the in-flight one instead of queueing behind it.
// Without this, one stuck read coalesced every later action into the same
// never-resolving promise: the panel froze for good (no mode chips, no
// folder picker, nothing responded). The workspace QUALIFIES the target: the
// same URI string resolves to different data after set_workspace, and the
// switch refresh must never coalesce with a read of the OLD workspace.
function refreshTarget() {
  const t = mode === "commits" && !commitSel ? "log://commits"
    : mode === "turns" && !turnSel ? "turn://list"
    : diffUriFor();
  // wsChosen qualifies the target: flipping it (0.10.1 picker prompt) must
  // supersede an in-flight run that started with the other value, not
  // coalesce into it.
  return `${t}@${currentWorkspace ?? ""}@${wsChosen ? 1 : 0}`;
}

const isStale = (gen) => gen !== refreshGen;
let refreshCalls = 0; // e2e telemetry: did the refresh loop even run?
// Quiescence counter for tests (0.11.1): bumped by every render — the e2e
// waits on "tick unchanged across two frames" instead of sleeping a fixed
// time. Cheap, monotonic, never resets.
let renderTick = 0;

async function refresh(explicit = false) {
  refreshCalls++;
  // The editor does not survive a re-render: while an edit session is open,
  // the REACTIVE refresh is deferred (it is applied once editing ends). The
  // explicit one (⟳, mode change) saves everything, closes sessions, goes on.
  if (!explicit && editingCount() > 0) {
    pendingRefresh = true;
    return;
  }
  // Coalesce: two near-simultaneous triggers (our own write + an agent
  // change) share ONE read/render. Actions that depend on fresh state
  // (revert) await this promise.
  const target = refreshTarget();
  if (refreshInFlight && refreshInFlight.target === target) return refreshInFlight;
  const gen = ++refreshGen; // supersedes any in-flight run aimed elsewhere
  const run = (async () => {
  const root = document.getElementById("root");
  // NOTE: the ↩/＋ popup is NOT hidden here anymore (0.10.0): an unchanged
  // payload short-circuits below and the rows it anchors to never die —
  // hiding up-front killed freshly painted popups on reactive storms (e2e
  // flake). clearRendered()/renderTurns()/renderCommits() hide it exactly
  // when the DOM they anchor to is replaced.
  if (explicit) root.classList.add("loading");
  try {
    if ((mode === "working" || mode === "commits") && !wsChosen) {
      // No repo chosen yet: don't read the server's session workspace — show
      // the picker prompt and run the one-shot last-turn suggestion (spec
      // 22/11). The suggestion's applyWorkspace refreshes on its own.
      renderRepoPickerPrompt();
      ensureWorkspaceForRepoTab();
    } else if (mode === "commits" && !commitSel) {
      await loadCommits();
    } else if (mode === "turns" && !turnSel) {
      await loadTurns(true);
    } else {
      let uri = diffUriFor();
      // Cached headers first (only when this URI is NOT what the DOM already
      // shows): switching back to a turn paints instantly, then the read
      // below revalidates through the signature short-circuit.
      const cachedRaw = viewCache.get(uri);
      if (cachedRaw && lastRendered.uri !== uri) {
        try {
          diffData = JSON.parse(cachedRaw);
          if (diffData?.workspace) currentWorkspace = diffData.workspace;
          document.documentElement.dataset.repo = diffData?.error ? "no" : "yes";
          renderAll();
          lastRendered = { uri, sig: payloadSig(cachedRaw) };
        } catch {
          /* a broken cache entry is never fatal — the read below owns it */
        }
      }
      // pendingTurnFocus (the fork's end-of-turn file click): the payload of
      // ANY view can ask us to switch to a turn — follow the hint with ONE
      // extra read, then render that view.
      let lastRaw = null;
      for (let hop = 0; hop < 2; hop++) {
        const res = await withTimeout(app.readServerResource({ uri }), "diff");
        if (isStale(gen)) return; // a newer refresh owns the UI now
        const raw = res?.contents?.[0]?.text ?? "{}";
        lastRaw = raw;
        rememberView(uri, raw);
        if (uri === lastRendered.uri && payloadSig(raw) === lastRendered.sig) {
          // Same payload as what's already on screen: keep the DOM (and its
          // expanded FileDiffs) — reactive storms must not rebuild the view.
          diffData = JSON.parse(raw);
          resubscribe(uri);
          return;
        }
        diffData = JSON.parse(raw);
        if (diffData?.workspace) currentWorkspace = diffData.workspace;
        document.documentElement.dataset.repo = diffData?.error ? "no" : "yes";
        const nav = diffData?.pendingTurnFocus;
        if (!nav || (mode === "turns" && turnSel === nav.turn)) break;
        turnSel = nav.turn ?? "latest";
        if (mode !== "turns") {
          mode = "turns";
          commitSel = null;
          document.querySelectorAll(".modebar button").forEach((b) =>
            b.classList.toggle("active", b.dataset.mode === "turns"));
        }
        uri = diffUriFor();
      }
      renderAll();
      if (lastRaw !== null) lastRendered = { uri, sig: payloadSig(lastRaw) };
      resubscribe(uri);
    }
    if (isStale(gen)) return;
    renderPile();
    renderAnchors();
  } catch (e) {
    if (isStale(gen)) return; // the newer run renders its own state
    root.textContent = "";
    // Without a mode bar a transport error would leave the user stuck in the
    // current mode (no chips to exit with).
    renderRepoError(root, `I could not read the diff: ${e?.message ?? e}`);
  } finally {
    root.classList.remove("loading");
  }
  })();
  const wrapped = run.finally(() => { if (refreshInFlight === wrapped) refreshInFlight = null; });
  wrapped.target = target;
  wrapped.gen = gen;
  refreshInFlight = wrapped;
  return wrapped;
}

function applyTheme(ctx) {
  const tm = ctx?.theme === "dark" ? "dark" : ctx?.theme === "light" ? "light" : theme;
  if (tm === theme && document.documentElement.dataset.theme) return;
  theme = tm;
  applyDocumentTheme(theme);
  for (const entry of rendered.values()) {
    try { entry.fd?.setThemeType(theme); entry.fd?.rerender(); } catch { /* stale */ }
  }
}

app.onhostcontextchanged = (ctx) => applyTheme(ctx);

async function boot() {
  ensureShell();
  document.getElementById("root").textContent = "Conectando…";
  try {
    await app.connect();
  } catch (e) {
    document.getElementById("root").textContent = `No connection to the host: ${e?.message ?? e}`;
    return;
  }
  applyTheme(app.getHostContext());
  // Session handshake (0.10.1, hardened 0.10.8): ANY tool call carries the
  // request context — but the server's cached sid is the LAST caller's, and
  // in a multi-task app another task's model call (its own get_diff) would
  // silently re-scope OUR un-stamped resources/read. So the panel learns its
  // sid here and stamps it EXPLICITLY on every turn read (turn://list?sid=
  // and diff://turn/…?sid=) — the panel's view follows its own task, always.
  // Best-effort AND bounded (3s): a stalled tool bridge must never block the
  // boot itself — without the handshake the reads fall back to global.
  try {
    const who = await callTool("whoami", {}, 3_000);
    sessionSid = String(who?.structuredContent?.sessionId ?? who?.sessionId ?? "") || "";
  } catch { /* global fallback */ }
  try {
    // Reactive refresh, THROTTLED (0.10.4): an agent working in the watched
    // repo can notify several times per second; unbounded refresh → render
    // storms froze the panel (renderer at 167% CPU measured). Leading edge
    // fires at most once per 500 ms; a trailing edge catches the tail.
    let lastReactive = 0;
    let reactiveTimer = null;
    const onReactiveUpdate = () => {
      clearTimeout(reactiveTimer);
      const since = Date.now() - lastReactive;
      if (since >= 500) {
        lastReactive = Date.now();
        refresh();
        return;
      }
      reactiveTimer = setTimeout(() => {
        lastReactive = Date.now();
        refresh();
      }, 500 - since);
    };
    app.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      // Subscribed to the active mode's URI (resubscribe): any git-signature
      // update refreshes the CURRENT view.
      if (n?.params?.uri) onReactiveUpdate();
    });
    const caps = app.getHostCapabilities?.();
    if (caps?.experimental?.["zcode/resourceSubscribe"])
      await resubscribe(diffUriFor());
  } catch {
    /* no reactive updates — manual ⟳ still works */
  }
  await refresh();
}

// errors with a visible STACK (0.8.3): the message alone is not enough to locate
// the bomb — the stack's first frame names the exact file/function.
window.addEventListener('error', (e) => {
  const stack = String(e.error?.stack ?? '').split('\n').slice(0, 4).join(' ⏐ ');
  const d = document.createElement('div');
  d.className = 'state error';
  d.textContent = 'ONERROR: ' + (e.message || e.error) + (stack ? ` ⟵ ${stack}` : '');
  document.body.appendChild(d);
});
window.addEventListener('unhandledrejection', (e) => {
  const stack = String(e.reason?.stack ?? '').split('\n').slice(0, 4).join(' ⏐ ');
  const d = document.createElement('div');
  d.className = 'state error';
  d.textContent = 'REJECT: ' + (e.reason?.message || e.reason) + (stack ? ` ⟵ ${stack}` : '');
  document.body.appendChild(d);
});

ensureShell();
if (window.__DA_TEST__) {
  // Visual-test harness (dist/dev.html): render without a host connection.
  window.__DA = {
    FileDiff,
    parsePatchFiles,
    hl: { loaded: isHighlighterLoaded, loading: isHighlighterLoading, null: isHighlighterNull },
    get rendered() { return rendered; },
    get diffData() { return diffData; },
    get wsChosen() { return wsChosen; },
    set wsChosen(v) { wsChosen = Boolean(v); },
    get refreshCalls() { return refreshCalls; },
    get renderTick() { return renderTick; },
    get refreshBusy() { return Boolean(refreshInFlight); },
    get busy() { return busyCount; },
    get fileContents() { return fileContents; },
    loadFileContent: (path) => loadFileContent(rendered.get(path)),
    prefetchFile: (path) => prefetchFileContent(rendered.get(path)),
    get lastRenderedUri() { return lastRendered.uri; },
    get mode() { return mode; },
    get turnSel() { return turnSel; },
    get turnsState() { return turnsState; },
    openCommits,
    renderAll,
    get pendingAsks() { return pendingAsks; },
    get boxSel() { return boxSel; },
    get fragSel() { return fragSel; },
    get fragModes() { return fragModes; },
    get dragPath() { return dragPath; },
    renderSelUI,
    refresh,
    edit: (path) => startEditing(window.__DA.rendered.get(path)),
    get editingCount() { return editingCount(); },
    re: (path) => {
      const e = rendered.get(path);
      const fd = new FileDiff({
        themeType: theme, diffStyle: "unified", enableGutterUtility: true, lineHoverHighlight: "both",
      });
      const meta = parsePatchFiles(e.patch, "re")[0]?.files?.[0];
      const host = document.createElement("div");
      e.section.appendChild(host);
      return { fd, meta, host, result: fd.render({ fileContainer: host, fileDiff: meta }) };
    },
  };
  diffData = window.__DA_TEST__;
  currentWorkspace = window.__DA_TEST__.workspace ?? null;
  // The harness ships a workspace: treat it as chosen so the repo tab
  // behaves like a live panel (tests can reset __DA.wsChosen to exercise
  // the picker-prompt/suggestion flow).
  wsChosen = Boolean(currentWorkspace);
  applyTheme({ theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" });
  renderAll();
  renderPile();
  // Fake send so the composer flow can be exercised outside the app too.
  app.sendMessage = async () => ({ mode: "sent", ok: true });
  // __DA_E2E__: bridge to the REAL MCP server (tests/e2e): readServerResource and
  // callServerTool travel over http to the harness, which forwards them over stdio to the
  // real server.mjs — the revert writes REAL files and the refresh
  // arrives over SSE just like the app's reactive notify.
  if (window.__DA_E2E__) {
    app.readServerResource = async ({ uri }) => {
      const r = await fetch(`/mcp?read=${encodeURIComponent(uri)}`);
      return { contents: [{ text: await r.text() }] };
    };
    app.callServerTool = async ({ name, arguments: a }) => {
      const r = await fetch("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool: name, args: a }),
      });
      return { structuredContent: await r.json() };
    };
    // in test mode boot() does not run: nobody registers the notification handler,
    // so the SSE refreshes directly (same effect as the app's reactive notify).
    new EventSource("/events").onmessage = () => {
      try { refresh(); } catch { /* best-effort refresh */ }
    };
  } else {
  // Mocked resources (window.__DA_TEST__.mockResources[uri]) to exercise
  // the views that read resources (turn://list, diff://turn/…) without a host.
  app.readServerResource = async ({ uri }) => {
    const mock = window.__DA_TEST__?.mockResources?.[uri];
    if (mock !== undefined)
      return { contents: [{ text: typeof mock === "string" ? mock : JSON.stringify(mock) }] };
    throw new Error("Not connected");
  };
  app.callServerTool = async ({ name, arguments: a }) => {
    if (name === "set_workspace")
      return { structuredContent: { ok: true, workspace: a?.path ?? currentWorkspace } };
    if (name === "suggest_workspace")
      return { structuredContent: { ok: true, workspace: null, turnId: null, reason: "no_turns" } };
    if (name === "write_file")
      return { structuredContent: { ok: true, hash: "stub-hash" } };
    return { structuredContent: { ok: true, at: new Date().toISOString() } };
  };
  }
} else {
  boot();
}
