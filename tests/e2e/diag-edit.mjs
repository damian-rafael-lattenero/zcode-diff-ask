// DIAGNÓSTICO MANUAL (no corre en npm test — no matchea *.test.*):
// reproduce el reporte "en el edit y en el rollback aparece todo
// duplicado" — abre el panel, entra al modo ✏️, sale con Esc, fuerza 3
// refresh con contenido idéntico y cuenta secciones/filas/ocultas en cada
// paso. Uso: node tests/e2e/diag-edit.mjs (screenshots en tests/e2e/shots/).
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
//   - Enter = ↩ quirúrgico; palabra de una línea 100% nueva → SOLO la palabra (0.9.2)
//   - modo brocha ↩ del header: N pintadas acumuladas → UN rollback general (sin popups flotantes)
//   - UNA fila por línea modificada: roja pareada oculta, original al hover (0.9.4)
//   - coexistencia: dos palabras en la MISMA fila, drag multilínea multipalabra,
//     palabra gemela pinta UNA sola, y drag LENTO (>1.5s) sigue vivo (0.9.3)
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
// headless ignora --window-size a veces: fijar el viewport EXACTO para que
// las coordenadas de Input.dispatchMouseEvent (px CSS del viewport) coincidan
// con los getBoundingClientRect que medimos desde la página.
await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1900, deviceScaleFactor: 1, mobile: false });

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
    async locate(rel, needle, type, noScroll) {
      const entry = [...__DA.rendered.values()].find((e) => e.path === rel);
      if (!entry) return { error: "no entry " + rel };
      const host = entry.body.querySelector("diffs-container");
      if (!host?.shadowRoot) return { error: "no shadow" };
      for (const row of host.shadowRoot.querySelectorAll("[data-line]")) {
        if (row.querySelector("[data-line]")) continue; // wrapper, no fila real
        const t = row.dataset.lineType ?? "";
        if (type && t !== type) continue;
        const text = row.textContent ?? "";
        const idx = text.indexOf(needle);
        if (idx < 0) continue;
        if (!noScroll) row.scrollIntoView({ block: "center" });
        // esperar que el scroll TERMINE antes de medir (si fuera smooth,
        // medir a mitad de animación da coords que ya no valen al gestear).
        // noScroll = la fila ya está a la vista (medición doble sin invalidar
        // la primera con un scroll nuevo): medir directo.
        if (!noScroll) await new Promise((res) => {
          const root = document.getElementById("root");
          let last = null, same = 0, n = 0;
          const iv = setInterval(() => {
            const y = root.scrollTop;
            if (y === last) { if (++same >= 2) { clearInterval(iv); res(); } }
            else { same = 0; last = y; }
            if (++n > 60) { clearInterval(iv); res(); }
          }, 20);
        });
        const at = (target) => {
          const pos = { n: 0 };
          let lastText = null;
          const walk = (node) => {
            if (node.nodeType === 3) {
              lastText = node;
              if (pos.n + node.data.length > target) return { node, offset: Math.max(0, Math.min(target - pos.n, node.data.length)) };
              pos.n += node.data.length; return null;
            }
            for (const c of node.childNodes) { const r = walk(c); if (r) return r; }
            return null;
          };
          const hit = walk(row);
          if (hit) return hit;
          // target == fin EXACTO del texto de la fila: rango válido al final
          // del último nodo de texto (needles que terminan con la fila)
          if (lastText && pos.n === target) return { node: lastText, offset: lastText.data.length };
          return null;
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
        // fila OCULTA (la roja pareada, 0.9.4) u otro row sin geometría:
        // saltarla y seguir con la próxima que contenga el needle
        if (!full || full.width < 5) continue;
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
  window.__evts = [];
  var __log = (t) => (e) => {
    var dp = (t === "pointerdown" && window.__DA && __DA.dragPath) ? (" dp=" + __DA.dragPath.x0.toFixed(0) + "/" + (__DA.dragPath.detail || 1)) : "";
    window.__evts.push(t + "(" + e.clientX.toFixed(1) + "," + e.clientY.toFixed(1) + (t === "pointerdown" ? ",d" + (e.detail || 1) : "") + dp + ")");
    if (window.__evts.length > 40) window.__evts.shift();
  };
  for (var t of ["pointerdown", "pointerup", "pointermove", "click", "dblclick"])
    document.addEventListener(t, __log(t), true);
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
  // button:"left" en los moves es OBLIGATORIO: con "none" Chromium los toma
  // como hover y nunca extiende la selección (el drag no selecciona nada).
  move: (x, y) => cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 }),
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
    console.error("    diag:", await evalJs(`(document.querySelector('.diag-chip')?.__log ?? []).join(' ⏐ ')`).catch((e) => "diag?" + e.message));
    console.error("    selection:", JSON.stringify(await evalJs(`String(document.getSelection())`).catch(() => "?")));
    console.error("    allFrags:", JSON.stringify(await evalJs(`__E2E.allFrags()`).catch(() => "?")));
    await shot("debug-no-paint.png");
  }
  return ok;
};
const readDisk = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const waitDisk = async (rel, pred, label) => {
  const ok = await until(async () => pred(readDisk(rel)), 6000);
  if (!ok) {
    console.error(`    chips: ${JSON.stringify(await evalJs(`[...document.querySelectorAll(".sent-chip")].map((c) => c.textContent)`).catch(() => "?"))}`);
    console.error(`    ring:  ${(await evalJs("window.__evts").catch(() => "?")).slice(-16).join(" ")}`);
    console.error(`    diag:  ${(await evalJs(`(document.querySelector('.diag-chip')?.__log ?? []).join(' ⏐ ')`).catch(() => "?")).slice(-400)}`);
    await shot("debug-disk.png");
  }
  return ok;
};
// El refresh reactivo post-write llega ASÍNCRONO (server debounce 600ms +
// SSE): si un gesto arranca antes de que el re-render termine, las coords
// medidas quedan viejas y el mouse pinta OTRA fila. Esperamos a que el
// panel no vuelva a cambiar (generatedAt + archivos + scroll quietos).
const panelStable = async () => {
  let a, b, guard = 0;
  do {
    a = await evalJs(`JSON.stringify({g: __DA.diffData?.generatedAt, n: __DA.rendered.size, y: document.getElementById("root").scrollTop})`);
    await sleep(450);
    b = await evalJs(`JSON.stringify({g: __DA.diffData?.generatedAt, n: __DA.rendered.size, y: document.getElementById("root").scrollTop})`);
  } while (a !== b && ++guard < 20);
  return JSON.parse(b);
};
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


