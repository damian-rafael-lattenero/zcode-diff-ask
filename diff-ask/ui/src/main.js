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
// inside a rendered diff). "Enviar todo" (⌘↵) sends ONE message with every
// pending question.

import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/core";
import { FileDiff, parsePatchFiles, isHighlighterLoaded, isHighlighterLoading, isHighlighterNull, getFiletypeFromFileName } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/edit";
import {
  esc, extractLines, rangeLabel, quoteFor, diffTotals, buildAskMessage,
  compressRuns, linesLabel, quoteForRanges, revertLines, revertFrags,
} from "./lib.js";

const DIFF_URI = "diff://workspace";
const app = new App({ name: "diff-ask", version: "0.1.0" }, {});

// Modos del panel: qué diff se muestra y contra qué base.
//   working   → git diff HEAD + untracked (el clásico)
//   unpushed  → commits sin pushear + cambios locales, vs @{upstream}
//   turns     → TURNOS: cada mensaje del usuario fotografía el workspace
//               (HEAD + blobs de git); el diff de un turno = su foto vs la
//               del prompt siguiente; el ÚLTIMO, contra el working tree VIVO
//               (nace abierto por default). Señal: ~/.zcode/diff-ask/
//               turn-events.jsonl (la escribe el bot para Telegram y el fork
//               para desktop).
//   commits   → historial: últimos commits / búsqueda por hash o título;
//               un click abre el diff de ese commit (vs primer padre)
const MODES = [
  { id: "working", label: "Trabajo", title: "Cambios sin commitear vs HEAD (+ untracked)" },
  { id: "unpushed", label: "Sin pushear", title: "Commits sin pushear + cambios locales vs el upstream" },
  { id: "turns", label: "Turnos", title: "Qué logró cada turno (de tu prompt al siguiente); el último, en vivo" },
  { id: "commits", label: "Commits", title: "Historial de commits: buscá por hash o título, abrí el diff de uno" },
];
let mode = "working";
let commitSel = null; // hash en vista de diff de commit (null = lista)
let turnSel = null;   // id de turno en vista (null = lista; "latest" = último)
let turnsState = { list: [] };
let commitsState = { query: "", skip: 0, list: [], hasMore: false };
let subscribedUri = null;

function diffUriFor() {
  if (mode === "unpushed") return `${DIFF_URI}?mode=unpushed`;
  if (mode === "turns" && turnSel) return `diff://turn/${encodeURIComponent(turnSel)}`;
  if (mode === "commits" && commitSel) return `diff://commit/${encodeURIComponent(commitSel)}`;
  return DIFF_URI;
}

// Scope del mensaje: que el agente sepa QUÉ diff se le pregunta.
function scopeLabel() {
  if (mode === "unpushed") return diffData?.upstream ? `sin pushear, vs ${diffData.upstream}` : "sin pushear";
  if (mode === "turns" && diffData?.turn)
    return `turno ${diffData.turn.at?.slice(11, 16) ?? ""}${diffData.turn.isLatest ? " (en vivo)" : ""}`.trim();
  if (mode === "commits" && diffData?.commit) return `commit ${diffData.commit.short} ${diffData.commit.subject ?? ""}`.trim();
  return "";
}

// ------------------------------------------------- carpeta del diff (📁)
// El server diffea su workspace ACTIVO (arranca en el de la sesión y se
// cambia con la tool set_workspace). El chip muestra cuál es y permite
// cambiar a cualquier repo local — al cambiar se limpia TODO el estado
// anclado (archivos colapsados, pila, commits) porque era de la carpeta vieja.
let currentWorkspace = null;

function wsLabel() {
  if (!currentWorkspace) return "…";
  const parts = currentWorkspace.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? currentWorkspace;
}

