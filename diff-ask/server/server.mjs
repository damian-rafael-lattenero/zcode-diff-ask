#!/usr/bin/env node
// diff-ask MCP server — stdio, Node stdlib only.
//
// Serves:
//   ui://diff-ask/panel.html        → the Diff Ask panel (built by ui/build.mjs)
//   diff://workspace                → live JSON diff of the session workspace
//                                     (git diff HEAD + untracked; the payload
//                                     also carries upstream/ahead/behind for
//                                     the panel's header chips)
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
// Mega commits (upstream-sync merges with thousands of files): with no caps,
// enriching before/after cost 2 git-shows PER file SERIALLY — a 5103-file
// merge meant ~10k spawns and a panel hung for minutes. With these: content
// only for the first N files (bounded pool), the rest rides the patch map
// (ONE capped-output git diff), and the file list is pruned in the payload.
const MAX_CONTENT_FILES = 250;
const MAX_LIST_FILES = 600;
const ENRICH_CONCURRENCY = 12;
// Cap on captured git stdout (a mega-merge `git diff` can dump tens of MB —
// buffering it all is pointless: the patch budget prunes it anyway).
const GIT_OUT_CAP = 4_000_000;
// Every git read is bounded (audit wave 5): an index lock or a filesystem
// stall must fail the read, never hang the MCP tool call.
const GIT_TIMEOUT_MS = 30_000;
// The turn-path git reads share a bounded pool (audit wave 5): serial issue
// made an N-commit turn cost N× the latency.
const TURN_GIT_POOL = 4;
// Exported for the unit tests (tests/server-mega-commit.test.mjs).
export {
  MAX_CONTENT_FILES, MAX_LIST_FILES, ENRICH_CONCURRENCY, GIT_OUT_CAP,
};
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

export function runGit(args, { cwd = activeWorkspace, expectDiffExit = false, maxOut = Infinity, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const p = spawn("git", ["-C", cwd, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let capped = false;
    let timedOut = false;
    // Bounded (audit wave 5): a git stuck on an index lock or a filesystem
    // stall used to hang the whole MCP tool call — the timeout kills it and
    // the caller sees an honest failure instead of a dead panel.
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          p.kill("SIGKILL");
        }, timeoutMs)
      : null;
    timer?.unref?.();
    p.stdout.on("data", (d) => {
      if (capped) return; // already killed: don't keep buffering past the cap
      out += d;
      if (out.length > maxOut) {
        capped = true;
        p.kill();
      }
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, out: "", err: "git binary not found" });
    });
    p.on("close", (code) => {
      if (timer) clearTimeout(timer);
      // capped: we killed it on purpose — the captured output is still valid.
      const ok = !timedOut && (capped || code === 0 || (expectDiffExit && code === 1));
      const reason = timedOut ? `${err} (timeout ${timeoutMs} ms)`.trim() : err;
      resolve({ ok, out, err: reason, capped, timedOut });
    });
  });
}

// Bounded-concurrency map over a list: at most `limit` fn() calls in flight
// (worker pool, not chunked batches — a slow item doesn't stall its chunk
// neighbours). The shared `next` cursor is safe: check+increment has no await
// between them, so it's atomic in the event loop.
export async function mapPool(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    })(),
  );
  await Promise.all(workers);
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

// Contenido utf8 de un archivo (o null si no existe / binario / muy grande).
// NUL check: Buffer first, so a binary file never rides the JSON payload as
// mojibake (tracked binaries get flagged by numstat later; files outside git
// only have this guard).
function readAbsFile(abs) {
  try {
    const buf = fs.readFileSync(abs);
    if (buf.length > CONTENT_LIMIT || buf.includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

// Contenido actual del archivo de trabajo (o null si no existe / muy grande).
function readWorkFile(p, cwd) {
  return readAbsFile(path.join(cwd, p));
}

// The heart shared by every "vs a base" mode: file list in (name-status +
// untracked), out each one with before/after (if it fits the budget) or a
// fallback -U10 patch, plus added/deleted/binary.
export async function enrichFiles({ entries, numstat, getBefore, getAfter, buildPatches, cwd }) {
  let truncated = false;
  let budget = MAX_PATCH_BYTES;
  // First, full content (before/after) for the first MAX_CONTENT_FILES
  // non-binary files, with a bounded pool: the panel diffs locally with 10
  // context lines and expandable separators. Patch is the fallback. The cap
  // keeps a mega commit from costing one spawn pair per file.
  const targets = entries.filter((f) => !f.binary).slice(0, MAX_CONTENT_FILES);
  await mapPool(targets, ENRICH_CONCURRENCY, async (f) => {
    const before = f.status === "A" || f.status === "?" ? null : await getBefore(f);
    const after = f.status === "D" ? null : await getAfter(f);
    if (before !== null || after !== null) {
      const cost = (before?.length ?? 0) + (after?.length ?? 0);
      if (cost <= budget) {
        f.before = before ?? "";
        f.after = after ?? "";
        budget -= cost;
      } else {
        truncated = true;
      }
    }
  });
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

// Bound the payload AND the panel render: beyond MAX_LIST_FILES the entries
// themselves are pruned (the totals still live in fileCount). Marks truncated
// so the panel shows its "diff too big" banner.
function pruneList(files, truncated) {
  if (files.length <= MAX_LIST_FILES) return { files, truncated };
  return { files: files.slice(0, MAX_LIST_FILES), truncated: true };
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
  // REALPATH (audit wave 5): the panel keys its watchers, URIs and diff roots
  // off ONE canonical path — a symlinked workspace used to make the watchers
  // and the git CWD disagree about which tree is being diffed.
  let real;
  try {
    real = fs.realpathSync(p);
  } catch {
    return { error: "invalid_path", message: `No existe: ${p}` };
  }
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: real });
  if (!inside.ok)
    return { error: "not_a_repo", message: `${real} no es un repositorio git. Diff Ask necesita git.` };
  activeWorkspace = real;
  lastSig = null; // el próximo cálculo de firma difiere → notifica y refresca
  worktreeWatcher?.close();
  gitWatcher?.close();
  worktreeWatcher = null;
  gitWatcher = null;
  if (subs.size) ensureWatchers();
  ensureInboxWatcher();
  log(`workspace activo → ${real}`);
  return { ok: true, workspace: real };
}

// Lista los repos git LOCALES bajo una carpeta (chip 📁 del panel — spec
// Damian 28/10: "un pequeño árbol que pueda ir para arriba y me filtre solo
// las carpetas que tengan .git"). Recursivo con tope de profundidad y
// SKIP de pesadas (node_modules, Library, hidden dirs — except .worktrees):
// parado en ~/Projects
// ves TODOS tus repos de una. Un repo puede contener sub-repos: se sigue
// bajando igual. Tope de resultados para no colgar la UI en árboles raros.
const GIT_WALK_SKIP = new Set([
  "node_modules", "Library", "Caches", ".Trash", "Application Support",
  "vendor", "target", "build", "dist", "out", "venv", ".venv", "__pycache__",
  "Coverage", "DerivedData",
]);
// Hidden dirs are skipped EXCEPT these worktree containers: ZCode's agent
// convention is <parent>/.worktrees/<repo>-<slug> and a worktree's .git is a
// FILE (handled below), so without this exception the picker never shows them
// (Damian 13/11: "no se ven los de las carpetas ocultas").
const GIT_WALK_HIDDEN_OK = new Set([".worktrees"]);
export function listGitProjects(input, maxDepth = 4, maxResults = 400) {
  const under = path.resolve(String(input ?? "").trim().replace(/^~(?=\/|$)/, os.homedir()));
  let stats;
  try {
    stats = fs.statSync(under);
  } catch {
    return { error: "invalid_path", message: `No existe: ${under}`, repos: [] };
  }
  if (!stats.isDirectory()) return { error: "invalid_path", message: `No es una carpeta: ${under}`, repos: [] };
  const repos = [];
  const walk = (dir, depth) => {
    if (repos.length >= maxResults) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // sin permiso / desmontada: silencio
    }
    for (const ent of entries) {
      if (repos.length >= maxResults) return;
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith(".") && !GIT_WALK_HIDDEN_OK.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      try {
        // .git puede ser dir (repo normal) o archivo (worktree/submodule)
        if (fs.statSync(path.join(p, ".git")).isFile() || fs.statSync(path.join(p, ".git")).isDirectory()) {
          // repos living inside a hidden worktree container (the agent
          // .worktrees) get flagged with the CONTAINER NAME so the panel can
          // surface them FIRST with a tag, whatever folder the picker is
          // rooted at (Damian 14/11: they were there but nobody could spot
          // them). Absolute-path check: the flag does not depend on `under`.
          const wtSeg = p.split(path.sep).find((seg) => seg.startsWith(".") && GIT_WALK_HIDDEN_OK.has(seg));
          const repo = { path: p, name: ent.name, depth };
          if (wtSeg) repo.worktree = wtSeg;
          repos.push(repo);
        }
      } catch { /* sin .git */ }
      if (depth + 1 < maxDepth && !GIT_WALK_SKIP.has(ent.name)) walk(p, depth + 1);
    }
  };
  walk(under, 0);
  repos.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name));
  return { ok: true, under, repos };
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
// Working tree vs HEAD (the "unpushed" mode was removed in 0.10.0 — the
// unpushed VIEW too; what survives is the upstream/ahead/behind info riding
// every payload so the panel's working header can show its ↑/↓ chips).
// Tracked files come from `git diff --name-status -M HEAD` (renames included)
// plus untracked from porcelain.
export async function buildDiff({ includePatches = true, workspace = activeWorkspace } = {}) {
  const ws = workspace;
  const meta = await repoMeta(ws);
  if (!meta.inside)
    return {
      error: "not_a_repo",
      message: `El workspace no es un repositorio git (${ws}). Diff Ask necesita git.`,
      workspace: ws,
    };

  const base = "HEAD";
  const baseLabel = "HEAD";
  const upstream = await resolveUpstream(ws);
  let ahead;
  let behind;
  if (upstream) {
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
          const map = splitPatch((await runGit(["diff", base, "--no-color", "-U10"], { cwd: ws, maxOut: GIT_OUT_CAP })).out);
          // Untracked files need a per-file --no-index diff: pool them too (a
          // sea of untracked files was the same serial-spawn trap).
          await mapPool(untracked, ENRICH_CONCURRENCY, async (f) => {
            const r = await runGit(
              ["diff", "--no-index", "--no-color", "-U10", "--", "/dev/null", f.path],
              { cwd: ws, expectDiffExit: true },
            );
            for (const [k, v] of splitPatch(r.out)) map.set(k, v);
          });
          return map;
        }
      : null,
    cwd: ws,
  });

  const pruned = pruneList(files, truncated);
  return {
    workspace: ws,
    branch: meta.branch,
    head: meta.head,
    mode: "working",
    baseLabel,
    upstream,
    ahead,
    behind,
    dirty: files.length > 0,
    truncated: pruned.truncated,
    fileCount: files.length,
    files: pruned.files,
    generatedAt: new Date().toISOString(),
  };
}