// ------------------------------------------------ DIAG: edit + rev + refresh
const countRows = async (rel) => await evalJs(`(() => {
  const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(rel)});
  const rows = [...e.body.querySelector("diffs-container").shadowRoot.querySelectorAll("[data-line]")].filter((r) => !r.querySelector("[data-line]"));
  const texts = rows.map((r) => (r.textContent ?? "").slice(0, 44));
  const dups = texts.filter((t, i) => t && texts.indexOf(t) !== i);
  return { n: rows.length, dups: [...new Set(dups)].slice(0, 6), hidden: rows.filter((r) => getComputedStyle(r).display === "none").length };
})()`);
try {
  await expandFile(SERVER_TS);
  console.log("D0 filas:", JSON.stringify(await countRows(SERVER_TS)));
  const editBtn = await evalJs(`(() => {
    const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(SERVER_TS)});
    e.section.querySelector(".file-head").scrollIntoView({ block: "start" });
    const b = e.section.querySelector(".fedit");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  console.log("D1 editBtn:", JSON.stringify(editBtn));
  if (editBtn) { await click(editBtn.x, editBtn.y); await sleep(1500); }
  console.log("D2 en EDIT:", JSON.stringify(await countRows(SERVER_TS)));
  await shot("diag-1-edit.png");
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(800);
  console.log("D3 tras Esc:", JSON.stringify(await countRows(SERVER_TS)));
  for (let i = 0; i < 3; i++) {
    await evalJs("__DA.refresh(true)"); await sleep(900);
    const secs = await evalJs(`[...__DA.rendered.values()].filter((e) => e.path === ${JSON.stringify("tests/diffs/server.ts")}).length`);
    console.log("D4 refresh " + (i + 1) + " -> secciones de server.ts:", secs, "rendered total:", await evalJs("__DA.rendered.size"));
  }
  console.log("D4b:", JSON.stringify(await countRows(SERVER_TS)));
  await shot("diag-2-tras-refresh.png");
} catch (e) {
  console.error("DIAG FAIL:", e?.message ?? e);
  await shot("diag-FAIL.png").catch(() => {});
} finally {
  clearInterval(drainNotifications);
  try { ws.close(); } catch {}
  chrome.kill("SIGKILL");
  server.kill("SIGKILL");
  harness.close();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 300);
  setTimeout(() => process.exit(0), 600);
}
