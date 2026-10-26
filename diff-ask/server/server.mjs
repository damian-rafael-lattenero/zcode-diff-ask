#!/usr/bin/env node
// diff-ask MCP server — stdio, Node stdlib only.
//
// Serves:
//   ui://diff-ask/panel.html        → the Diff Ask panel (built by ui/build.mjs)
//   diff://workspace[?mode=…]       → live JSON diff of the session workspace
//     · mode=working (default)        git diff HEAD + untracked
//     · mode=unpushed                 git diff @{upstream} + untracked (lo que
//                                     subiría un push + cambios locales)
//   turn://list                     → turnos registrados (cada prompt = una
//                                     foto del workspace; índice persistente)
//   diff://turn/<id|latest>         → diff del turno (foto N vs foto N+1; el
//                                     último, contra el working tree VIVO)
//   diff://commit/<hash>            → diff de ese commit vs su primer padre
//   log://commits?skip=&q=          → lista de commits (paginada) / búsqueda
//
// Reactive updates: on resources/subscribe we fs.watch the worktree (plus .git)
// and, when the git signature actually changes (status + numstat + HEAD +
// upstream), push notifications/resources/updated. No polling anywhere.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.join(HERE, "..");
const PANEL_URI = "ui://diff-ask/panel.html";
const DIFF_URI = "diff://workspace";
const WORKSPACE = process.env.ZCODE_WORKSPACE_ROOT || process.cwd();
// Workspace ACTIVO: arranca en el de la sesión, pero el panel puede cambiarlo
// (set_workspace) para diffejar otra carpeta del disco. Todo el server lee de
// acá — builders, firma reactiva y watchers incluidos.
let activeWorkspace = WORKSPACE;
const MAX_PATCH_BYTES = 1_500_000;
// Archivos con before+after <= esto viajan con contenido COMPLETO en el JSON
// (el panel diffea local y expande contexto sin red); más grandes → parche -U10.
const CONTENT_LIMIT = 300_000;
// Árbol vacío canónico de git — el "padre" de un commit raíz, para que
// `git diff <empty> <root>` liste el commit completo sin caso especial.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
// Formato del log: hash completo, corto, subject, autor, fecha relativa.
const LOG_FMT = "%H%x1f%h%x1f%s%x1f%an%x1f%ar";

let serverInfo = { name: "diff-ask", version: "0.1.0" };
try {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_ROOT, ".zcode-plugin", "plugin.json"), "utf8"),
  );
  serverInfo = { name: manifest.name, version: manifest.version };
} catch {
  /* fall back to the constants above */
}

const log = (...a) => process.stderr.write(`[diff-ask] ${a.join(" ")}\n`);

// ---------------------------------------------------------------- git

function runGit(args, { cwd = activeWorkspace, expectDiffExit = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => resolve({ ok: false, out: "", err: "git binary not found" }));
    p.on("close", (code) => {
      const ok = code === 0 || (expectDiffExit && code === 1);
      resolve({ ok, out, err });
    });
  });
}

export function parsePorcelainZ(out) {
  // `git status --porcelain=v1 -z`: NUL-separated records; rename/copy
  // records are followed by an extra NUL-separated origin path.
  const toks = out.split("\0").filter((t) => t !== "");
  const files = [];
  for (let i = 0; i < toks.length; i++) {
    const rec = toks[i];
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    // XY: staged+worktree codes. Untracked is '??'; otherwise prefer the
    // worktree letter. Kept single-letter so the panel can chip it.
    const status = xy === "??" ? "?" : xy[1] !== " " ? xy[1] : xy[0];
    // -z rename/copy records are `XY NEW\0ORIG` — new path comes first.
    const entry = { status, path: p };
    if (xy[0] === "R" || xy[0] === "C") {
      entry.oldPath = toks[++i] ?? p;
    }
    files.push(entry);
  }
  return files;
}

export function parseNameStatusZ(out) {
  // `git diff --name-status -z -M`: registros `STATUS\0PATH\0`; renames/copies
  // agregan `\0ORIGEN` (path nuevo primero, igual que porcelain). STATUS puede
  // traer score (R100/C75) — se normaliza a una letra para el chip del panel.
  const toks = out.split("\0").filter((t) => t !== "");
  const files = [];
  for (let i = 0; i < toks.length; i++) {
    const status = toks[i].replace(/\d+$/, "");
    const p = toks[++i];
    if (!p) continue;
    const entry = { status, path: p };
    if (status === "R" || status === "C") entry.oldPath = toks[++i] ?? p;
    files.push(entry);
  }
  return files;
}

export function splitPatch(patchText) {
  // Split a multi-file unified diff into per-file chunks keyed by new path.
  if (!patchText) return new Map();
  const chunks = patchText.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git"));
  const map = new Map();
  for (const chunk of chunks) {
    let key = null;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+++ b/")) {
        key = line.slice(6);
        break;
      }
    }
    if (key === null) {
      const m = chunk.match(/^diff --git a\/(.*) b\/(.*)$/m);
      key = m ? m[2] : null;
    }
    if (key !== null) map.set(key, chunk);
  }
  return map;
}

export function parseLogLine(line) {
  // Una línea de `--format=$LOG_FMT` (campos separados por 0x1f).
  const [hash, short, subject, author, date] = line.split("\x1f");
  return hash ? { hash, short, subject: subject ?? "", author: author ?? "", date: date ?? "" } : null;
}

// numstat → Map por path nuevo (un rename puede traer `new\told` — se queda
// con el primero, mismo criterio que el modo working original).
function numstatMapOf(out) {
  const m = new Map();
  for (const line of out.split("\n")) {
    const mt = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (mt) m.set(mt[3].replace(/(.*)\t.*$/, "$1"), { added: mt[1], deleted: mt[2] });
  }
  return m;
}

// Contenido de `ref:path` (o null si no existe / muy grande / binario ilegible).
async function gitShow(ref, p, cwd) {
  const r = await runGit(["show", `${ref}:${p}`], { cwd });
  if (!r.ok || r.out.length > CONTENT_LIMIT) return null;
  return r.out;
}

