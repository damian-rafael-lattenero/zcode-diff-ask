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
import { FileDiff, parsePatchFiles, isHighlighterLoaded, isHighlighterLoading, isHighlighterNull } from "@pierre/diffs";
import { esc, extractLines, rangeLabel, quoteFor, diffTotals, buildAskMessage } from "./lib.js";

const DIFF_URI = "diff://workspace";
const app = new App({ name: "diff-ask", version: "0.1.0" }, {});

/** @type {any} */ let diffData = null;
/** @type {Map<string, {section: HTMLElement, body: HTMLElement, fd: import("@pierre/diffs").FileDiff|null, patch: string}>} */
const rendered = new Map();
// Pila de preguntas pendientes — kind: "line" (ancla path:líneas), "file"
// (ancla al archivo entero) o "free" (sin ancla, del askbar). Sobrevive los
// refresh del diff vivo; "Enviar todo" (⌘↵) manda UN solo mensaje.
/** @type {{kind:"line"|"file"|"free", path?:string, start?:number, lines?:string, label?:string, quoteLines?:string[], question:string}[]} */
const pendingAsks = [];
// Archivos colapsados por path — persiste durante la sesión entre re-renders.
const collapsedPaths = new Set();
let theme = "light";

// ------------------------------------------------------------- diff text

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
  const { n, text } = buildAskMessage(pendingAsks);
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

function queueQuestion(path, range, quoteLines, question) {
  if (!range) {
    // Pregunta anclada al archivo entero: la "cita" es su mini-resumen.
    pendingAsks.push({ kind: "file", path, label: "archivo", quoteLines, question });
  } else {
    const { side, lines, label } = rangeLabel(range);
    pendingAsks.push({ kind: "line", path, start: range.start, lines, label, side, quoteLines, question });
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

function openComposer(entry, path, range, opts = {}) {
  if (range && entry.fd)
    entry.fd?.setSelectedLines({ start: range.start, end: range.end, side: range.side, endSide: range.endSide });
  closeComposer(entry);
  const { label } = range ? rangeLabel(range) : { label: "archivo" };
  const card = document.createElement("div");
  card.className = "composer";
  card.innerHTML = `
    <div class="composer-head">
      <span class="anchor"></span>
      <button class="ghost close" title="Cancelar">✕</button>
    </div>
    <textarea rows="3" placeholder="${range ? `Preguntá sobre ${label}…` : "Preguntá sobre este archivo…"}"></textarea>
    <div class="composer-actions">
      <span class="hint">⌘↵ envía</span>
      <button class="ghost cancel">Cancelar</button>
      <button class="primary ask">Preguntar</button>
    </div>`;
  const anchor = card.querySelector(".anchor");
  anchor.textContent = range ? `${path}:${rangeLabel(range).lines}` : `${path} · archivo`;
  const ta = card.querySelector("textarea");
  const ask = card.querySelector(".ask");
  const close = () => {
    card.remove();
    entry.fd?.setSelectedLines(null);
  };
  card.querySelector(".close").onclick = close;
  card.querySelector(".cancel").onclick = close;

  function submit() {
    const q = ta.value.trim();
    if (!q) { ta.focus(); return; }
    queueQuestion(path, range ?? null, quoteFor(entry, range, opts.verbatim), q);
    close();
  }
  ask.onclick = submit;
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); submit(); }
  });
  entry.body.after(card);
  ta.focus();
}

function closeComposer(entry) {
  entry.section.querySelectorAll(".composer").forEach((n) => n.remove());
}

// ------------------------------------------------------------ selección
// Seleccionar texto dentro de un diff renderizado → chip flotante "＋"
// que abre el composer con el rango resuelto (data-line del shadow DOM de
// pierre) y la cita VERBATIM: lo que el usuario subrayó, no la línea entera.
let selChip = null;

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

function selectionAsk() {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const host = containerOf(range.startContainer);
  if (!host || containerOf(range.endContainer) !== host) return null;
  const content = host.shadowRoot?.querySelector("[data-content]");
  if (!content) return null;
  const rows = [...content.children].filter((r) => r.hasAttribute("data-line"));
  const selRows = rows.filter((r) => range.intersectsNode(r));
  if (!selRows.length) return null;
  // data-line = número NUEVO (o viejo en change-deletion); data-alt-line =
  // número viejo en contexto. Si la selección toca algo no-borrado anclamos
  // por el lado nuevo; si es todo borrado, por el viejo.
  const news = [];
  const olds = [];
  for (const r of selRows) {
    const t = r.dataset.lineType;
    const n = parseInt(r.dataset.line, 10);
    if (t === "change-deletion") olds.push(n);
    else if (t === "change-addition") news.push(n);
    else {
      news.push(n);
      olds.push(parseInt(r.dataset.altLine ?? n, 10));
    }
  }
  const byNew = news.length > 0;
  const nums = byNew ? news : olds;
  const askRange = {
    start: Math.min(...nums),
    end: Math.max(...nums),
    side: byNew ? "additions" : "deletions",
  };
  const text = sel.toString();
  if (!text.trim()) return null;
  for (const e of rendered.values()) {
    if (!e.body.contains(host)) continue;
    const endRow = selRows.find((r) => r.contains(range.endContainer)) ?? selRows[selRows.length - 1];
    return { entry: e, path: e.path, range: askRange, text, rows: selRows, endRow };
  }
  return null;
}

