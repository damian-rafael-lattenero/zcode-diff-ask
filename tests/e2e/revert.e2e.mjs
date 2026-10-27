// E2E del revert quirúrgico con MOUSE REAL: lanza Chromium de verdad
// (CDP Input.dispatchMouseEvent = el mismo pipeline de input que el mouse
// del usuario), carga el panel REAL (dist/panel.html) puenteado al server
// MCP REAL (server.mjs por stdio) apuntado a ESTE repo, y verifica cada
// revert leyendo el archivo en disco (git-verificable). Nada de stubs de
// selección ni de escritura.
//
// Gestos ejercitados (los de Damian):
//   - doble-click → palabra exacta
//   - triple-click → línea entera
//   - drag izquierda→derecha → rango de chars exacto
//   - drag derecha→izquierda → mismo rango, normalizado
//   - drag de UNA letra
//   - drag vertical en el gutter → cajitas (revert de línea por números)
// Uso: node tests/e2e/revert.e2e.mjs   (requiere Google Chrome instalado)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PANEL = fs.readFileSync(path.join(REPO, "diff-ask/dist/panel.html"), "utf8");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = path.join(HERE, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const NOTES = "tests/diffs/notes.md";
const SERVER_TS = "tests/diffs/server.ts";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let step = 0;
const fails = [];

function log(msg) { console.log(`[${String(++step).padStart(2, "0")}] ${msg}`); }
function check(cond, label, extra = "") {
  if (cond) { log(`✓ ${label}`); return true; }
  fails.push(label + (extra ? ` — ${extra}` : ""));
  console.error(`    ✗ ${label} ${extra}`);
  return false;
}

// ------------------------------------------------ fixture: estado inicial
execFileSync("node", [path.join(HERE, "apply-fixture-mods.mjs")], { stdio: "inherit" });

// ------------------------------------------------ server MCP real (stdio)
const server = spawn("node", [path.join(REPO, "diff-ask/server/server.mjs")], {
  env: { ...process.env, ZCODE_WORKSPACE_ROOT: REPO },
  stdio: ["pipe", "pipe", "pipe"],
});
let rpcId = 0;
const rpcPending = new Map();
const rpcQueue = [];
let serverBuf = "";
server.stdout.on("data", (d) => {
  serverBuf += d;
  let nl;
  while ((nl = serverBuf.indexOf("\n")) !== -1) {
    const line = serverBuf.slice(0, nl).trim();
    serverBuf = serverBuf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && rpcPending.has(msg.id)) {
      const { res, rej } = rpcPending.get(msg.id);
      rpcPending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method) {
      rpcQueue.push(msg);
    }
  }
});
const serverLog = fs.createWriteStream(path.join(SHOTS, "server.log"));
server.stderr.on("data", (d) => serverLog.write(d));
function rpc(method, params = {}) {
  const id = ++rpcId;
  return new Promise((res, rej) => {
    rpcPending.set(id, { res, rej });
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

// ------------------------------------------------ harness http + SSE
const sseClients = new Set();
const harness = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/panel") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PANEL.replace("<head>", `<head><script>window.__DA_TEST__={files:[],workspace:${JSON.stringify(REPO)}};window.__DA_E2E__=true;</script>`));
  } else if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: hello\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  } else if (url.pathname === "/mcp" && req.method === "GET") {
    rpc("resources/read", { uri: url.searchParams.get("read") })
      .then((r) => { res.writeHead(200, { "content-type": "text/json" }); res.end(r.contents?.[0]?.text ?? "{}"); })
      .catch((e) => { res.writeHead(500); res.end(String(e?.message ?? e)); });
  } else if (url.pathname === "/mcp" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { tool, args } = JSON.parse(body);
      rpc("tools/call", { name: tool, arguments: args })
        .then((r) => { res.writeHead(200, { "content-type": "text/json" }); res.end(JSON.stringify(r.structuredContent ?? r ?? {})); })
        .catch((e) => { res.writeHead(200, { "content-type": "text/json" }); res.end(JSON.stringify({ error: String(e?.message ?? e) })); });
    });
  } else { res.writeHead(404); res.end(); }
});
await new Promise((r) => harness.listen(0, "127.0.0.1", r));
const PORT = harness.address().port;
const pushUpdate = () => { for (const c of sseClients) c.write("data: u\n\n"); };
const drainNotifications = setInterval(() => {
  while (rpcQueue.length) {
    const m = rpcQueue.shift();
    if (m.method === "notifications/resources/updated") pushUpdate();
  }
}, 150);
await rpc("resources/subscribe", { uri: "diff://workspace" }).catch(() => {});
log(`harness http://127.0.0.1:${PORT}/panel · server MCP suscripto (notificaciones → SSE)`);