// Contenido de un blob de la foto de turno. OJO al cwd: los blobs viven en
// el .git DEL WORKSPACE de la foto — cat-file con el cwd por defecto busca
// en otro repo y no los encuentra (null si el objeto ya no está, p.ej. gc).
async function catBlob(sha, cwd) {
  const r = await runGit(["cat-file", "blob", sha], { cwd });
  return r.ok ? r.out : null;
}

// Contenido actual del archivo de trabajo (o null si no existe / muy grande).
function readWorkFile(p, cwd) {
  try {
    const abs = path.join(cwd, p);
    if (fs.statSync(abs).size > CONTENT_LIMIT) return null;
    return fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

// El corazón común a todos los modos "vs una base": entra la lista de archivos
// (name-status + untracked), sale cada uno con before/after (si entran en el
// presupuesto) o parche -U10 de fallback, más added/deleted/binary.
async function enrichFiles({ entries, numstat, getBefore, getAfter, buildPatches, cwd }) {
  let truncated = false;
  let budget = MAX_PATCH_BYTES;
  // Primero intento contenido completo (before/after): el panel diffea local
  // con 10 líneas de contexto y separadores expandibles. Parche sólo fallback.
  for (const f of entries) {
    if (f.binary) continue;
    const before = f.status === "A" || f.status === "?" ? null : await getBefore(f);
    const after = f.status === "D" ? null : await getAfter(f);
    if (before !== null || after !== null) {
      const cost = (before?.length ?? 0) + (after?.length ?? 0);
      if (cost <= budget) {
        f.before = before ?? "";
        f.after = after ?? "";
        budget -= cost;
        continue;
      }
      truncated = true;
    }
  }
  const needPatch = entries.some((f) => f.before === undefined && !f.binary && f.status !== "R");
  let patchMap = new Map();
  if (needPatch && buildPatches) patchMap = await buildPatches();
  for (const f of entries) {
    if (f.before !== undefined) continue; // ya viaja con contenido completo
    const chunk = patchMap.get(f.path);
    if (!chunk) continue;
    if (chunk.length <= budget) {
      f.patch = chunk;
      budget -= chunk.length;
    } else {
      truncated = true;
    }
  }
  for (const f of entries) {
    const n = numstat.get(f.path);
    if (n) {
      f.added = n.added;
      f.deleted = n.deleted;
      if (n.added === "-") f.binary = true;
    } else if (!f.binary) {
      // numstat no cubre untracked: contamos del contenido (o del parche
      // --no-index) para que el resumen del panel sea real.
      if (f.status === "?" && typeof f.after === "string" && f.after.length) {
        f.added = String(f.after.split("\n").length - (f.after.endsWith("\n") ? 1 : 0));
        f.deleted = "0";
      } else if (f.patch) {
        let a = 0;
        let d = 0;
        for (const l of f.patch.split("\n")) {
          if (l.startsWith("+") && !l.startsWith("+++")) a++;
          else if (l.startsWith("-") && !l.startsWith("---")) d++;
        }
        f.added = String(a);
        f.deleted = String(d);
      }
    }
    if (f.patch && /^Binary files /m.test(f.patch)) f.binary = true;
  }
  return { files: entries, truncated };
}

async function repoMeta(cwd) {
  const [inside, branchR, headR] = await Promise.all([
    runGit(["rev-parse", "--is-inside-work-tree"], { cwd }),
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd }),
    runGit(["rev-parse", "--short", "HEAD"], { cwd }),
  ]);
  return {
    inside: inside.ok,
    branch: branchR.out.trim(),
    head: headR.out.trim(),
  };
}

async function resolveUpstream(cwd) {
  const r = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { cwd });
  return r.ok && r.out.trim() ? r.out.trim() : null;
}

// Cambia el workspace ACTIVO (chip 📁 del panel): valida que exista y sea un
// repo git, re-arma los watchers y resetea la firma para que el próximo
// evento notifique y el panel refresque solo.
export async function setActiveWorkspace(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return { error: "invalid_path", message: "Pasame la ruta de una carpeta." };
  const p = path.resolve(raw.replace(/^~(?=\/|$)/, os.homedir()));
  let stats;
  try {
    stats = fs.statSync(p);
  } catch {
    return { error: "invalid_path", message: `No existe: ${p}` };
  }
  if (!stats.isDirectory()) return { error: "invalid_path", message: `No es una carpeta: ${p}` };
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: p });
  if (!inside.ok)
    return { error: "not_a_repo", message: `${p} no es un repositorio git. Diff Ask necesita git.` };
  activeWorkspace = p;
  lastSig = null; // el próximo cálculo de firma difiere → notifica y refresca
  worktreeWatcher?.close();
  gitWatcher?.close();
  worktreeWatcher = null;
  gitWatcher = null;
  if (subs.size) ensureWatchers();
  ensureInboxWatcher();
  log(`workspace activo → ${p}`);
  return { ok: true, workspace: p };
}

