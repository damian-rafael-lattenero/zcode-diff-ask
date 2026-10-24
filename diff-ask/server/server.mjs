#!/usr/bin/env node
// diff-ask MCP server — stdio, Node stdlib only.
//
// Serves:
//   ui://diff-ask/panel.html        → the Diff Ask panel (built by ui/build.mjs)
//   diff://workspace[?mode=…]       → live JSON diff of the session workspace
//     · mode=working (default)        git diff HEAD + untracked
//     · mode=unpushed                 git diff @{upstream} + untracked (lo que
//                                     subiría un push + cambios locales)
//     · mode=last-turn                working tree vs 📸 (snapshot de turno)
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

function runGit(args, { cwd = WORKSPACE, expectDiffExit = false } = {}) {
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

// ------------------------------------------------------- diff vs una base
// base = HEAD (working) o @{upstream} (unpushed). Los archivos salen de
// `git diff --name-status -M base` (tracked, renames incluidos) + untracked
// del porcelain — en unpushed los untracked también son "sin pushear".
export async function buildDiff({ mode = "working", includePatches = true, workspace = WORKSPACE } = {}) {
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
    runGit(["status", "--porcelain=v1", "-z"], { cwd: ws }),
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

// ------------------------------------------------- último turno (📸)
// El server no ve los turnos de la sesión (la SDK no expone eventos), así que
// el marcador lo pone el panel: automático ANTES de mandar cada tanda de
// preguntas (línea de base = arranque del turno) o manual con 📸. El diff
// "último turno" compara el árbol actual contra ese snapshot: muestra lo que
// el agente editó (commiteado o no) desde entonces.
let turnSnapshot = null;

export async function markTurnSnapshot({ workspace = WORKSPACE } = {}) {
  const ws = workspace;
  const meta = await repoMeta(ws);
  if (!meta.inside)
    return { error: "not_a_repo", message: `El workspace no es un repositorio git (${ws}).`, workspace: ws };
  const full = await runGit(["rev-parse", "HEAD"], { cwd: ws });
  const stR = await runGit(["status", "--porcelain=v1", "-z"], { cwd: ws });
  // Contenido ACTUAL de los archivos sucios (la línea de base del turno).
  // Archivos > CONTENT_LIMIT no se guardan: el diff cae a la versión de HEAD
  // del marcador (chip "aprox" en el panel).
  const files = new Map();
  for (const f of parsePorcelainZ(stR.out)) {
    if (f.status === "D") {
      files.set(f.path, null);
      continue;
    }
    const c = readWorkFile(f.path, ws);
    files.set(f.path, c === null ? { oversized: true } : c);
  }
  turnSnapshot = { at: new Date().toISOString(), head: full.out.trim(), files, workspace: ws };
  return { ok: true, at: turnSnapshot.at, files: files.size };
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

export async function buildLastTurnDiff({ workspace = WORKSPACE } = {}) {
  const ws = workspace;
  const meta = await repoMeta(ws);
  if (!meta.inside)
    return { error: "not_a_repo", message: `El workspace no es un repositorio git (${ws}).`, workspace: ws };
  if (!turnSnapshot || turnSnapshot.workspace !== ws)
    return {
      error: "no_snapshot",
      message: "Todavía no hay marcador de turno. Mandá preguntas desde el panel (marca automática al enviar) o tocá 📸 para marcar el estado actual.",
      workspace: ws,
      branch: meta.branch,
      head: meta.head,
    };

  const snap = turnSnapshot;
  const stR = await runGit(["status", "--porcelain=v1", "-z"], { cwd: ws });
  const nowMap = new Map(parsePorcelainZ(stR.out).map((f) => [f.path, f]));
  // Unión: sucios en el marcador ∪ sucios ahora. Archivos limpios en ambos
  // lados son idénticos por definición (salvo commits intermedios — cubiertos
  // porque "ahora limpio" se resuelve contra HEAD actual).
  const paths = new Set([...snap.files.keys(), ...nowMap.keys()]);
  const entries = [];
  for (const p of paths) {
    const nowF = nowMap.get(p);
    const snapV = snap.files.get(p);
    // before: lo que había en el marcador. undefined = limpio → versión de
    // HEAD del marcador; oversized → ídem (fallback documentado); null =
    // borrado en el marcador; string = contenido guardado.
    let before;
    if (snapV === undefined || (snapV && typeof snapV === "object")) {
      before = await gitShow(snap.head, p, ws);
    } else {
      before = snapV;
    }
    // after: estado actual. Sucio → disco; limpio/borrado ahora → HEAD actual
    // (el archivo se restauró o el cambio se commiteó durante el turno).
    let after;
    if (nowF) {
      after = nowF.status === "D" ? null : readWorkFile(p, ws);
    } else {
      after = await gitShow("HEAD", p, ws);
    }
    if (before === after) continue;
    if (before === null && after === null) continue;
    const status = before === null ? "A" : after === null ? "D" : "M";
    entries.push({ status, path: p, before: before ?? "", after: after ?? "", patch: undefined });
  }

  // numstat por archivo (no hay base git que lo dé): --no-index temporal.
  for (const f of entries) {
    const n = await numstatBetween(f.before, f.after);
    f.added = n.added;
    f.deleted = n.deleted;
    if (n.added === "-") f.binary = true;
  }

  return {
    workspace: ws,
    branch: meta.branch,
    head: meta.head,
    mode: "last-turn",
    baseLabel: `📸 ${snap.at}`,
    snapshotAt: snap.at,
    dirty: entries.length > 0,
    truncated: false,
    fileCount: entries.length,
    files: entries,
    generatedAt: new Date().toISOString(),
  };
}

// ------------------------------------------------------------ commits

export async function listCommits({ skip = 0, limit = 10, query = "", workspace = WORKSPACE } = {}) {
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

export async function buildCommitDiff(ref, { workspace = WORKSPACE } = {}) {
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
    runGit(["status", "--porcelain=v1", "-z"]),
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
  if (worktreeWatcher) return;
  try {
    worktreeWatcher = fs.watch(WORKSPACE, { recursive: true }, onFsEvent);
    worktreeWatcher.on("error", () => {});
  } catch {
    /* recursive watch unsupported — panel still has its refresh button */
  }
  try {
    gitWatcher = fs.watch(path.join(WORKSPACE, ".git"), { recursive: true }, onFsEvent);
    gitWatcher.on("error", () => {});
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
      "Get the live diff of the session workspace as structured JSON: per-file path, status, added/deleted counts and unified patch. Opens the Diff Ask panel, where the user can also press '+' on any diff line to ask about that exact line. Modes: working (default, git diff HEAD + untracked), unpushed (everything a push would send plus local changes, vs @{upstream}), last-turn (changes since the last turn marker 📸).",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["working", "unpushed", "last-turn"],
          default: "working",
          description: "Which changes to diff: working (vs HEAD), unpushed (vs @{upstream}), last-turn (vs the turn snapshot).",
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
    name: "mark_turn_snapshot",
    description:
      "Mark the current workspace state as the 'last turn' baseline (📸). The Diff Ask panel does this automatically before sending each batch of questions; call this only when the user explicitly asks to mark/save the current state as the turn baseline.",
    inputSchema: { type: "object", properties: {} },
  },
];

const RESOURCES = [
  { uri: PANEL_URI, name: "panel", mimeType: "text/html;profile=mcp-app" },
  { uri: DIFF_URI, name: "workspace-diff", mimeType: "application/json" },
  { uri: "diff://workspace?mode=unpushed", name: "workspace-diff-unpushed", mimeType: "application/json" },
  { uri: "diff://workspace?mode=last-turn", name: "workspace-diff-last-turn", mimeType: "application/json" },
  { uri: "log://commits", name: "commits", mimeType: "application/json" },
];

function uriDiffData(uri) {
  const u = new URL(uri);
  if (u.protocol === "diff:") {
    if (u.host === "workspace") {
      const mode = u.searchParams.get("mode") ?? "working";
      if (mode === "last-turn") return buildLastTurnDiff();
      return buildDiff({ mode: mode === "unpushed" ? "unpushed" : "working" });
    }
    if (u.host === "commit") {
      const ref = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
      return buildCommitDiff(ref);
    }
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
            mode: params.arguments?.mode === "unpushed" || params.arguments?.mode === "last-turn"
              ? params.arguments.mode
              : "working",
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
        case "mark_turn_snapshot":
          data = await markTurnSnapshot();
          return {
            structuredContent: data,
            content: [{ type: "text", text: data.ok ? `📸 Marcador de turno guardado (${data.at}).` : data.message }],
          };
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