// --------------------------------------------------------------- turnos (v2)
// A TURN = one prompt→stop window of a ZCode session. The app's hook system
// taps both boundaries into turn-events.jsonl (UserPromptSubmit writes
// {"type":"prompt",...}, Stop writes {"type":"stop","reply":...}; both carry
// sid + cwd). While a turn is open this server accumulates every path touched
// on the machine (recursive FSEvents over $HOME — measured ~17 ev/s with
// negligible CPU) and at Stop groups them by enclosing git repo: the commits
// made DURING the window (agents commit per unit — often in .worktrees of
// other repos) plus whatever stayed dirty at the end. One JSON per turn in
// <state>/turns2/, global across sessions; the panel lists turns newest-first
// with the prompt + the agent's reply summary.
// Overridable (tests point at a tmp): ZCODE_DIFF_ASK_STATE=/tmp/x
const DA_STATE_DIR = process.env.ZCODE_DIFF_ASK_STATE || path.join(os.homedir(), ".zcode", "diff-ask");
const TURN_INBOX = path.join(DA_STATE_DIR, "turn-events.jsonl");
const TURNS2_DIR = path.join(DA_STATE_DIR, "turns2");
const PROMPT_MAX = 100_000; // paranoia: prompts gigantes se recortan
const REPLY_MAX = 8_000;
const MAX_TURN_COMMITS = 40;
const MAX_TURN_OUTSIDE = 300;
const MAX_TURN_DIRTY = 300; // per repo, after the noise filter
// Repo label (and panel group header) for files touched OUTSIDE any git repo.
// The panel renders this group as "Fuera de git" — keep both sides in sync.
const OUTSIDE_LABEL = "~";

function wsKey(ws) {
  return createHash("sha1").update(ws).digest("hex").slice(0, 16);
}

// ---- event parsing (pure; exported for tests) -------------------------
// One inbox line → a tagged event. New shape: {type:"prompt"|"stop", sid,
// cwd, prompt|reply, at}. Legacy lines ({workspace, prompt, at, source},
// written by the Telegram bot) parse as a prompt so that path keeps working.
export function parseTurnEvent(line) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (!e || typeof e !== "object") return null;
  const atMs = Date.parse(String(e.at ?? "").trim());
  if (!Number.isFinite(atMs)) return null;
  const sid = String(e.sid ?? e.session_id ?? "").trim();
  const cwd = String(e.cwd ?? e.workspace ?? "").trim();
  if (e.type === "stop")
    return { type: "stop", sid, cwd, reply: String(e.reply ?? e.last_assistant_message ?? ""), atMs };
  const prompt = String(e.prompt ?? "");
  if (!prompt) return null;
  return { type: "prompt", sid, cwd, prompt, atMs };
}

// ---- touched-path noise filter (pure; exported) -----------------------
// Paths are relative to $HOME. Build dirs, caches, dependency trees and the
// server's own state/logs would drown the turn; .git internals are handled
// separately (they mark the repo as "commits to scan").
export function isTapNoise(rel) {
  const p = String(rel ?? "").replaceAll("\\", "/");
  return (
    /(^|\/)(Library|\.Trash|Caches|\.cache|node_modules|\.venv|venv|__pycache__|\.next|DerivedData|\.gradle|\.m2|target\/debug|target\/release)(\/|$)/.test(p) ||
    /\.(log|lock|tmp|swp|swo|sqlite-wal|sqlite-shm)$/.test(p) ||
    p.startsWith(".zcode/diff-ask/") || // the tap's own state (avoid self-feedback)
    // Derived install copies (0.10.6): marketplace/cache/registry mirrors of
    // plugin repos — every session's install writes them, so machine-wide
    // capture leaked them into EVERY open task's turn. The source-of-truth
    // repo files are captured by the owning session via its own workspace.
    p.startsWith(".zcode/cli/plugins/") ||
    p.startsWith(".zcode/cli/log/") ||
    p.startsWith(".zcode/cli/db/") ||
    p.startsWith(".zcode/cli/exec/") ||
    p.startsWith(".zcode/agent-brain/") ||
    p.startsWith(".zcode/hooks/logs/")
  );
}