// ------------------------------------------------- write_file (editor)
// Autosave del editor del panel (estilo IntelliJ: siempre guarda). Política
// de conflicto AGENTE GANA: si el archivo cambió en disco desde el contenido
// que el panel tenía como base (expect_base = sha1), NO se pisa — la versión
// del panel va a un shelve (contenido completo + .patch con la diferencia)
// bajo ~/.zcode/diff-ask/shelved/<ws>/ y el panel cierra la edición.
export async function writeFileGuarded({ path: rel, content, base, expect_base: expect, on_conflict: onConflict = "shelve", workspace = activeWorkspace } = {}) {
  const ws = workspace;
  const abs = path.resolve(ws, String(rel ?? ""));
  if (abs !== ws && !abs.startsWith(ws + path.sep))
    return { error: "invalid_path", message: `La ruta "${rel}" sale del workspace.` };
  if (typeof content !== "string")
    return { error: "invalid_content", message: "Falta el contenido a guardar." };
  const hash = (buf) => createHash("sha1").update(buf).digest("hex");
  let cur;
  try {
    cur = fs.readFileSync(abs);
  } catch {
    return {
      conflict: true,
      onConflict: "drop",
      message: `El archivo ya no existe en disco (¿lo borraron mientras editabas?). Tu versión no se guardó.`,
    };
  }
  const curHash = hash(cur);
  // La verificación de base se hace SIEMPRE acá (server-side): el panel manda
  // el CONTENIDO base y este lado lo hashea con la MISMA función que el disco.
  // El hash del lado del panel (crypto.subtle en el sandbox) demostró no ser
  // confiable — shelvings con patch VACÍO: bytes idénticos, hashes distintos.
  const baseOk =
    typeof base === "string"
      ? hash(Buffer.from(base, "utf8")) === curHash
      : String(expect ?? "") === curHash;
  if (!baseOk) {
    if (onConflict === "drop")
      return { conflict: true, dropped: true, current_hash: curHash, message: "El archivo cambió en disco mientras editabas (gana el agente); tus ediciones no se guardaron." };
    // shelve: contenido completo + patch con la diferencia (disco vs mío)
    const stamp = new Date(); // hora local legible en el nombre
    const p2 = (n) => String(n).padStart(2, "0");
    const ts = `${p2(stamp.getHours())}${p2(stamp.getMinutes())}${p2(stamp.getSeconds())}`;
    const base = path.basename(String(rel));
    const dir = path.join(DA_STATE_DIR, "shelved", wsKey(ws), path.dirname(String(rel)) === "." ? "" : path.dirname(String(rel)));
    fs.mkdirSync(dir, { recursive: true });
    const minePath = path.join(dir, `${base}.${ts}.mine`);
    fs.writeFileSync(minePath, content);
    const patchPath = `${minePath}.patch`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "da-shelve-"));
    try {
      fs.writeFileSync(path.join(tmp, "disk"), cur);
      fs.writeFileSync(path.join(tmp, "mine"), content);
      const r = await runGit(["diff", "--no-index", "--no-color", "--", "disk", "mine"], { cwd: tmp, expectDiffExit: true });
      fs.writeFileSync(patchPath, r.out.replace(/^--- a\/disk/m, `--- a/${rel}`).replace(/^\+\+\+ b\/mine/m, `+++ b/${rel}`));
    } catch {
      /* sin patch: el .mine ya es suficiente */
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    return {
      conflict: true,
      shelved: [minePath, patchPath],
      current_hash: curHash,
      message: `El archivo cambió en disco mientras editabas (gana el agente). Tu versión quedó en ${minePath} (+ .patch con la diferencia).`,
    };
  }
  fs.writeFileSync(abs, content);
  return { ok: true, hash: hash(Buffer.from(content, "utf8")) };
}

// ------------------------------------------------------- diff vs una base
// base = HEAD (working) o @{upstream} (unpushed). Los archivos salen de
// `git diff --name-status -M base` (tracked, renames incluidos) + untracked
// del porcelain — en unpushed los untracked también son "sin pushear".
export async function buildDiff({ mode = "working", includePatches = true, workspace = activeWorkspace } = {}) {
  const ws = workspace;
  const meta = await repoMeta(ws);
  if (!meta.inside)
    return {
      error: "not_a_repo",
      message: `El workspace no es un repositorio git (${ws}). Diff Ask necesita git.`,
      workspace: ws,
    };

  let base = "HEAD";
  let baseLabel = "HEAD";
  let upstream = null;
  let ahead;
  let behind;
  if (mode === "unpushed") {
    upstream = await resolveUpstream(ws);
    if (!upstream)
      return {
        error: "no_upstream",
        message: `La rama ${meta.branch} no tiene upstream configurado. Configuralo con "git push -u origin ${meta.branch}" (o el remoto que uses) para ver "Sin pushear".`,
        workspace: ws,
        branch: meta.branch,
        head: meta.head,
      };
    base = upstream;
    baseLabel = upstream;
    const c = await runGit(["rev-list", "--left-right", "--count", `${upstream}...HEAD`], { cwd: ws });
    const m = c.out.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) {
      behind = Number(m[1]);
      ahead = Number(m[2]);
    }
  }

  const [nsR, stR, numR] = await Promise.all([
    runGit(["diff", "--name-status", "-z", "-M", base], { cwd: ws }),
    runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: ws }),
    runGit(["diff", "--numstat", "-M", base], { cwd: ws }),
  ]);
  const entries = parseNameStatusZ(nsR.out);
  const untracked = parsePorcelainZ(stR.out).filter((f) => f.status === "?");
  const paths = new Set(entries.map((f) => f.path));
  for (const f of untracked) if (!paths.has(f.path)) entries.push({ ...f, patch: undefined });

  const { files, truncated } = await enrichFiles({
    entries,
    numstat: numstatMapOf(numR.out),
    getBefore: (f) => gitShow(base, f.oldPath ?? f.path, ws),
    getAfter: (f) => Promise.resolve(readWorkFile(f.path, ws)),
    buildPatches: includePatches
      ? async () => {
          const map = splitPatch((await runGit(["diff", base, "--no-color", "-U10"], { cwd: ws })).out);
          for (const f of untracked) {
            const r = await runGit(
              ["diff", "--no-index", "--no-color", "-U10", "--", "/dev/null", f.path],
              { cwd: ws, expectDiffExit: true },
            );
            for (const [k, v] of splitPatch(r.out)) map.set(k, v);
          }
          return map;
        }
      : null,
    cwd: ws,
  });

  return {
    workspace: ws,
    branch: meta.branch,
    head: meta.head,
    mode,
    baseLabel,
    upstream,
    ahead,
    behind,
    dirty: files.length > 0,
    truncated,
    fileCount: files.length,
    files,
    generatedAt: new Date().toISOString(),
  };
}

