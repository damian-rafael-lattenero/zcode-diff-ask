// Diff Ask panel — vanilla JS, rendered inside ZCode's session webview.
//
// Flow: connect to the host (App from the MCP Apps SDK), subscribe to the
// server's diff://workspace resource (reactive — no polling), and render each
// changed file with @pierre/diffs' FileDiff (the same library the host's own
// diff panel uses) with the gutter utility ON: hover a line → "+" → composer →
// app.sendMessage carries the question to the conversation anchored to
// path:line with the exact lines quoted.

import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/core";
import { FileDiff, parsePatchFiles, isHighlighterLoaded, isHighlighterLoading, isHighlighterNull } from "@pierre/diffs";

const DIFF_URI = "diff://workspace";
const app = new App({ name: "diff-ask", version: "0.1.0" }, {});

/** @type {any} */ let diffData = null;
/** @type {Map<string, {section: HTMLElement, body: HTMLElement, fd: import("@pierre/diffs").FileDiff|null, patch: string}>} */
const rendered = new Map();
// Preguntas acumuladas: el "+" encola acá y "Enviar todo" (⌘↵) manda UN solo
// mensaje con todas las anclas. Sobrevive los refresh del diff vivo.
/** @type {{path:string, start:number, lines:string, label:string, quoteLines:string[], question:string}[]} */
const pendingAsks = [];
// Archivos colapsados por path — persiste durante la sesión entre re-renders.
const collapsedPaths = new Set();
let theme = "light";

// ------------------------------------------------------------- diff text

// Extract the literal text of [start,end] on one side of a unified patch.
function extractLines(patch, side, start, end) {
  const out = [];
  let oldN = 0;
  let newN = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldN = parseInt(m[1], 10);
        newN = parseInt(m[2], 10);
      }
      continue;
    }
    if (
      raw.startsWith("diff ") || raw.startsWith("index ") ||
      raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("Binary files")
    )
      continue;
    if (raw.startsWith("+")) {
      if (side !== "deletions" && newN >= start && newN <= end) out.push(raw.slice(1));
      newN++;
    } else if (raw.startsWith("-")) {
      if (side === "deletions" && oldN >= start && oldN <= end) out.push(raw.slice(1));
      oldN++;
    } else if (raw.startsWith(" ")) {
      if (side === "deletions" ? oldN >= start && oldN <= end : newN >= start && newN <= end)
        out.push(raw.slice(1));
      oldN++;
      newN++;
    }
  }
  return out;
}

function rangeLabel(range) {
  const side = range.side ?? "additions";
  const lines = range.end > range.start ? `${range.start}-${range.end}` : `${range.start}`;
  return { side, lines, label: `${side === "deletions" ? "líneas" : "líneas"} ${lines} · ${side === "deletions" ? "deletions" : "additions"}` };
}

// Cita las líneas del rango: desde el contenido completo si lo hay (render
// desde before/after — números de línea directos), sino desde el parche.
function quoteFor(entry, range) {
  const side = range.side ?? "additions";
  const arr = side === "deletions" ? entry.beforeLines : entry.afterLines;
  if (arr) {
    const out = [];
    for (let n = range.start; n <= range.end; n++) {
      if (arr[n - 1] !== undefined) out.push(arr[n - 1]);
    }
    if (out.length) return out;
  }
  return extractLines(entry.patch, side, range.start, range.end);
}

// ------------------------------------------------------------------ ask

function buildQuestionText(path, range, quoteLines, question) {
  const { side, lines } = rangeLabel(range);
  const quoted = quoteLines.map((l) => `> ${l}`).join("\n");
  const head = `- \`${path}:${range.start}\` (Diff Ask · diff, líneas ${lines} · ${side}):`;
  return quoted ? `${head}\n${quoted}\n\n${question}` : `${head}\n\n${question}`;
}

function chip(text) {
  const c = document.createElement("div");
  c.className = "sent-chip sent";
  c.textContent = text;
  document.getElementById("root").appendChild(c);
  setTimeout(() => c.remove(), 10_000);
}

async function sendAllPending() {
  if (!pendingAsks.length) return;
  const n = pendingAsks.length;
  const blocks = pendingAsks.map(({ path, start, label, quoteLines, question }) => {
    const quoted = quoteLines.length ? quoteLines.map((l) => `> ${l}`).join("\n") : "";
    const head = `- \`${path}:${start}\` (Diff Ask · diff, ${label}):`;
    return quoted ? `${head}\n${quoted}\n\n${question}` : `${head}\n\n${question}`;
  });
  const text =
    `Diff Ask — ${n} pregunta${n === 1 ? "" : "s"} anclada${n === 1 ? "" : "s"} al diff:\n\n` +
    blocks.join("\n\n");
  try {
    const res = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
    if (res && res.isError) throw new Error("host rejected sendMessage");
    chip(`✓ ${n} pregunta${n === 1 ? "" : "s"} en el chat`);
  } catch {
    await app.updateModelContext({ content: [{ type: "text", text }] });
    chip(`↪ contexto listo (${n} pregunta${n === 1 ? "" : "s"}) — mandá tu mensaje`);
  }
  pendingAsks.length = 0;
  renderInbox();
}