// ---- live turn collector ------------------------------------------------
// While a turn is open every FSEvent under $HOME lands here (filtered); at
// Stop the set is grouped by enclosing git repo. Repo roots are cached per
// directory to keep the walk cheap.
const repoRootCache = new Map();

export function repoRootOf(absPath) {
  let dir = String(absPath ?? "");
  const seen = [];
  while (dir && dir !== path.dirname(dir)) {
    if (repoRootCache.has(dir)) {
      const root = repoRootCache.get(dir);
      for (const d of seen) repoRootCache.set(d, root);
      return root;
    }
    seen.push(dir);
    try {
      if (fs.existsSync(path.join(dir, ".git"))) {
        for (const d of seen) repoRootCache.set(d, dir);
        return dir;
      }
    } catch { /* unreadable dir: keep walking up */ }
    dir = path.dirname(dir);
  }
  for (const d of seen) repoRootCache.set(d, null);
  return null;
}

let tapWatcher = null;
const tapTouched = new Map(); // ABSOLUTE path -> last touch ms (attribution of the "~" group)
const tapGitRoots = new Set(); // repos whose .git changed (commits happen here)
let openTurn = null; // { sid, cwd, prompt, startMs, reply?, stopMs? }

// The session's TERRITORY (0.10.6, Damian: "solo de la sesion/task"): the
// workspace tree, the agent-worktree containers, and ~/.zcode (session
// state — plans, memories). Writes anywhere else on the machine belong to
// other tasks or daemons and are NEVER captured, so they cannot leak into
// another task's turn.
function inTerritory(abs) {
  const cwd = openTurn?.cwd;
  if (cwd) {
    const root = repoRootOf(cwd) ?? cwd;
    if (abs === root || abs.startsWith(root + path.sep)) return true;
  }
  if (abs.startsWith(os.homedir() + path.sep + ".zcode" + path.sep)) return true;
  if (abs.includes(`${path.sep}.worktrees${path.sep}`)) return true;
  return false;
}

// Accepts an absolute path or one relative to $HOME (the watcher's form).
// Exported so tests can inject paths without a real FSEvents stream.
export function noteTapPath(raw) {
  if (!openTurn || !raw) return;
  const p = String(raw);
  const abs = path.isAbsolute(p) ? p : path.join(os.homedir(), p);
  const home = os.homedir();
  const gitAt = abs.indexOf(`${path.sep}.git${path.sep}`);
  if (gitAt >= 0 || abs.endsWith(`${path.sep}.git`)) {
    const root = gitAt >= 0 ? abs.slice(0, gitAt) : abs.slice(0, -5);
    // A commit marker counts only inside our territory (a foreign repo's
    // .git is another task's business).
    if (root && inTerritory(root)) tapGitRoots.add(root);
    return;
  }
  const noiseTarget = abs.startsWith(home + path.sep) ? path.relative(home, abs) : abs;
  if (isTapNoise(noiseTarget)) return;
  if (!inTerritory(abs)) return;
  if (tapTouched.size < 5000) tapTouched.set(abs, Date.now());
}

function ensureTapWatcher() {
  if (tapWatcher) return;
  try {
    tapWatcher = fs.watch(os.homedir(), { recursive: true }, (_evt, file) => noteTapPath(String(file ?? "")));
    tapWatcher.on("error", () => { tapWatcher?.close(); tapWatcher = null; });
    tapWatcher.unref?.();
  } catch {
    /* no FSEvents: the turn still records its cwd repo commits/dirty */
  }
}

// Current touched set, exported for tests and for the live diff.
export function tapSnapshot() {
  return { touched: [...tapTouched.entries()], gitRoots: [...tapGitRoots] };
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
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    const ev = parseTurnEvent(line);
    if (!ev) continue;
    if (ev.type === "prompt") await onTurnPrompt(ev);
    else await onTurnStop(ev);
  }
}

async function onTurnPrompt(ev) {
  // Foreign prompts are not ours to bound (0.10.1): every server sees the
  // GLOBAL inbox, so without this gate another session's prompt would mark
  // THIS session's open turn as interrupted in the shared store. With no
  // known session (CLI/tests/rig) the old global behavior applies.
  const sid = currentSid();
  if (sid && ev.sid && ev.sid !== sid) return;
  // a new prompt supersedes an unfinished turn (persisted as interrupted) —
  // but a ZOMBIE window (older than the open cap) is silently dropped: it is
  // not a real interruption and persisting it spams interrupted records with
  // stoppedAt=now (measured tonight: October windows re-written as chains).
  if (openTurn && Date.now() - openTurn.startMs <= TURN_OPEN_MAX_MS) {
    await finalizeOpenTurn({ interrupted: true });
  }
  openTurn = null;
  openTurn = { sid: ev.sid, cwd: ev.cwd, prompt: ev.prompt.slice(0, PROMPT_MAX), startMs: ev.atMs };
  tapTouched.clear();
  tapGitRoots.clear();
  ensureTapWatcher();
  log(`turno abierto (${ev.sid.slice(0, 8)}): "${ev.prompt.slice(0, 50)}"`);
}

async function onTurnStop(ev) {
  if (!openTurn) return; // stop without a prompt in this server life: nothing to bound
  if (openTurn.sid && ev.sid && ev.sid !== openTurn.sid) return; // another session's stop
  const sid = currentSid();
  if (sid && ev.sid && ev.sid !== sid) return; // foreign stop: this server never opened that turn
  openTurn.reply = String(ev.reply ?? "").slice(0, REPLY_MAX);
  openTurn.stopMs = Math.max(ev.atMs, openTurn.startMs + 1);
  await finalizeOpenTurn({ interrupted: false });
}

// ---- session timeline (whose cwd was active when) ------------------------
// The $HOME-wide tap is machine-global: with several tasks open at once,
// EVERY server's open turn used to claim every write — another task's
// Turnos showed diff-ask files that a DIFFERENT session was editing
// (Damian 22/11: "que atraiga hacia sí los cambios solo de la sesion/task").
// Attribution rule: a repo that is the CWD of a DIFFERENT top-level session
// whose turn was OPEN during this window is THAT session's work — excluded
// here. Child sessions (sess_subagent_*, sess_workflow_*) never claim:
// their worktrees belong to the parent task's story. The timeline parses
// the global inbox ONCE per change (size+mtime cached).
let inboxTimelineCache = null; // { key, intervals }

function inboxTimeline() {
  let key = "missing";
  try {
    const st = fs.statSync(TURN_INBOX);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return [];
  }
  if (inboxTimelineCache?.key === key) return inboxTimelineCache.intervals;
  const openBySid = new Map(); // sid -> {sid, cwd, startMs}
  const intervals = [];
  let data = "";
  try {
    data = fs.readFileSync(TURN_INBOX, "utf8");
  } catch { /* sin inbox */ }
  for (const line of data.split("\n")) {
    if (!line.trim()) continue;
    const ev = parseTurnEvent(line);
    if (!ev || !ev.sid) continue;
    if (ev.type === "prompt") {
      const prev = openBySid.get(ev.sid);
      if (prev) intervals.push({ ...prev, endMs: ev.atMs - 1 });
      openBySid.set(ev.sid, { sid: ev.sid, cwd: ev.cwd, startMs: ev.atMs });
    } else {
      const prev = openBySid.get(ev.sid);
      if (prev) {
        openBySid.delete(ev.sid);
        intervals.push({ ...prev, endMs: ev.atMs });
      }
    }
  }
  for (const open of openBySid.values()) intervals.push({ ...open, endMs: null }); // still open
  inboxTimelineCache = { key, intervals };
  return intervals;
}