// ------------------------------------------------ Chromium real + CDP
if (!fs.existsSync(CHROME)) { console.error("falta Google Chrome en /Applications"); process.exit(1); }
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "da-e2e-"));
const chrome = spawn(CHROME, [
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  `--user-data-dir=${profile}`, "--remote-debugging-port=0",
  "--window-size=1440,1900", "about:blank",
], { stdio: ["ignore", "ignore", "ignore"] });
const waitPort = async () => {
  for (let i = 0; i < 100; i++) {
    try {
      const f = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8");
      return { port: Number(f.split("\n")[0]), path: f.split("\n")[1] };
    } catch { await sleep(100); }
  }
  throw new Error("Chrome no abrió el puerto de debug");
};
const { port: cdpPort, path: cdpPath } = await waitPort();
const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r, rej) => { ws.onopen = r; ws.onerror = rej; });
let cdpId = 0;
const cdpPending = new Map();
const pageErrors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id !== undefined && cdpPending.has(m.id)) {
    const { res, rej } = cdpPending.get(m.id);
    cdpPending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  } else if (m.method === "Runtime.exceptionThrown") {
    pageErrors.push(m.params.exceptionDetails?.text ?? "exception");
  }
};
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const id = ++cdpId;
  cdpPending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, sessionId: SESSION }));
});
let SESSION = null;
const { targetId } = await (async () => {
  const id = ++cdpId;
  const p = new Promise((res, rej) => cdpPending.set(id, { res, rej }));
  ws.send(JSON.stringify({ id, method: "Target.createTarget", params: { url: "about:blank" } }));
  return p;
})();
SESSION = (await (async () => {
  const id = ++cdpId;
  const p = new Promise((res, rej) => cdpPending.set(id, { res, rej }));
  ws.send(JSON.stringify({ id, method: "Target.attachToTarget", params: { targetId, flatten: true } }));
  return p;
})()).sessionId;
await cdp("Page.enable");
await cdp("Runtime.enable");

const evalJs = async (expr) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result?.value;
};
const shot = async (name) => {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, "base64"));
};

// helpers de página: localizar filas/chars en el shadow del diff
await cdp("Page.navigate", { url: `http://127.0.0.1:${PORT}/panel` });
await sleep(700);
await evalJs(`(() => {
  window.__E2E = {
    head(rel) {
      const e = [...__DA.rendered.values()].find((x) => x.path === rel);
      if (!e) return null;
      const h = e.section.querySelector(".file-head");
      if (!h) return null;
      h.scrollIntoView({ block: "start" });
      const r = h.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, collapsed: e.section.classList.contains("collapsed") };
    },
    locate(rel, needle, type) {
      const entry = [...__DA.rendered.values()].find((e) => e.path === rel);
      if (!entry) return { error: "no entry " + rel };
      const host = entry.body.querySelector("diffs-container");
      if (!host?.shadowRoot) return { error: "no shadow" };
      for (const row of host.shadowRoot.querySelectorAll("[data-line]")) {
        const t = row.dataset.lineType ?? "";
        if (type && t !== type) continue;
        const text = row.textContent ?? "";
        const idx = text.indexOf(needle);
        if (idx < 0) continue;
        row.scrollIntoView({ block: "center" });
        const at = (target) => {
          const pos = { n: 0 };
          const walk = (node) => {
            if (node.nodeType === 3) {
              if (pos.n + node.data.length > target) return { node, offset: Math.max(0, Math.min(target - pos.n, node.data.length)) };
              pos.n += node.data.length; return null;
            }
            for (const c of node.childNodes) { const r = walk(c); if (r) return r; }
            return null;
          };
          return walk(row);
        };
        const box = (a, b) => {
          const A = at(a), B = at(b);
          if (!A || !B) return null;
          const r = document.createRange();
          r.setStart(A.node, A.offset);
          try { r.setEnd(B.node, B.offset); } catch { return null; }
          return r.getBoundingClientRect();
        };
        const full = box(idx, idx + needle.length);
        if (!full || full.width < 5) return { error: "rect degenerado (¿archivo colapsado?) para " + needle };
        const chars = [];
        for (let i = 0; i < needle.length; i++) {
          const c = box(idx + i, idx + i + 1);
          if (c) chars.push({ left: c.left, right: c.right });
        }
        const gutter = host.shadowRoot.querySelector("[data-gutter]")?.getBoundingClientRect();
        return { line: row.dataset.line, type: t, rowText: text, idx,
          left: full.left, right: full.right, top: full.top, bottom: full.bottom,
          y: (full.top + full.bottom) / 2, chars,
          gutterX: gutter ? gutter.right + 2 : null };
      }
      return { error: "sin fila con " + needle + " (" + type + ")" };
    },
    frags(rel) { return [...(__DA.fragSel.get(rel) ?? [])].map((f) => ({ text: f.text, offA: f.offA, offB: f.offB, first: f.firstRowIdx, last: f.lastRowIdx })); },
    allFrags() { const o = {}; for (const [p, v] of __DA.fragSel) o[p] = v.map((f) => ({ text: f.text, first: f.firstRowIdx, last: f.lastRowIdx })); return o; },
    stripes(rel) { const e = [...__DA.rendered.values()].find((x) => x.path === rel); return e ? e.body.querySelectorAll(".frag-stripe").length : -1; },
    hasRowText(rel, needle) {
      const e = [...__DA.rendered.values()].find((x) => x.path === rel);
      if (!e) return false;
      const h = e.body.querySelector("diffs-container");
      return [...h.shadowRoot.querySelectorAll("[data-line]")].some((r) => (r.textContent ?? "").includes(needle));
    },
    popRev() { const b = document.querySelector(".sel-pop .rev"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; },
    errors() { return [...document.querySelectorAll(".state.error")].map((d) => d.textContent); },
  };
})()`);
await evalJs(`__DA.refresh(true)`);
await (async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (await evalJs(`__DA.rendered.size >= 9`)) return;
    await sleep(150);
  }
  throw new Error("el panel no renderizó los 9 archivos del fixture");
})();
log(`panel: ${await evalJs("__DA.rendered.size")} archivos en el diff (Trabajo vs HEAD)`);