// ------------------------------------------------------- turnos (por prompt)
// Cada mensaje del usuario corta un turno. La señal la escriben DOS
// escritores en ~/.zcode/diff-ask/turn-events.jsonl (una línea JSON por
// mensaje: {"workspace","prompt","at","source"}):
//   · el BOT (Telegram/mobile) en su hook on_user_prompt
//   · el FORK (desktop/web) en el punto de envío del renderer
// Este server observa ese inbox CON PRIORIDAD (sin debounce: la foto hay que
// tomarla ANTES de que el agente empiece a editar) y para eventos del
// workspace activo fotografia el estado: HEAD + por cada archivo sucio su
// contenido como BLOB de git (hash-object -w — vive en .git/objects,
// comprimido y deduplicado, sin tocar worktree ni índice). El índice por
// workspace persiste en ~/.zcode/diff-ask/turns/<key>/turns.json, así la
// historia sobrevive sessions/restarts. Diff del turno N = foto(prompt N) vs
// foto(prompt N+1) — el efecto NETO (commits incluidos); el ÚLTIMO turno =
// foto del último prompt vs working tree VIVO.
// Sobreescribible (tests apuntan a un tmp): ZCODE_DIFF_ASK_STATE=/tmp/x
const DA_STATE_DIR = process.env.ZCODE_DIFF_ASK_STATE || path.join(os.homedir(), ".zcode", "diff-ask");
const TURN_INBOX = path.join(DA_STATE_DIR, "turn-events.jsonl");
const TURNS_DIR = path.join(DA_STATE_DIR, "turns");
const PROMPT_MAX = 100_000; // paranoia: prompts gigantes se recortan
const BLOB_LIMIT = 5_000_000; // por archivo: más grande no se fotografía

// ISO en hora LOCAL sin zona: la lista del panel muestra la hora que el
// usuario vivió (los eventos del bot ya vienen así).
function localIso() {
  return new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 19);
}

function wsKey(ws) {
  return createHash("sha1").update(ws).digest("hex").slice(0, 16);
}

function turnsIndexPath(ws) {
  return path.join(TURNS_DIR, wsKey(ws), "turns.json");
}