const CHILD_SESSION_PREFIXES = ["sess_subagent_", "sess_workflow_"];

// Timeline staleness cap: a prompt without a stop older than this is a
// ZOMBIE window (a server that died mid-turn — October windows were still
// "open" today, polluting every overlap computation). After the cap the
// interval no longer overlaps anything.
const TURN_OPEN_MAX_MS = 2 * 60 * 60 * 1000;

// CWDs of OTHER top-level sessions whose turn overlapped [startMs, stopMs].
function foreignCwds(sid, startMs, stopMs) {
  const out = new Set();
  for (const iv of inboxTimeline()) {
    if (!iv.cwd || iv.sid === sid) continue;
    if (CHILD_SESSION_PREFIXES.some((p) => iv.sid.startsWith(p))) continue;
    const end = Math.min(iv.endMs ?? Number.MAX_SAFE_INTEGER, iv.startMs + TURN_OPEN_MAX_MS);
    if (iv.startMs <= stopMs && end >= startMs) out.add(iv.cwd);
  }
  return out;
}

// Was ANOTHER top-level session's turn open at instant `ms`? (Attribution of
// the outside-git group: a loose file touched inside someone else's open
// window is their write.)
function foreignActiveAt(mySid, ms) {
  for (const iv of inboxTimeline()) {
    if (!iv.cwd || iv.sid === mySid) continue;
    if (CHILD_SESSION_PREFIXES.some((p) => iv.sid.startsWith(p))) continue;
    const end = Math.min(iv.endMs ?? Number.MAX_SAFE_INTEGER, iv.startMs + TURN_OPEN_MAX_MS);
    if (iv.startMs <= ms && ms <= end) return true;
  }
  return false;
}

// Reads everything a turn touched: per repo, the commits made in the window
// and the dirty state left at the end. Shared by finalize and the live view.
async function collectTurnChanges({ sid = "", cwd, startMs, stopMs, touched, gitRoots }) {
  // Cross-session attribution: another task's live repo is theirs, not ours.
  const foreignRoots = new Set(
    [...foreignCwds(sid, startMs - 2000, stopMs + 2000)].map((c) => repoRootOf(c)).filter(Boolean),
  );
  const home = os.homedir();
  const repos = new Map(); // root -> Set(rel)
  const outside = [];
  for (const [abs, ts] of touched) {
    const root = repoRootOf(abs);
    if (!root) {
      // "~" group attribution (0.10.6): a loose file whose LAST touch fell
      // inside ANOTHER top-level session's open interval is that session's
      // write — not ours.
      if (foreignActiveAt(sid, ts)) continue;
      outside.push(abs.startsWith(home + path.sep) ? path.relative(home, abs) : abs);
      continue;
    }
    if (foreignRoots.has(root)) continue; // territory rule missed it; timeline owns it
    if (!repos.has(root)) repos.set(root, new Set());
    repos.get(root).add(path.relative(root, abs));
  }
  for (const root of gitRoots) {
    if (!repos.has(root) && fs.existsSync(root)) repos.set(root, new Set());
  }
  const cwdRoot = cwd ? repoRootOf(cwd) : null;
  if (cwdRoot && !repos.has(cwdRoot)) repos.set(cwdRoot, new Set());
  // ...unless another task OWNS that repo (its cwd, its turn open): drop it.
  for (const root of [...repos.keys()]) if (foreignRoots.has(root)) repos.delete(root);

  const sinceIso = new Date(startMs - 2000).toISOString();
  const untilIso = new Date(stopMs + 2000).toISOString();
  const out = [];
  for (const [root, relSet] of repos) {
    const commitsR = await runGit(
      ["log", "--all", `--since=${sinceIso}`, `--until=${untilIso}`, "-n", String(MAX_TURN_COMMITS), `--format=${LOG_FMT}`],
      { cwd: root },
    );
    const commits = (commitsR.ok && commitsR.out.trim() ? commitsR.out.trim().split("\n") : [])
      .map(parseLogLine)
      .filter(Boolean);
    const stR = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root });
    // Repos can hold THOUSANDS of untracked junk files (node_modules without a
    // .gitignore — Damian's 2052-file turn). The same noise rules as the tap
    // apply to the dirty list, and a hard cap keeps any repo bounded; the
    // hidden count travels so nothing is silently lost.
    const allDirty = parsePorcelainZ(stR.out).map((f) => ({
      path: f.path,
      status: f.status,
      ...(f.oldPath ? { oldPath: f.oldPath } : {}),
    }));
    const dirty = allDirty.filter((f) => !isTapNoise(f.path)).slice(0, MAX_TURN_DIRTY);
    const dirtyHidden = allDirty.length - dirty.length;
    if (!commits.length && !dirty.length && !relSet.size) continue;
    out.push({
      path: root,
      label: path.basename(root),
      commits,
      dirty,
      ...(dirtyHidden > 0 ? { dirtyHidden } : {}),
    });
  }
  return { repos: out, outside: outside.slice(0, MAX_TURN_OUTSIDE) };
}

// One touched path OUTSIDE any git repo → its turn-diff entry. The tap's
// recorded paths are untrusted boundary data: they parse ONCE here (fp-kb
// parse-don't-validate) into a shape the rest of the pipeline never re-checks.
// Live files ride ALL-GREEN (status "?" — the pre-turn content is unknowable
// without git), vanished ones ride a content-less note. `home` is injectable
// for tests. Returns null only for empty paths.
export function outsideEntry(raw, home = os.homedir()) {
  const p = String(raw ?? "");
  if (!p) return null;
  // "~/x" is the STORED form (home-relative key): resolve to the real abs —
  // joining home + "~/x" produced home/"~"/x (nonexistent), marking LIVE
  // home files as gone and breaking focus resolution.
  const abs = path.isAbsolute(p)
    ? p
    : p.startsWith("~/")
      ? path.join(home, p.slice(2))
      : path.join(home, p);
  const key = abs.startsWith(home + path.sep) ? `~/${path.relative(home, abs)}` : abs;
  let gone = true;
  try {
    gone = !fs.statSync(abs).isFile();
  } catch { /* gone: created+deleted inside the window, or never a file */ }
  return {
    status: gone ? "D" : "?",
    path: key,
    repoLabel: OUTSIDE_LABEL,
    repo: home,
    note: gone ? "borrado en el turno (fuera de git)" : "fuera de git",
    ...(gone ? { gone: true } : {}),
    _src: { outside: true, abs },
  };
}