// ------------------------------------------------ mouse real
const mouse = {
  press: (x, y, c = 1) => cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: c }),
  release: (x, y, c = 1) => cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: c }),
  move: (x, y) => cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 1 }),
};
async function click(x, y) { await mouse.press(x, y); await mouse.release(x, y); }
async function dblclick(x, y) {
  await mouse.press(x, y); await mouse.release(x, y); await sleep(80);
  await mouse.press(x, y, 2); await mouse.release(x, y, 2);
}
async function tripleclick(x, y) {
  await mouse.press(x, y); await mouse.release(x, y); await sleep(80);
  await mouse.press(x, y, 2); await mouse.release(x, y, 2); await sleep(80);
  await mouse.press(x, y, 3); await mouse.release(x, y, 3);
}
async function drag(x0, y0, x1, y1, steps = 14) {
  await mouse.press(x0, y0);
  for (let i = 1; i <= steps; i++) { await mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await sleep(14); }
  await mouse.release(x1, y1);
}
const until = async (fn, ms = 5000, stepMs = 90) => {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(stepMs); }
  return v;
};
const waitPaint = async (rel, n) => {
  const ok = await until(async () => ((await evalJs(`__E2E.frags(${JSON.stringify(rel)})`)).length >= n ? true : false), 5000);
  if (!ok) {
    console.error("    diag:", await evalJs(`(document.querySelector('.diag-chip')?.__log ?? []).slice(-20).join(' ⏐ ')`).catch((e) => "diag?" + e.message));
    console.error("    selection:", JSON.stringify(await evalJs(`String(document.getSelection())`).catch(() => "?")));
    console.error("    allFrags:", JSON.stringify(await evalJs(`__E2E.allFrags()`).catch(() => "?")));
    await shot("debug-no-paint.png");
  }
  return ok;
};
const readDisk = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const waitDisk = async (rel, pred, label) => until(async () => pred(readDisk(rel)), 6000);
const expandFile = async (rel) => {
  const h = await evalJs(`__E2E.head(${JSON.stringify(rel)})`);
  if (!h) throw new Error("sin header para " + rel);
  if (h.collapsed) { await click(h.x, h.y); await sleep(350); }
  const h2 = await evalJs(`__E2E.head(${JSON.stringify(rel)})`);
  if (h2.collapsed) throw new Error("no pude expandir " + rel);
};
const clickRevert = async () => {
  const p = await until(async () => await evalJs("__E2E.popRev()"), 3000);
  if (!p) throw new Error("no apareció el popup ↩");
  await click(p.x, p.y);
};