function openWorkspaceEditor() {
  document.querySelectorAll(".ws-editor").forEach((n) => n.remove());
  const card = document.createElement("div");
  card.className = "ws-editor";
  card.innerHTML = `
    <div class="ie-head"><span class="anchor">📁 Carpeta del diff</span><button class="ghost close" title="Cancelar">✕</button></div>
    <input type="text" spellcheck="false">
    <div class="ie-actions"><span class="hint">Ruta local de un repo git · Enter aplica · Esc cancela</span><button class="primary ok">Cambiar</button></div>`;
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

async function applyWorkspace(p) {
  try {
    const res = await app.callServerTool({ name: "set_workspace", arguments: { path: p } });
    const sc = res?.structuredContent;
    if (!sc?.ok) throw new Error(sc?.message ?? "no se pudo cambiar la carpeta");
    currentWorkspace = sc.workspace;
    collapsedPaths.clear();
    seenPaths.clear();
    pendingAsks.length = 0;
    commitsState = { query: "", skip: 0, list: [], hasMore: false };
    turnsState = { list: [] };
    commitSel = null;
    turnSel = mode === "turns" ? "latest" : null;
    await endAllEdits();
    renderPile();
    await refresh(true);
    chip(`📁 ${wsLabel()}`);
    return true;
  } catch (e) {
    chip(`⚠ ${e?.message ?? e}`);
    return false;
  }
}

/** @type {any} */ let diffData = null;
/** @type {Map<string, {section: HTMLElement, body: HTMLElement, fd: import("@pierre/diffs").FileDiff|null, patch: string}>} */
const rendered = new Map();
// Pila de preguntas pendientes — kind: "line" (ancla path:líneas), "file"
// (ancla al archivo entero) o "free" (sin ancla, del askbar). Sobrevive los
// refresh del diff vivo; "Enviar todo" (⌘↵) manda UN solo mensaje.
/** @type {{kind:"line"|"file"|"free", path?:string, start?:number, lines?:string, label?:string, quoteLines?:string[], question:string}[]} */
const pendingAsks = [];
// Archivos colapsados por path — persiste durante la sesión entre re-renders.
// Todo archivo NUEVO (incluido el arranque) nace COLAPSADO: el estado inicial
// del panel es todo cerrado; lo que vos abrís queda abierto entre refresh.
const collapsedPaths = new Set();
const seenPaths = new Set();
let theme = "light";

// ------------------------------------------------------------- diff text


// Colores de líneas con pregunta pendiente: la fila SE pinta (estilo inyectado
// en el shadow DOM de pierre) según su naturaleza — verde muy oscuro/blanco
// (adiciones), rojo muy oscuro/blanco (borrados), gris clarito/negro (contexto).
const QA_STYLE = [
  // bg en la fila; color en la fila Y en todos sus spans (los tokens de
  // pierre traen color propio del tema y si no se pisan quedan ilegibles).
  // Vars CSS que heredan al shadow DOM → cambian solas con el tema.
  '[data-qa="add"]{background:var(--da-qa-add-bg,#0E4429) !important;box-shadow:inset 3px 0 0 var(--da-qa-add-bar,#3DD68C) !important;}',
  '[data-qa="add"],[data-qa="add"] *{color:var(--da-qa-add-fg,#FFFFFF) !important;}',
  '[data-qa="del"]{background:var(--da-qa-del-bg,#5A1E22) !important;box-shadow:inset 3px 0 0 var(--da-qa-del-bar,#F87171) !important;}',
  '[data-qa="del"],[data-qa="del"] *{color:var(--da-qa-del-fg,#FFFFFF) !important;}',
  '[data-qa="ctx"]{background:var(--da-qa-ctx-bg,#EBEBEF) !important;box-shadow:inset 3px 0 0 var(--da-qa-ctx-bar,#8B95A8) !important;}',
  '[data-qa="ctx"],[data-qa="ctx"] *{color:var(--da-qa-ctx-fg,#101014) !important;}',
].join("\n");

// El NÚMERO es la cajita (0.2.16): click en el gutter suma/quita la línea;
// seleccionada = celda rellena con el número visible en contraste (seguís
// contando líneas). Números +20% (1.2em) para que se lean como contadores.
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

// ------------------------------------------- filtros de visibilidad + ⌘F
// Toggles por tipo de línea: la celda del gutter lleva el MISMO
// data-line-type que su fila, así que ocultar por selector esconde fila y
// número juntos (columnas alineadas). Los separadores de hunk existen para
// el contexto colapsado: con el contexto oculto se van también.
// [data-da-find]: resaltado de la búsqueda ⌘F (hit = fila con coincidencia,
// cur = coincidencia actual).
const lineFilter = { add: true, del: true, ctx: true };
const EXTRA_STYLE = [
  ':host(.da-hide-add) [data-line-type="change-addition"]{display:none !important;}',
  ':host(.da-hide-del) [data-line-type="change-deletion"]{display:none !important;}',
  // contexto: DOS clases — pierre marca "context" el umbral renderizado y
  // "context-expanded" el que el usuario expandió de un separador. Ocultar
  // ambas = cero líneas sin cambio (si no, quedan las expandidas colgadas).
  ':host(.da-hide-ctx) [data-line-type="context"]{display:none !important;}',
  ':host(.da-hide-ctx) [data-line-type="context-expanded"]{display:none !important;}',
  ':host(.da-hide-ctx) [data-separator]{display:none !important;}',
  // selección de texto con contraste real en ambos temas (pierre trae la
  // suya apagada y encima compite con los fondos verde/rojo de las filas)
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

// Aplica los filtros corrientes a un archivo (o a todos) y refresca los
// botones del header. Las clases viven en el HOST (light DOM nuestro): la
// sombra las ve vía :host() y sobreviven sus re-renders internos.
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

// ¿El tipo de línea de esta fila está oculto por el filtro? (para que ⌘F no
// "encuentre" coincidencias invisibles)
function rowHiddenByFilter(row) {
  const t = row.dataset.lineType;
  if (t === "change-addition") return !lineFilter.add;
  if (t === "change-deletion") return !lineFilter.del;
  if (t === "context" || t === "context-expanded") return !lineFilter.ctx;
  return false;
}

// ------------------------------------------------- edición en vivo (✏️)
// El panel ES un editor: ✏️ engancha el Editor de pierre al diff de ese
// archivo y cada tecla re-difiera EN VIVO (verde/rojo al instante — la
// sesión de edición de la librería re-renderiza hunk por hunk). Guardado
// estilo IntelliJ (save-all-always): autosave con debounce 900ms vía la
// tool write_file del server, ⌘Z nativo del editor, y "↩ Descartar"
// restaura el contenido del momento del ✏️. Conflicto = GANA EL AGENTE:
// si el archivo cambió en disco, no se pisa — la versión del panel va a un
// shelve y la edición se cierra. Mientras haya edición, el refresh
// reactivo queda EN PAUSA (el editor no puede sobrevivir un re-render);
// al terminar, se refresca solo.
function editingCount() {
  let n = 0;
  for (const e of rendered.values()) if (e.edit) n++;
  return n;
}

// ¿este archivo se puede editar en la vista ACTUAL? Sólo vistas del working
// tree (Trabajo, Sin pushear, turno EN VIVO) y con contenido completo.
function editableNow(f) {
  if (typeof f.after !== "string" || f.binary || f.status === "D") return false;
  if (mode === "working" || mode === "unpushed") return true;
  if (mode === "turns" && diffData?.turn?.isLatest) return true;
  return false;
}

function ensureEditBanner() {
  if (document.getElementById("editbanner")) return;
  const b = document.createElement("div");
  b.id = "editbanner";
  b.hidden = true;
  b.innerHTML = `<span class="msg"></span><button class="ghost close" title="Cerrar">✕</button>`;
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
  c.textContent = "✏️ editando — el refresco automático sigue en pausa; al terminar se actualiza solo";
  document.body.prepend(c);
}

function updateEditUI() {
  ensurePausedChip();
  const paused = editingCount() === 0 && pendingRefresh;
  document.getElementById("pausedchip").hidden = editingCount() === 0;
  // última edición cerrada → aplicar el refresh diferido
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
    btn.textContent = `↩ Descartar (${n})`;
    btn.title = "Descartar TODAS mis ediciones (vuelve al contenido de antes de cada ✏️)";
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
  // modo edición = PURO editor: fuera selecciones y hover de ESTE archivo
  setBoxSel(entry, new Set());
  hideHoverPlus();
  const chip = document.createElement("span");
  chip.className = "editing-chip";
  chip.textContent = "✏️ editando";
  entry.section.querySelector(".file-head .fplus")?.after(chip);
  entry.section.classList.add("editing");
  entry.editBtn?.classList.add("on");
  if (entry.editBtn) entry.editBtn.title = "Salir del modo edición (guarda)";
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
    const res = await app.callServerTool({
      name: "write_file",
      arguments: { path: entry.path, content, base: e.lastSaved },
    });
    const sc = res?.structuredContent;
    if (sc?.ok) {
      e.lastSaved = content;
      return;
    }
    if (sc?.conflict) return handleConflict(entry, sc);
    throw new Error(sc?.message ?? "write_file sin respuesta");
  } catch (err) {
    showEditBanner(`⚠ No pude guardar ${entry.path}: ${err?.message ?? err}`);
  }
}

// GANA EL AGENTE: cierro la edición (descarto la sesión local) y aviso dónde
// quedó mi versión (el server ya la shelfó con su .patch).
function handleConflict(entry, sc) {
  endEdit(entry, "discard");
  showEditBanner(sc.message ?? "El archivo cambió en disco mientras editabas (gana el agente).", true);
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
  if (entry.editBtn) entry.editBtn.title = "Editar este archivo acá mismo (autosave, ⌘Z, ↩ descartar)";
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

// "↩ Descartar (N)": vuelve cada archivo al contenido del momento de su ✏️.
// Si el agente lo cambió mientras tanto, gana el agente (drop, sin shelve —
// mis ediciones ya no están en disco, no hay nada que descartar).
async function discardAllEdits() {
  for (const entry of [...rendered.values()]) {
    if (!entry.edit) continue;
    try {
      const res = await app.callServerTool({
        name: "write_file",
        arguments: {
          path: entry.path,
          content: entry.edit.origin,
          base: entry.edit.lastSaved,
          on_conflict: "drop",
        },
      });
      if (res?.structuredContent?.conflict)
        showEditBanner(`${entry.path}: ${res.structuredContent.message}`);
    } catch (err) {
      showEditBanner(`⚠ descartar ${entry.path}: ${err?.message ?? err}`);
    }
    endEdit(entry, "discard");
  }
  refresh(true);
}

// ------------------------------------------------------- revert (↩)
// "Dejálo como el original" estilo IDE (revert chunk / discard changes):
// por SELECCIÓN (las cajitas — verde o rojo da igual: el hunk que cubre esas
// líneas vuelve a su versión before) y por ARCHIVO completo. La escritura
// pasa por write_file → misma política AGENTE GANA (conflicto = shelve/aviso,
// nunca pisa). Revertir mientras el archivo está en edición ✏️ se bloquea
// (el editor tiene su propio estado del documento).
async function writeReverted(entry, content, label) {
  try {
    const res = await app.callServerTool({
      name: "write_file",
      arguments: { path: entry.path, content, base: entry.fileData.after },
    });
    const sc = res?.structuredContent;
    if (sc?.ok) {
      setBoxSel(entry, new Set());
      chip(label);
      return;
    }
    if (sc?.conflict) return showEditBanner(sc.message ?? "El archivo cambió en disco (gana el agente).", true);
    throw new Error(sc?.message ?? "write_file sin respuesta");
  } catch (e) {
    chip(`⚠ revert ${entry.path}: ${e?.message ?? e}`);
  }
}

function revertGuard(entry) {
  if (entry.edit) {
    chip("⚠ cerrá la edición ✏️ de este archivo antes de revertir");
    return false;
  }
  if (typeof entry.fileData?.after !== "string" || typeof entry.fileData?.before !== "string") {
    chip("⚠ este archivo no tiene contenido completo (¿binario/grande?)");
    return false;
  }
  return true;
}

// Revertir el ARCHIVO entero a su versión original.
async function revertWholeFile(entryIn) {
  if (refreshInFlight) await refreshInFlight.catch(() => {});
  const entry = rendered.get(entryIn.path) ?? entryIn;
  if (!revertGuard(entry)) return;
  await writeReverted(entry, entry.fileData.before, `↩ ${entry.path} vuelto al original`);
}

// Revertir EXACTAMENTE las líneas indicadas (cajitas o hover): las rojas
// seleccionadas vuelven (selOld), las verdes seleccionadas se van (selNew),
// el resto no se toca. La reconstrucción es revertLines (pura, testeada)
// sobre el alineamiento hunkContent del diff interno.
async function revertKeys(entryIn, keys) {
  // La carrera del 0.6.1: el propio usuario editó (autosave en disco) pero
  // el re-render puede seguir EN VUELO — con el alineamiento viejo, sus
  // líneas nuevas eran "contexto" (no revertible) o el hash base no pegaba
  // y saltaba el conflicto contra su propio edit. Esperamos el refresh y
  // re-resolvemos el archivo del render NUEVO (las claves son números de
  // línea del lado nuevo: siguen válidas).
  if (refreshInFlight) await refreshInFlight.catch(() => {});
  const entry = rendered.get(entryIn.path) ?? entryIn;
  if (!revertGuard(entry)) return;
  const diff = entry.fd?.getInputDiff?.();
  if (!diff || diff.isPartial || !Array.isArray(diff.hunks)) {
    chip("⚠ no tengo el alineamiento de este archivo");
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
    chip("⚠ no pude reconstruir el revert (alineamiento inconsistente)");
    return;
  }
  // chip HONESTO: si la reconstrucción es idéntica, esas líneas no tenían
  // cambios que revertir (p.ej. contexto seleccionado solito).
  if (newLines.join("\n") === entry.fileData.after) {
    chip("⚠ esas líneas no tienen cambios para revertir");
    return;
  }
  const n = selOld.size + selNew.size;
  await writeReverted(entry, newLines.join("\n"), `↩ ${n} línea${n === 1 ? "" : "s"} revertida${n === 1 ? "" : "s"}`);
}

async function revertSelection(entry) {
  revertKeys(entry, selKeysOf(entry));
}


// ------------------------------------------------- pintado de sintaxis
// Lenguajes del subconjunto bundleado (vendor/shiki-subset) + aliases.
const HL_LANGS = new Set([
  "json", "yaml", "python", "typescript", "javascript", "markdown",
  "html", "css", "bash", "shellscript", "kotlin", "haskell",
  "yml", "py", "ts", "js", "md", "sh", "shell", "zsh", "kt", "hs",
]);
// El motor (vendor/shiki-subset) tokeniza; el RENDERER de pierre no cablea
// esos tokens en nuestro contexto embebido — así que pintamos las filas
// nosotras: cada fila plain tiene UN <span> de contenido; lo reemplazamos
// por spans coloreados por token. Idempotente por tema (data-hl); se re-
// pinta en el rAF de anclajes (expansión de hunks incluida) y al cambiar
// el tema. La cita/selección siguen leyendo textContent (intacto).
const HL_THEME = () => (theme === "dark" ? "pierre-dark" : "pierre-light");

function hlColorize(entry, lang) {
  const api = globalThis.__DA_HL_READY;
  if (!api?.has(lang)) return;
  const themeName = HL_THEME();
  const afterTok =
    typeof entry.fileData?.after === "string" ? api.lines(entry.fileData.after, lang, themeName) : null;
  const beforeTok =
    typeof entry.fileData?.before === "string" ? api.lines(entry.fileData.before, lang, themeName) : null;
  if (!afterTok && !beforeTok) return;
  const sr = shadowHostOf(entry)?.shadowRoot;
  const content = sr?.querySelector("[data-content]");
  if (!content) return;
  for (const r of content.children) {
    if (!r.hasAttribute("data-line") || r.dataset.hl === themeName) continue;
    const isDel = r.dataset.lineType === "change-deletion";
    const toks = (isDel ? beforeTok : afterTok)?.[parseInt(r.dataset.line, 10) - 1];
    if (!toks) continue;
    const span = r.querySelector("span");
    if (!span) continue;
    span.innerHTML = toks
      .map((tk) => (tk.color ? `<span style="color:${tk.color}">${esc(tk.content)}</span>` : esc(tk.content)))
      .join("");
    r.dataset.hl = themeName;
  }
}

// ------------------------------------------------------------ búsqueda ⌘F// ------------------------------------------------------------ búsqueda ⌘F
// El webview no tiene find nativo (y el shadow DOM lo rompería igual):
// barra propia. Coincidencia = fila cuyo texto contiene el query
// (case-insensitive); se resalta la FILA (hit) y la actual (cur, con barra
// de acento), Enter/⇧Enter ciclan y hacen scrollIntoView. Si la fila está en
// un archivo colapsado, lo expande al saltar.
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
    <button class="ghost" id="findbar-close" title="Cerrar (Esc)">✕</button>`;
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
    // la coincidencia puede vivir en un archivo colapsado: expandirlo
    if (cur.entry.section.classList.contains("collapsed")) {
      cur.entry.section.classList.remove("collapsed");
      collapsedPaths.delete(cur.entry.path);
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

// ⌘F/ctrl+F abre la barra (aunque el foco esté en el askbar); Esc cierra.
// Nota: llega como key "f" y en el webview de la app sí llega el evento.
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
      // el span/los spans del GESTO mandan: se pintan exactamente las filas
      // cubiertas (multi-select = varias corridas). Fallback (asks sin span):
      // anclas por número DEL LADO (sin cruces).
      if (a.kind !== "line" || a.path !== entryPath) continue;
      const side = a.side ?? "additions";
      const end = a.end ?? a.start;
      let pairs = a.spans?.map((s) => [s.first, s.last]);
      if (!pairs && a.span) pairs = [{ first: a.span.first, last: a.span.last }].map((s) => [s.first, s.last]);
      if (!pairs) {
        // fallback numérico (multi-rango si lo hay, sino start..end)
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
  await saveAllEditing(); // save-all-always: nada mío queda sin guardar
  const { n, text } = buildAskMessage(pendingAsks, scopeLabel());
  try {
    const res = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
    if (res && res.isError) throw new Error("host rejected sendMessage");
    chip(`✓ ${n} pregunta${n === 1 ? "" : "s"} en el chat`);
  } catch {
    await app.updateModelContext({ content: [{ type: "text", text }] });
    chip(`↪ contexto listo (${n} pregunta${n === 1 ? "" : "s"}) — mandá tu mensaje`);
  }
  pendingAsks.length = 0;
  renderPile();
  renderAnchors();
}

// span = {first, last} índices DOM de las filas EXACTAS que cubrió el gesto
// (drag/hover/selección) — se pintan esas y ninguna más.
function queueQuestion(path, range, quoteLines, question, span) {
  if (!range) {
    // Pregunta anclada al archivo entero: la "cita" es su mini-resumen.
    pendingAsks.push({ kind: "file", path, label: "archivo", quoteLines, question });
  } else {
    const { side, lines, label } = rangeLabel(range);
    pendingAsks.push({ kind: "line", path, start: range.start, end: range.end, lines, label, side, quoteLines, question, span });
  }
  renderPile();
  renderAnchors();
}

// ------------------------------------------------------------------ shell

// #root scrollea; #pile y #askbar viven debajo, fuera del scroll — la caja
// queda SIEMPRE visible abajo. Se crea una sola vez y sobrevive renderAll.
function ensureShell() {
  if (document.getElementById("askbar")) return;
  const pile = document.createElement("div");
  pile.id = "pile";
  const askbar = document.createElement("div");
  askbar.id = "askbar";
  askbar.innerHTML = `
    <textarea id="askbar-input" rows="2" placeholder="Preguntá algo del diff (sin ancla)…"></textarea>
    <div class="askbar-actions">
      <span class="hint">Enter agrega a la pila · Shift+Enter salto de línea · ⌘↵ envía todo</span>
      <button class="ghost danger" id="askbar-clear" title="Borrar todas las preguntas pendientes">🗑 Borrar todo</button>
      <button class="primary" id="askbar-send" disabled>Enviar todo (⌘↵)</button>
      <span class="ver" title="Versión del panel — para saber qué build corrés"></span>
    </div>`;
  document.body.append(pile, askbar);
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
  askbar.querySelector("#askbar-clear").onclick = () => {
    pendingAsks.length = 0;
    renderPile();
    renderAnchors();
  };
}

// La pila: cada pendiente es una card editable in-place (click y escribí).
function renderPile() {
  const pile = document.getElementById("pile");
  if (!pile) return;
  const send = document.getElementById("askbar-send");
  if (send) {
    send.disabled = !pendingAsks.length;
    send.textContent = pendingAsks.length
      ? `Enviar todo (${pendingAsks.length}) (⌘↵)`
      : "Enviar todo (⌘↵)";
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
  head.innerHTML = `<span class="pile-title"></span><button class="ghost pile-clear">Limpiar</button>`;
  head.querySelector(".pile-title").textContent =
    `${pendingAsks.length} pregunta${pendingAsks.length === 1 ? "" : "s"} en la pila`;
  head.querySelector(".pile-clear").onclick = () => {
    pendingAsks.length = 0;
    renderPile();
  };
  pile.appendChild(head);

  pendingAsks.forEach((a, i) => {
    const card = document.createElement("div");
    card.className = "pile-item";
    card.innerHTML = `
      <div class="pile-top"><span class="anchor"></span><button class="ghost rm" title="Quitar">✕</button></div>
      <textarea class="q-edit" rows="1"></textarea>`;
    const anchor = card.querySelector(".anchor");
    anchor.textContent =
      a.kind === "free" ? "💬 libre" : a.kind === "file" ? `${a.path} · archivo` : `${a.path}:${a.lines}`;
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
    card.querySelector(".rm").onclick = () => {
      pendingAsks.splice(i, 1);
      renderPile();
    };
    pile.appendChild(card);
  });
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

// -------------------------------------------------------------- composer
// Span DOM de un rango: el del gesto si "hasta" no se tocó; si se extendió
// a mano, se re-ancla first/last por número DEL LADO (la extensión es
// numérica por definición).
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

// El composer aparece JUSTO DEBAJO de la línea seleccionada (contexto a la
// vista), no al pie del archivo. Fila oculta → fallback al pie del body.
function positionComposerAtRow(entry, card, row) {
  entry.body.appendChild(card);
  card.classList.add("anchored");
  const bodyRect = entry.body.getBoundingClientRect();
  const top = row
    ? row.getBoundingClientRect().bottom - bodyRect.top + 6
    : 4; // sin fila (＋ de archivo): pegado al inicio del body, bajo el head
  card.style.top = `${top}px`;
  card.scrollIntoView({ block: "nearest" });
}



function openComposer(entry, path, range, opts = {}) {
  // working: el rango se puede EXTENDER en el composer ("hasta línea") — así
  // el multi-línea no depende del drag: click en una línea y tipeás hasta dónde.
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
      <span class="range-ext" title="Extendé la pregunta hasta esa línea">hasta <input type="number" min="${working.start}" step="1"></span>
      <button class="ghost close" title="Cancelar">✕</button>
    </div>
    <textarea rows="3" placeholder="Preguntá sobre ${label}…"></textarea>
    <div class="composer-actions">
      <span class="hint">⌘↵ envía</span>
      <button class="ghost cancel">Cancelar</button>
      <button class="primary ask">Preguntar</button>
    </div>`;
  const anchor = card.querySelector(".anchor");
  const paint = () => {
    anchor.textContent = `${path}:${rangeLabel(working).lines}`;
    ta.placeholder = `Preguntá sobre ${rangeLabel(working).label}…`;
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
    // el verbatim vale sólo si no se extendió el rango a mano
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

// ------------------------------------------------------------ selección
// Un SOLO modelo de selección: las CAJITAS del riel (0.2.15). Click = sumar o
// quitar una línea; click y arrastre = pintar/despintar en modo pintura; se
// pueden marcar varias corridas salteadas; el ＋ grande vive debajo de la
// ÚLTIMA cajita pintada y abre el composer de toda la selección. La selección
// de texto del mouse alimenta el mismo modelo (con cita VERBATIM).

// El <diffs-container> (light DOM nuestro) que contiene al nodo, cruzando
// la frontera del shadow root — null si la selección no es de un diff.
function containerOf(node) {
  let root = node?.getRootNode?.();
  while (root instanceof ShadowRoot) {
    if (root.host?.tagName?.toLowerCase?.() === "diffs-container") return root.host;
    root = root.host.getRootNode();
  }
  return null;
}

// diagSel: chip persistente arriba a la derecha que narra el flujo de
// selección→popup (0.7.4). En la app no hay consola visible: cuando algo
// "no funciona" este chip dice EN QUÉ gate murió, sin screenshots ni OCR.
const diagSel = (() => {
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
  // OJO: Chromium RETARGETEA selecciones dentro de shadow roots — isCollapsed
  // da true y el rango queda en light DOM con rects 0×0, PERO el texto sobrevive
  // (String(sel) completo). isCollapsed ya NO puede decidir solo: hay texto, hay selección.
  const text = sel?.toString() ?? "";
  if (!sel || !text.trim()) return diagNull("colapsada/texto vacío");
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
              diagSel(`selchg → ${selRows.length} filas en ${e.path}`);
              return { entry: e, rows: selRows, text };
            }
          }
        }
      }
    }
  }
  // Camino B (Chromium real): sin rango usable — match del TEXTO contra las
  // filas. El anchorNode retargeteado sigue en el light DOM del archivo: nos
  // dice cuál entry buscar primero.
  return selectionFromText(sel, text);
}