function loadTurns(ws) {
  try {
    const arr = JSON.parse(fs.readFileSync(turnsIndexPath(ws), "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveTurns(ws, arr) {
  fs.mkdirSync(path.dirname(turnsIndexPath(ws)), { recursive: true });
  fs.writeFileSync(turnsIndexPath(ws), JSON.stringify(arr));
}

// git con stdin (hash-object --stdin necesita escribir bytes al proceso).
function runGitIn(args, input, { cwd = activeWorkspace } = {}) {
  return new Promise((resolve) => {
    const p = spawn("git", ["-C", cwd, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => resolve({ ok: false, out: "", err: "git binary not found" }));
    p.on("close", (code) => resolve({ ok: code === 0, out, err }));
    p.stdin.end(input);
  });
}

async function hashBlobIn(content, ws) {
  const r = await runGitIn(["hash-object", "-w", "--stdin"], content, { cwd: ws });
  return r.ok ? r.out.trim() : null;
}

// La foto del AHORA: HEAD + blob del contenido de cada archivo sucio.
// Exportada para tests.
export async function recordTurn(prompt, at = localIso(), workspace = activeWorkspace) {
  const ws = workspace;
  const headR = await runGit(["rev-parse", "HEAD"], { cwd: ws });
  if (!headR.ok) return null; // sin repo no hay turno
  const stR = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: ws });
  const files = [];
  for (const f of parsePorcelainZ(stR.out)) {
    if (f.status === "D") {
      files.push({ path: f.path, status: "D", blob: null });
      continue;
    }
    let blob = null;
    let oversized = false;
    try {
      const abs = path.join(ws, f.path);
      if (fs.statSync(abs).size <= BLOB_LIMIT) {
        blob = await hashBlobIn(fs.readFileSync(abs), ws); // Buffer: binario OK
      } else oversized = true;
    } catch {
      oversized = true; // ilegible ahora: la foto cae a la versión de HEAD
    }
    files.push({ path: f.path, status: f.status, ...(f.oldPath ? { oldPath: f.oldPath } : {}), blob, ...(oversized ? { oversized: true } : {}) });
  }
  const turns = loadTurns(ws);
  const rec = {
    id: `${Date.now().toString(36)}-${turns.length + 1}`,
    at,
    prompt: String(prompt ?? "").slice(0, PROMPT_MAX),
    head: headR.out.trim(),
    files,
  };
  turns.push(rec);
  saveTurns(ws, turns);
  log(`turno ${rec.id} (${files.length} archivo(s) sucios) — "${rec.prompt.slice(0, 50)}"`);
  return rec;
}

// ----------------------------------------------------------- inbox de turnos
let inboxOffset = 0;
let inboxInit = false;

// Al arrancar: el offset arranca en el EOF actual — eventos anteriores a
// esta vida del server no se pueden fotografiar (el estado ya cambió); su
// historia, si existe, ya está en los índices que grabaron servers previos.
function initInboxOffset() {
  if (inboxInit) return;
  inboxInit = true;
  try {
    inboxOffset = fs.statSync(TURN_INBOX).size;
  } catch {
    inboxOffset = 0;
  }
}

export async function processInbox() {
  initInboxOffset();
  let data;
  try {
    data = fs.readFileSync(TURN_INBOX, "utf8");
  } catch {
    return;
  }
  if (data.length < inboxOffset) inboxOffset = 0; // rotaron/reemplazaron el archivo
  if (data.length <= inboxOffset) return;
  const chunk = data.slice(inboxOffset);
  inboxOffset = data.length;
  let active = activeWorkspace;
  try {
    active = fs.realpathSync(activeWorkspace);
  } catch { /* sin realpath nos quedamos con la ruta literal */ }
  let touched = false;
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const ws = String(ev.workspace ?? "").trim();
    if (!ws) continue;
    let resolved = ws;
    try {
      resolved = fs.realpathSync(ws);
    } catch {
      continue; // la carpeta ya no existe
    }
    if (resolved !== active) continue;
    // dedupe anti doble-disparo (la misma línea procesada dos veces o un
    // evento sintético inmediato): mismo prompt a <3s del último turno.
    const turnsNow = loadTurns(activeWorkspace);
    const lastRec = turnsNow[turnsNow.length - 1];
    if (
      lastRec &&
      lastRec.prompt === String(ev.prompt ?? "") &&
      Math.abs(Date.parse(String(ev.at ?? "")) - Date.parse(lastRec.at)) < 3000
    )
      continue;
    if (await recordTurn(ev.prompt ?? "", ev.at ?? localIso())) touched = true;
  }
  if (touched)
    for (const uri of subs) sendNotification("notifications/resources/updated", { uri });
}

let inboxWatcher = null;
function ensureInboxWatcher() {
  if (inboxWatcher) return;
  try {
    fs.mkdirSync(DA_STATE_DIR, { recursive: true });
    initInboxOffset();
    inboxWatcher = fs.watch(DA_STATE_DIR, (_evt, file) => {
      if (file !== path.basename(TURN_INBOX)) return;
      processInbox().catch(() => {});
    });
    inboxWatcher.on("error", () => {});
    inboxWatcher.unref?.();
  } catch {
    /* sin watcher: turn mode still works leyendo el índice al refrescar */
  }
}

// Counts reales de un diff before/after que git no conoce: numstat contra
// archivos temporales (--no-index). Binarios llegan como "-".
async function numstatBetween(a, b) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-turn-"));
  try {
    const fa = path.join(dir, "a");
    const fb = path.join(dir, "b");
    fs.writeFileSync(fa, a ?? "");
    fs.writeFileSync(fb, b ?? "");
    const r = await runGit(["diff", "--no-index", "--numstat", "--", fa, fb], {
      cwd: dir,
      expectDiffExit: true,
    });
    const m = r.out.trim().match(/^(-|\d+)\t(-|\d+)\t/);
    return m ? { added: m[1], deleted: m[2] } : { added: "0", deleted: "0" };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Contenido de un archivo según una FOTO: blob guardado (estado sucio en ese
// momento) o, si estaba limpio/oversized, la versión de HEAD de la foto.
// null = no existía / borrado. Oversize → {oversize:true} (sin contenido).
async function contentAt(rec, entry, p, ws) {
  if (entry) {
    if (entry.blob) {
      const c = await catBlob(entry.blob, ws);
      if (c !== null) return c.length > CONTENT_LIMIT ? { oversize: true } : c;
    }
    if (entry.status === "D") return null;
    const c = await gitShow(rec.head, entry.oldPath ?? p, ws);
    return c !== null && c.length > CONTENT_LIMIT ? { oversize: true } : c;
  }
  // sin entrada = estaba LIMPIO: la versión de HEAD de la foto.
  const c = await gitShow(rec.head, p, ws);
  return c !== null && c.length > CONTENT_LIMIT ? { oversize: true } : c;
}

// Diff del turno: foto(prompt N) vs foto(prompt N+1). El último ("latest")
// compara contra el working tree VIVO (se actualiza con cada notificación).
export async function buildTurnDiff(id, { workspace = activeWorkspace } = {}) {
  const ws = workspace;
  const meta = await repoMeta(ws);
  if (!meta.inside)
    return { error: "not_a_repo", message: `El workspace no es un repositorio git (${ws}).`, workspace: ws };
  const turns = loadTurns(ws);
  if (!turns.length)
    return {
      error: "no_turns",
      message: "Todavía no hay turnos registrados para esta carpeta. Cada mensaje tuyo en la sesión (desktop o Telegram) registra uno automáticamente.",
      workspace: ws,
      branch: meta.branch,
      head: meta.head,
    };
  const idx = id === "latest" ? turns.length - 1 : turns.findIndex((t) => t.id === id);
  if (idx === -1)
    return { error: "unknown_turn", message: `No encontré el turno "${id}".`, workspace: ws, branch: meta.branch, head: meta.head };

  const rec = turns[idx];
  const isLatest = idx === turns.length - 1;
  const next = isLatest ? null : turns[idx + 1];

  // estado "después": la foto siguiente, o el working tree vivo.
  let nowMap = new Map();
  if (isLatest) {
    const stR = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: ws });
    nowMap = new Map(parsePorcelainZ(stR.out).map((f) => [f.path, f]));
  }
  const paths = new Set(rec.files.map((f) => f.path));
  for (const f of next?.files ?? []) paths.add(f.path);
  for (const p of nowMap.keys()) paths.add(p);

  const entries = [];
  for (const p of paths) {
    const fe = rec.files.find((f) => f.path === p);
    const fn = next?.files.find((f) => f.path === p);
    const before = await contentAt(rec, fe, p, ws);
    let after;
    if (isLatest) {
      const nf = nowMap.get(p);
      if (nf) after = nf.status === "D" ? null : readWorkFile(p, ws);
      else {
        const c = await gitShow("HEAD", p, ws);
        after = c !== null && c.length > CONTENT_LIMIT ? { oversize: true } : c;
      }
    } else {
      after = await contentAt(next, fn, p, ws);
    }
    // oversize en ambos lados: sin contenido comparable, el archivo se omite.
    if (before?.oversize && after?.oversize) continue;
    if (before === after) continue;
    if (before === null && after === null) continue;
    const status = before === null ? "A" : after === null ? "D" : "M";
    if (before?.oversize || after?.oversize) {
      entries.push({ status, path: p, note: "archivo muy grande — sin contenido en este turno" });
      continue;
    }
    entries.push({ status, path: p, before: before ?? "", after: after ?? "", patch: undefined });
  }

  for (const f of entries) {
    if (f.before === undefined) continue;
    const n = await numstatBetween(f.before, f.after);
    f.added = n.added;
    f.deleted = n.deleted;
    if (n.added === "-") f.binary = true;
  }

  return {
    workspace: ws,
    branch: meta.branch,
    head: meta.head,
    mode: "turn",
    turn: { id: rec.id, at: rec.at, prompt: rec.prompt, isLatest },
    baseLabel: `turno ${rec.at.slice(11, 16)}`,
    snapshotAt: rec.at,
    dirty: entries.length > 0,
    truncated: false,
    fileCount: entries.length,
    files: entries,
    generatedAt: new Date().toISOString(),
  };
}

export function listTurns({ workspace = activeWorkspace } = {}) {
  const turns = loadTurns(workspace)
    .map((t, i, arr) => ({
      id: t.id,
      at: t.at,
      prompt: t.prompt,
      head: t.head,
      seq: i,
      isLatest: i === arr.length - 1,
    }))
    .reverse();
  return { workspace, count: turns.length, turns };
}

// Borrar un turno: su registro sale del índice — el turno ANTERIOR pasa a
// diffear contra la foto siguiente que quede (o el working tree si era el
// último). Los blobs quedan huérfanos en .git/objects (el gc de git los
// recoge).
export function deleteTurn(id, { workspace = activeWorkspace } = {}) {
  const turns = loadTurns(workspace);
  const i = turns.findIndex((t) => t.id === id);
  if (i === -1) return { error: "unknown_turn", message: `No encontré el turno "${id}".` };
  turns.splice(i, 1);
  saveTurns(workspace, turns);
  return { ok: true, remaining: turns.length };
}

export function clearTurns({ workspace = activeWorkspace } = {}) {
  saveTurns(workspace, []);
  return { ok: true, remaining: 0 };
}

// ------------------------------------------------------------ commits

export async function listCommits({ skip = 0, limit = 10, query = "", workspace = activeWorkspace } = {}) {
  const ws = workspace;
  const meta = await repoMeta(ws);
  if (!meta.inside)
    return { error: "not_a_repo", message: `El workspace no es un repositorio git (${ws}).`, workspace: ws };
  const q = query.trim();

  if (!q) {
    // Paginado plano: pido limit+1 para saber si hay más ("…" en el panel).
    const r = await runGit(
      ["log", "--skip", String(skip), "-n", String(limit + 1), `--format=${LOG_FMT}`],
      { cwd: ws },
    );
    const arr = r.out.trim() ? r.out.trim().split("\n") : [];
    const hasMore = arr.length > limit;
    return {
      workspace: ws,
      query: "",
      skip,
      limit,
      hasMore,
      commits: arr.slice(0, limit).map(parseLogLine).filter(Boolean),
    };
  }

  // Búsqueda: hash exacto/prefijo primero (si resuelve), después por texto
  // del título (--fixed-strings -i: substring literal, sin regex).
  let exact = null;
  if (/^[0-9a-f]{4,40}$/i.test(q)) {
    const v = await runGit(["rev-parse", "--verify", "--quiet", `${q}^{commit}`], { cwd: ws });
    if (v.ok) {
      const s = await runGit(["show", "-s", `--format=${LOG_FMT}`, q], { cwd: ws });
      exact = parseLogLine(s.out.trim());
    }
  }
  const g = await runGit(
    ["log", "-n", "30", "-i", "--fixed-strings", "--grep", q, `--format=${LOG_FMT}`],
    { cwd: ws },
  );
  const seen = new Set();
  const commits = [];
  if (exact) {
    commits.push(exact);
    seen.add(exact.hash);
  }
  for (const line of g.out.trim() ? g.out.trim().split("\n") : []) {
    const c = parseLogLine(line);
    if (c && !seen.has(c.hash)) {
      commits.push(c);
      seen.add(c.hash);
    }
  }
  return { workspace: ws, query: q, skip: 0, limit: 30, hasMore: false, commits, exactMatch: Boolean(exact) };
}

export async function buildCommitDiff(ref, { workspace = activeWorkspace } = {}) {
  const ws = workspace;
  const meta = await repoMeta(ws);
  if (!meta.inside)
    return { error: "not_a_repo", message: `El workspace no es un repositorio git (${ws}).`, workspace: ws };
  const full = await runGit(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: ws });
  if (!full.ok)
    return { error: "unknown_commit", message: `No encontré el commit "${ref}" en ${ws}.`, workspace: ws };
  const sha = full.out.trim();

  const [metaR, parentsR, numR] = await Promise.all([
    runGit(["show", "-s", `--format=${LOG_FMT}`, sha], { cwd: ws }),
    runGit(["show", "-s", "--format=%P", sha], { cwd: ws }),
    runGit(["diff", "--numstat", "-M", `${sha}^`, sha], { cwd: ws }),
  ]);
  const commit = parseLogLine(metaR.out.trim());
  const parents = parentsR.out.trim().split(/\s+/).filter(Boolean);
  const isMerge = parents.length > 1;
  // Commit raíz: padre = árbol vacío canónico. Merge: primer padre (nota en
  // el panel).
  const parent = parents[0] ?? EMPTY_TREE;

  const nsR = await runGit(["diff", "--name-status", "-z", "-M", parent, sha], { cwd: ws });
  const entries = parseNameStatusZ(nsR.out);
  const { files, truncated } = await enrichFiles({
    entries,
    numstat: numstatMapOf(numR.out),
    getBefore: (f) => gitShow(parent, f.oldPath ?? f.path, ws),
    getAfter: (f) => gitShow(sha, f.path, ws),
    buildPatches: async () =>
      splitPatch((await runGit(["diff", "--no-color", "-U10", parent, sha], { cwd: ws })).out),
    cwd: ws,
  });

  return {
    workspace: ws,
    branch: meta.branch,
    head: meta.head,
    mode: "commit",
    baseLabel: `commit ${commit?.short ?? sha.slice(0, 7)}`,
    commit: commit ? { ...commit, hash: sha, isMerge, parents } : { hash: sha, short: sha.slice(0, 7), subject: "", author: "", date: "", isMerge, parents },
    isMerge,
    dirty: false,
    truncated,
    fileCount: files.length,
    files,
    generatedAt: new Date().toISOString(),
  };
}

