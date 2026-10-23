// Build the self-contained panel: bundle src/main.js (esbuild, iife) and inline
// it + panel.css into ../dist/panel.html (the file the MCP server serves as
// ui://diff-ask/panel.html). Enforces the host's 4 MiB HTML resource limit.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, "..", "dist");
const LIMIT = 4 * 1024 * 1024;

// Keep the panel under the host's 4 MiB HTML limit by stubbing the syntax
// highlighter backends and their heavy dynamic-import cargo (shiki language
// catalog, oniguruma/highlights wasm). Diffs render plain — same degradation
// the host shows for unknown languages.
const stub = (file) => path.join(HERE, "vendor", file);
const slimHighlighter = {
  name: "da-slim-highlighter",
  setup(builder) {
    builder.onResolve({ filter: /backends[\\/](shiki|highlights)\.js$/ }, () => ({
      path: stub("stub-backend.mjs"),
    }));
    builder.onResolve({ filter: /^(shiki|@shikijs)(\/|$)/ }, () => ({
      path: stub("stub-shiki.mjs"),
    }));
    builder.onResolve({ filter: /^@pierre\/highlights(\/|$)/ }, () => ({
      path: stub("stub-highlights.mjs"),
    }));
  },
};

const result = await build({
  entryPoints: [path.join(HERE, "src", "main.js")],
  bundle: true,
  format: "iife",
  target: "es2022",
  platform: "browser",
  minify: true,
  write: false,
  legalComments: "none",
  logLevel: "warning",
  plugins: [slimHighlighter],
});
let js = result.outputFiles[0].text;
// Never let a literal </script> inside the bundle close our inline script tag.
js = js.replace(/<\/script/gi, "<\\/script");
const css = fs.readFileSync(path.join(HERE, "src", "panel.css"), "utf8");

// Sello de build: la UI muestra qué versión corrés (vX.Y.Z en el askbar).
const manifest = JSON.parse(
  fs.readFileSync(path.join(HERE, "..", ".zcode-plugin", "plugin.json"), "utf8"),
);

function makeHtml(extraHead) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Diff Ask</title>
    <script>window.__DA_BUILD=${JSON.stringify(manifest.version)};</script>
    <style>${css}</style>
    ${extraHead}
  </head>
  <body>
    <div id="root">Cargando Diff Ask…</div>
    <script>${js}</script>
  </body>
</html>`;
}

const panel = makeHtml("");
const bytes = Buffer.byteLength(panel, "utf8");
if (bytes > LIMIT) {
  console.error(`panel.html is ${bytes} bytes — exceeds the 4 MiB resource limit`);
  process.exit(1);
}
fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, "panel.html"), panel);
console.log(`dist/panel.html — ${(bytes / 1024).toFixed(0)} KiB`);

// Optional visual-test harness: if the scratch repo exists, embed its real
// diff JSON so dist/dev.html renders the panel without the host (open it in
// any browser; main.js picks up window.__DA_TEST__).
const testRepo = "/tmp/da-testrepo";
if (fs.existsSync(path.join(testRepo, ".git"))) {
  const child = spawn("node", [path.join(HERE, "..", "server", "server.mjs")], {
    env: { ...process.env, ZCODE_WORKSPACE_ROOT: testRepo },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buf = "";
  const readDiff = new Promise((resolve) => {
    child.stdout.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2 && msg.result?.contents?.[0]?.text) resolve(msg.result.contents[0].text);
        } catch {}
      }
    });
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "build", version: "0" } } })}\n`,
  );
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "diff://workspace" } })}\n`);
  const json = await Promise.race([readDiff, new Promise((r) => setTimeout(() => r(null), 4000))]);
  child.kill();
  if (json) {
    const dev = makeHtml(
      `<script>window.__DA_TEST__ = ${json.replace(/</g, "\\u003c")};</script>`,
    );
    fs.writeFileSync(path.join(DIST, "dev.html"), dev);
    console.log(`dist/dev.html — visual harness con ${Buffer.byteLength(dev)} bytes`);
  }
}