// Match línea a línea: cada línea del texto seleccionado corresponde a UNA
// fila del diff (el orden se respeta, corrida contigua desde alguna fila).
// Las líneas parciales (media primera/media última) matchean por inclusión
// mutua de texto; las líneas vacías matchean cualquier fila (no discriminan).
function matchRowsToLines(rows, lines, near = -1) {
  // El String(sel) RETARGETEADO puede llegar INFLADO (trae contenido de más,
  // p.ej. todo el archivo) y las líneas vacías matchean cualquier fila. Las
  // vacías NO cuentan: el largo de la corrida = líneas con contenido, y las
  // vacías del texto pueden caer en cualquier fila de la corrida.
  const real = lines.map((l) => l.trim()).filter(Boolean);
  if (!real.length || real.length > rows.length) return null;
  const match1 = (line, row) => {
    const rowText = (row.textContent ?? "").trim();
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
  // texto repetido o inflado: gana la corrida MÁS CERCANA a dónde soltaste
  // el mouse (geometría real), y entre empatadas la MÁS CORTA en distancia
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
  // anchorNode retargeteado (light DOM): si cae en un entry, ése es el archivo
  const an = sel.anchorNode;
  const byAnchor = an ? candidates.filter((e) => e.body === an || e.body.contains?.(an) || an.contains?.(e.body)) : [];
  for (const e of [...new Set([...byAnchor, ...candidates])]) {
    if (e.edit) continue;
    const rows = contentRowsOf(e);
    // pista geométrica: la fila bajo el último pointerup de este archivo
    const near = selPopAt ? rows.indexOf(rowFromPoint(selPopAt.x, selPopAt.y, e)) : -1;
    const matched = matchRowsToLines(rows, lines, near);
    if (matched) {
      diagSel(`selchg → ${matched.length} filas por TEXTO (retarget) en ${e.path}`);
      return { entry: e, rows: matched, text };
    }
  }
  return diagNull("texto sin match contiguo en filas");
}

function diagNull(gate) {
  diagSel(`selchg → null (${gate})`);
  return null;
}

// boxSel: Map<path, Set<key>> — key "A:<n>" (addiciones/contexto, número
// nuevo) | "D:<n>" (borrados, número viejo). entry.selVerbatim: cita textual
// mientras la selección vino del mouse de texto (una cajita la invalida).
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
    hideSelPop(); // selección vaciada por cualquier vía → sin popup colgado
  }
  entry.selVerbatim = verbatim;
  renderSelUI(entry);
}

function selectedRowsOf(entry) {
  const keys = selKeysOf(entry);
  if (!keys.size) return [];
  return contentRowsOf(entry).filter((r) => keys.has(keyOfRow(r)));
}

// Pinta la selección de un archivo: franja tintada por fila + NÚMERO relleno
// (la cajita ES el número) + ＋ grande debajo de la última seleccionada.
function renderSelUI(entry) {
  let layer = entry.body.querySelector(".sel-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "sel-layer";
    entry.body.appendChild(layer);
  }
  layer.textContent = "";
  ensureShadowSelStyle(entry);
  // fill de números: limpiar los viejos, marcar los seleccionados
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
  big.title = "Preguntar sobre la selección";
  const br = last.getBoundingClientRect();
  big.style.top = `${br.bottom - bodyRect.top + 3}px`;
  big.style.left = "2px"; // riel izquierdo (el número ya no ocupa cajita propia)
  big.onclick = () => openComposerMulti(entry);
  layer.appendChild(big);
  // ↩ revert: los bloques cubiertos por la selección vuelven al original
  // (estilo IDE). Sólo si hay before completo — archivo nuevo no tiene original.
  if (typeof entry.fileData?.before === "string") {
    const rev = document.createElement("button");
    rev.className = "big-plus big-revert";
    rev.textContent = "↩";
    rev.title = "Revertir la selección al original (verde y rojo por igual)";
    rev.style.top = big.style.top;
    rev.style.left = "36px";
    rev.onclick = () => revertSelection(entry);
    layer.appendChild(rev);
  }
}

// Cambio in-place de una línea seleccionada (sin rebuild: el drag va fluido).
function applyBoxState(entry, key, on, row) {
  const keys = selKeysOf(entry);
  if (on) keys.add(key);
  else keys.delete(key);
  if (keys.size) boxSel.set(entry.path, keys);
  else boxSel.delete(entry.path);
  entry.selVerbatim = null; // tocó un número: la cita sale de las líneas
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

// Gestura sobre el GUTTER: click en un número = seleccionar/deseleccionar
// esa línea; arrastre = modo pintura (pinta o despinta, según el estado del
// número donde arrancó) todo lo traversado.
let boxDrag = null;
document.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const body = e.target.closest?.(".file-body");
  if (!body) return;
  // modo edición: el gutter es del editor — ni cajitas ni drag propio
  {
    let en = null;
    for (const cand of rendered.values()) if (cand.body === body) { en = cand; break; }
    if (en?.edit) return;
  }
  // no intervenir sobre nuestra propia UI
  if (e.target.closest?.(".inline-editor, .line-marker, .head-marker, .composer, .big-plus, .hover-plus, .sel-layer")) return;
  let entry = null;
  for (const en of rendered.values()) if (en.body === body) { entry = en; break; }
  if (!entry) return;
  const g = entry.body.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-gutter]");
  if (!g) return;
  const gr = g.getBoundingClientRect();
  if (e.clientX < gr.left - 4 || e.clientX > gr.right + 14) return; // sólo la zona de números
  const row = rowFromPoint(e.clientX, e.clientY, entry);
  if (!row) return;
  hideHoverPlus();
  e.stopPropagation(); // la sesión es nuestra: la lib no arranca la suya
  e.preventDefault(); // sin selección de texto nativa colgante tras el drag
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
  // 0.7.3: el popup flotante también para la selección de CAJITAS (el gesto
  // clásico del panel) — no sólo para texto del mouse. Ancla: el punto donde
  // soltaste (coords del pointerup — selPopAt aún no se actualizó: este
  // listener corre antes que el de anclaje) + rect de la última fila pintada.
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