function queueQuestion(path, range, quoteLines, question) {
  const { lines, label } = rangeLabel(range);
  pendingAsks.push({ path, start: range.start, lines, label, quoteLines, question });
  renderInbox();
}

function renderInbox() {
  document.querySelectorAll(".inbox").forEach((n) => n.remove());
  if (!pendingAsks.length) return;
  const box = document.createElement("div");
  box.className = "inbox";
  const list = document.createElement("div");
  list.className = "inbox-list";
  pendingAsks.forEach((a, i) => {
    const row = document.createElement("div");
    row.className = "inbox-item";
    row.innerHTML = `<span class="anchor"></span><span class="q"></span><button class="ghost rm" title="Quitar">✕</button>`;
    row.querySelector(".anchor").textContent = `${a.path}:${a.lines}`;
    const q = row.querySelector(".q");
    q.textContent = a.question.length > 70 ? `${a.question.slice(0, 67)}…` : a.question;
    q.title = a.question;
    row.querySelector(".rm").onclick = () => { pendingAsks.splice(i, 1); renderInbox(); };
    list.appendChild(row);
  });
  const actions = document.createElement("div");
  actions.className = "inbox-actions";
  actions.innerHTML = `<button class="ghost clear">Limpiar</button><button class="primary send"></button>`;
  const send = actions.querySelector(".send");
  send.textContent = `Enviar ${pendingAsks.length} pregunta${pendingAsks.length === 1 ? "" : "s"} (⌘↵)`;
  send.onclick = sendAllPending;
  actions.querySelector(".clear").onclick = () => { pendingAsks.length = 0; renderInbox(); };
  box.append(list, actions);
  document.getElementById("root").appendChild(box);
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

function openComposer(entry, path, range) {
  entry.fd?.setSelectedLines({ start: range.start, end: range.end, side: range.side, endSide: range.endSide });
  closeComposer(entry);
  const { label } = rangeLabel(range);
  const card = document.createElement("div");
  card.className = "composer";
  card.innerHTML = `
    <div class="composer-head">
      <span class="anchor"></span>
      <button class="ghost close" title="Cancelar">✕</button>
    </div>
    <textarea rows="3" placeholder="Preguntá sobre ${label}…"></textarea>
    <div class="composer-actions">
      <span class="hint">⌘↵ envía</span>
      <button class="ghost cancel">Cancelar</button>
      <button class="primary ask">Preguntar</button>
    </div>`;
  const anchor = card.querySelector(".anchor");
  anchor.textContent = `${path}:${rangeLabel(range).lines}`;
  const ta = card.querySelector("textarea");
  const ask = card.querySelector(".ask");
  const close = () => { card.remove(); entry.fd?.setSelectedLines(null); };
  card.querySelector(".close").onclick = close;
  card.querySelector(".cancel").onclick = close;

  function submit() {
    const q = ta.value.trim();
    if (!q) { ta.focus(); return; }
    queueQuestion(path, range, quoteFor(entry, range), q);
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
    <span class="counts"></span>`;
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
    section, body, fd: null, patch: f.patch ?? "",
    beforeLines: typeof f.before === "string" ? f.before.split("\n") : null,
    afterLines: typeof f.after === "string" ? f.after.split("\n") : null,
  };
  rendered.set(f.path, entry);

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
  header.querySelector(".meta").textContent =
    `${diffData.branch} @ ${diffData.head} · ${diffData.fileCount} archivo${diffData.fileCount === 1 ? "" : "s"}`;
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
  hint.textContent = "Hover en una línea → + → acumulá preguntas → Enviar todo (⌘↵). Click en el encabezado colapsa el archivo; los separadores expanden contexto.";
  root.appendChild(hint);

  if (!diffData.files.length) {
    const clean = document.createElement("div");
    clean.className = "state clean";
    clean.textContent = "Árbol limpio — sin cambios contra HEAD.";
    root.appendChild(clean);
    return;
  }
  if (diffData.truncated) {
    const t = document.createElement("div");
    t.className = "state warn";
    t.textContent = "Diff muy grande: algunos parches se omitieron (refrescá tras los edits grandes).";
    root.appendChild(t);
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
    renderInbox();
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
  const t = ctx?.theme === "dark" ? "dark" : ctx?.theme === "light" ? "light" : theme;
  if (t === theme && document.documentElement.dataset.theme) return;
  theme = t;
  applyDocumentTheme(theme);
  for (const entry of rendered.values()) {
    try { entry.fd?.setThemeType(theme); entry.fd?.rerender(); } catch { /* stale */ }
  }
}

app.onhostcontextchanged = (ctx) => applyTheme(ctx);

async function boot() {
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
if (window.__DA_TEST__) {
  // Visual-test harness (dist/dev.html): render without a host connection.
  window.__DA = {
    FileDiff,
    parsePatchFiles,
    hl: { loaded: isHighlighterLoaded, loading: isHighlighterLoading, isNull: isHighlighterNull },
    get rendered() { return rendered; },
    get diffData() { return diffData; },
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
  renderInbox();
  // Fake send so the composer flow can be exercised outside the app too.
  app.sendMessage = async () => ({ mode: "sent", ok: true });
} else {
  boot();
}
