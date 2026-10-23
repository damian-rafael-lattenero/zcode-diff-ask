#!/usr/bin/env node
// diff-ask MCP server — stdio, Node stdlib only.
//
// Serves:
//   ui://diff-ask/panel.html  → the Diff Ask panel (built by ui/build.mjs)
//   diff://workspace          → live JSON diff of the session workspace
//
// Reactive updates: on resources/subscribe we fs.watch the worktree (plus .git)
// and, when the git signature actually changes, push
// notifications/resources/updated. No polling anywhere.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
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

function runGit(args, { expectDiffExit = false } = {}) {
  return new Promise((resolve) => {
    const p = spawn("git", ["-C", WORKSPACE, ...args], {
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

async function buildDiff({ includePatches = true } = {}) {
  const [inside, branchR, headR, statusR] = await Promise.all([
    runGit(["rev-parse", "--is-inside-work-tree"]),
    runGit(["rev-parse", "--abbrev-ref", "HEAD"]),
    runGit(["rev-parse", "--short", "HEAD"]),
    runGit(["status", "--porcelain=v1", "-z"]),
  ]);
  if (!inside.ok)
    return {
      error: "not_a_repo",
      message: `El workspace no es un repositorio git (${WORKSPACE}). Diff Ask necesita git.`,
      workspace: WORKSPACE,
    };

  const files = parsePorcelainZ(statusR.out).map((f) => ({ ...f, patch: undefined }));
  const numstat = new Map();
  const numR = await runGit(["diff", "HEAD", "--numstat"]);
  for (const line of numR.out.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) numstat.set(m[3].replace(/(.*)\t.*$/, "$1"), { added: m[1], deleted: m[2] });
  }

  let truncated = false;
  let budget = MAX_PATCH_BYTES;
  // Primero intento contenido completo (before/after): el panel diffea local
  // con 10 líneas de contexto y separadores expandibles. Parche sólo fallback.
  for (const f of files) {
    if (f.binary) continue;
    let before = null;
    let after = null;
    try {
      if (f.status !== "D") {
        const abs = path.join(WORKSPACE, f.path);
        if (fs.statSync(abs).size <= CONTENT_LIMIT) after = fs.readFileSync(abs, "utf8");
      }
      if (f.status !== "?" && f.status !== "A") {
        const r = await runGit(["show", `HEAD:${f.oldPath ?? f.path}`]);
        if (r.ok && r.out.length <= CONTENT_LIMIT) before = r.out;
      }
    } catch {
      /* ilegible → cae a parche */
    }
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
  if (includePatches) {
    const needPatch = files.some(
      (f) => f.before === undefined && !f.binary && f.status !== "R",
    );
    let patchMap = new Map();
    if (needPatch) {
      const tracked = await runGit(["diff", "HEAD", "--no-color", "-U10"]);
      patchMap = splitPatch(tracked.out);
      for (const f of files) {
        if (f.status === "?") {
          const r = await runGit(["diff", "--no-index", "--no-color", "-U10", "--", "/dev/null", f.path], {
            expectDiffExit: true,
          });
          for (const [k, v] of splitPatch(r.out)) patchMap.set(k, v);
        }
      }
    }
    for (const f of files) {
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
  }

  for (const f of files) {
    const n = numstat.get(f.path);
    if (n) {
      f.added = n.added;
      f.deleted = n.deleted;
      if (n.added === "-") f.binary = true;
    } else if (!f.binary) {
      // `git diff HEAD --numstat` no cubre untracked: contamos del contenido
      // (o del parche --no-index) para que el resumen del panel sea real.
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

  return {
    workspace: WORKSPACE,
    branch: branchR.out.trim(),
    head: headR.out.trim(),
    dirty: files.length > 0,
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

async function signature() {
  const [s, n, h] = await Promise.all([
    runGit(["status", "--porcelain=v1", "-z"]),
    runGit(["diff", "HEAD", "--numstat"]),
    runGit(["rev-parse", "HEAD"]),
  ]);
  return createHash("sha1").update(`${s.out}\u0000${n.out}\u0000${h.out}`).digest("hex");
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
      "Get the live diff of the session workspace (git diff HEAD plus untracked files) as structured JSON: per-file path, status, added/deleted counts and unified patch. Opens the Diff Ask panel, where the user can also press '+' on any diff line to ask about that exact line.",
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
];

const RESOURCES = [
  { uri: PANEL_URI, name: "panel", mimeType: "text/html;profile=mcp-app" },
  { uri: DIFF_URI, name: "workspace-diff", mimeType: "application/json" },
];

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
      if (params.name !== "get_diff")
        return { content: [{ type: "text", text: `Unknown tool: ${params.name}` }], isError: true };
      const data = await buildDiff({
        includePatches: params.arguments?.include_patches !== false,
      });
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
              : `${data.fileCount} archivo(s) con cambios en ${data.branch} (${data.head})${data.truncated ? " — parches truncados" : ""}. Detalle en structuredContent.`,
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
      if (params.uri === DIFF_URI) {
        const data = await buildDiff();
        return {
          contents: [
            { uri: DIFF_URI, mimeType: "application/json", text: JSON.stringify(data) },
          ],
        };
      }
      throw new Error(`Unknown resource: ${params.uri}`);
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