// ------------------------------------------------------- reactive watch

const subs = new Set();
let worktreeWatcher = null;
let gitWatcher = null;
let debounce = null;
let lastSig = null;

function sendNotification(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

// La firma incluye el upstream: en modo "Sin pushear" un fetch que mueva
// origin/* también tiene que refrescar el panel.
async function signature() {
  const [s, n, h, u] = await Promise.all([
    runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    runGit(["diff", "HEAD", "--numstat"]),
    runGit(["rev-parse", "HEAD"]),
    runGit(["rev-parse", "@{upstream}"]),
  ]);
  return createHash("sha1").update(`${s.out}\u0000${n.out}\u0000${h.out}\u0000${u.ok ? u.out : "-"}`).digest("hex");
}

function onFsEvent(_evt, file) {
  if (file && file.split("/")[0] === ".git" && !gitWatcher) return; // covered below
  clearTimeout(debounce);
  debounce = setTimeout(async () => {
    try {
      const sig = await signature();
      if (sig !== lastSig) {
        lastSig = sig;
        for (const uri of subs)
          sendNotification("notifications/resources/updated", { uri });
      }
    } catch {
      /* transient git error — next event retries */
    }
  }, 600);
}

function ensureWatchers() {
  ensureInboxWatcher();
  if (worktreeWatcher) return;
  try {
    worktreeWatcher = fs.watch(activeWorkspace, { recursive: true }, onFsEvent);
    worktreeWatcher.on("error", () => {});
    worktreeWatcher.unref?.();
  } catch {
    /* recursive watch unsupported — panel still has its refresh button */
  }
  try {
    gitWatcher = fs.watch(path.join(activeWorkspace, ".git"), { recursive: true }, onFsEvent);
    gitWatcher.on("error", () => {});
    gitWatcher.unref?.();
  } catch {
    /* .git missing or unwatchable */
  }
}

// ------------------------------------------------------------- MCP core

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const TOOLS = [
  {
    name: "get_diff",
    description:
      "Get the live diff of the session workspace as structured JSON: per-file path, status, added/deleted counts and unified patch. Opens the Diff Ask panel, where the user can also press '+' on any diff line to ask about that exact line. Modes: working (default, git diff HEAD + untracked) and unpushed (everything a push would send plus local changes, vs @{upstream}). For per-turn diffs use list_turns + get_turn_diff.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["working", "unpushed"],
          default: "working",
          description: "Which changes to diff: working (vs HEAD) or unpushed (vs @{upstream}).",
        },
        include_patches: {
          type: "boolean",
          default: true,
          description: "Include the unified patch text per file (false → metadata only).",
        },
      },
    },
    annotations: { readOnlyHint: true },
    _meta: {
      ui: { resourceUri: PANEL_URI, surface: "diff-ask", visibility: ["model", "app"] },
    },
  },
  {
    name: "list_commits",
    description:
      "List repository commits: latest N with title/author/date (paginate with skip), or search by commit hash/prefix or title text. Returns short hash, subject, author, relative date — enough to then call get_commit_diff.",
    inputSchema: {
      type: "object",
      properties: {
        skip: { type: "integer", minimum: 0, default: 0, description: "Skip the first N commits (pagination)." },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10, description: "How many commits to return." },
        query: { type: "string", default: "", description: "Commit hash/prefix or title text to search for." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_commit_diff",
    description:
      "Get the full diff of one commit (vs its first parent; root commits diff against the empty tree) as structured JSON, same shape as get_diff. Opens the Diff Ask panel on that commit.",
    inputSchema: {
      type: "object",
      properties: {
        commit: { type: "string", description: "Commit hash (full or short) or any revision resolving to a commit." },
      },
      required: ["commit"],
    },
    annotations: { readOnlyHint: true },
    _meta: {
      ui: { resourceUri: PANEL_URI, surface: "diff-ask", visibility: ["model", "app"] },
    },
  },
  {
    name: "list_turns",
    description:
      "List the recorded turns of the active workspace (newest first): every user prompt snapshots the workspace state, so each turn's diff shows exactly what that prompt achieved (commits included). Each entry: id, timestamp, full prompt text, isLatest.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_turn_diff",
    description:
      "Get the diff of one turn (state at its prompt vs state at the next prompt; 'latest' diffs against the live working tree). Same JSON shape as get_diff. Opens the Diff Ask panel on that turn.",
    inputSchema: {
      type: "object",
      properties: {
        turn: { type: "string", description: "Turn id, or 'latest' for the live last turn." },
      },
      required: ["turn"],
    },
    annotations: { readOnlyHint: true },
    _meta: {
      ui: { resourceUri: PANEL_URI, surface: "diff-ask", visibility: ["model", "app"] },
    },
  },
  {
    name: "delete_turn",
    description:
      "Delete one recorded turn (the panel's ✕). The previous turn then diffs against the next remaining snapshot; orphaned git blobs are collected by git gc.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "write_file",
    description:
      "Autosave from the Diff Ask panel's inline editor (IntelliJ-style save-all). Conflict policy: THE AGENT WINS — if the file changed on disk since the panel's base (expect_base = sha1 of the base content), the write is refused; with on_conflict=shelve the panel's version is saved aside (full content + .patch) under ~/.zcode/diff-ask/shelved/. The model should NOT call this to edit files (use your own edit tools).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path of the file." },
        content: { type: "string", description: "Full new content (utf8)." },
        base: { type: "string", description: "The content the panel believes is on disk (conflict check — hashed SERVER-side; do NOT pre-hash)." },
        expect_base: { type: "string", description: "Legacy: sha1 hex of the base content (only used when 'base' is absent)." },
        on_conflict: { type: "string", enum: ["shelve", "drop"], default: "shelve" },
      },
      required: ["path", "content", "base"],
    },
  },
  {
    name: "clear_turns",
    description: "Delete ALL recorded turns of the active workspace (the panel's 'Borrar todo').",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_workspace",
    description:
      "Change the workspace the Diff Ask panel diffs (and its reactive watchers) to another local git repository path. Used by the panel's 📁 chip; the model may call it when the user asks to diff a different folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of a local git repository (~ allowed)." },
      },
      required: ["path"],
    },
  },
];