async function finalizeOpenTurn({ interrupted }) {
  const t = openTurn;
  openTurn = null;
  if (!t) return null;
  const stopMs = t.stopMs ?? Date.now();
  const snap = tapSnapshot();
  tapTouched.clear();
  tapGitRoots.clear();
  const { repos, outside } = await collectTurnChanges({
    sid: t.sid,
    cwd: t.cwd,
    startMs: t.startMs,
    stopMs,
    touched: snap.touched,
    gitRoots: snap.gitRoots,
  });
  const rec = {
    // Deterministic per prompt window (0.10.2): keyed by startMs — a window
    // re-finalized by a restart race OVERWRITES the same file instead of
    // piling duplicate records (legacy stopMs-keyed ids never collided).
    id: `${t.startMs.toString(36)}-${(t.sid || "x").slice(0, 8)}`,
    sid: t.sid,
    workspace: t.cwd,
    prompt: t.prompt,
    reply: t.reply ?? "",
    startedAt: new Date(t.startMs).toISOString(),
    stoppedAt: new Date(stopMs).toISOString(),
    ...(interrupted ? { interrupted: true } : {}),
    repos,
    outside,
  };
  try {
    fs.mkdirSync(TURNS2_DIR, { recursive: true });
    // A zombie's interrupted supersede must never regress a COMPLETED turn
    // (the real stop may have landed first on another process).
    const existing = readTurnFiles().find((r) => r.id === rec.id);
    if (existing && !existing.interrupted && interrupted) {
      log(`turno ${rec.id}: finalize interrumpido ignorado (ya está completado)`);
      return existing;
    }
    fs.writeFileSync(path.join(TURNS2_DIR, `${rec.id}.json`), JSON.stringify(rec));
    turnStoreCache = null; // our own write invalidates the cache
  } catch {
    return null;
  }
  log(`turno ${rec.id}: ${repos.length} repo(s), ${repos.reduce((n, r) => n + r.commits.length, 0)} commit(s), ${outside.length} fuera de git`);
  for (const uri of subs) sendNotification("notifications/resources/updated", { uri });
  return rec;
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

// ---- turn store (one JSON per turn, global across sessions) --------------
// The store grows unbounded (4951 files / 73 MB measured 22/11): parsing it
// on EVERY read (~1.1 s synchronous) wedged the single-threaded server —
// tool calls queued behind each other and the panel's buttons froze. Cache
// the parsed records; re-parse only when the directory actually changes
// (mtime + file count + last name — cheap to check, correct for appends,
// deletes and the atomic rm of clearTurns).
let turnStoreCache = null; // { key, recs }

function turnStoreKey() {
  let st;
  try {
    st = fs.statSync(TURNS2_DIR);
  } catch {
    return "missing";
  }
  let names = [];
  try {
    names = fs.readdirSync(TURNS2_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    return `broken:${st.mtimeMs}`;
  }
  return `${st.mtimeMs}:${names.length}:${names.length ? names[names.length - 1] : ""}`;
}

function readTurnFiles() {
  const key = turnStoreKey();
  if (turnStoreCache?.key === key) return turnStoreCache.recs;
  let names = [];
  try {
    names = fs.readdirSync(TURNS2_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    names = [];
  }
  const out = [];
  for (const n of names) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(TURNS2_DIR, n), "utf8"));
      if (rec && rec.id) out.push(rec);
    } catch { /* turno corrupto: se ignora */ }
  }
  // Dedupe by (sid, startedAt) (0.10.2): restart/deploy races finalized the
  // SAME prompt window more than once and legacy ids (stopMs-keyed) never
  // collided — the panel showed "Es asi:" three times, most copies stamped
  // interrupted with empty replies. Prefer the completed record; ties → the
  // latest stoppedAt.
  const byKey = new Map();
  for (const rec of out) {
    const k = `${String(rec.sid ?? "")}|${String(rec.startedAt ?? "")}`;
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, rec);
      continue;
    }
    const better =
      (!rec.interrupted && prev.interrupted) ||
      (Boolean(rec.interrupted) === Boolean(prev.interrupted) &&
        Date.parse(rec.stoppedAt ?? "") > Date.parse(prev.stoppedAt ?? ""));
    if (better) byKey.set(k, rec);
  }
  out.length = 0;
  out.push(...byKey.values());
  out.sort((a, b) => Date.parse(b.stoppedAt ?? "") - Date.parse(a.stoppedAt ?? ""));
  turnStoreCache = { key, recs: out };
  return out;
}

// Turns of the session this server serves (0.10.1): the session id arrives
// in _meta["com.zcode/request-context"].session_id on every tools/call
// (panel AND model calls — cached by noteRequestMeta), or via the
// ZCODE_SESSION_ID env (belt-and-braces for a future host stamp). Empty →
// global across sessions (CLI, tests, the e2e rig: unchanged behavior).
let metaSid = "";

export function noteRequestMeta(meta) {
  const sid = String(meta?.["com.zcode/request-context"]?.session_id ?? "").trim();
  if (sid) metaSid = sid;
}

export function currentSid() {
  return String(process.env.ZCODE_SESSION_ID ?? "").trim() || metaSid;
}

function sidTurns() {
  const sid = currentSid();
  if (!sid) return readTurnFiles();
  return readTurnFiles().filter((t) => String(t.sid ?? "") === sid);
}

function turnFileCount(rec) {
  let n = rec.outside?.length ?? 0;
  for (const r of rec.repos ?? []) n += (r.commits?.length ?? 0) + (r.dirty?.length ?? 0);
  return n;
}

// Builds the panel entries for a turn: every commit hunk and every dirty file
// of every repo touched in the window, namespaced as "<repo label>/<path>"
// (the panel keys sections by path, and two repos can hold the same rel path),
// then the files touched OUTSIDE any git repo (all-green group). Content rides
// the shared bounded pool (mapPool + budget via enrichFiles).
async function turnEntries(repos, outside = []) {
  const entries = [];
  const numstat = new Map();
  const seen = new Set();
  // The per-commit git reads run in the shared bounded pool (audit wave 5):
  // serial issue made an N-commit turn cost N× the latency. Fetch in
  // parallel, assemble in ORDER — the dedupe (first repo wins) and the
  // panel's section order stay byte-identical.
  const commitsOf = [];
  for (const r of repos) for (const c of r.commits ?? []) commitsOf.push({ r, c });
  const fetched = new Map();
  await mapPool(commitsOf, TURN_GIT_POOL, async ({ r, c }) => {
    // -z: parseNameStatusZ speaks NUL-separated records
    let nsR = await runGit(["diff", "--name-status", "-z", "-M", `${c.hash}^`, c.hash], { cwd: r.path });
    if (!nsR.ok) {
      nsR = await runGit(["diff", "--name-status", "-z", "-M", EMPTY_TREE, c.hash], { cwd: r.path });
    }
    const numR = await runGit(["diff", "--numstat", "-M", `${c.hash}^`, c.hash], { cwd: r.path });
    fetched.set(`${r.path}\0${c.hash}`, { nsR, nums: numstatMapOf(numR.ok ? numR.out : "") });
  });
  for (const r of repos) {
    const label = r.label ?? path.basename(r.path);
    const root = r.path;
    for (const c of r.commits ?? []) {
      const got = fetched.get(`${root}\0${c.hash}`) ?? { nsR: { ok: false, out: "" }, nums: new Map() };
      for (const f of parseNameStatusZ(got.nsR.out)) {
        const key = `${label}/${f.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({
          status: f.status, path: key,
          ...(f.oldPath ? { oldPath: `${label}/${f.oldPath}` } : {}),
          repo: root, repoLabel: label, commit: c.short, note: `commit ${c.short} · ${c.subject}`,
          _src: { commit: c.hash, rel: f.path, oldRel: f.oldPath, abs: path.join(root, f.path) },
        });
        const n = got.nums.get(f.path);
        if (n) numstat.set(key, n);
      }
    }
    for (const f of r.dirty ?? []) {
      const key = `${label}/${f.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        status: f.status, path: key,
        ...(f.oldPath ? { oldPath: `${label}/${f.oldPath}` } : {}),
        repo: root, repoLabel: label, note: "sin commitear",
        _src: { dirty: true, rel: f.path, oldRel: f.oldPath, abs: path.join(root, f.path) },
      });
    }
    // counts for the dirty side: one numstat vs HEAD per repo (untracked files
    // fall back to content-length counting inside enrichFiles)
    if ((r.dirty ?? []).length) {
      const dnR = await runGit(["diff", "--numstat", "-M", "HEAD"], { cwd: root });
      const dnums = numstatMapOf(dnR.ok ? dnR.out : "");
      for (const f of r.dirty ?? []) {
        const n = dnums.get(f.path);
        const key = `${label}/${f.path}`;
        if (n && !numstat.has(key)) numstat.set(key, n);
      }
    }
  }
  // Files OUTSIDE any git repo, LAST so their group header closes the list
  // (the panel renders the "~" group as "Fuera de git").
  for (const raw of outside) {
    const e = outsideEntry(raw);
    if (e && !seen.has(e.path)) {
      seen.add(e.path);
      entries.push(e);
    }
  }
  await enrichFiles({
    entries,
    numstat,
    getBefore: (f) =>
      f._src.outside
        ? Promise.resolve(null)
        : f._src.dirty
          ? f.status === "A" || f.status === "?"
            ? Promise.resolve(null)
            : gitShow("HEAD", f._src.oldRel ?? f._src.rel, f.repo)
          : gitShow(`${f._src.commit}^`, f._src.oldRel ?? f._src.rel, f.repo).then((c) => c ?? ""),
    getAfter: (f) =>
      f._src.outside
        ? f.gone
          ? Promise.resolve(null)
          : Promise.resolve(readAbsFile(f._src.abs))
        : f._src.dirty
          ? f.status === "D"
            ? Promise.resolve(null)
            : Promise.resolve(readWorkFile(f._src.rel, f.repo))
          : gitShow(f._src.commit, f._src.rel, f.repo).then((c) => c ?? ""),
    buildPatches: null,
    cwd: activeWorkspace,
  });
  // Outside files whose content didn't fit the budget (or is binary): no text
  // can ride — flag binary so the panel shows its honest plain-note instead of
  // an empty diff box.
  for (const f of entries) {
    if (f._src?.outside && !f.gone && f.after === undefined) f.binary = true;
  }
  return entries;
}