try {
  // ============ A. doble-click en la palabra cambiada "singular" ============
  await expandFile(NOTES);
  let loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "singular", "change-addition")`);
  check(loc && !loc.error, "localizo fila verde con 'singular'", loc?.error ?? "");
  await dblclick((loc.left + loc.right) / 2, loc.y);
  await waitPaint(NOTES, 1);
  let frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
  check(frags.length === 1 && frags[0].text === "singular", `doble-click pinta la palabra exacta (frags: ${JSON.stringify(frags.map((f) => f.text))})`);

  // ============ B. drag izq→der de 3 letras "pai" de la palabra AGREGADA "painted" ============
  loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "painted", "change-addition")`);
  check(loc && !loc.error, "localizo fila verde con 'painted'", loc?.error ?? "");
  await drag(loc.chars[0].left + 1.5, loc.y, loc.chars[2].right - 1.5, loc.y);
  await waitPaint(NOTES, 2);
  frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
  const painted3 = frags[frags.length - 1]?.text ?? "";
  check(frags.length === 2, "las DOS selecciones quedan pintadas (acumulación)", JSON.stringify(frags.map((f) => f.text)));
  check(frags.some((f) => f.text === "singular"), "la primera palabra SIGUE pintada tras la segunda selección");
  check(painted3 === "pai", `drag izq→der toma 3 letras exactas (${JSON.stringify(painted3)})`);
  const stripes = await evalJs(`__E2E.stripes(${JSON.stringify(NOTES)})`);
  check(stripes >= 2, `franjas visibles: ${stripes}`);
  await shot("01-dos-frags-pintadas.png");

  // ============ C. ↩ del popup: revert de palabra+letras en UNA escritura ============
  const beforeDisk = readDisk(NOTES);
  check(beforeDisk.includes("singular words inside") && beforeDisk.includes("amber painted stripes"), "disco pre-revert tiene los dos cambios");
  await clickRevert();
  await waitDisk(NOTES, (c) => c.includes("individual words inside"), "m1 restaurada");
  const afterC = readDisk(NOTES);
  check(afterC.includes("individual words inside"), "git/disco: 'singular' volvió a 'individual' (línea restaurada al original)");
  check(!afterC.includes("amber painted stripes") && afterC.includes("amber " + "painted".replace(painted3, "") + " stripes"),
    `git/disco: las 3 letras '${painted3}' se fueron de 'painted' (quedó 'painted'.replace)`, JSON.stringify(afterC.match(/visible as amber.*stripes/)?.[0] ?? ""));
  check(await until(async () => (await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`)).length === 0), "frags despintados tras el revert");
  check(await until(async () => !(await evalJs(`__E2E.hasRowText(${JSON.stringify(NOTES)}, "singular")`))), "el panel RECARGÓ el diff: 'singular' ya no está en las filas");
  await shot("02-tras-revert-palabra+letras.png");

  // ============ D. drag DER→IZQ de 3 letras "cit" de "explicitly" ============
  loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "explicitly", "change-addition")`);
  check(loc && !loc.error, "localizo fila verde con 'explicitly'", loc?.error ?? "");
  await drag(loc.chars[5].right - 1.5, loc.y, loc.chars[3].left + 1.5, loc.y); // t←i←c: derecha a izquierda
  await waitPaint(NOTES, 1);
  frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
  check(frags.length === 1 && frags[0].text === "cit" && frags[0].offA < frags[0].offB,
    `drag derecha→izquierda pinta 'cit' normalizado (${JSON.stringify(frags[0]?.text)})`);

  // ============ E. drag de UNA letra "m" de "simple" ============
  loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "simple", "change-addition")`);
  check(loc && !loc.error, "localizo fila verde con 'simple'", loc?.error ?? "");
  await drag(loc.chars[1].left + 1.2, loc.y, loc.chars[1].right - 1.2, loc.y); // la "m" solita
  await waitPaint(NOTES, 2);
  frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
  const oneLetter = frags[frags.length - 1]?.text ?? "";
  check(frags.length === 2 && oneLetter.length === 1, `seleccionar UNA letra funciona (${JSON.stringify(frags.map((f) => f.text))})`);
  await shot("03-letra-unica+y-cit.png");

  // ============ F. ↩ de las dos quirúrgicas juntas ============
  await clickRevert();
  await waitDisk(NOTES, (c) => !c.includes("explicitly talks") && !c.includes("simple bullet"), "D+E aplicadas");
  const afterF = readDisk(NOTES);
  check(afterF.includes("explicitly".replace("cit", "") + " talks"), `git/disco: 'cit' removidas → 'explly talks' (${afterF.match(/bravo section.*talks/)?.[0] ?? ""})`);
  check(afterF.includes("simple".replace(oneLetter, "") + " bullet lists"), `git/disco: la letra '${oneLetter}' removida → 'siple' (${afterF.match(/Delta adds.*lists/)?.[0] ?? ""})`);
  await shot("04-tras-revert-letras.png");

  // ============ G. triple-click en la fila de tabla cambiada → línea entera ============
  loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "chosen", "change-addition")`);
  check(loc && !loc.error, "localizo fila verde de la tabla con 'chosen'", loc?.error ?? "");
  await tripleclick((loc.left + loc.right) / 2, loc.y);
  await waitPaint(NOTES, 1);
  frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
  check(frags.length === 1 && frags[0].offA === 0 && frags[0].offB === loc.rowText.length && frags[0].text === loc.rowText,
    `triple-click pinta la LÍNEA entera (${frags[0]?.offA}..${frags[0]?.offB} de ${loc.rowText.length})`);
  await clickRevert();
  await waitDisk(NOTES, (c) => c.includes("| alpha  | select   |") && !c.includes("chosen"), "línea de tabla restaurada");
  check(readDisk(NOTES).includes("| alpha  | select   |"), "git/disco: línea entera revertida al original (sin rebota)");
  check(await until(async () => !(await evalJs(`__E2E.hasRowText(${JSON.stringify(NOTES)}, "chosen")`))), "panel recargado: 'chosen' desapareció del diff");
  await shot("05-tras-revert-linea-tripleclick.png");

  // ============ H. palabra en fila ROJA (línea borrada) → la línea vuelve ============
  loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "second bullet", "change-deletion")`);
  check(loc && !loc.error, "localizo fila ROJA con 'second bullet'", loc?.error ?? "");
  const wordLoc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "second", "change-deletion")`);
  await dblclick((wordLoc.left + wordLoc.right) / 2, wordLoc.y);
  await waitPaint(NOTES, 1);
  frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
  check(frags.length === 1 && frags[0].text === "second", `doble-click en fila roja pinta '${frags[0]?.text}'`);
  await clickRevert();
  await waitDisk(NOTES, (c) => c.includes("- second bullet with the word bravo inside"), "línea borrada restaurada");
  check(readDisk(NOTES).includes("- second bullet with the word bravo inside"), "git/disco: la línea BORRADA volvió entera");
  await shot("06-tras-revert-fila-roja.png");

  // ============ I. cajitas del gutter (drag vertical) → revert de línea en server.ts ============
  await expandFile(SERVER_TS);
  loc = await evalJs(`__E2E.locate(${JSON.stringify(SERVER_TS)}, '"ready"', "change-addition")`);
  check(loc && !loc.error, "localizo fila verde con \\\"ready\\\" en server.ts", loc?.error ?? "");
  check(loc.gutterX, "tengo la coordenada del gutter");
  await drag(loc.gutterX, loc.y, loc.gutterX + 2, loc.y + 9, 6);
  await until(async () => (await evalJs(`__DA.boxSel.size`)) > 0);
  await clickRevert();
  await waitDisk(SERVER_TS, (c) => c.includes('status: "running"'), "server.ts restaurado");
  check(readDisk(SERVER_TS).includes('status: "running"') && !readDisk(SERVER_TS).includes('"ready"'),
    "git/disco: cajitas del gutter revierten la línea de server.ts");
  await shot("07-tras-revert-cajitas-gutter.png");

  // ============ salud general del panel ============
  check(pageErrors.length === 0, `sin excepciones en la página (${pageErrors.length})`, pageErrors.slice(0, 3).join(" | "));
  check((await evalJs("__E2E.errors()")).length === 0, "sin carteles de error en el panel", JSON.stringify(await evalJs("__E2E.errors()")));
} catch (e) {
  fails.push(`EXCEPCIÓN: ${e?.message ?? e}`);
  await shot("FAIL.png").catch(() => {});
} finally {
  clearInterval(drainNotifications);
  await shot("08-final.png").catch(() => {});
  try { ws.close(); } catch {}
  chrome.kill("SIGKILL");
  server.kill("SIGKILL");
  harness.close();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 300);
}

console.log("");
if (fails.length) {
  console.error(`E2E ✗ — ${fails.length} fallas:`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`E2E ✓ — todos los gestos y reverts verificados con git (screenshots en tests/e2e/shots/)`);
// el playground queda en su estado completo para jugar a mano
execFileSync("node", [path.join(HERE, "apply-fixture-mods.mjs")], { stdio: "inherit" });