// Selección de texto del mouse → el MISMO modelo de cajitas (con verbatim)
// y el popup flotante ＋/↩ anclado a donde terminó el gesto.
let selTimer = null;
document.addEventListener("selectionchange", () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(paintCurrentSelection, 150);
});

// FLUJO ÚNICO de pintado (0.8.4): 1) geometría del drag (caret sobre el
// shadow — inmune al retargeting de Chromium); 2) match por texto (fallback);
// 3) nada. Antes selectionAsk era el portero y si su texto inflado no
// matcheaba, el pintado moría aunque la geometría del drag fuera perfecta.
function paintCurrentSelection() {
  const sel = document.getSelection();
  if (!sel || !String(sel).trim()) {
    if (!boxSel.size && !fragSelTotal()) hideSelPop("seleccionó nada");
    return;
  }
  // 1) drag conocido → entry por hit-test del punto inicial, frag por carets
  if (dragPath && Date.now() - dragPath.at < 1500) {
    const A = pointToRowInfo(dragPath.x0, dragPath.y0, true);
    diagSel(`caret A=${A?.fail ?? A?.entry?.path.slice(-18) + "@" + A?.idx ?? "fuera"} drag=${dragPath.x0},${dragPath.y0}`);
    const entry = A?.entry && rendered.get(A.entry.path) ? A.entry : null;
    if (entry && !entry.edit) {
      const byCaret = caretFrag(entry);
      if (byCaret) return void toggleFrag(entry, byCaret);
      diagSel("caretFrag ✗ sobre el entry del drag (sigue por texto)");
    }
  }
  // 2) fallback: selección → filas por rango/texto → offsets derivados
  const info = selectionAsk();
  if (info && !info.entry.edit) paintFromSelection(info.entry, info.rows, info.text);
  else if (info?.entry?.edit) diagSel("selchg → archivo en edición, ignorada");
}

// 0.7.4 respaldo: si por lo que fuere el selectionchange no llegara (webview
// raro, foco, IME), el pointerup re-intenta el mismo flujo 180ms después.
// Nunca ESCONDE: si no hay selección, no hace nada (el popup del gutter
// recién creado por endBoxDrag debe sobrevivir este camino).
document.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return;
  setTimeout(() => {
    if (selPop) return;
    const sel = document.getSelection();
    if (!sel || !String(sel).trim()) return; // retarget: no confiar en isCollapsed
    const before = fragSelTotal();
    paintCurrentSelection();
    if (fragSelTotal() > before) diagSel("respaldo pointerup → pintó");
  }, 180);
}, true);

// --------------------------------- popup flotante ＋/↩ de la selección
// Al soltar el mouse sobre texto del diff los DOS botones aparecen flotando
// pegados a donde terminó el gesto: ＋ pregunta sobre la selección, ↩ revierte
// SOLO lo seleccionado. Hacen exactamente lo mismo que el ＋ grande y la ↩
// grande que quedan bajo la última línea — el popup es el atajo inmediato,
// los grandes siguen de ancla cuando scrolleás. Se va solo: scroll, click
// afuera, Esc, selección nueva/colapsada o re-render.
let selPop = null;
let selPopAt = null;

function hideSelPop(why = "") {
  if (selPop && why) diagSel(`popup fuera (${why})`);
  selPop?.remove();
  selPop = null;
}

// última posición del mouse: es el ancla natural del popup (donde soltaste)
document.addEventListener("pointerup", (e) => {
  if (e.button === 0) selPopAt = { x: e.clientX, y: e.clientY };
}, true);

// anchor (opcional): {x, y, top, bottom} — para la selección de CAJITAS, que
// no tiene selección nativa (rect de rango colapsado = 0 y el gate lo mata).
function showSelPop(entry, anchor = null, actions = null) {
  let rect;
  let p;
  if (anchor?.row) {
    // ancla FIN DE SELECCIÓN (spec Damian): la última fila seleccionada, pegado
    // al borde derecho de SU TEXTO (el span de contenido; el row es todo el
    // ancho del archivo y mandaría el popup al margen derecho) — flota EN el
    // área del texto, no en rieles.
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
      diagSel("showSelPop → rect 0×0, sin popup (¿selección retargeteada?)");
      return;
    }
    p = selPopAt;
  }
  hideSelPop();
  const pop = document.createElement("div");
  pop.className = "sel-pop";
  const ask = document.createElement("button");
  ask.textContent = "＋";
  ask.title = "Preguntar sobre la selección";
  ask.onclick = () => { hideSelPop(); actions?.frag ? openFragComposer(entry) : openComposerMulti(entry); };
  pop.appendChild(ask);
  // ↩ sólo si hay original al cual volver (archivo nuevo no tiene)
  if (typeof entry.fileData?.before === "string") {
    const rev = document.createElement("button");
    rev.className = "rev";
    rev.textContent = "↩";
    rev.title = "Revertir la selección al original";
    rev.onclick = () => { hideSelPop(); actions?.frag ? revertPainted(entry) : revertSelection(entry); };
    pop.appendChild(rev);
  }
  // pointerdown propio sin colapsar la selección nativa al tocar un botón
  pop.addEventListener("pointerdown", (e) => e.preventDefault());
  document.body.appendChild(pop);
  selPop = pop;
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let x;
  let y;
  if (anchor?.row) {
    // al final de la última línea: pegado al borde derecho del texto, arriba
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
  diagSel(`popup ＋${pop.children.length > 1 ? "↩" : ""} @${Math.round(x)},${Math.round(y)} (${anchor?.row ? "fin de selección" : anchor ? "gutter" : "texto"})`);
}

// el popup queda desanclado al scrollear: se va (los grandes siguen)
document.addEventListener("scroll", () => hideSelPop("scroll"), { capture: true, passive: true });
document.addEventListener("pointerdown", (e) => {
  if (selPop && !selPop.contains(e.target)) hideSelPop("click afuera");
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideSelPop("esc");
});

// ------------------------------------------------ pintado quirúrgico
// 0.8.0 — la selección de texto es un canal PROPIO, separado de las cajitas
// del gutter (que quedan exactamente como estaban). frags por archivo:
// {firstRowIdx, lastRowIdx, offA, offB, text} — offsets planos [A,B) sobre
// el texto de la primera/última fila (intermedias van completas).
// Modo por archivo (botones ?/↩ junto a ✏️): neutral = pintada ÚNICA con
// popup inmediato; modo = acumulativa con toggle (pintar sobre pintado
// despinta); el botón pasa a ✓-ejecutar; Esc despinta lo del archivo activo.
const fragSel = new Map(); // path → [frag...]
const fragModes = new Map(); // path → "ask" | "rev"
let lastPaintedEntry = null;

function fragSelTotal() {
  let n = 0;
  for (const v of fragSel.values()) n += v.length;
  return n;
}

// Range interno sobre el span de una fila para offsets planos [a,b]. La
// RAÍZ del 0.8.6: los offsets de CARACTERES hay que resolverlos hasta el
// nodo de TEXTO real (los tokens de highlight son spans anidados — `código`
// con backticks, negritas markdown — y setStart/setEnd sobre un ELEMENTO
// interpreta el offset como ÍNDICE DE HIJO: "no child at offset N"). El
// localizador recursivo baja por los subárboles acumulando longitud.
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

// Camino del drag de texto: punto inicial y final del gesto. Con el
// retargeting de Chromium ni el rango ni (a veces) los newlines de
// String(sel) son confiables — caretRangeFromPoint sobre ESTOS puntos sí
// atraviesa el shadow root y da fila+offset exactos.
let dragPath = null;
document.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  dragPath = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, at: Date.now() };
}, true);
document.addEventListener("pointermove", (e) => {
  if (dragPath && (e.buttons & 1)) { dragPath.x1 = e.clientX; dragPath.y1 = e.clientY; }
}, true);

// frag geométrico: hit-test de los extremos del drag contra el shadow DOM
// (shadowRoot.elementFromPoint SÍ devuelve el elemento interno — y los spans
// del highlighting son tokens, así que la suma de hermanos previos da offset
// con precisión de palabra). caretRangeFromPoint NO sirve: retargetea.
// offset de carácter dentro del span cuya posición horizontal ≈ x, por
// búsqueda binaria sobre getBoundingClientRect de ranges internos (los rects
// del shadow SÍ son geometría real aunque la Selection retargetee).
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
      continue; // probar el próximo archivo — no es culpa suya
    }
    let node = inner;
    while (node && !node.hasAttribute?.("data-line")) node = node.parentElement;
    if (!node?.hasAttribute?.("data-line")) return why ? { fail: "walk sin DL desde " + inner.nodeName } : null;
    const rows = contentRowsOf(e);
    const idx = rows.indexOf(node);
    if (idx < 0) return why ? { fail: "idx -1 en " + e.path.slice(-16) } : null;
    const span = node.querySelector("span");
    const spanText = span?.textContent ?? "";
    let off = spanText.length;
    if (span && inner !== node && inner !== span) {
      let n = inner;
      while (n && n.parentElement !== span) n = n.parentElement;
      if (n) {
        off = 0;
        for (const c of span.childNodes) {
          if (c === n) break;
          off += c.textContent.length;
        }
      }
    } else if (span) {
      // el punto no tocó un TOKEN (línea sin highlight o padding): binaria
      // de rects sobre ranges internos para el offset de carácter exacto —
      // antes esto daba 0/mitad/fin y una palabra se volvía línea entera.
      off = offsetAtX(span, x);
    }
    return { entry: e, idx, off };
  }
  return null;
}