function clearSelectionUI() {
  document.querySelectorAll(".mini-plus, .big-plus").forEach((n) => n.remove());
}

// Mientras seleccionás: un ＋ chiquito al costado de CADA línea cubierta;
// al terminar, UN ＋ grande al final de la selección (el que se clickea).
function updateSelectionUI(info) {
  clearSelectionUI();
  const bodyRect = info.entry.body.getBoundingClientRect();
  let layer = info.entry.body.querySelector(".sel-layer");
  if (!layer) {
    layer = document.createElement("div");
    layer.className = "sel-layer";
    info.entry.body.appendChild(layer);
  }
  layer.textContent = "";
  for (const row of info.rows) {
    if (row === info.endRow) continue;
    const mini = document.createElement("div");
    mini.className = "mini-plus";
    mini.textContent = "＋";
    layer.appendChild(mini);
    const r = row.getBoundingClientRect();
    mini.style.top = `${r.top - bodyRect.top + (r.height - mini.offsetHeight) / 2}px`;
  }
  const big = document.createElement("button");
  big.className = "big-plus";
  big.textContent = "＋";
  const { lines } = rangeLabel(info.range);
  big.title = `Preguntar sobre ${info.path}:${lines}`;
  big.onclick = () => {
    clearSelectionUI();
    document.getSelection()?.removeAllRanges();
    openComposer(info.entry, info.path, info.range, { verbatim: info.text });
  };
  layer.appendChild(big);
  const r = info.endRow.getBoundingClientRect();
  big.style.top = `${r.top - bodyRect.top + (r.height - big.offsetHeight) / 2}px`;
}

let selTimer = null;
document.addEventListener("selectionchange", () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    const info = selectionAsk();
    if (info) updateSelectionUI(info);
    else clearSelectionUI();
  }, 150);
});

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
  document.querySelectorAll(".sel-layer").forEach((n) => n.remove());
  for (const entry of rendered.values()) ensureLayer(entry);
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

// Los separadores expandidos / colapsos desplazan filas: reposicionar.
document.addEventListener("click", (e) => {
  const body = e.target.closest?.(".file-body");
  if (body) setTimeout(renderAnchors, 250);
});
document.addEventListener("click", (e) => {
  const head = e.target.closest?.(".file-head");
  if (head) setTimeout(renderAnchors, 30);
});
// El editor flotante se cierra al scrollear (queda lejos de su línea).
document.getElementById("root").addEventListener("scroll", () => {
  document.querySelectorAll(".inline-editor").forEach((n) => n.remove());
});

// --------------------------------------------------------------- render

function clearRendered() {
  for (const entry of rendered.values()) {
    try { entry.fd?.cleanUp(); } catch { /* already gone */ }
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
  });
  section.appendChild(head);

  const body = document.createElement("div");
  body.className = "file-body";
  section.appendChild(body);

  const entry = {
    section, body, fd: null, path: f.path, patch: f.patch ?? "",
    beforeLines: typeof f.before === "string" ? f.before.split("\n") : null,
    afterLines: typeof f.after === "string" ? f.after.split("\n") : null,
  };
  rendered.set(f.path, entry);

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
    enableGutterUtility: true,
    lineHoverHighlight: "both",
    // 10 líneas de contexto alrededor de cada cambio; los tramos más largos
    // quedan como separador expandible (click = ver más código, read-only).
    hunkSeparators: "line-info",
    collapsedContextThreshold: 10,
    onGutterUtilityClick: (range) => openComposer(entry, f.path, range),
  });
  entry.fd = fd;
  // <diffs-container> carries the shadow-DOM shell + core styles the
  // FileDiff renders into — a plain div renders unstyled.
  const container = document.createElement("diffs-container");
  body.appendChild(container);

  if (typeof f.before === "string" || typeof f.after === "string") {
    // Contenido completo: diff local expandible (los números de línea del
    // gutter son los del archivo real, la cita sale de acá directo).
    fd.render({
      fileContainer: container,
      oldFile:
        f.before !== undefined && f.before !== null
          ? { name: f.oldPath ?? f.path, contents: f.before, cacheKey: `da-old:${f.path}:${f.before.length}` }
          : null,
      newFile:
        f.after !== undefined && f.after !== null
          ? { name: f.path, contents: f.after, cacheKey: `da-new:${f.path}:${f.after.length}` }
          : null,
    });
    fd.setThemeType(theme);
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
}

// Composer del ＋ por archivo: mismo look, sin setSelectedLines (no hay rango).
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
  entry.section.appendChild(card);
  ta.focus();
}

