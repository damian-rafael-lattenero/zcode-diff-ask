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
import { foldTurnEvent, reopenWindows, sliceByWindow, TURN_OPEN_MAX_MS, PROMPT_MAX, REPLY_MAX, TURN_LANES_CAP } from "./turn-fold.mjs";
import { appTurnFiles } from "./app-store.mjs";

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
export async function enrichFiles({ entries, numstat, getBefore, getAfter, buildPatches, cwd, withContent = true }) {
  let truncated = false;
  let budget = MAX_PATCH_BYTES;
  // First, full content (before/after) for the first MAX_CONTENT_FILES
  // non-binary files, with a bounded pool: the panel diffs locally with 10
  // context lines and expandable separators. Patch is the fallback. The cap
  // keeps a mega commit from costing one spawn pair per file.
  // withContent:false (0.11.0, the panel's light turn payload): headers only —
  // the content is fetched per file when the user reaches it, so a turn switch
  // never pays for files nobody looks at.
  const targets = withContent ? entries.filter((f) => !f.binary).slice(0, MAX_CONTENT_FILES) : [];
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
  const needPatch = withContent && entries.some((f) => f.before === undefined && !f.binary && f.status !== "R");
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
  if (!raw) return { error: "invalid_path", message: "Give me the path of a folder." };
  const p = path.resolve(raw.replace(/^~(?=\/|$)/, os.homedir()));
  let stats;
  try {
    stats = fs.statSync(p);
  } catch {
    return { error: "invalid_path", message: `No existe: ${p}` };
  }
  if (!stats.isDirectory()) return { error: "invalid_path", message: `Not a folder: ${p}` };
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
    return { error: "not_a_repo", message: `${real} is not a git repository. Diff Ask needs git.` };
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
  if (!stats.isDirectory()) return { error: "invalid_path", message: `Not a folder: ${under}`, repos: [] };
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
    return { error: "invalid_path", message: `The path "${rel}" escapes the workspace.` };
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
      message: `The file no longer exists on disk (was it deleted while you were editing?). Your version was not saved.`,
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
      return { conflict: true, dropped: true, current_hash: curHash, message: "The file changed on disk while you were editing (the agent wins); your edits were not saved." };
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
      message: `The file changed on disk while you were editing (the agent wins). Your version was shelved at ${minePath} (+ .patch with the difference).`,
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
      message: `The workspace is not a git repository (${ws}). Diff Ask needs git.`,
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
const TURN_GUARD_MS = 2000; // guard band around a turn's prompt→stop window
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
// One stored outside path (("~/rel") or absolute) → its $HOME-relative form,
// or null when it is not under $HOME (absolute foreign paths have no noise
// rules). Shared by the tap and the read-time drops so both speak the same
// language about a path.
export function homeRelOutside(raw) {
  const p = String(raw ?? "");
  if (p.startsWith("~/")) return p.slice(2);
  const home = os.homedir();
  if (p.startsWith(home + "/")) return p.slice(home.length + 1);
  return null;
}

export function isTapNoise(rel) {
  const p = String(rel ?? "").replaceAll("\\", "/");
  return (
    /(^|\/)(Library|\.Trash|Caches|\.cache|node_modules|\.venv|venv|__pycache__|\.next|DerivedData|\.gradle|\.m2|target\/debug|target\/release)(\/|$)/.test(p) ||
    /\.(log|lock|tmp|swp|swo|sqlite-wal|sqlite-shm)$/.test(p) ||
    // ~/.zcode is session TERRITORY only where the session actually speaks:
    // its plans and its memories (0.10.9). Everything else under .zcode is
    // machine plumbing with no owning session — bot daemons' heartbeats and
    // state locks, the recorder, runtime/provider locks, memory diagnostics,
    // tool-call artifacts of OTHER sessions — and it used to land in
    // whatever turn happened to be open (measured 23/11: a bot-kotlin turn
    // carried 300 capped outside entries, all noise). One rule, no
    // enumeration of daemons: allow-list the two speaking subtrees.
    (p.startsWith(".zcode/") &&
      !p.startsWith(".zcode/plans/") &&
      !p.startsWith(".zcode/cli/memories/"))
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
const tapGitRoots = new Map(); // repo root -> last .git touch ms (commits happen here)
// One open window PER SESSION — the inbox fold's lane map (0.10.8). The
// old single openTurn was gated by the LAST caller's sid: with several
// tasks open in the app (one server, sticky request-context sid) every
// other session's prompt/stop was dropped as "foreign" and NOTHING was
// recorded for hours (both panel tabs empty, 22/11). Recording is now
// session-agnostic — the fold routes each event to its own lane, and the
// caller's sid only scopes READS (listTurns / buildTurnDiff / suggest).
const openTurns = new Map(); // sid -> { sid, cwd, prompt, startMs, reply?, stopMs? }

// The live lane a READ should serve: THIS session's open window when the
// reader is known; in global mode (CLI/tests/rig, no sid) the newest open
// lane — the last-processed window, preserving the single-slot semantics.
function liveLane(sid) {
  if (!openTurns.size) return null;
  if (sid) return openTurns.get(sid) ?? null;
  let best = null;
  for (const t of openTurns.values()) if (!best || t.startMs > best.startMs) best = t;
  return best;
}

// The union TERRITORY of every open lane (0.10.6: "solo de la
// sesion/task"): each lane's workspace tree, the agent-worktree
// containers, and ~/.zcode (session state — plans, memories). Writes
// anywhere else on the machine belong to other tasks or daemons and are
// NEVER captured, so they cannot leak into another task's turn. Which
// lane a captured write belongs to is decided later, by each lane's
// window slice plus the cross-session attribution rules.
function inTerritory(abs) {
  for (const t of openTurns.values()) {
    if (t.cwd) {
      const root = repoRootOf(t.cwd) ?? t.cwd;
      if (abs === root || abs.startsWith(root + path.sep)) return true;
    }
  }
  if (abs.startsWith(os.homedir() + path.sep + ".zcode" + path.sep)) return true;
  if (abs.includes(`${path.sep}.worktrees${path.sep}`)) return true;
  return false;
}

// Accepts an absolute path or one relative to $HOME (the watcher's form).
// Exported so tests can inject paths without a real FSEvents stream.
export function noteTapPath(raw) {
  if (!openTurns.size || !raw) return;
  const p = String(raw);
  const abs = path.isAbsolute(p) ? p : path.join(os.homedir(), p);
  const home = os.homedir();
  const gitAt = abs.indexOf(`${path.sep}.git${path.sep}`);
  if (gitAt >= 0 || abs.endsWith(`${path.sep}.git`)) {
    const root = gitAt >= 0 ? abs.slice(0, gitAt) : abs.slice(0, -5);
    // A commit marker counts only inside our territory (a foreign repo's
    // .git is another task's business).
    if (root && inTerritory(root)) tapGitRoots.set(root, Date.now());
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
  return { touched: [...tapTouched.entries()], gitRoots: [...tapGitRoots.keys()] };
}

// Read-only diagnostics of the tap (paths + roots, never content). The e2e
// uses it to WAIT for the tap to see a write before closing a turn window —
// a deterministic alternative to "sleep and hope the FSEvents landed".
export function tapState() {
  return { ok: true, touched: tapTouched.size, gitRoots: [...tapGitRoots.keys()], openTurns: openTurns.size };
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

// Structured-concurrency lane for the inbox (0.10.8): every drain — watcher,
// tool dispatch, tests — runs ONE AT A TIME through this queue. The old
// fire-and-forget watcher drain could still be inside finalizeWindow (its
// git scans await) while a clear_turns wiped the store: the late write
// resurrected deleted records. clear/delete join the queue before wiping,
// so no finalize can land after them.
let inboxLane = Promise.resolve();
export function processInbox() {
  const run = inboxLane.then(() => drainInbox());
  inboxLane = run.catch(() => {});
  return run;
}

async function drainInbox() {
  // Every drain also guarantees the watcher and (once per life) the boot
  // heal — reads that reach here from any dispatch must not depend on which
  // code path happened to ensure the watcher first.
  ensureInboxWatcher();
  initInboxOffset();
  // Byte-exact offsets (0.10.8): the offset rides statSync BYTES, so the
  // chunk must be measured in bytes too. Reading utf8 made data.length a
  // UTF-16 count — with accented prompts (every real one) it ran BELOW the
  // byte offset, tripped the rotation guard and re-drained the WHOLE inbox
  // on every server life, re-finalizing every window (the October chains).
  let buf;
  try {
    buf = fs.readFileSync(TURN_INBOX);
  } catch {
    return;
  }
  if (buf.length < inboxOffset) inboxOffset = 0; // rotaron/reemplazaron el archivo
  if (buf.length <= inboxOffset) return;
  const chunk = buf.subarray(inboxOffset).toString("utf8");
  inboxOffset = buf.length;
  let openedAny = false;
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    const ev = parseTurnEvent(line);
    if (!ev) continue;
    // The PURE fold routes the event to its own lane — no caller-identity
    // gate, ever (that gate is what starved the store on 22/11). The
    // computed effects (supersede/finalize) run here, at the edge.
    const { states, superseded, finalized } = foldTurnEvent(openTurns, ev, {
      promptMax: PROMPT_MAX,
      replyMax: REPLY_MAX,
      lanesCap: TURN_LANES_CAP,
    });
    openTurns.clear();
    for (const [k, v] of states) openTurns.set(k, v);
    if (ev.type === "prompt") openedAny = true;
    if (superseded) await finalizeWindow(superseded, { interrupted: true });
    if (finalized) await finalizeWindow(finalized, { interrupted: false });
  }
  if (openedAny && openTurns.size) ensureTapWatcher();
}

// Restart-race heal (0.10.8): windows still open at EOF re-open as lanes.
// Every deploy restarts the app mid-turn; the old life dropped the in
// flight window (its stop later found "no prompt in this server life" and
// the turn was lost). The log still carries prompt/cwd/startMs — only the
// pre-boot loose-write tap is unrecoverable, and the git scans at finalize
// recover commits and dirty state anyway.
let bootHealed = false;
function reopenLiveLanes() {
  if (bootHealed || openTurns.size) return;
  bootHealed = true; // once per server life — the full-inbox scan must not ride every drain
  try {
    const lanes = reopenWindows(fs.readFileSync(TURN_INBOX, "utf8").split("\n"), {
      promptMax: PROMPT_MAX,
      lanesCap: TURN_LANES_CAP,
    });
    for (const [k, v] of lanes) openTurns.set(k, v);
    if (openTurns.size) {
      log(`boot: ${openTurns.size} ventana(s) reabierta(s) del inbox`);
      ensureTapWatcher();
    }
  } catch {
    /* sin inbox: nada que reabrir */
  }
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

// Timeline staleness cap: TURN_OPEN_MAX_MS lives in turn-fold.mjs now (a
// prompt without a stop older than the cap is a ZOMBIE window — a server
// that died mid-turn; October windows were still "open" today, polluting
// every overlap computation). After the cap the interval no longer
// overlaps anything.

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
  // Cross-session attribution: another task's live repo is theirs, not ours
  // — EXCEPT our own workspace repo (two tasks on the same project are both
  // legitimate; the session cwd is ALWAYS ours, like the default git).
  const foreignRoots = new Set(
    [...foreignCwds(sid, startMs - 2000, stopMs + 2000)]
      .map((c) => repoRootOf(c))
      .filter(Boolean)
      .filter((root) => root !== (cwd ? repoRootOf(cwd) : null)),
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

// Panel key of a file outside any git repo: home-relative "~/x" when it
// lives under $HOME, its absolute path otherwise.
const outsideKey = (abs, home) => (abs.startsWith(home + path.sep) ? `~/${path.relative(home, abs)}` : abs);

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
  const key = outsideKey(abs, home);
  let gone = true;
  try {
    gone = !fs.statSync(abs).isFile();
  } catch { /* gone: created+deleted inside the window, or never a file */ }
  return {
    status: gone ? "D" : "?",
    path: key,
    repoLabel: OUTSIDE_LABEL,
    repo: home,
    note: gone ? "deleted in the turn (outside git)" : "fuera de git",
    ...(gone ? { gone: true } : {}),
    _src: { outside: true, abs },
  };
}

// The app's file changes of one turn window, or null when the app has no
// truth for that session (0.10.10). The window is the prompt→stop bracket:
// open at the prompt itself (measured 23/11 on 18 real turns: the first
// checkpoint lands ≥17 s after it, and a band there would let a turn claim
// the previous turn's last writes), closed 2 s past the stop (a row the app
// flushes late still belongs to the turn; the next one writes ≥17 s later).
async function turnItems({ sid, startedAt, stoppedAt }) {
  const fromMs = Date.parse(startedAt ?? "");
  const toMs = Date.parse(stoppedAt ?? "");
  if (!sid || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return appTurnFiles({ sid, fromMs, toMs: toMs + TURN_GUARD_MS });
}

async function finalizeWindow(t, { interrupted }) {
  if (!t) return null;
  const stopMs = t.stopMs ?? Date.now();
  // THE TURN'S FILES (0.10.10): when the app knows the session, its own
  // checkpoints ARE the turn's file list — the one its end-of-turn summary
  // shows — read again at every view, so nothing is captured or stored. The
  // tap + git capture stays for sessions the app does not know (bot lines,
  // the rig).
  const appBacked =
    (await turnItems({ sid: t.sid, startedAt: new Date(t.startMs).toISOString(), stoppedAt: new Date(stopMs).toISOString() })) !== null;
  let repos = [];
  let outside = [];
  if (!appBacked) {
    // WINDOW SLICE (L5): with several lanes open the tap sets are shared —
    // each lane finalizes with only the writes inside ITS window (startMs
    // minus the same 2s guard band the git scans use). The shared sets die
    // only when the LAST lane closes, so concurrent windows never starve
    // each other's tap.
    const touched = sliceByWindow(tapTouched.entries(), t.startMs - TURN_GUARD_MS);
    const gitRoots = sliceByWindow(tapGitRoots.entries(), t.startMs - TURN_GUARD_MS).map(([root]) => root);
    ({ repos, outside } = await collectTurnChanges({
      sid: t.sid,
      cwd: t.cwd,
      startMs: t.startMs,
      stopMs,
      touched,
      gitRoots,
    }));
  }
  if (openTurns.size === 0) {
    tapTouched.clear();
    tapGitRoots.clear();
  }
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
    ...(appBacked ? { source: "app" } : {}),
    repos,
    outside,
  };
  try {
    fs.mkdirSync(TURNS2_DIR, { recursive: true });
    // A zombie's interrupted supersede must never regress a COMPLETED turn
    // (the real stop may have landed first on another process).
    const existing = readTurnFiles().find((r) => r.id === rec.id);
    if (existing && !existing.interrupted && interrupted) {
      log(`turn ${rec.id}: interrupted finalize ignored (already completed)`);
      return existing;
    }
    fs.writeFileSync(path.join(TURNS2_DIR, `${rec.id}.json`), JSON.stringify(rec));
    turnStoreCache = null; // our own write invalidates the cache
  } catch {
    return null;
  }
  log(
    appBacked
      ? `turn ${rec.id}: files according to the app's checkpoints`
      : `turno ${rec.id}: ${repos.length} repo(s), ${repos.reduce((n, r) => n + r.commits.length, 0)} commit(s), ${outside.length} fuera de git`,
  );
  for (const uri of subs) sendNotification("notifications/resources/updated", { uri });
  return rec;
}

let inboxWatcher = null;
function ensureInboxWatcher() {
  if (inboxWatcher) return;
  try {
    fs.mkdirSync(DA_STATE_DIR, { recursive: true });
    initInboxOffset();
    reopenLiveLanes(); // boot heal (once per life): open windows survive the restart
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
// PER-FILE parse cache (0.11.0): the store holds thousands of records, and a
// new turn changes the directory key — re-parsing ALL of them cost ~2 s on
// the live store, on every turn written. Re-read only the files whose
// mtime/size changed; everything else is reused as the same parsed object.
let turnFileCache = new Map(); // name -> { mtimeMs, size, rec|null }

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
  const alive = new Set(names);
  for (const n of turnFileCache.keys()) if (!alive.has(n)) turnFileCache.delete(n);
  const out = [];
  for (const n of names) {
    const abs = path.join(TURNS2_DIR, n);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      turnFileCache.delete(n);
      continue;
    }
    const hit = turnFileCache.get(n);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      if (hit.rec) out.push(hit.rec);
      continue;
    }
    let rec = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
      if (parsed && parsed.id) rec = parsed;
    } catch { /* turno corrupto: se ignora */ }
    turnFileCache.set(n, { mtimeMs: st.mtimeMs, size: st.size, rec });
    if (rec) out.push(rec);
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

// Tests only: the sticky sid is deliberately never forgotten by product
// code (a request without a sid keeps the last known task); tests that
// simulate several callers need to unwind it between scenarios.
export function resetRequestMetaForTests() {
  metaSid = "";
}

export function currentSid() {
  return String(process.env.ZCODE_SESSION_ID ?? "").trim() || metaSid;
}

function sidTurns(scopeSid) {
  const sid = scopeSid || currentSid();
  if (!sid) return readTurnFiles();
  return readTurnFiles().filter((t) => String(t.sid ?? "") === sid);
}

function turnFileCount(rec) {
  // The outside count rides the same read-time noise drop as buildTurnDiff
  // (0.10.9): old records stored daemon plumbing — the list row must not
  // advertise 300 files the view will never show.
  let n = 0;
  for (const o of rec.outside ?? []) {
    const rel = homeRelOutside(o?.path ?? o);
    if (rel === null || !isTapNoise(rel)) n++;
  }
  for (const r of rec.repos ?? []) n += (r.commits?.length ?? 0) + (r.dirty?.length ?? 0);
  return n;
}

// Builds the panel entries for a turn: every commit hunk and every dirty file
// of every repo touched in the window, namespaced as "<repo label>/<path>"
// (the panel keys sections by path, and two repos can hold the same rel path),
// then the files touched OUTSIDE any git repo (all-green group). Content rides
// the shared bounded pool (mapPool + budget via enrichFiles).
// Per-file content readers of the CAPTURE model (sessions the app does not
// know): before/after from git or the work tree. Shared by the full build
// (enrichFiles) and the on-demand single-file read (buildTurnFile), so the
// two can never disagree about one file's content.
function turnReaders() {
  return {
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
  };
}

async function turnEntries(repos, outside = [], { withContent = true } = {}) {
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
    ...turnReaders(),
    buildPatches: null,
    cwd: activeWorkspace,
    withContent,
  });
  // Outside files whose content didn't fit the budget (or is binary): no text
  // can ride — flag binary so the panel shows its honest plain-note instead of
  // an empty diff box. In LIGHT mode nothing was read: the file is deferred,
  // and the per-file read reports binary/too-big then.
  if (withContent) {
    for (const f of entries) {
      if (f._src?.outside && !f.gone && f.after === undefined) f.binary = true;
    }
  }
  return entries;
}

// Items of an app-backed turn → repo groups in display order: repos by
// first appearance, files outside any repo LAST under the "~" pseudo-repo.
function appTurnGroups(items) {
  const groups = new Map(); // label -> { label, path, items[] }
  for (const item of items) {
    const root = repoRootOf(item.path);
    const label = root ? path.basename(root) : OUTSIDE_LABEL;
    const group = groups.get(label) ?? { label, path: root ?? os.homedir(), items: [] };
    group.items.push(item);
    groups.set(label, group);
  }
  return [...groups.values()].sort(
    (a, b) => Number(a.label === OUTSIDE_LABEL) - Number(b.label === OUTSIDE_LABEL),
  );
}

// Panel entries for an app-backed turn (0.10.10): one per item, grouped by
// repo and namespaced "<label>/<rel>" — the capture model's layout, so the
// panel's repo → folder → file grouping works unchanged. Content is the
// app's own first-before → final-after; the shared enrichFiles applies the
// payload budget and carries the app's counts through its numstat seam.
async function appTurnEntries(items, { withContent = true } = {}) {
  const ordered = appTurnGroups(items);
  const entries = [];
  const numstat = new Map();
  const home = os.homedir();
  for (const g of ordered)
    for (const item of g.items) {
      const key = g.label === OUTSIDE_LABEL ? outsideKey(item.path, home) : `${g.label}/${path.relative(g.path, item.path)}`;
      numstat.set(key, { added: String(item.additions), deleted: String(item.deletions) });
      entries.push({
        status: item.before === null ? "A" : "M",
        path: key,
        repo: g.path,
        repoLabel: g.label,
        note: `${item.writeCount} escritura${item.writeCount === 1 ? "" : "s"} · ${item.toolNames.join(" + ")}`,
        _src: { app: true, abs: item.path, item },
        // Nothing to show (the app kept no final content and its patch
        // cannot rebuild it): the honest plain note, not an empty diff box.
        ...(item.after === undefined ? { binary: true } : {}),
      });
    }
  await enrichFiles({
    entries,
    numstat,
    getBefore: (f) => Promise.resolve(f._src.item.before),
    getAfter: (f) => Promise.resolve(f._src.item.after ?? null),
    buildPatches: null,
    cwd: activeWorkspace,
    withContent,
  });
  return { entries, repos: ordered.map((g) => ({ label: g.label, path: g.path, files: g.items.length })) };
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
  if (!raw) return { ok: false, message: "empty focus" };
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
// withContent:false is the panel's light read (0.11.0): file headers and
// counts only — the heavy before/after rides a per-file read when the user
// reaches it (`buildTurnFile`), so switching turns never moves megabytes.
export async function buildTurnDiff(id, opts = {}) {
  return (await buildTurnBundle(id, opts)).payload;
}

async function buildTurnBundle(id, { workspace = activeWorkspace, resolveFocus = true, sid: scopeSid, withContent = true } = {}) {
  let rec;
  let isLive = false;
  // scopeSid: the panel's EXPLICIT task (diff://turn/<id>?sid=…) — see listTurns.
  const sid = scopeSid || currentSid();
  // The live turn only serves THIS session (0.10.1); a foreign open turn is
  // someone else's "latest" — fall through to the saved per-session list.
  const lane = id === "latest" ? liveLane(sid) : null;
  // A turn's files (0.10.10): { source: "app", items } — the app's own
  // truth, the list its end-of-turn summary shows — or { source: "capture",
  // repos, outside } for sessions the app does not know.
  let source;
  if (id === "latest" && lane) {
    isLive = true;
    const stopMs = Date.now();
    const startedAt = new Date(lane.startMs).toISOString();
    const stoppedAt = new Date(stopMs).toISOString();
    // The open turn grows while the agent works: the app persists a
    // checkpoint as each write lands, so the live view is what was written so far.
    const items = await turnItems({ sid: lane.sid, startedAt, stoppedAt });
    source = items
      ? { source: "app", items }
      : {
          source: "capture",
          ...(await collectTurnChanges({
            sid: lane.sid,
            cwd: lane.cwd,
            startMs: lane.startMs,
            stopMs,
            // WINDOW SLICE (L5): only the writes inside THIS lane's window.
            touched: sliceByWindow(tapTouched.entries(), lane.startMs - TURN_GUARD_MS),
            gitRoots: sliceByWindow(tapGitRoots.entries(), lane.startMs - TURN_GUARD_MS).map(([root]) => root),
          })),
        };
    rec = { id: "latest", workspace: lane.cwd, prompt: lane.prompt, reply: "", startedAt, stoppedAt };
  } else {
    rec = sidTurns(scopeSid).find((t) => t.id === id) ?? null;
    if (!rec && id === "latest") {
      // sin turno abierto (de esta sesión): el último guardado de la sesión
      rec = sidTurns(scopeSid)[0] ?? null;
    }
    // Read-time attribution (0.10.6): records stored BEFORE the territory
    // rules carry repos captured machine-wide — drop repos that are OTHER
    // top-level sessions' cwd with overlapping windows, so old records
    // render clean without migrating the 8000-file store. The record's OWN
    // workspace repo is NEVER dropped (0.10.6b: two tasks on the same
    // project are both legitimate — consecutive same-repo turns were going
    // empty).
    if (rec) {
      const recStart = Date.parse(rec.startedAt ?? "") || 0;
      const recStop = Date.parse(rec.stoppedAt ?? "") || Date.now();
      const ivs = foreignCwds(String(rec.sid ?? ""), recStart, recStop);
      const ownRoot = rec.workspace ? repoRootOf(rec.workspace) : null;
      if (ivs.size) {
        const foreignRoots = new Set(
          [...ivs].map((c) => repoRootOf(c)).filter(Boolean).filter((root) => root !== ownRoot),
        );
        if (foreignRoots.size)
          rec = { ...rec, repos: (rec.repos ?? []).filter((r) => !foreignRoots.has(r.path)) };
      }
      // Read-time noise drop (0.10.9): records stored BEFORE the ~/.zcode
      // allow-list carry daemon plumbing in their outside list (bot state,
      // locks, recorder, diagnostics, artifacts) — the same isTapNoise
      // predicate filters them at read, so old records render clean without
      // migrating the store. Outside paths are "~/rel" or absolute.
      const outside = (rec.outside ?? []).filter((o) => {
        const rel = homeRelOutside(o?.path ?? o);
        return rel === null || !isTapNoise(rel);
      });
      if (outside.length !== (rec.outside ?? []).length) rec = { ...rec, outside };
    }
    if (!rec) {
      if (id !== "latest")
        return {
          entries: [],
          payload: { error: "unknown_turn", message: `I could not find turn "${id}".`, workspace, files: [], fileCount: 0 },
        };
      return {
        entries: [],
        payload: {
          error: "no_turns",
          message: "No turns recorded yet. Every message in the session opens a turn and closes it when the answer ends.",
          workspace,
          files: [],
          fileCount: 0,
        },
      };
    }
    // Records stored before 0.10.10 carry the captured repos; the app's
    // truth still wins whenever it has the session.
    const items = await turnItems(rec);
    source = items ? { source: "app", items } : { source: "capture", repos: rec.repos ?? [], outside: rec.outside ?? [] };
  }
  const { entries, repos: appRepos } =
    source.source === "app"
      ? await appTurnEntries(source.items, { withContent })
      : { entries: await turnEntries(source.repos, source.outside, { withContent }), repos: null };
  const pruned = pruneList(entries, false);
  // The light read hands the panel the headers and keeps the entries HERE:
  // the per-file read (`buildTurnFile`) picks the content out of this cache.
  if (!withContent) rememberTurnEntries(turnCacheKey(id, scopeSid, workspace), entries);
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
  const outsideCount = (source.outside ?? []).length;
  const payload = {
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
      // "app": the app's own file list (its end-of-turn summary); "capture": repos and loose files captured by the tap.
      source: source.source,
      repos:
        appRepos ??
        [
          ...(source.repos ?? []).map((r) => ({
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
      outside: source.outside ?? [],
    },
    baseLabel: `turno ${atLabel}`,
    snapshotAt: rec.startedAt,
    dirty: entries.length > 0,
    truncated: pruned.truncated,
    fileCount: entries.length,
    // LIGHT payload: headers only + a `deferred` flag per file whose content
    // the panel must request (`diff://file/…?path=`). `_src` is internal
    // (it carried the app item — before/after TWICE in the old payload) and
    // never rides the wire.
    ...(withContent ? {} : { light: true }),
    files: pruned.files.map(({ _src, ...f }) =>
      withContent ? f : { ...f, ...(f.binary || f.gone ? {} : { deferred: true }) },
    ),
    generatedAt: new Date().toISOString(),
  };
  return { payload, entries };
}

// ---- light turns: the per-file read (0.11.0) ----------------------------
// The light payload's cache: the parsed turn entries (with their internal
// `_src`) of the last few turns. A per-file read is then a find + one file's
// content, never a whole-turn rebuild.
const TURN_ENTRY_MAX = 6;
const TURN_ENTRY_TTL_MS = 30_000;
const turnEntryCache = new Map(); // key -> { at, entries }

function turnCacheKey(id, scopeSid, workspace) {
  return `${workspace ?? ""}\0${id}\0${scopeSid || currentSid()}`;
}

function rememberTurnEntries(key, entries) {
  turnEntryCache.delete(key);
  turnEntryCache.set(key, { at: Date.now(), entries });
  while (turnEntryCache.size > TURN_ENTRY_MAX) turnEntryCache.delete(turnEntryCache.keys().next().value);
}

/**
 * One file's content of a turn, on demand (the light payload's other half).
 * App-backed turns answer from the app's own before/after; capture turns run
 * the same readers the full build used. Degrades to an honest `error` — the
 * panel shows a note, never a broken diff.
 * @returns {Promise<{path:string, before:string|null, after:string|null, binary?:boolean, gone?:boolean, error?:string, message?:string}>}
 */
export async function buildTurnFile(id, filePath, { workspace = activeWorkspace, sid: scopeSid } = {}) {
  const key = turnCacheKey(id, scopeSid, workspace);
  let bundle = turnEntryCache.get(key);
  if (!bundle || Date.now() - bundle.at > TURN_ENTRY_TTL_MS) {
    await buildTurnBundle(id, { workspace, sid: scopeSid, withContent: false, resolveFocus: false });
    bundle = turnEntryCache.get(key);
  }
  const entry = bundle?.entries.find((e) => e.path === filePath);
  if (!entry) return { error: "unknown_file", path: filePath, content: true, message: `The turn does not have the file "${filePath}".` };
  if (entry._content) return entry._content;
  let content;
  if (entry._src?.app) {
    const item = entry._src.item;
    content = {
      path: entry.path,
      before: item.before ?? null,
      after: item.after ?? null,
      ...(item.after === undefined ? { binary: true } : {}),
    };
  } else if (entry.gone) {
    content = { path: entry.path, before: null, after: null, gone: true };
  } else {
    const readers = turnReaders();
    const before = entry.status === "A" || entry.status === "?" ? null : await readers.getBefore(entry);
    const after = entry.status === "D" ? null : await readers.getAfter(entry);
    content = {
      path: entry.path,
      before,
      after,
      ...(before === null && after === null ? { binary: true } : {}),
    };
  }
  content.content = true; // marks a per-file payload (never a view)
  entry._content = content;
  return content;
}

// ---- turn list pagination ------------------------------------------------
// 2000+ stored turns used to ride ONE payload with FULL prompts — megabytes
// per reactive read, the panel choked. Now: newest first (live turn on top),
// slices of `limit` + hasMore, and summaries are PREVIEWS (first line, capped)
// — the full prompt lives in the turn's diff payload (buildTurnDiff).
const TURN_PAGE = 20;
const TURN_PREVIEW_MAX = 300;

// Repos an app-backed turn wrote in ("~" for files outside any repo) — the
// same groups its view will show.
const appRepoCount = (items) => appTurnGroups(items).length;

export async function listTurns({ skip = 0, limit = TURN_PAGE, sid: scopeSid } = {}) {
  // scopeSid: the panel's EXPLICIT task (turn://list?sid=…) — resources/read
  // carries no request context, and the cached sid is whoever called any
  // tool last; the panel's view must follow ITS OWN task, always (0.10.8).
  const sid = scopeSid || currentSid();
  const recs = sidTurns(scopeSid);
  // The live turn only belongs to this view when it is THIS session's turn
  // (global mode serves the newest open lane — the last-processed window).
  const live = liveLane(sid);
  const total = recs.length + (live ? 1 : 0);
  const from = Math.max(0, Math.min(Number(skip) || 0, total));
  const lim = Math.max(1, Math.min(Number(limit) || TURN_PAGE, 100));
  const preview = (s) => String(s ?? "").split("\n")[0].slice(0, TURN_PREVIEW_MAX);
  const at = async (i) => {
    if (live && i === 0)
      return {
        id: "latest",
        at: new Date(live.startMs).toISOString(),
        stoppedAt: "",
        prompt: preview(live.prompt),
        reply: "",
        workspace: live.cwd,
        repoCount: 0,
        fileCount: 0,
        isLive: true,
        interrupted: false,
      };
    const t = recs[i - (live ? 1 : 0)];
    // The row counts what the turn's view will show (0.10.10): the app's
    // file list when it has the session, the captured repos otherwise.
    const items = await turnItems(t);
    return {
      id: t.id,
      at: t.startedAt,
      stoppedAt: t.stoppedAt,
      prompt: preview(t.prompt),
      reply: preview(t.reply),
      workspace: t.workspace,
      repoCount: items ? appRepoCount(items) : (t.repos ?? []).length,
      fileCount: items ? items.length : turnFileCount(t),
      isLive: false,
      interrupted: Boolean(t.interrupted),
    };
  };
  const turns = [];
  for (let i = from; i < total && turns.length <= lim; i++) turns.push(await at(i));
  const hasMore = turns.length > lim;
  // sessionFilter: the panel renders "· esta task" when non-null (0.10.1).
  return { count: total, skip: from, limit: lim, hasMore, sessionFilter: sid || null, turns: turns.slice(0, lim) };
}

export async function deleteTurn(id, { workspace = activeWorkspace } = {}) {
  await inboxLane.catch(() => {}); // no in-flight finalize may resurrect the file
  const rec = sidTurns().find((t) => t.id === id);
  if (!rec) return { error: "unknown_turn", message: `I could not find turn "${id}".` };
  try {
    fs.rmSync(path.join(TURNS2_DIR, `${rec.id}.json`), { force: true });
  } catch { /* ya no está */ }
  return { ok: true, remaining: sidTurns().length };
}

export async function clearTurns({ workspace = activeWorkspace } = {}) {
  await inboxLane.catch(() => {}); // no in-flight finalize may resurrect records
  const sid = currentSid();
  if (!sid) {
    try {
      fs.rmSync(TURNS2_DIR, { recursive: true, force: true });
    } catch { /* nada que borrar */ }
    turnStoreCache = null;
    openTurns.clear(); // global clear drops every live lane too
    return { ok: true, remaining: 0 };
  }
  // Scoped (0.10.1): the panel's "Borrar todo" is per task view — with a
  // known session it must NOT nuke every other task's history. Its own
  // live lane dies with the view (dropped, never persisted as a record).
  openTurns.delete(sid);
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
// 22/11): the git repo with the MOST changes of the last recorded turn. An
// all-outside turn (or no turns at all) suggests nothing: the tab then
// shows "seleccionar repositorio..." and waits for a manual pick.
//
// 0.10.10 — "changes" follow the turn's own truth. When the app knows the
// session they are the files the turn WROTE (its end-of-turn summary), and
// the newest turn that wrote any decides: a turn that only ran commands
// writes none, and the tab should still land where the work is. The
// captured commits + dirty files remain the measure for sessions the app
// does not know.
const SUGGEST_LOOKBACK = 10; // newest turns searched for one that wrote files

export async function suggestWorkspace() {
  const recs = sidTurns();
  const rec = recs[0] ?? null;
  if (!rec) return { ok: true, turnId: null, workspace: null, reason: "no_turns" };
  let appKnown = false;
  for (const candidate of recs.slice(0, SUGGEST_LOOKBACK)) {
    const items = await turnItems(candidate);
    if (!items) continue;
    appKnown = true;
    // Most files written; ties go to the most changed lines, then the path.
    const best = appTurnGroups(items)
      .filter((g) => g.label !== OUTSIDE_LABEL)
      .map((g) => ({
        label: g.label,
        path: g.path,
        files: g.items.length,
        lines: g.items.reduce((n, i) => n + i.additions + i.deletions, 0),
      }))
      .sort((a, b) => b.files - a.files || b.lines - a.lines || String(a.path).localeCompare(String(b.path)))[0];
    if (!best) continue;
    // The repo may be gone (a deleted worktree): an honest null beats a
    // suggestion the panel cannot apply.
    const inside = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: best.path });
    return inside.ok
      ? { ok: true, turnId: candidate.id, workspace: best.path, label: best.label, files: best.files }
      : { ok: true, turnId: candidate.id, workspace: null, reason: "repo_gone" };
  }
  if (appKnown) return { ok: true, turnId: rec.id, workspace: null, reason: "no_repos" };
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
    return { error: "not_a_repo", message: `The workspace is not a git repository (${ws}).`, workspace: ws };
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
    return { error: "not_a_repo", message: `The workspace is not a git repository (${ws}).`, workspace: ws };
  const full = await runGit(["rev-parse", "--verify", `${ref}^{commit}`], { cwd: ws });
  if (!full.ok)
    return { error: "unknown_commit", message: `I could not find commit "${ref}" in ${ws}.`, workspace: ws };
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
    name: "tap_state",
    description:
      "Read-only tap diagnostics: whether the file-write tap has seen paths and which git roots it knows (the e2e/turn capture tests use it to wait deterministically).",
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
      const sid = u.searchParams.get("sid") ?? "";
      // ?light=1 (0.11.0): headers only — the panel fetches each file's
      // content from diff://file/… when the user reaches it.
      const light = u.searchParams.get("light") === "1";
      ensureInboxWatcher();
      // Reads drain the inbox first (0.10.8): the fs.watch notifier can
      // miss appends on macOS, and a blind read served a stale/empty turn
      // list — the exact "both tabs show nothing" live failure.
      return processInbox().then(() =>
        buildTurnDiff(id || "latest", { ...(sid ? { sid } : {}), ...(light ? { withContent: false } : {}) }),
      );
    }
    if (u.host === "file") {
      const id = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
      const sid = u.searchParams.get("sid") ?? "";
      const filePath = u.searchParams.get("path") ?? "";
      ensureInboxWatcher();
      return processInbox().then(() =>
        buildTurnFile(id || "latest", filePath, sid ? { sid } : {}),
      );
    }
    if (u.host === "commit") {
      const ref = decodeURIComponent(u.pathname.replace(/^\/+/, ""));
      return buildCommitDiff(ref);
    }
  }
  if (u.protocol === "turn:" && u.host === "list") {
    ensureInboxWatcher();
    const sid = u.searchParams.get("sid") ?? "";
    return processInbox().then(() =>
      listTurns({
        skip: parseInt(u.searchParams.get("skip") ?? "0", 10) || 0,
        limit: parseInt(u.searchParams.get("limit") ?? "20", 10) || 20,
        ...(sid ? { sid } : {}),
      }),
    );
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
          await processInbox(); // drain before reading — watcher misses must not blind reads
          data = await listTurns({
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
          await processInbox();
          // The fork's end-of-turn click parks a focus request here; the build
          // below does NOT resolve it — the panel's own resource read is the
          // one that consumes it (this build would eat it first).
          if (params.arguments?.focus)
            requestTurnFocus(params.arguments.focus, params.arguments?.turn ?? "latest");
          data = await buildTurnDiff(String(params.arguments?.turn ?? "latest"), { resolveFocus: false });
          break;
        case "delete_turn": {
          data = await deleteTurn(String(params.arguments?.id ?? ""));
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
          data = await clearTurns();
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
          await processInbox(); // the suggestion ranks SAVED turns — drain first
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
            content: [{ type: "text", text: `Session: ${data.sessionId ?? "(global)"} · workspace: ${data.workspace}` }],
          };
        }
        case "tap_state": {
          data = tapState();
          return {
            structuredContent: data,
            content: [{ type: "text", text: `tap: ${data.touched} path(s) · ${data.gitRoots.length} root(s)` }],
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
              : `${data.fileCount} file(s) with changes in ${data.branch} (${data.head}) vs ${data.baseLabel}${data.truncated ? " — truncated by size (patches and/or file list)" : ""}. Details in structuredContent.`,
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
      // Per-file content payloads are not views — they never carry the hint.
      const nav = peekPendingTurnFocus();
      if (nav && data && typeof data === "object" && !data.error && !data.content && data.mode !== "turn")
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
  // Boot wiring (0.10.8): the inbox watcher, the cold offset and the boot
  // heal must all be armed AT STARTUP — a restart mid-turn receives events
  // (the deploy's own stop!) before any turn read; without this, nothing
  // watched the inbox until the first tools/call, and those early appends
  // fell in the cold-offset gap: unseen by the watcher, skipped by the
  // first drain. This is the restart race's second half.
  ensureInboxWatcher();
  // Warm the turn store (0.11.0): the FIRST scan of a server life parses every
  // record (~2 s on the live 8.7k store); the panel usually opens seconds
  // after startup, so parse in the background — its first list read then hits
  // the warm cache instead of paying the full scan. setTimeout keeps the MCP
  // handshake (initialize/tools/list) completely ahead of the warm-up.
  setTimeout(() => {
    try {
      readTurnFiles();
    } catch {
      /* a warm-up failure is not a boot failure — the first read retries */
    }
  }, 250).unref?.();
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