function caretFrag(entry) {
  if (!dragPath || Date.now() - dragPath.at > 1200) return null;
  const A = pointToRowInfo(dragPath.x0, dragPath.y0);
  const B = pointToRowInfo(dragPath.x1, dragPath.y1);
  if (!A || !B || A.entry !== entry || B.entry !== entry) {
    diagSel(`caretFrag ✗ A=${A ? A.entry.path.slice(-14) : "null"} B=${B ? B.entry.path.slice(-14) : "null"} (cae al match por texto)`);
    return null;
  }
  if (A.idx === B.idx && B.off <= A.off) {
    // doble-click / click sin arrastre: PALABRA bajo el caret (spec Damian —
    // antes esto caía al fallback de texto y pintaba la LÍNEA ENTERA)
    const rowText = contentRowsOf(entry)[A.idx]?.querySelector("span")?.textContent ?? "";
    const isWord = (ch) => /[\wáéíóúñÁÉÍÓÚÑ]/.test(ch);
    let a = Math.min(A.off, rowText.length);
    let b = a;
    while (a > 0 && isWord(rowText[a - 1])) a--;
    while (b < rowText.length && isWord(rowText[b])) b++;
    if (b <= a) return null;
    return { firstRowIdx: A.idx, lastRowIdx: A.idx, offA: a, offB: b, text: rowText.slice(a, b) };
  }
  const first = A.idx <= B.idx ? A : B;
  const last = A.idx <= B.idx ? B : A;
  const rows = contentRowsOf(entry);
  const rowText = (i) => rows[i]?.querySelector("span")?.textContent ?? rows[i]?.textContent ?? "";
  // drag VERTICAL (el gesto natural para "estas líneas enteras"): filas
  // completas — la componente horizontal no discrimina nada útil
  // vertical = gesto claramente de líneas enteras: bajó media línea (14px) o
  // más y casi sin componente horizontal. Diagonales cortas de palabra ya no
  // clasifican (antes pintaban la fila entera).
  const vertical = Math.abs(dragPath.y1 - dragPath.y0) >= 14 && Math.abs(dragPath.x1 - dragPath.x0) < 8;
  const offA = vertical ? 0 : Math.min(first.off, rowText(first.idx).length);
  const offB = vertical ? rowText(last.idx).length : Math.min(last.off, rowText(last.idx).length);
  const parts = [];
  for (let i = first.idx; i <= last.idx; i++) {
    const rt = rowText(i);
    parts.push(rt.slice(i === first.idx ? offA : 0, i === last.idx ? offB : rt.length));
  }
  return { firstRowIdx: first.idx, lastRowIdx: last.idx, offA, offB, text: parts.join("\n") };
}

// Selección → frag. PRIMERO geometría (camino del drag + carets, exacto);
// si no hay camino usable, match del texto contra las filas (fallback).
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
  const firstText = crows[first]?.querySelector("span")?.textContent ?? crows[first]?.textContent ?? "";
  const lastText = crows[last]?.querySelector("span")?.textContent ?? crows[last]?.textContent ?? "";
  // línea vacía = la selección nace/muere EN el borde de la fila (no un
  // "endsWith('')" que mandaría el offset al otro extremo)
  const firstLine = lines[0] ?? "";
  const lastLine = lines[lines.length - 1] ?? "";
  let offA = 0;
  if (firstLine) offA = firstText.endsWith(firstLine) ? firstText.length - firstLine.length : Math.max(0, firstText.indexOf(firstLine));
  let offB = lastText.length;
  if (rows.length === 1) {
    if (lastLine) {
      const idx = firstText.indexOf(lastLine, offA);
      offB = idx >= 0 ? idx + lastLine.length : firstText.length;
    } else offB = firstText.length;
  } else if (lastLine) {
    offB = lastText.startsWith(lastLine) ? lastLine.length : Math.max(0, lastText.indexOf(lastLine)) + lastLine.length;
  }
  if (offB <= offA) offB = firstText.length;
  const frag = { firstRowIdx: first, lastRowIdx: last, offA, offB, text };
  toggleFrag(entry, frag);
}

function toggleFrag(entry, frag) {
  lastPaintedEntry = entry;
  const list = fragSel.get(entry.path) ?? [];
  const mode = fragModes.get(entry.path);
  if (mode) {
    // modo: toggle exacto; solapado con otro → el nuevo lo reemplaza
    const eq = list.find((f) => f.firstRowIdx === frag.firstRowIdx && f.lastRowIdx === frag.lastRowIdx && f.offA === frag.offA && f.offB === frag.offB);
    let next;
    if (eq) next = list.filter((f) => f !== eq);
    else {
      next = list.filter((f) => f.lastRowIdx < frag.firstRowIdx || f.firstRowIdx > frag.lastRowIdx);
      next.push(frag);
      next.sort((a, b) => a.firstRowIdx - b.firstRowIdx);
    }
    if (next.length) fragSel.set(entry.path, next);
    else fragSel.delete(entry.path);
  } else {
    // neutral: pintada ÚNICA y continua
    fragSel.set(entry.path, [frag]);
  }
  renderFragUI(entry);
  renderFragBadge(entry);
  if (fragSel.get(entry.path)?.length) {
    const rows = contentRowsOf(entry);
    const f = fragSel.get(entry.path).at(-1);
    showSelPop(entry, { row: rows[f.lastRowIdx] }, { frag: true });
  } else {
    hideSelPop("despintado");
  }
}