const RESOURCES = [
  { uri: PANEL_URI, name: "panel", mimeType: "text/html;profile=mcp-app" },
  { uri: DIFF_URI, name: "workspace-diff", mimeType: "application/json" },
  { uri: "diff://workspace?mode=unpushed", name: "workspace-diff-unpushed", mimeType: "application/json" },
  { uri: "turn://list", name: "turns", mimeType: "application/json" },
  { uri: "log://commits", name: "commits", mimeType: "application/json" },
];

function uriDiffData(uri) {
  const u = new URL(uri);
  if (u.protocol === "diff:") {
    if (u.host === "workspace") {
      const mode = u.searchParams.get("mode") ?? "working";
      return buildDiff({ mode: mode === "unpushed" ? "unpushed" : "working" });
    }
    if (u.host === "turn") {
      const id = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
      ensureInboxWatcher();
      return buildTurnDiff(id || "latest");
    }
    if (u.host === "commit") {
      const ref = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
      return buildCommitDiff(ref);
    }
  }
  if (u.protocol === "turn:" && u.host === "list") {
    ensureInboxWatcher();
    return Promise.resolve(listTurns());
  }
  if (u.protocol === "log:" && u.host === "commits") {
    const skip = parseInt(u.searchParams.get("skip") ?? "0", 10) || 0;
    const limit = parseInt(u.searchParams.get("limit") ?? "10", 10) || 10;
    const q = u.searchParams.get("q") ?? "";
    return listCommits({ skip, limit, query: q });
  }
  return null;
}