function renderAll() {
  clearRendered();
  const root = document.getElementById("root");
  root.textContent = "";

  if (!diffData || diffData.error) {
    const err = document.createElement("div");
    err.className = "state error";
    err.textContent = diffData?.message ?? "Sin datos del diff.";
    root.appendChild(err);
    return;
  }

  const header = document.createElement("div");
  header.className = "header";
  header.innerHTML = `
    <div class="meta"></div>
    <button class="ghost fold" title="Colapsar todos los archivos">⊟</button>
    <button class="ghost unfold" title="Expandir todos los archivos">⊞</button>
    <button class="ghost refresh" title="Refrescar el diff ahora">⟳</button>`;
  // Resumen REAL del diff (los números de la tarjeta Git de la app son
  // cálculo propio de ella): líneas +/- y archivos nuevos/eliminados.
  const t = diffTotals(diffData.files);
  const bits = [
    `${esc(diffData.branch)} @ ${esc(diffData.head)}`,
    `${diffData.fileCount} archivo${diffData.fileCount === 1 ? "" : "s"}`,
    `<span class="tot-a">+${t.added}</span>`,
    `<span class="tot-d">−${t.deleted}</span>`,
  ];
  if (t.newFiles) bits.push(`<span class="tot-a">${t.newFiles} nuevo${t.newFiles === 1 ? "" : "s"}</span>`);
  if (t.delFiles) bits.push(`<span class="tot-d">${t.delFiles} eliminado${t.delFiles === 1 ? "" : "s"}</span>`);
  if (t.renamed) bits.push(`${t.renamed} renombrado${t.renamed === 1 ? "" : "s"}`);
  header.querySelector(".meta").innerHTML = bits.join(` <span class="dot">·</span> `);
  header.querySelector(".refresh").onclick = () => refresh(true);
  header.querySelector(".fold").onclick = () => {
    for (const f of diffData.files) collapsedPaths.add(f.path);
    for (const [p, e] of rendered) e.section.classList.toggle("collapsed", collapsedPaths.has(p));
  };
  header.querySelector(".unfold").onclick = () => {
    collapsedPaths.clear();
    for (const e of rendered.values()) e.section.classList.remove("collapsed");
  };
  root.appendChild(header);

  const hint = document.createElement("div");
  hint.className = "hint-bar";
  hint.textContent = "Hover en una línea → + · ＋ en el encabezado pregunta por el archivo · seleccioná texto en el diff para preguntar por esa selección. La caja de abajo acumula preguntas libres; ⌘↵ manda todo junto.";
  root.appendChild(hint);

  if (!diffData.files.length) {
    const clean = document.createElement("div");
    clean.className = "state clean";
    clean.textContent = "Árbol limpio — sin cambios contra HEAD.";
    root.appendChild(clean);
    return;
  }
  if (diffData.truncated) {
    const tr = document.createElement("div");
    tr.className = "state warn";
    tr.textContent = "Diff muy grande: algunos parches se omitieron (refrescá tras los edits grandes).";
    root.appendChild(tr);
  }
  for (const f of diffData.files) renderFile(f);
}

// ------------------------------------------------------------ data flow

async function refresh(explicit = false) {
  const root = document.getElementById("root");
  if (explicit) root.classList.add("loading");
  try {
    const res = await app.readServerResource({ uri: DIFF_URI });
    const text = res?.contents?.[0]?.text ?? "{}";
    diffData = JSON.parse(text);
    document.documentElement.dataset.repo = diffData?.error ? "no" : "yes";
    renderAll();
    renderPile();
    renderAnchors();
  } catch (e) {
    const err = document.createElement("div");
    err.className = "state error";
    err.textContent = `No pude leer el diff: ${e?.message ?? e}`;
    root.textContent = "";
    root.appendChild(err);
  } finally {
    root.classList.remove("loading");
  }
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
      if (n?.params?.uri === DIFF_URI) refresh();
    });
    const caps = app.getHostCapabilities?.();
    if (caps?.experimental?.["zcode/resourceSubscribe"])
      await app.request({ method: "resources/subscribe", params: { uri: DIFF_URI } });
  } catch {
    /* no reactive updates — manual ⟳ still works */
  }
  await refresh();
}

window.addEventListener('error', (e) => { const d=document.createElement('div'); d.className='state error'; d.textContent='ONERROR: '+(e.message||e.error); document.body.appendChild(d); });
window.addEventListener('unhandledrejection', (e) => { const d=document.createElement('div'); d.className='state error'; d.textContent='REJECT: '+(e.reason?.message||e.reason); document.body.appendChild(d); });

ensureShell();
if (window.__DA_TEST__) {
  // Visual-test harness (dist/dev.html): render without a host connection.
  window.__DA = {
    FileDiff,
    parsePatchFiles,
    hl: { loaded: isHighlighterLoaded, loading: isHighlighterLoading, isNull: isHighlighterNull },
    get rendered() { return rendered; },
    get diffData() { return diffData; },
    get pendingAsks() { return pendingAsks; },
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
  applyTheme({ theme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" });
  renderAll();
  renderPile();
  // Fake send so the composer flow can be exercised outside the app too.
  app.sendMessage = async () => ({ mode: "sent", ok: true });
} else {
  boot();
}