// franjas de lo pintado: rects reales de la porción [a,b) de cada fila
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
    // telemetría del throw: fila/datos exactos que lo causan
    const rows = contentRowsOf(entry);
    const dump = frags.flatMap((f) => {
      const out = [];
      for (let i = f.firstRowIdx; i <= f.lastRowIdx && out.length < 4; i++) {
        const c = rows[i];
        out.push({ i, hay: !!c, span: !!c?.querySelector("span"), tc: (c?.textContent ?? "").length, offA: f.offA, offB: f.offB, tipo: c?.dataset?.lineType });
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
      // fila a fila a prueba de todo: una fila rara no puede tumbar el
      // pintado entero (y si explota, el dump dice exactamente qué era)
      try {
        const row = crows[i];
        if (!row) continue;
        const rt = row.querySelector("span")?.textContent ?? row.textContent ?? "";
        const a = i === f.firstRowIdx ? f.offA : 0;
        const b = i === f.lastRowIdx ? Math.min(f.offB, rt.length) : rt.length;
        if (b <= a) continue;
        let rects;
        const span = row.querySelector("span");
        if (span) {
          try { rects = [...plainOffsetToRange(span, a, b).getClientRects()]; } catch { rects = []; }
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
        diagSel(`fila ${i} THROW ${err.message} ⟵ nodeType=${c?.nodeType} tc=${typeof c?.textContent} span=${!!c?.querySelector?.("span")} kids=${c?.childNodes?.length}`);
      }
    }
  }
  layer.appendChild(frag);
}

function clearFrags(entry) {
  fragSel.delete(entry.path);
  renderFragUI(entry);
  renderFragBadge(entry);
  hideSelPop("esc despinta");
}

function renderFragBadge(entry) {
  const n = fragSel.get(entry.path)?.length ?? 0;
  const mode = fragModes.get(entry.path);
  for (const [btn, m] of [[entry.fragAskBtn, "ask"], [entry.fragRevBtn, "rev"]]) {
    if (!btn) continue;
    const active = mode === m;
    btn.classList.toggle("on", active);
    if (m === "ask") btn.textContent = active ? (n ? "?✓" : "?") : "?";
    else btn.textContent = active ? (n ? "↩✓" : "↩") : "↩";
    btn.title = active
      ? (n ? `Ejecutar sobre ${n} fragmento${n === 1 ? "" : "s"} pintado${n === 1 ? "" : "s"} (Esc despinta)` : "Modo pintar para preguntar — seleccioná fragmentos")
      : m === "ask"
        ? "Modo brocha: pintá fragmentos y después preguntás"
        : "Modo brocha: pintá fragmentos y después revertís (quirúrgico)";
  }
}

function setFragMode(entry, m) {
  const cur = fragModes.get(entry.path);
  if (cur === m) {
    // ya activo: con pintadas = EJECUTAR; sin pintadas = apagar
    const n = fragSel.get(entry.path)?.length ?? 0;
    if (n && m === "ask") return openFragComposer(entry);
    if (n && m === "rev") return revertPainted(entry);
    fragModes.delete(entry.path);
  } else {
    fragModes.set(entry.path, m);
  }
  renderFragBadge(entry);
}

// ---- ejecutores ----
function fragsToLib(entry) {
  const crows = contentRowsOf(entry);
  const out = [];
  for (const f of fragSel.get(entry.path) ?? []) {
    for (let i = f.firstRowIdx; i <= f.lastRowIdx; i++) {
      const row = crows[i];
      if (!row) continue;
      const rt = row.querySelector("span")?.textContent ?? row.textContent ?? "";
      const a = i === f.firstRowIdx ? f.offA : 0;
      const b = i === f.lastRowIdx ? Math.min(f.offB, rt.length) : rt.length;
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
      <button class="ghost close" title="Cancelar">✕</button>
    </div>
    <textarea rows="3"></textarea>
    <div class="composer-actions">
      <span class="hint">⌘↵ envía</span>
      <button class="ghost cancel">Cancelar</button>
      <button class="primary ask">Preguntar</button>
    </div>`;
  card.querySelector(".anchor").textContent = `${entry.path} · ${frags.length} fragmento${frags.length === 1 ? "" : "s"}`;
  const ta = card.querySelector("textarea");
  ta.placeholder = `Preguntá sobre ${frags.length} fragmento${frags.length === 1 ? "" : "s"} pintado${frags.length === 1 ? "" : "s"}…`;
  entry.section.appendChild(card);
  const close = () => card.remove();
  card.querySelector(".close").onclick = close;
  card.querySelector(".cancel").onclick = close;
  const submit = () => {
    const q = ta.value.trim();
    if (!q) { ta.focus(); return; }
    // cita verbatim: los fragmentos concatenados con separador ⋯
    const quote = [];
    frags.forEach((f, i) => {
      if (i) quote.push("⋯");
      quote.push(...f.text.split("\n"));
    });
    queueQuestion(entry.path, range ?? { start: 1, end: 1, side: "additions" }, quote, q, null);
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
  if (!diff || !Array.isArray(diff.hunks)) return chip("⚠ no tengo el alineamiento de este archivo");
  const libFrags = fragsToLib(entry);
  diagSel(`rev input: ${JSON.stringify(libFrags).slice(0, 150)}`);
  const res = revertFrags(entry.beforeLines, entry.afterLines, diff.hunks, libFrags);
  diagSel(`rev res: ${res?.noDiff ? "noDiff" : res?.lines ? "lines:" + res.lines.length : String(res)}`);
  if (!res) return chip("⚠ no pude reconstruir el revert (alineamiento inconsistente)");
  if (res.noDiff) {
    clearFrags(entry);
    return miniNotice("no diff selected");
  }
  const n = uiFrags.length;
  await writeReverted(entry, res.lines.join("\n"), `↩ quirúrgico: ${n} fragmento${n === 1 ? "" : "s"}`);
  clearFrags(entry);
}

// mini aviso efímero (p.ej. "no diff selected") — infimo, esquina inferior
function miniNotice(msg) {
  const d = document.createElement("div");
  d.className = "mini-notice";
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 2200);
}

// Esc en cascada: composer → findbar → pintado del activo → edición (descarta)
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const composer = document.querySelector(".composer");
  if (composer) { composer.remove(); return; }
  const fb = document.getElementById("findbar");
  if (fb && !fb.hidden) { closeFindbar(); return; }
  const entry = lastPaintedEntry && rendered.get(lastPaintedEntry.path) ? lastPaintedEntry : null;
  if (entry && (fragSel.get(entry.path)?.length || fragModes.get(entry.path))) {
    clearFrags(entry);
    fragModes.delete(entry.path);
    renderFragBadge(entry);
    return;
  }
  const editing = entry?.edit ? entry : [...rendered.values()].find((en) => en.edit);
  if (editing) {
    // ✏️ mismo contrato que ?: apretar de nuevo acepta, Esc DESESTIMA todo
    discardAllEdits();
  }
});

// ------------------------------------------------ hover-＋ (riel izquierdo)
// Hover en una línea → ＋ chiquito pegado a la IZQUIERDA (sobre los números,
// nunca sobre el texto seleccionable). Se va con el mouse. Click → composer
// de esa línea. Un solo botón global que vive en el body de su archivo.
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
  if (row === hoverRow && hoverPlus?.isConnected) return;
  hideHoverPlus();
  hoverRow = row;
  hoverPlus = document.createElement("button");
  hoverPlus.className = "hover-plus";
  hoverPlus.textContent = "＋";
  hoverPlus.title = "Preguntar sobre esta línea";
  hoverPlus.onclick = () => {
    hideHoverPlus();
    const idx = contentRowsOf(entry).indexOf(row);
    openComposer(entry, entry.path, rangeOfRow(row), { row, span: { first: idx, last: idx } });
  };
  entry.body.appendChild(hoverPlus);
  // ↩ por línea en el riel DERECHO (donde viven los 💬): sólo filas CAMBIADAS
  // (agregada se quita / borrada vuelve). Convive con el ＋ izquierdo.
  const t = row.dataset.lineType;
  if (t === "change-addition" || t === "change-deletion") {
    hoverRevert = document.createElement("button");
    hoverRevert.className = "hover-plus hover-revert";
    hoverRevert.textContent = "↩";
    hoverRevert.title = "Revertir esta línea al original";
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
  if (e.target.closest?.(".hover-plus")) return; // parado sobre el ＋: queda
  const body = e.target.closest?.(".file-body");
  if (!body) { hideHoverPlus(); return; }
  let entry = null;
  for (const en of rendered.values()) if (en.body === body) { entry = en; break; }
  if (!entry || entry.edit) { hideHoverPlus(); return; } // edición = puro editor
  const row = rowFromPoint(e.clientX, e.clientY, entry);
  if (!row) { hideHoverPlus(); return; }
  showHoverPlus(entry, row);
});
document.documentElement.addEventListener("pointerleave", hideHoverPlus);

// ------------------------------------------------- filas del shadow DOM
// El acceso a las filas de pierre (shadow DOM) para hover-＋ y cajitas:
// document.elementFromPoint NO atraviesa el shadow (devuelve el host), hay
// que preguntarle directo al shadowRoot del diffs-container.
function contentRowsOf(entry) {
  const content = entry.body.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-content]");
  return content ? [...content.children].filter((r) => r.hasAttribute("data-line")) : [];
}

// Fila bajo un punto: GEOMETRÍA sobre los rects de las filas de contenido.
// El hit-test clásico no sirve acá: nuestros overlays (cajitas, franjas,
// hover-＋) tapan el punto y elementFromPoint los devuelve a ellos — medir
// rects es inmune a lo que esté encima (y no depende del shadow DOM).
function rowFromPoint(x, y, entry) {
  for (const r of contentRowsOf(entry)) {
    const rect = r.getBoundingClientRect();
    if (y >= rect.top && y <= rect.bottom) return r;
  }
  return null;
}

// Lado del ancla de un conjunto de filas: si toca algo no-borrado es el
// lado nuevo; si es todo borrado, el viejo (mismo criterio que el resto).
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

// Composer de la SELECCIÓN multi: filas seleccionadas → corridas → rangos
// numéricos por lado; el ＋ grande (debajo de la última cajita) abre esto.
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
      <button class="ghost close" title="Cancelar">✕</button>
    </div>
    <textarea rows="3"></textarea>
    <div class="composer-actions">
      <span class="hint">⌘↵ envía</span>
      <button class="ghost cancel">Cancelar</button>
      <button class="primary ask">Preguntar</button>
    </div>`;
  card.querySelector(".anchor").textContent = `${entry.path}:${lines}`;
  const ta = card.querySelector("textarea");
  ta.placeholder = `Preguntá sobre líneas ${lines}…`;
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
      lines, label: `líneas ${lines} · ${side}`, side, quoteLines, question: q, spans, ranges,
    });
    close();
    setBoxSel(entry, new Set()); // la pregunta quedó anclada: selección a cero
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

// Re-posicionado de anclajes REACTIVO: un solo rAF coalesce cualquier
// cantidad de disparadores (onHunkExpand, observer estructural, colapso) —
// cero "esperar N ms a ver si asentó".
let anchorsScheduled = false;
function scheduleAnchors() {
  if (anchorsScheduled) return;
  anchorsScheduled = true;
  requestAnimationFrame(() => {
    anchorsScheduled = false;
    renderAnchors();
    // filas nuevas (expansión) o motor recién listo → re-pintar sintaxis
    for (const entry of rendered.values()) {
      if (!entry.fileData) continue;
      const l = getFiletypeFromFileName(entry.fileData.oldPath ?? entry.fileData.path);
      if (l && HL_LANGS.has(l)) hlColorize(entry, l);
      if (fragSel.has(entry.path)) renderFragUI(entry); // overlays tras repaint
    }
    // Al expandir un separador aparecen filas NUEVAS: re-marcar la búsqueda
    // activa sin mover el scroll (el match podía estar en el contexto
    // colapsado y hasta ahora era invisible para ⌘F).
    if (find.q && !document.getElementById("findbar")?.hidden) runFind(find.q, false);
  });
}

// La lib re-acomoda filas al expandir separadores / re-render de tema: el
// observer del shadowRoot reacciona a esos cambios estructurales.
function attachStructureObserver(entry) {
  if (entry.structureObserver) return;
  const sr = entry.body.querySelector("diffs-container")?.shadowRoot;
  if (!sr) return;
  const mo = new MutationObserver(() => scheduleAnchors());
  mo.observe(sr, { childList: true, subtree: true });
  entry.structureObserver = mo;
}

// ------------------------------------------------- anclajes inline (0.2.1)
// Cada pregunta ANCLADA vive colapsada sobre su línea: un 💬 en el borde
// derecho de la fila (chip en el file-head para archivo/línea oculta).
// Click → editor in-place (editar / borrar). Free questions van a la pila.

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

// La fila del shadow DOM que muestra esa línea (según el lado del ancla).
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
  chip.title = note ? `${a.path}:${a.lines} (línea no visible — expandila)` : `${a.path} · archivo`;
  chip.onclick = () => openInlineEditor(i, chip);
  entry.section.querySelector(".file-head .fplus").after(chip);
}

function renderAnchors() {
  document.querySelectorAll(".inline-editor").forEach((n) => n.remove());
  document.querySelectorAll(".head-marker").forEach((n) => n.remove());
  for (const entry of rendered.values()) {
    ensureLayer(entry);
    renderSelUI(entry); // cajitas + franjas + ＋ grande sobreviven el re-render
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

// Editor in-place del anclaje: editar la pregunta o borrarla, ahí mismo.
function openInlineEditor(i, at) {
  document.querySelectorAll(".inline-editor").forEach((n) => n.remove());
  const a = pendingAsks[i];
  if (!a) return;
  const card = document.createElement("div");
  card.className = "inline-editor";
  card.innerHTML = `
    <div class="ie-head"><span class="anchor"></span><button class="ghost danger ie-del" title="Borrar esta pregunta">🗑 Borrar</button></div>
    <textarea rows="2"></textarea>
    <div class="ie-actions"><span class="hint">Enter guarda · Shift+Enter salto de línea</span><button class="primary ie-ok">Listo</button></div>`;
  card.querySelector(".anchor").textContent =
    a.kind === "file" ? `${a.path} · archivo` : `${a.path}:${a.lines}`;
  const ta = card.querySelector("textarea");
  ta.value = a.question;
  ta.addEventListener("input", () => { a.question = ta.value; });
  const close = () => { card.remove(); renderAnchors(); };
  card.querySelector(".ie-del").onclick = () => {
    pendingAsks.splice(i, 1);
    close();
    renderPile();
  };
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

// Nota: los clicks en NUESTRA UI (💬, editor, composer, ＋) no disparan
// nada — el reposicionado llega por eventos (onHunkExpand, observer), no
// por clicks adivinados con timers (los setTimeout de 0.2.4, fuera).
// El editor flotante se cierra al scrollear (queda lejos de su línea).
document.getElementById("root").addEventListener("scroll", () => {
  document.querySelectorAll(".inline-editor").forEach((n) => n.remove());
});

// --------------------------------------------------------------- render

function clearRendered() {
  boxDrag = null;
  hideHoverPlus();
  for (const entry of rendered.values()) endEdit(entry, "complete");
  for (const entry of rendered.values()) {
    try { entry.fd?.cleanUp(); } catch { /* already gone */ }
    entry.structureObserver?.disconnect();
    entry.section.remove();
  }
  rendered.clear();
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

function renderFileInner(f) {
  const section = document.createElement("section");
  section.className = "file" + (collapsedPaths.has(f.path) ? " collapsed" : "");
  document.getElementById("root").appendChild(section);
  const head = document.createElement("div");
  head.className = "file-head";
  const status = f.status ?? "M";
  head.innerHTML = `<span class="chev">▾</span><span class="chip s-${status === "?" ? "A" : status}"></span>
    <span class="path"></span>
    <span class="counts"></span>
    <button class="ghost fplus" title="Preguntar sobre este archivo">＋</button>`;
  head.querySelector(".path").textContent = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
  const counts = head.querySelector(".counts");
  if (f.added !== undefined || f.deleted !== undefined)
    counts.textContent = `+${f.added ?? 0} −${f.deleted ?? 0}`;
  head.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    if (section.classList.toggle("collapsed")) collapsedPaths.add(f.path);
    else collapsedPaths.delete(f.path);
    scheduleAnchors(); // rAF: reposicionar cuando el layout ya cambió
  });
  section.appendChild(head);

  const body = document.createElement("div");
  body.className = "file-body";
  section.appendChild(body);

  const entry = {
    section, body, fd: null, path: f.path, patch: f.patch ?? "", fileData: f,
    beforeLines: typeof f.before === "string" ? f.before.split("\n") : null,
    afterLines: typeof f.after === "string" ? f.after.split("\n") : null,
  };
  rendered.set(f.path, entry);
  // ✏️ edición en vivo (sólo vistas del working tree con contenido completo).
  // TOGGLE: entra al modo edición; si ya está editando ESTE archivo, guarda
  // (autosave final, estilo IntelliJ) y sale.
  if (editableNow(f)) {
    const editBtn = document.createElement("button");
    editBtn.className = "ghost fedit";
    editBtn.textContent = "✏️";
    editBtn.title = "Editar este archivo acá mismo (autosave, ⌘Z, ↩ descartar)";
    editBtn.onclick = (e) => {
      e.stopPropagation();
      if (entry.edit) saveEntry(entry).finally(() => endEdit(entry, "complete"));
      else startEditing(entry);
    };
    entry.editBtn = editBtn;
    head.querySelector(".fplus").after(editBtn);
  }
  // Modos brocha (0.8.0): ? acumula fragmentos para PREGUNTAR, ↩ para
  // REVERTIR quirúrgico. Sin modo: pintada única con popup inmediato.
  if (!f.binary) {
    const askBtn = document.createElement("button");
    askBtn.className = "ghost fmode fmode-ask";
    askBtn.textContent = "?";
    const revBtn = document.createElement("button");
    revBtn.className = "ghost fmode fmode-rev";
    revBtn.textContent = "↩";
    askBtn.onclick = (e) => { e.stopPropagation(); setFragMode(entry, "ask"); };
    revBtn.onclick = (e) => { e.stopPropagation(); setFragMode(entry, "rev"); };
    entry.fragAskBtn = askBtn;
    entry.fragRevBtn = revBtn;
    head.querySelector(".fplus").after(askBtn, revBtn);
    renderFragBadge(entry);
  }
  // ↩ revert de TODO el archivo (sólo modificados con before completo)
  if (typeof f.before === "string" && f.status !== "A" && f.status !== "?") {
    const revBtn = document.createElement("button");
    revBtn.className = "ghost frev";
    revBtn.textContent = "↩";
    revBtn.title = "Revertir TODO este archivo al original";
    revBtn.onclick = (e) => {
      e.stopPropagation();
      revertWholeFile(entry);
    };
    head.querySelector(".fplus").after(revBtn);
  }

  // ＋ a nivel archivo: ancla al archivo entero, cita = mini-resumen.
  head.querySelector(".fplus").onclick = (e) => {
    e.stopPropagation();
    const summary = `${status}${f.oldPath ? ` · ${f.oldPath} → ${f.path}` : ""} · +${f.added ?? "?"} −${f.deleted ?? "?"}`;
    openComposerFile(entry, f.path, summary);
  };

  if (f.binary) {
    const info = document.createElement("div");
    info.className = "plain-note";
    info.textContent = "Archivo binario — sin diff de texto.";
    body.appendChild(info);
    return;
  }

  const fd = new FileDiff({
    themeType: theme,
    diffStyle: "unified",
    // El gutter es NUESTRO (drag propio abajo): el ＋ nativo y la selección
    // de la lib no arrancan en el webview de la app, y su hover tapaba la
    // zona de agarre. Click/drag sobre los números = nuestro sistema.
    lineHoverHighlight: "both",
    // 10 líneas de contexto alrededor de cada cambio; los tramos más largos
    // quedan como separador expandible (click = ver más código, read-only).
    hunkSeparators: "line-info",
    collapsedContextThreshold: 10,
    // Reactivo: pierre avisa cuando se expande un separador (antes: esperar
    // 250ms a ver si movió las filas). rAF coalesce múltiples eventos.
    onHunkExpand: () => scheduleAnchors(),
  });
  entry.fd = fd;
  // <diffs-container> carries the shadow-DOM shell + core styles the
  // FileDiff renders into — a plain div renders unstyled.
  const container = document.createElement("diffs-container");
  body.appendChild(container);
  applyLineFilter(entry); // el archivo nuevo nace con los filtros corrientes

  // Lenguaje para el highlighting (HL_LANGS a nivel módulo): la librería no
  // lo infiere sola en el render por contenidos — sin esto pinta plain.
  const hlLang = (() => {
    const l = getFiletypeFromFileName(f.oldPath ?? f.path);
    return l && HL_LANGS.has(l) ? l : undefined;
  })();
  if (hlLang) hlColorize(entry, hlLang);

  if (typeof f.before === "string" || typeof f.after === "string") {
    // Contenido completo: diff local expandible (los números de línea del
    // gutter son los del archivo real, la cita sale de acá directo).
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
    fd.setThemeType(theme);
    attachStructureObserver(entry);
    return;
  }

  if (!f.patch) {
    const info = document.createElement("div");
    info.className = "plain-note";
    info.textContent =
      status === "R" ? "Renombre sin cambios de contenido." : "Sin parche (archivo grande o sin cambios de texto).";
    body.appendChild(info);
    return;
  }

  const parsed = parsePatchFiles(f.patch, `da-${rendered.size}`);
  const meta = parsed[0]?.files?.[0];
  if (!meta) {
    const info = document.createElement("div");
    info.className = "plain-note";
    info.textContent = "El parche de este archivo no se pudo parsear.";
    body.appendChild(info);
    return;
  }
  fd.render({ fileContainer: container, fileDiff: meta });
  fd.setThemeType(theme);
  attachStructureObserver(entry);
}

// Composer del ＋ por archivo: mismo look, sin setSelectedLines (no hay
// rango). Funciona COLAPSADO también: la caja vive bajo el encabezado (el
// body está display:none — el composer no puede ir ahí).
function openComposerFile(entry, path, summary) {
  closeComposer(entry);
  const card = document.createElement("div");
  card.className = "composer";
  card.innerHTML = `
    <div class="composer-head">
      <span class="anchor"></span>
      <button class="ghost close" title="Cancelar">✕</button>
    </div>
    <textarea rows="3" placeholder="Preguntá sobre este archivo…"></textarea>
    <div class="composer-actions">
      <span class="hint">⌘↵ envía</span>
      <button class="ghost cancel">Cancelar</button>
      <button class="primary ask">Preguntar</button>
    </div>`;
  const anchor = card.querySelector(".anchor");
  anchor.textContent = `${path} · archivo`;
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
    // colapsado: bajo el head, estático — el body está oculto.
    card.classList.add("under-head");
    entry.section.appendChild(card);
    card.scrollIntoView({ block: "nearest" });
  } else {
    positionComposerAtRow(entry, card, null);
  }
  ta.focus();
}

// La barra de modos vive SIEMPRE arriba (también en estados de error, para
// poder salir de un modo sin upstream/marcador sin quedarse trabado).
function renderModebar(root) {
  const modebar = document.createElement("div");
  modebar.className = "modebar";
  for (const m of MODES) {
    const b = document.createElement("button");
    b.dataset.mode = m.id;
    b.textContent = m.label;
    b.title = m.title;
    if (m.id === mode) b.classList.add("active");
    b.onclick = () => setMode(m.id);
    modebar.appendChild(b);
  }
  // 📁: qué carpeta se está diffeando (título = ruta completa) y cambio.
  const ws = document.createElement("button");
  ws.className = "ghost ws";
  ws.textContent = `📁 ${wsLabel()}`;
  ws.title = currentWorkspace
    ? `${currentWorkspace}\n(click para cambiar la carpeta del diff)`
    : "Cambiar la carpeta del diff";
  ws.onclick = openWorkspaceEditor;
  modebar.appendChild(ws);
  root.appendChild(modebar);
}

function renderAll() {
  clearRendered();
  const root = document.getElementById("root");
  root.textContent = "";

  if (!diffData || diffData.error) {
    renderModebar(root);
    const err = document.createElement("div");
    err.className = "state error";
    err.textContent = diffData?.message ?? "Sin datos del diff.";
    root.appendChild(err);
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
    ${mode === "commits" || mode === "turns" ? `<button class="ghost back" title="Volver a la lista">${mode === "commits" ? "← Commits" : "← Turnos"}</button>` : ""}
    <button class="ghost filt" data-filt="add" title="Mostrar/ocultar líneas agregadas">＋</button>
    <button class="ghost filt" data-filt="del" title="Mostrar/ocultar líneas borradas">−</button>
    <button class="ghost filt" data-filt="ctx" title="Mostrar/ocultar líneas de contexto (sin cambio)">≡</button>
    <button class="ghost fold" title="Colapsar todos los archivos">⊟</button>
    <button class="ghost unfold" title="Expandir todos los archivos">⊞</button>
    <button class="ghost refresh" title="Refrescar el diff ahora">⟳</button>`;
  // Resumen REAL del diff (los números de la tarjeta Git de la app son
  // cálculo propio de ella): líneas +/- y archivos nuevos/modificados/
  // eliminados. Extras por modo: upstream/📸/commit.
  const t = diffTotals(diffData.files);
  const bits = [];
  if (mode === "commits" && diffData.commit) {
    const c = diffData.commit;
    bits.push(`<b>${esc(c.short)}</b> ${esc(c.subject)}`);
    if (c.author || c.date) bits.push(esc([c.author, c.date].filter(Boolean).join(" · ")));
    if (diffData.isMerge) bits.push('<span class="tot-m">merge (vs primer padre)</span>');
  } else {
    bits.push(`${esc(diffData.branch)} @ ${esc(diffData.head)}`);
    if (mode === "unpushed" && diffData.upstream) {
      const ab = [];
      if (diffData.ahead !== undefined) ab.push(`<span class="tot-a">↑${diffData.ahead}</span>`);
      if (diffData.behind !== undefined) ab.push(`<span class="tot-d">↓${diffData.behind}</span>`);
      bits.push(`${ab.join(" ")} vs ${esc(diffData.upstream)}`);
    }
    if (mode === "turns" && diffData.turn) {
      bits.push(`<b>turno ${esc(diffData.turn.at?.slice(11, 16) ?? "")}</b>`);
      if (diffData.turn.isLatest) bits.push('<span class="tot-a">en vivo</span>');
    }
    bits.push(`${diffData.fileCount} archivo${diffData.fileCount === 1 ? "" : "s"}`);
    bits.push(`<span class="tot-a">+${t.added}</span>`, `<span class="tot-d">−${t.deleted}</span>`);
    if (t.newFiles) bits.push(`<span class="tot-a">${t.newFiles} nuevo${t.newFiles === 1 ? "" : "s"}</span>`);
    if (t.modFiles) bits.push(`<span class="tot-m">${t.modFiles} modificado${t.modFiles === 1 ? "" : "s"}</span>`);
    if (t.delFiles) bits.push(`<span class="tot-d">${t.delFiles} eliminado${t.delFiles === 1 ? "" : "s"}</span>`);
    if (t.renamed) bits.push(`${t.renamed} renombrado${t.renamed === 1 ? "" : "s"}`);
  }
  header.querySelector(".meta").innerHTML = bits.join(` <span class="dot">·</span> `);
  const backBtn = header.querySelector(".back");
  if (backBtn)
    backBtn.onclick = () => {
      endAllEdits().finally(() => {
        commitSel = null;
        turnSel = null;
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
    for (const [p, e] of rendered) e.section.classList.toggle("collapsed", collapsedPaths.has(p));
  };
  header.querySelector(".unfold").onclick = () => {
    collapsedPaths.clear();
    for (const e of rendered.values()) e.section.classList.remove("collapsed");
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
  hint.textContent = "Modos arriba: Trabajo (vs HEAD) · Sin pushear (upstream) · Turnos (qué logró cada prompt; el último en vivo) · Commits. ⌘F busca en el diff (Enter cicla) · ＋/−/≡ filtran líneas agregadas/borradas/contexto. Click en un NÚMERO = seleccionarlo (arrastrás y pintás varios, salteados también) → ＋ grande abre la pregunta · hover en una línea → ＋ · ＋ del encabezado = archivo. Abajo: libres; ⌘↵ manda todo junto.";
  root.appendChild(hint);

  if (!diffData.files.length) {
    const clean = document.createElement("div");
    clean.className = "state clean";
    clean.textContent = `Árbol limpio — sin cambios contra ${diffData.baseLabel ?? "HEAD"}.`;
    root.appendChild(clean);
    return;
  }
  if (diffData.truncated) {
    const tr = document.createElement("div");
    tr.className = "state warn";
    tr.textContent = "Diff muy grande: algunos parches se omitieron (refrescá tras los edits grandes).";
    root.appendChild(tr);
  }
  for (const f of diffData.files) {
    if (!seenPaths.has(f.path)) {
      seenPaths.add(f.path);
      collapsedPaths.add(f.path); // nace colapsado
    }
  }
  for (const f of diffData.files) renderFile(f);
  applyLineFilter();
  // re-render: restaurar overlays/modos de pintado (sobreviven por path)
  for (const [p] of fragSel) {
    const e = rendered.get(p);
    if (e) { renderFragUI(e); renderFragBadge(e); }
  }
  // Si hay búsqueda activa, re-marcar sobre las filas nuevas SIN saltar el
  // scroll (el refresh reactivo no debe moverle la lectura a nadie).
  if (find.q && !document.getElementById("findbar")?.hidden) runFind(find.q, false);
}

// --------------------------------------------------------------- commits
// Lista del modo Commits: buscador (hash o texto del título, Enter), filas
// [hash · subject · autor · fecha] y "…" para traer 10 más. Un click abre
// el diff de ese commit (commitSel → refresh renderiza archivos).

async function loadCommits(reset = false) {
  if (reset) commitsState = { query: commitsState.query, skip: 0, list: [], hasMore: false };
  const uri = `log://commits?skip=${commitsState.skip}&limit=10&q=${encodeURIComponent(commitsState.query)}`;
  const res = await app.readServerResource({ uri });
  const data = JSON.parse(res?.contents?.[0]?.text ?? "{}");
  if (data.workspace) currentWorkspace = data.workspace;
  document.documentElement.dataset.repo = data?.error ? "no" : "yes";
  if (data.error) {
    const root = document.getElementById("root");
    root.textContent = "";
    const err = document.createElement("div");
    err.className = "state error";
    err.textContent = data.message ?? "No pude leer el log.";
    root.appendChild(err);
    return;
  }
  const seen = new Set(commitsState.list.map((c) => c.hash));
  for (const c of data.commits ?? []) if (!seen.has(c.hash)) commitsState.list.push(c);
  commitsState.skip += (data.commits ?? []).length;
  commitsState.hasMore = Boolean(data.hasMore);
  diffData = null; // la vista activa es la lista, no un diff
  renderCommits();
  resubscribe("log://commits");
}

function renderCommits() {
  const root = document.getElementById("root");
  root.textContent = "";

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  renderModebar(toolbar);

  const bar = document.createElement("div");
  bar.className = "commits-search";
  bar.innerHTML = `<input type="search" placeholder="Hash o texto del título… (Enter busca)">`;
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
    const st = document.createElement("div");
    st.className = "state";
    st.textContent = commitsState.query
      ? `Nada para “${commitsState.query}”. Probá con un hash más corto o parte del título.`
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
      refresh();
    };
    list.appendChild(row);
  }
  root.appendChild(list);
  if (commitsState.hasMore) {
    const more = document.createElement("button");
    more.className = "more-btn";
    more.textContent = "…";
    more.title = "Cargar 10 commits más";
    more.onclick = () => loadCommits();
    root.appendChild(more);
  }
}

// ---------------------------------------------------------------- turnos
// Lista del modo Turnos: una fila por mensaje del usuario — [hora] [prompt
// recortado] [💬 prompt completo] [✕ borrar]. El de arriba con "en vivo" es
// el último turno (contra el working tree actual). "Borrar todo" pide
// confirmación inline (un click lo arma, el segundo confirma).

async function loadTurns() {
  const res = await app.readServerResource({ uri: "turn://list" });
  const data = JSON.parse(res?.contents?.[0]?.text ?? "{}");
  if (data.workspace) currentWorkspace = data.workspace;
  document.documentElement.dataset.repo = data?.error ? "no" : "yes";
  if (data.error) {
    const root = document.getElementById("root");
    root.textContent = "";
    renderModebar(root);
    const err = document.createElement("div");
    err.className = "state error";
    err.textContent = data.message ?? "No pude leer los turnos.";
    root.appendChild(err);
    return;
  }
  turnsState.list = data.turns ?? [];
  diffData = null;
  renderTurns();
  resubscribe("turn://list");
}

function openPromptCard(turn) {
  document.querySelectorAll(".prompt-card").forEach((n) => n.remove());
  const card = document.createElement("div");
  card.className = "prompt-card";
  card.innerHTML = `
    <div class="ie-head"><span class="anchor"></span><button class="ghost close" title="Cerrar (Esc)">✕</button></div>
    <pre></pre>`;
  card.querySelector(".anchor").textContent = `Turno ${turn.at?.slice(11, 16) ?? ""} — tu prompt completo`;
  card.querySelector("pre").textContent = turn.prompt || "(sin texto)";
  card.querySelector(".close").onclick = () => card.remove();
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { card.remove(); document.removeEventListener("keydown", esc); }
  });
  document.body.appendChild(card);
}