// ---- panel focus (the fork's end-of-turn file click) ---------------------
// The fork calls get_turn_diff { turn, focus } when the user clicks a file in
// the turn-end summary. The request parks here (TTL'd, one-shot) and resolves
// to an entry key at the next PANEL read of that turn (payload.focusPath);
// every other payload carries pendingTurnFocus so the panel switches views
// first. The tool-call build itself does NOT resolve (it would consume the
// focus before the panel ever reads it).
const FOCUS_TTL_MS = 30_000;
let pendingFocus = null; // { abs, turn, atMs } | null

export function requestTurnFocus(rawPath, turn = "latest", atMs = Date.now()) {
  const raw = String(rawPath ?? "").trim();
  if (!raw) return { ok: false, message: "focus vacío" };
  pendingFocus = {
    abs: path.resolve(raw.replace(/^~(?=\/|$)/, os.homedir())),
    turn: String(turn || "latest"),
    atMs,
  };
  for (const uri of subs) sendNotification("notifications/resources/updated", { uri });
  return { ok: true };
}

// Hint for payloads that are NOT the focused turn: the panel switches views.
// Peeks without consuming — only the focused turn's read consumes.
function peekPendingTurnFocus() {
  if (!pendingFocus) return null;
  if (Date.now() - pendingFocus.atMs > FOCUS_TTL_MS) {
    pendingFocus = null;
    return null;
  }
  return { turn: pendingFocus.turn };
}