async function handleRequest(msg) {
  const { method, params = {} } = msg;
  switch (method) {
    case "initialize":
      return {
        protocolVersion:
          typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: true, listChanged: true },
        },
        serverInfo,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      let data;
      switch (params.name) {
        case "get_diff":
          data = await buildDiff({
            mode: params.arguments?.mode === "unpushed" ? "unpushed" : "working",
            includePatches: params.arguments?.include_patches !== false,
          });
          break;
        case "list_commits": {
          data = await listCommits({
            skip: Number(params.arguments?.skip ?? 0) || 0,
            limit: Math.min(Number(params.arguments?.limit ?? 10) || 10, 50),
            query: String(params.arguments?.query ?? ""),
          });
          return { structuredContent: data, content: [{ type: "text", text: `${data.commits?.length ?? 0} commit(s).` }] };
        }
        case "get_commit_diff":
          data = await buildCommitDiff(String(params.arguments?.commit ?? ""));
          break;
        case "list_turns": {
          data = listTurns();
          return {
            structuredContent: data,
            content: [{ type: "text", text: `${data.count} turno(s).` }],
          };
        }
        case "get_turn_diff":
          ensureInboxWatcher();
          data = await buildTurnDiff(String(params.arguments?.turn ?? "latest"));
          break;
        case "delete_turn": {
          data = deleteTurn(String(params.arguments?.id ?? ""));
          return {
            structuredContent: data,
            content: [{ type: "text", text: data.ok ? `Turno borrado (${data.remaining} restantes).` : data.message }],
          };
        }
        case "write_file": {
          data = await writeFileGuarded({
            path: params.arguments?.path,
            content: params.arguments?.content,
            base: typeof params.arguments?.base === "string" ? params.arguments.base : undefined,
            expect_base: params.arguments?.expect_base,
            on_conflict: params.arguments?.on_conflict === "drop" ? "drop" : "shelve",
          });
          return {
            structuredContent: data,
            content: [{ type: "text", text: data.ok ? "Guardado." : data.message }],
          };
        }
        case "clear_turns": {
          data = clearTurns();
          return { structuredContent: data, content: [{ type: "text", text: "Turnos borrados." }] };
        }
        case "set_workspace": {
          data = await setActiveWorkspace(params.arguments?.path);
          return {
            structuredContent: data,
            content: [{ type: "text", text: data.ok ? `📁 Workspace activo: ${data.workspace}` : data.message }],
          };
        }
        default:
          return { content: [{ type: "text", text: `Unknown tool: ${params.name}` }], isError: true };
      }
      // El modelo no necesita el contenido completo de los archivos (before/
      // after son para el panel): respuesta liviana con paths + parches.
      const slim = data.error
        ? data
        : {
            ...data,
            files: data.files.map(({ before: _b, after: _a, ...f }) => f),
          };
      return {
        structuredContent: slim,
        content: [
          {
            type: "text",
            text: data.error
              ? data.message
              : `${data.fileCount} archivo(s) con cambios en ${data.branch} (${data.head}) vs ${data.baseLabel}${data.truncated ? " — parches truncados" : ""}. Detalle en structuredContent.`,
          },
        ],
      };
    }
    case "resources/list":
      return { resources: RESOURCES };
    case "resources/read": {
      if (params.uri === PANEL_URI) {
        const html = fs.readFileSync(path.join(PLUGIN_ROOT, "dist", "panel.html"), "utf8");
        return { contents: [{ uri: PANEL_URI, mimeType: "text/html;profile=mcp-app", text: html }] };
      }
      const build = uriDiffData(params.uri);
      if (!build) throw new Error(`Unknown resource: ${params.uri}`);
      const data = await build;
      return {
        contents: [
          { uri: params.uri, mimeType: "application/json", text: JSON.stringify(data) },
        ],
      };
    }
    case "resources/subscribe": {
      subs.add(params.uri);
      ensureWatchers();
      return {};
    }
    case "resources/unsubscribe": {
      subs.delete(params.uri);
      return {};
    }
    default:
      const err = new Error(`Method not found: ${method}`);
      err.code = -32601;
      throw err;
  }
}

// The ZCode plugin host (zcode.cjs __zcode-plugin-host) imports this module
// in-process and calls `await main()` — exporting main() is REQUIRED. When
// run directly (`node server.mjs`, e.g. tools/check-server.mjs) main() runs
// via the argv guard below, the same pattern as the official documents server.
export async function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    line = line.trim();
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON — ignore the line
    }
    if (typeof msg.method !== "string") return;
    if (msg.id === undefined) return; // client notification — nothing to do
    handleRequest(msg)
      .then((result) => send({ jsonrpc: "2.0", id: msg.id, result }))
      .catch((e) =>
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: e.code ?? -32603, message: e.message ?? String(e) },
        }),
      );
  });
  log(`server up — workspace: ${WORKSPACE}`);
}

process.on("uncaughtException", (e) => log("uncaught:", e?.stack ?? e));
process.on("unhandledRejection", (e) => log("unhandled:", e?.stack ?? e));

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