async function deleteTurnById(id) {
  try {
    const res = await app.callServerTool({ name: "delete_turn", arguments: { id } });
    if (!res?.structuredContent?.ok) throw new Error(res?.structuredContent?.message ?? "no se pudo borrar");
    loadTurns();
  } catch (e) {
    chip(`⚠ ${e?.message ?? e}`);
  }
}

function renderTurns() {
  const root = document.getElementById("root");
  root.textContent = "";

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  renderModebar(toolbar);

  const bar = document.createElement("div");
  bar.className = "commits-search turns-actions";
  const count = document.createElement("span");
  count.className = "turns-count";
  count.textContent = turnsState.list.length
    ? `${turnsState.list.length} turno${turnsState.list.length === 1 ? "" : "s"}`
    : "";
  const clear = document.createElement("button");
  clear.className = "ghost danger";
  clear.textContent = "🗑 Borrar todo";
  clear.title = "Borrar todos los turnos de esta carpeta";
  clear.onclick = () => {
    if (clear.dataset.armed) {
      app.callServerTool({ name: "clear_turns", arguments: {} })
        .then(() => loadTurns())
        .catch((e) => chip(`⚠ ${e?.message ?? e}`));
      return;
    }
    clear.dataset.armed = "1";
    clear.textContent = "¿Seguro? BORRAR TODO";
    setTimeout(() => {
      delete clear.dataset.armed;
      clear.textContent = "🗑 Borrar todo";
    }, 4000);
  };
  bar.append(count, clear);
  toolbar.appendChild(bar);
  root.appendChild(toolbar);

  if (!turnsState.list.length) {
    const st = document.createElement("div");
    st.className = "state";
    st.textContent = "Todavía no hay turnos. Cada mensaje tuyo en la sesión (desktop o Telegram) registra uno automáticamente.";
    root.appendChild(st);
    return;
  }
  const list = document.createElement("div");
  list.className = "commit-list turn-list";
  for (const t of turnsState.list) {
    const row = document.createElement("div");
    row.className = "commit-row turn-row";
    const time = t.at?.slice(11, 16) ?? "";
    const day = t.at?.slice(0, 10) ?? "";
    row.innerHTML = `
      <span class="turn-time"></span>
      <span class="turn-prompt"></span>
      <span class="turn-live"></span>
      <button class="ghost turn-prompt-btn" title="Ver el prompt completo">💬</button>
      <button class="ghost danger turn-del" title="Borrar este turno">✕</button>`;
    row.querySelector(".turn-time").textContent = `${day} ${time}`;
    row.querySelector(".turn-prompt").textContent = (t.prompt || "(sin texto)").split("\n")[0];
    row.querySelector(".turn-prompt").title = t.prompt || "";
    if (t.isLatest) row.querySelector(".turn-live").textContent = "en vivo";
    row.querySelector(".turn-prompt-btn").onclick = (e) => {
      e.stopPropagation();
      openPromptCard(t);
    };
    row.querySelector(".turn-del").onclick = (e) => {
      e.stopPropagation();
      deleteTurnById(t.id);
    };
    row.onclick = () => {
      turnSel = t.id;
      refresh();
    };
    list.appendChild(row);
  }
  root.appendChild(list);
}