function sameFile(a, b) {
  if (a === b) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

// Diff de un turno: "latest" = turno EN VIVO (ventana abierta hasta ahora);
// un id = turno guardado. Multi-repo: cada archivo viaja con repoLabel.
export async function buildTurnDiff(id, { workspace = activeWorkspace, resolveFocus = true } = {}) {
  let rec;
  let isLive = false;
  const sid = currentSid();
  // The live turn only serves THIS session (0.10.1); a foreign open turn is
  // someone else's "latest" — fall through to the saved per-session list.
  if (id === "latest" && openTurn && (!sid || openTurn.sid === sid)) {
    isLive = true;
    const stopMs = Date.now();
    const snap = tapSnapshot();
    const { repos, outside } = await collectTurnChanges({
      sid: openTurn.sid,
      cwd: openTurn.cwd,
      startMs: openTurn.startMs,
      stopMs,
      touched: snap.touched,
      gitRoots: snap.gitRoots,
    });
    rec = {
      id: "latest",
      workspace: openTurn.cwd,
      prompt: openTurn.prompt,
      reply: "",
      startedAt: new Date(openTurn.startMs).toISOString(),
      stoppedAt: new Date(stopMs).toISOString(),
      repos,
      outside,
    };
  } else {
    rec = sidTurns().find((t) => t.id === id) ?? null;
    if (!rec && id === "latest") {
      // sin turno abierto (de esta sesión): el último guardado de la sesión
      rec = sidTurns()[0] ?? null;
    }
    // Read-time attribution (0.10.6): records stored BEFORE the territory
    // rules carry repos captured machine-wide — drop repos that are OTHER
    // top-level sessions' cwd with overlapping windows, so old records
    // render clean without migrating the 8000-file store.
    if (rec) {
      const ivs = foreignCwds(
        String(rec.sid ?? ""),
        Date.parse(rec.startedAt ?? "") || 0,
        Date.parse(rec.stoppedAt ?? "") || Date.now(),
      );
      if (ivs.size) {
        const foreignRoots = new Set([...ivs].map((c) => repoRootOf(c)).filter(Boolean));
        if (foreignRoots.size)
          rec = { ...rec, repos: (rec.repos ?? []).filter((r) => !foreignRoots.has(r.path)) };
      }
    }
    if (!rec) {
      if (id !== "latest")
        return { error: "unknown_turn", message: `No encontré el turno "${id}".`, workspace, files: [], fileCount: 0 };
      return {
        error: "no_turns",
        message: "Todavía no hay turnos registrados. Cada mensaje en la sesión abre un turno y lo cierra al terminar la respuesta.",
        workspace,
        files: [],
        fileCount: 0,
      };
    }
  }
  const entries = await turnEntries(rec.repos ?? [], rec.outside ?? []);
  const pruned = pruneList(entries, false);
  // Focus resolution (one-shot): the click's absolute path → the entry key the
  // panel can scroll to. Consumed here so later refreshes don't re-scroll.
  let focusPath = null;
  if (resolveFocus && pendingFocus) {
    if (Date.now() - pendingFocus.atMs > FOCUS_TTL_MS) {
      pendingFocus = null;
    } else if (pendingFocus.turn === id) {
      const hit = entries.find((f) => f._src?.abs && sameFile(f._src.abs, pendingFocus.abs));
      if (hit) {
        focusPath = hit.path;
        pendingFocus = null;
      }
    }
  }
  const atLabel = String(rec.startedAt ?? "").slice(11, 16);
  const outsideCount = (rec.outside ?? []).length;
  return {
    workspace: rec.workspace || workspace,
    head: "",
    mode: "turn",
    ...(focusPath ? { focusPath } : {}),
    // The panel is reading a DIFFERENT turn than the focused one: hint the
    // switch (the focused turn's own read resolves focusPath).
    ...(resolveFocus && pendingFocus && pendingFocus.turn !== id
      ? { pendingTurnFocus: { turn: pendingFocus.turn } }
      : {}),
    turn: {
      id: rec.id,
      at: rec.startedAt,
      stoppedAt: rec.stoppedAt,
      prompt: rec.prompt,
      reply: rec.reply ?? "",
      isLive,
      interrupted: Boolean(rec.interrupted),
      repos: [
        ...(rec.repos ?? []).map((r) => ({
          label: r.label,
          path: r.path,
          commits: (r.commits ?? []).length,
          dirty: (r.dirty ?? []).length,
          ...(r.dirtyHidden ? { dirtyHidden: r.dirtyHidden } : {}),
        })),
        // The pseudo-repo for files touched outside git (header "Fuera de git").
        ...(outsideCount
          ? [{ label: OUTSIDE_LABEL, path: os.homedir(), commits: 0, dirty: 0, outside: outsideCount }]
          : []),
      ],
      outside: rec.outside ?? [],
    },
    baseLabel: `turno ${atLabel}`,
    snapshotAt: rec.startedAt,
    dirty: entries.length > 0,
    truncated: pruned.truncated,
    fileCount: entries.length,
    files: pruned.files,
    generatedAt: new Date().toISOString(),
  };
}

// ---- turn list pagination ------------------------------------------------
// 2000+ stored turns used to ride ONE payload with FULL prompts — megabytes
// per reactive read, the panel choked. Now: newest first (live turn on top),
// slices of `limit` + hasMore, and summaries are PREVIEWS (first line, capped)
// — the full prompt lives in the turn's diff payload (buildTurnDiff).
const TURN_PAGE = 20;
const TURN_PREVIEW_MAX = 300;

export function listTurns({ skip = 0, limit = TURN_PAGE } = {}) {
  const sid = currentSid();
  const recs = sidTurns();
  // The live turn only belongs to this view when it is THIS session's turn.
  const live = openTurn && (!sid || openTurn.sid === sid) ? openTurn : null;
  const total = recs.length + (live ? 1 : 0);
  const from = Math.max(0, Math.min(Number(skip) || 0, total));
  const lim = Math.max(1, Math.min(Number(limit) || TURN_PAGE, 100));
  const preview = (s) => String(s ?? "").split("\n")[0].slice(0, TURN_PREVIEW_MAX);
  const at = (i) => {
    if (live && i === 0)
      return {
        id: "latest",
        at: new Date(openTurn.startMs).toISOString(),
        stoppedAt: "",
        prompt: preview(openTurn.prompt),
        reply: "",
        workspace: openTurn.cwd,
        repoCount: 0,
        fileCount: 0,
        isLive: true,
        interrupted: false,
      };
    const t = recs[i - (live ? 1 : 0)];
    return {
      id: t.id,
      at: t.startedAt,
      stoppedAt: t.stoppedAt,
      prompt: preview(t.prompt),
      reply: preview(t.reply),
      workspace: t.workspace,
      repoCount: (t.repos ?? []).length,
      fileCount: turnFileCount(t),
      isLive: false,
      interrupted: Boolean(t.interrupted),
    };
  };
  const turns = [];
  for (let i = from; i < total && turns.length <= lim; i++) turns.push(at(i));
  const hasMore = turns.length > lim;
  // sessionFilter: the panel renders "· esta task" when non-null (0.10.1).
  return { count: total, skip: from, limit: lim, hasMore, sessionFilter: sid || null, turns: turns.slice(0, lim) };
}

export function deleteTurn(id, { workspace = activeWorkspace } = {}) {
  const rec = sidTurns().find((t) => t.id === id);
  if (!rec) return { error: "unknown_turn", message: `No encontré el turno "${id}".` };
  try {
    fs.rmSync(path.join(TURNS2_DIR, `${rec.id}.json`), { force: true });
  } catch { /* ya no está */ }
  return { ok: true, remaining: sidTurns().length };
}

export function clearTurns({ workspace = activeWorkspace } = {}) {
  const sid = currentSid();
  if (!sid) {
    try {
      fs.rmSync(TURNS2_DIR, { recursive: true, force: true });
    } catch { /* nada que borrar */ }
    turnStoreCache = null;
    return { ok: true, remaining: 0 };
  }
  // Scoped (0.10.1): the panel's "Borrar todo" is per task view — with a
  // known session it must NOT nuke every other task's history.
  let remaining = 0;
  for (const t of readTurnFiles()) {
    if (String(t.sid ?? "") === sid) {
      try {
        fs.rmSync(path.join(TURNS2_DIR, `${t.id}.json`), { force: true });
      } catch { /* ya no está */ }
    } else remaining++;
  }
  turnStoreCache = null;
  return { ok: true, remaining, scoped: sid };
}

// Default workspace for the panel's "Trabajo por repositorio" tab (spec
// 22/11): the git repo with the MOST changes of the last recorded turn —// commits + dirty files (dirtyHidden is noise by definition and doesn't
// count). An all-outside turn (or no turns at all) suggests nothing: the tab
// then shows "seleccionar repositorio..." and waits for a manual pick. The
// newest SAVED turn is the deterministic source (a live turn's repos are only
// computed at Stop).
export async function suggestWorkspace() {
  const rec = sidTurns()[0] ?? null;
  if (!rec) return { ok: true, turnId: null, workspace: null, reason: "no_turns" };
  const best = (rec.repos ?? [])
    .filter((r) => r.path && ((r.commits?.length ?? 0) + (r.dirty?.length ?? 0)) > 0)
    .sort(
      (a, b) =>
        (b.commits.length + b.dirty.length) - (a.commits.length + a.dirty.length) ||
        b.commits.length - a.commits.length ||
        String(a.path).localeCompare(String(b.path)),
    )[0] ?? null;
  if (!best) return { ok: true, turnId: rec.id, workspace: null, reason: "no_repos" };
  // The repo may be gone (a deleted worktree): an honest null beats a
  // suggestion the panel can't apply.
  const inside = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: best.path });
  if (!inside.ok) return { ok: true, turnId: rec.id, workspace: null, reason: "repo_gone" };
  return {
    ok: true,
    turnId: rec.id,
    workspace: best.path,
    label: best.label ?? path.basename(best.path),
    commits: best.commits.length,
    dirty: best.dirty.length,
  };
}