// ------------------------------------------------------------ data flow

// Suscripción reactiva al URI del modo ACTUAL: al cambiar de modo/vista se
// baja el viejo y se sube el nuevo (la firma git del server notifica a los
// suscriptos; el ⟳ manual sigue existiendo como fallback).
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

// Cambio de modo: chips arriba. Sale de Commits/Turnos limpia la selección y
// la búsqueda; entrar a Turnos abre el ÚLTIMO turno directo (en vivo).
async function setMode(m) {
  if (m === mode) return;
  await endAllEdits();
  mode = m;
  commitSel = null;
  turnSel = m === "turns" ? "latest" : null;
  commitsState = { query: "", skip: 0, list: [], hasMore: false };
  turnsState = { list: [] };
  document.querySelectorAll(".modebar button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === m);
  });
  await refresh();
}

let pendingRefresh = false;
let refreshInFlight = null;
async function refresh(explicit = false) {
  // El editor no sobrevive un re-render: mientras haya edición, el refresh
  // REACTIVO se difiere (al terminar la edición se aplica solo). El
  // explícito (⟳, cambio de modo) guarda todo, cierra sesiones y sigue.
  if (!explicit && editingCount() > 0) {
    pendingRefresh = true;
    return;
  }
  // Coalescer: dos disparos casi simultáneos (nuestra propia escritura +
  // un cambio del agente) comparten UNA sola lectura/render. Las acciones
  // que dependen del estado fresco (revert) esperan esta promesa.
  if (refreshInFlight) return refreshInFlight;
  const run = (async () => {
  const root = document.getElementById("root");
  hideSelPop("re-render"); // re-render: la entrada que cierra el popup deja de existir
  if (explicit) root.classList.add("loading");
  try {
    if (mode === "commits" && !commitSel) {
      await loadCommits();
    } else if (mode === "turns" && !turnSel) {
      await loadTurns();
    } else {
      const uri = diffUriFor();
      const res = await app.readServerResource({ uri });
      const text = res?.contents?.[0]?.text ?? "{}";
      diffData = JSON.parse(text);
      if (diffData?.workspace) currentWorkspace = diffData.workspace;
      document.documentElement.dataset.repo = diffData?.error ? "no" : "yes";
      renderAll();
      resubscribe(uri);
    }
    renderPile();
    renderAnchors();
  } catch (e) {
    const err = document.createElement("div");
    err.className = "state error";
    err.textContent = `No pude leer el diff: ${e?.message ?? e}`;
    root.textContent = "";
    // Sin barra de modos un error de transporte dejaría al usuario trabado
    // en el modo actual (sin chips para salir).
    renderModebar(root);
    root.appendChild(err);
  } finally {
    root.classList.remove("loading");
  }
  })();
  refreshInFlight = run.finally(() => (refreshInFlight = null));
  return refreshInFlight;
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
    document.getElementById("root").textContent = `Sin conexión con el host: ${e?.message ?? e}`;
    return;
  }
  applyTheme(app.getHostContext());
  try {
    app.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
      // Estamos suscriptos al URI del modo activo (resubscribe): cualquier
      // actualización de la firma git refresca la vista CORRIENTE.
      if (n?.params?.uri) refresh();
    });
    const caps = app.getHostCapabilities?.();
    if (caps?.experimental?.["zcode/resourceSubscribe"])
      await resubscribe(diffUriFor());
  } catch {
    /* no reactive updates — manual ⟳ still works */
  }
  await refresh();
}

// errores con STACK visible (0.8.3): el mensaje solo no alcanza para ubicar
// la bomba — el primer frame del stack dice el archivo/función exactos.
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
    hl: { loaded: isHighlighterLoaded, loading: isHighlighterLoading, isNull: isHighlighterNull },
    get rendered() { return rendered; },
    get diffData() { return diffData; },
    renderAll,
    get pendingAsks() { return pendingAsks; },
    get boxSel() { return boxSel; },
    get fragSel() { return fragSel; },
    get fragModes() { return fragModes; },
    renderSelUI,
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
  applyTheme({ theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" });
  renderAll();
  renderPile();
  // Fake send so the composer flow can be exercised outside the app too.
  app.sendMessage = async () => ({ mode: "sent", ok: true });
  // Recursos mockeados (window.__DA_TEST__.mockResources[uri]) para ejercitar
  // las vistas que leen recursos (turn://list, diff://turn/…) sin host.
  app.readServerResource = async ({ uri }) => {
    const mock = window.__DA_TEST__?.mockResources?.[uri];
    if (mock !== undefined)
      return { contents: [{ text: typeof mock === "string" ? mock : JSON.stringify(mock) }] };
    throw new Error("Not connected");
  };
  app.callServerTool = async ({ name, arguments: a }) => {
    if (name === "set_workspace")
      return { structuredContent: { ok: true, workspace: a?.path ?? currentWorkspace } };
    if (name === "write_file")
      return { structuredContent: { ok: true, hash: "stub-hash" } };
    return { structuredContent: { ok: true, at: new Date().toISOString() } };
  };
} else {
  boot();
}