// Panel handshake (0.10.1): ANY tool call caches the request context's
// session id (noteRequestMeta in the tools/call dispatch) — this cheap call
// at panel boot is the one that teaches the server WHICH task it serves, so
// every later turn read (even resources/read, which carries no _meta) is
// scoped to this task.
export function whoAmI() {
  return {
    ok: true,
    sessionId: currentSid() || null,
    workspace: activeWorkspace,
    version: serverInfo.version,
  };
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
      splitPatch((await runGit(["diff", "--no-color", "-U10", parent, sha], { cwd: ws, maxOut: GIT_OUT_CAP })).out),
    cwd: ws,
  });

  const pruned = pruneList(files, truncated);
  return {
    workspace: ws,
    branch: meta.branch,
    head: meta.head,
    mode: "commit",
    baseLabel: `commit ${commit?.short ?? sha.slice(0, 7)}`,
    commit: commit ? { ...commit, hash: sha, isMerge, parents } : { hash: sha, short: sha.slice(0, 7), subject: "", author: "", date: "", isMerge, parents },
    isMerge,
    dirty: false,
    truncated: pruned.truncated,
    fileCount: files.length,
    files: pruned.files,
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

// La firma incluye el upstream: un fetch que mueva origin/* también cambia
// los chips ↑/↓ del header de working y tiene que refrescar el panel.
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
  // A dead watcher (workspace deleted/renamed under us) would otherwise stay
  // non-null forever and block re-arming: drop it AND notify subscribers so
  // the panel re-reads NOW and shows its "repo gone — pick another folder"
  // state instead of a stale diff nobody can leave.
  try {
    worktreeWatcher = fs.watch(activeWorkspace, { recursive: true }, onFsEvent);
    worktreeWatcher.on("error", () => { worktreeWatcher?.close(); worktreeWatcher = null; for (const uri of subs) sendNotification("notifications/resources/updated", { uri }); });
    worktreeWatcher.unref?.();
  } catch {
    /* recursive watch unsupported — panel still has its refresh button */
  }
  try {
    gitWatcher = fs.watch(path.join(activeWorkspace, ".git"), { recursive: true }, onFsEvent);
    gitWatcher.on("error", () => { gitWatcher?.close(); gitWatcher = null; for (const uri of subs) sendNotification("notifications/resources/updated", { uri }); });
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
      "Get the live diff of the session workspace as structured JSON: per-file path, status, added/deleted counts and unified patch (working tree vs HEAD + untracked; the payload also carries upstream/ahead/behind when an upstream exists). Opens the Diff Ask panel, where the user can also press '+' on any diff line to ask about that exact line. For per-turn diffs use list_turns + get_turn_diff.",
    inputSchema: {
      type: "object",
      properties: {
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
      "List recorded turns (newest first, paginated in small pages — use skip to page deeper): a turn is one prompt→stop window. Turns are SCOPED to the session making the call when it is known (panel/model request context), otherwise global across sessions. Each entry: id, startedAt/stoppedAt, a PREVIEW of the user prompt and the agent's reply, how many repos/worktrees were touched and how many files changed. The first entry may be the OPEN turn (isLive); call get_turn_diff for the full prompt and its files.",
    inputSchema: {
      type: "object",
      properties: {
        skip: { type: "integer", minimum: 0, default: 0, description: "Skip the first N turns (pagination, newest first)." },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "How many turns per page." },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_turn_diff",
    description:
      "Get the diff of one turn: every commit made DURING the window and every file left dirty, across ALL repos the turn touched (agents commit per unit, often in .worktrees of other repos — paths are namespaced by repo label). 'latest' returns the open turn live; same JSON shape as get_diff. Opens the Diff Ask panel on that turn.",
    inputSchema: {
      type: "object",
      properties: {
        turn: { type: "string", description: "Turn id, or 'latest' for the open/last turn." },
        focus: {
          type: "string",
          description:
            "Absolute path of one file to open the panel at (the app's end-of-turn file click; the panel opens that turn scrolled to the file's section). Not for model use.",
        },
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
    description: "Delete one recorded turn (the panel's ✕).",
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
    description: "Delete ALL recorded turns (the panel's 'Borrar todo').",
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
  {
    name: "suggest_workspace",
    description:
      "Suggest the default workspace for the panel's repo tab: the git repo with the most changes (commits + dirty files) of the LAST recorded turn. Returns workspace=null (reason: no_turns | no_repos | repo_gone) when nothing can be suggested — the panel then waits for a manual pick.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "whoami",
    description:
      "Identify the session this Diff Ask server serves (panel handshake; turns, suggestions and clear_turns are scoped to it when known).",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "list_git_projects",
    description:
      "List local git repositories under a folder (recursive, bounded depth, skips node_modules/Library/hidden — except .worktrees agent-worktree containers) for the panel's 📁 repo picker. Default folder: parent of the active workspace.",
    inputSchema: {
      type: "object",
      properties: {
        under: { type: "string", description: "Folder to scan (~ allowed). Default: parent of the active workspace." },
        maxDepth: { type: "number", description: "Max subfolder depth to walk (default 4)." },
      },
    },
  },
];

const RESOURCES = [
  { uri: PANEL_URI, name: "panel", mimeType: "text/html;profile=mcp-app" },
  { uri: DIFF_URI, name: "workspace-diff", mimeType: "application/json" },
  { uri: "turn://list", name: "turns", mimeType: "application/json" },
  { uri: "log://commits", name: "commits", mimeType: "application/json" },
];

function uriDiffData(uri) {
  const u = new URL(uri);
  if (u.protocol === "diff:") {
    if (u.host === "workspace") return buildDiff();
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
    return Promise.resolve(listTurns({
      skip: parseInt(u.searchParams.get("skip") ?? "0", 10) || 0,
      limit: parseInt(u.searchParams.get("limit") ?? "20", 10) || 20,
    }));
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
      // Every tool call carries the request context (panel AND model calls):
      // cache the session id so turn reads — including bare resources/read,
      // which has no _meta — are scoped to THIS task (0.10.1).
      noteRequestMeta(params._meta);
      let data;
      switch (params.name) {
        case "get_diff":
          data = await buildDiff({ includePatches: params.arguments?.include_patches !== false });
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
          data = listTurns({
            skip: Number(params.arguments?.skip ?? 0) || 0,
            limit: Math.min(Number(params.arguments?.limit ?? 20) || 20, 100),
          });
          return {
            structuredContent: data,
            content: [{ type: "text", text: `${data.turns.length} de ${data.count} turno(s).` }],
          };
        }
        case "get_turn_diff":
          ensureInboxWatcher();
          // The fork's end-of-turn click parks a focus request here; the build
          // below does NOT resolve it — the panel's own resource read is the
          // one that consumes it (this build would eat it first).
          if (params.arguments?.focus)
            requestTurnFocus(params.arguments.focus, params.arguments?.turn ?? "latest");
          data = await buildTurnDiff(String(params.arguments?.turn ?? "latest"), { resolveFocus: false });
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
        case "list_git_projects": {
          const under = params.arguments?.under ?? path.dirname(activeWorkspace);
          data = listGitProjects(under, params.arguments?.maxDepth);
          return {
            structuredContent: data,
            content: [{ type: "text", text: data.ok ? `${data.repos.length} repos bajo ${data.under}` : data.message }],
          };
        }
        case "suggest_workspace": {
          data = await suggestWorkspace();
          return {
            structuredContent: data,
            content: [
              {
                type: "text",
                text: data.workspace
                  ? `Sugerencia: ${data.workspace} (${data.commits} commit(s) + ${data.dirty} sucio(s), turno ${data.turnId}).`
                  : `Sin sugerencia (${data.reason}).`,
              },
            ],
          };
        }
        case "whoami": {
          data = whoAmI();
          return {
            structuredContent: data,
            content: [{ type: "text", text: `Sesión: ${data.sessionId ?? "(global)"} · workspace: ${data.workspace}` }],
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
              : `${data.fileCount} archivo(s) con cambios en ${data.branch} (${data.head}) vs ${data.baseLabel}${data.truncated ? " — recortado por tamaño (parches y/o lista de archivos)" : ""}. Detalle en structuredContent.`,
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
      // Panel-focus hint: a parked click (requestTurnFocus) tells any view
      // that is NOT the focused turn to switch to it; the focused turn's own
      // payload carries focusPath (resolved + consumed by buildTurnDiff).
      const nav = peekPendingTurnFocus();
      if (nav && data && typeof data === "object" && !data.error && data.mode !== "turn")
        data.pendingTurnFocus = nav;
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
