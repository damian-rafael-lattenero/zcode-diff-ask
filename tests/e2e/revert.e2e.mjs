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
    res.end(PANEL.replace("<head>", `<head><script>window.__DA_TEST__={files:[],workspace:${JSON.stringify(REPO)}};window.__DA_E2E__=true;window.__DA_HL_READY={has:()=>true,lines:(t)=>String(t).split("\\n").map((l)=>[{content:l}])};</script>`));
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
      h.scrollIntoView({ block: "center" });
      return new Promise((res) => {
        // esperar el settle del scroll ANTES de medir (igual que locate):
        // un scroll largo mido a mitad de animación = coords viejas. Y con
        // block:"center" el header queda a mitad del viewport: con
        // block:"start" quedaba pegado arriba DEBAJO de la modebar sticky
        // y el click se perdía en la barra (visto con config.json). El click
        // apunta al CHEVRON, el toggle real.
        const root = document.getElementById("root");
        let last = null, same = 0, n = 0;
        const done = () => {
          const t = h.querySelector(".chev") ?? h;
          const r = t.getBoundingClientRect();
          res({ x: r.left + r.width / 2, y: r.top + r.height / 2, collapsed: e.section.classList.contains("collapsed") });
        };
        const iv = setInterval(() => {
          const y = root.scrollTop;
          if (y === last) {
            if (++same >= 2) { clearInterval(iv); done(); }
          } else { same = 0; last = y; }
          if (++n > 60) { clearInterval(iv); done(); }
        }, 20);
      });
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
    rowAt(rel, x, y) {
      const e = [...__DA.rendered.values()].find((x2) => x2.path === rel);
      const host = e?.body.querySelector("diffs-container");
      const r = host?.shadowRoot?.elementFromPoint(x, y)?.closest("[data-line]");
      return r ? { type: r.dataset.lineType, text: (r.textContent ?? "").slice(0, 44) } : null;
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
// tolerante al boot: con el stub del highlighter el bundle puede tardar un
// poco más que el sleep fijo — esperar a que __DA exista antes del refresh
await evalJs(`window.__daErr = []; if (!window.__daHooked) { window.__daHooked = 1; window.addEventListener("error", (e) => window.__daErr.push(String(e.message).slice(0, 200) + " @" + String(e.filename).slice(-40) + ":" + e.lineno)); }`).catch(() => {});
for (let i = 0; i < 100 && (await evalJs(`typeof __DA`).catch(() => "x")) !== "object"; i++) await sleep(100);
if ((await evalJs(`typeof __DA`).catch(() => "x")) !== "object") {
  console.error("BOOT FAIL — errores de página:", await evalJs(`JSON.stringify(window.__daErr)`).catch((e) => "eval: " + e.message));
  console.error("BOOT FAIL — body:", await evalJs(`JSON.stringify((document.body?.innerText ?? "").slice(0, 120))`).catch(() => "?"));
  console.error("BOOT FAIL — scripts:", await evalJs(`[...document.scripts].map((s) => s.src || "inline " + (s.textContent ?? "").length).join(" | ").slice(0, 200)`).catch(() => "?"));
}
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
  // hasta 3 intentos: el click puede caer en un botón del header o medirse
  // contra un layout que todavía se acomoda (visto tras un revert + refresh)
  for (let i = 0; i < 3; i++) {
    const h = await evalJs(`__E2E.head(${JSON.stringify(rel)})`);
    if (!h) throw new Error("sin header para " + rel);
    if (!h.collapsed) return h;
    await click(h.x, h.y);
    await sleep(350);
  }
  const h2 = await evalJs(`__E2E.head(${JSON.stringify(rel)})`);
  if (h2.collapsed) throw new Error("no pude expandir " + rel);
  return h2;
};
const clickRevert = async () => {
  const p = await until(async () => await evalJs("__E2E.popRev()"), 3000);
  if (!p) throw new Error("no apareció el popup ↩");
  await click(p.x, p.y);
};

try {
await mouse.move(500, 900);
await sleep(120);
console.error("    viewport:", JSON.stringify(await evalJs(`({iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, pm: window.__pm, scrollY: document.getElementById("root").scrollTop})`)));
  // ============ A. doble-click en la palabra cambiada "singular" ============
  await expandFile(NOTES);
  let loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "singular", "change-addition")`);
  check(loc && !loc.error, "localizo fila verde con 'singular'", loc?.error ?? "");
  await dblclick((loc.left + loc.right) / 2, loc.y);
  await waitPaint(NOTES, 1);
  let frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
  check(frags.length === 1 && frags[0].text === "singular", `doble-click pinta la palabra exacta (frags: ${JSON.stringify(frags.map((f) => f.text))})`);

  await panelStable();
  // ============ B. drag izq→der de 3 letras "pai" de la palabra AGREGADA "painted" ============
  loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "painted", "change-addition")`);
  check(loc && !loc.error, "localizo fila verde con 'painted'", loc?.error ?? "");
  await drag(loc.chars[0].left + 1, loc.y, loc.chars[2].right + 1.5, loc.y);
  await waitPaint(NOTES, 2);
  frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
  const painted3 = frags[frags.length - 1]?.text ?? "";
  check(frags.length === 2, "las DOS selecciones quedan pintadas (acumulación)", JSON.stringify(frags.map((f) => f.text)));
  check(frags.some((f) => f.text === "singular"), "la primera palabra SIGUE pintada tras la segunda selección");
  check(painted3.length >= 2 && painted3.length <= 4 && "painted".startsWith(painted3),
    `drag izq→der toma letras exactas de 'painted' (${JSON.stringify(painted3)})`);
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

  await panelStable();
  // ============ D. drag DER→IZQ de 3 letras "cit" de "explicitly" ============
  loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "explicitly", "change-addition")`);
  check(loc && !loc.error, "localizo fila verde con 'explicitly'", loc?.error ?? "");
  // derecha→izquierda: arranco pasado el borde de la última letra (off 8) y termino adentro de la primera (off 5)
  await drag(loc.chars[7].right + 1.5, loc.y, loc.chars[5].left + 1, loc.y);
  await waitPaint(NOTES, 1);
  frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
  const cit = frags[0]?.text ?? "";
  check(frags.length === 1 && frags[0].offA < frags[0].offB && cit.length >= 2 && "explicitly".includes(cit),
    `drag derecha→izquierda pinta letras de 'explicitly' normalizadas offA<offB (${JSON.stringify(cit)})`);

  await panelStable();
  // ============ E. drag de UNA letra "m" de "simple" ============
  loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "simple", "change-addition")`);
  check(loc && !loc.error, "localizo fila verde con 'simple'", loc?.error ?? "");
  await drag(loc.chars[2].left + 1, loc.y, loc.chars[2].right + 1.5, loc.y); // la "m" solita
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

  await panelStable();
  // ============ G. triple-click en la fila de tabla cambiada → línea entera ============
  loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "chosen", "change-addition")`);
  check(loc && !loc.error, "localizo fila verde de la tabla con 'chosen'", loc?.error ?? "");
  await tripleclick((loc.left + loc.right) / 2, loc.y);
  console.error(`    dragPath tras triple: ${JSON.stringify(await evalJs("(() => { const d = __DA.dragPath; return d ? { d: d.detail, x0: d.x0, y0: d.y0 } : null; })()"))}`);
  await waitPaint(NOTES, 1);
  frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
  // el gesto ES click,click,click: el dblclick intermedio pinta la palabra
  // (comportamiento nativo) y el 3er click la promueve a línea entera —
  // aceptamos la palabra si el click-merge perdió la carrera; el disco manda
  check(frags.length >= 1 && frags.some((f) => f.offA === 0 || f.text === "chosen"),
    `triple-click pinta (frags: ${JSON.stringify(frags.map((f) => f.text.slice(0, 14)))})`);
  await clickRevert();
  await waitDisk(NOTES, (c) => c.includes("| alpha  | select   |") && !c.includes("chosen"), "línea de tabla restaurada");
  check(readDisk(NOTES).includes("| alpha  | select   |"), "git/disco: línea entera revertida al original (sin rebota)");
  check(await until(async () => !(await evalJs(`__E2E.hasRowText(${JSON.stringify(NOTES)}, "chosen")`))), "panel recargado: 'chosen' desapareció del diff");
  await shot("05-tras-revert-linea-tripleclick.png");

  await panelStable();
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

  await panelStable();
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

  await panelStable();
  // ============ J. Enter + palabra en línea de ADICIÓN PURA: quirúrgico (0.9.2) ============
  // El reporte de Damian: "elijo 3 palabras de 3 filas, aprieto enter en el
  // rollback y me rollbackea las 3 LÍNEAS". Enter ahora ES el atajo del ↩
  // quirúrgico, y pintar una palabra de una línea 100% nueva borra SOLO la
  // palabra — la línea queda (0.9.1 la eliminaba entera).
  loc = await evalJs(`__E2E.locate(${JSON.stringify(SERVER_TS)}, "/delta", "change-addition")`);
  check(loc && !loc.error, "localizo la línea nueva de la ruta /delta", loc?.error ?? "");
  const jx = (loc.left + loc.right) / 2;
  // diagnóstico de puntería: ¿qué fila hay bajo el punto ANTES del gesto y
  // tras el primer click del doble? (si el panel se movió, ací se ve)
  const jRowBefore = await evalJs(`__E2E.rowAt(${JSON.stringify(SERVER_TS)}, ${jx}, ${loc.y})`);
  await dblclick(jx, loc.y);
  const jRowAfter = await evalJs(`__E2E.rowAt(${JSON.stringify(SERVER_TS)}, ${jx}, ${loc.y})`);
  const jSel = await evalJs("String(getSelection())");
  await waitPaint(SERVER_TS, 1);
  frags = await evalJs(`__E2E.frags(${JSON.stringify(SERVER_TS)})`);
  check(frags.length === 1 && frags[0].text === "delta",
    `doble-click pinta 'delta' en la línea nueva`,
    `frags=${JSON.stringify(frags.map((f) => f.text))} sel=${JSON.stringify(jSel)} rowBefore=${JSON.stringify(jRowBefore)} rowAfter=${JSON.stringify(jRowAfter)} locRow=${JSON.stringify((loc?.rowText ?? "").slice(0, 40))}`);
  await evalJs("document.activeElement?.blur?.()");
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitDisk(SERVER_TS, (c) => c.includes('register("GET", "/", async () => {'), "palabra delta removida quirúrgicamente");
  const afterJ = readDisk(SERVER_TS);
  check(afterJ.includes('register("GET", "/", async () => {') && !afterJ.includes('"/delta"'),
    "git/disco: se fue SOLO la palabra 'delta' — la línea nueva SIGUE en el archivo");
  check(afterJ.includes('return new Response("delta", { status: 200 });') && afterJ.includes("});"),
    "las líneas hermanas del bloque NO se tocaron");
  check(await until(async () => !(await evalJs(`__E2E.hasRowText(${JSON.stringify(SERVER_TS)}, "/delta")`))),
    "panel recargado: la palabra /delta desapareció del diff");
  await shot("09-tras-enter-quirurgico-adicion-pura.png");

  await panelStable();
  // ============ K. modo brocha ↩: pintar de TODO y UN rollback general (spec Damian) ============
  // "pinto 6 palabras seguidas, 4 palabras en otra línea, doble-click una
  // palabra en otra, 3 letras en otra → aprieto el rollback general y se
  // revierten todos esos chars" — sin popups flotantes en el modo.
  const TYPES_GO = "tests/diffs/types.go";
  await expandFile(TYPES_GO);
  const revBtn = await evalJs(`(() => {
    const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(TYPES_GO)});
    e.section.querySelector(".file-head").scrollIntoView({ block: "start" });
    const b = e.section.querySelector(".fmode-rev");
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await click(revBtn.x, revBtn.y); // entra al modo brocha ↩
  await sleep(150);
  check(await evalJs(`__DA.fragModes.get(${JSON.stringify(TYPES_GO)})`) === "rev", "modo brocha ↩ activo");

  // un gesto por vez, con trace completo si no pinta
  let kCount = 0;
  const kGesture = async (tag, fn) => {
    await evalJs("window.__evts.length = 0");
    await fn();
    await sleep(800); // respaldo pointerup = 180ms + margen
    const now = (await evalJs(`__E2E.frags(${JSON.stringify(TYPES_GO)})`)).length;
    if (now <= kCount) {
      console.error(`    [${tag}] evts: ${(await evalJs("window.__evts")).join(" ")}`);
      console.error(`    [${tag}] sel:   ${JSON.stringify(await evalJs("String(document.getSelection())"))}`);
      console.error(`    [${tag}] dragP: ${JSON.stringify(await evalJs("(() => { const d = __DA.dragPath; return d ? { x0: d.x0, y0: d.y0, age: Date.now() - d.at, detail: d.detail } : null; })()"))}`);
      console.error(`    [${tag}] uiPtr: ${JSON.stringify(await evalJs("window.__DA ? (__DA.lastUiPointerRef ? __DA.lastUiPointerRef.value : 'n/a') : 'n/a'"))}`);
      console.error(`    [${tag}] diag:  ${await evalJs("(document.querySelector('.diag-chip')?.__log ?? []).slice(-6).join(' ⏐ ')")}`);
    }
    check(now > kCount, `${tag}: el gesto pintó`);
    kCount = now;
  };

  // K1: 5 palabras seguidas del comentario nuevo (drag)
  loc = await evalJs(`__E2E.locate(${JSON.stringify(TYPES_GO)}, "Render formats the record as one", "change-addition")`);
  check(loc && !loc.error, "K1 localizo las 5 palabras del comentario", loc?.error ?? "");
  if (loc && !loc.error) await kGesture("K1-drag-5-palabras", () => drag(loc.chars[0].left + 1, loc.y, loc.chars[loc.chars.length - 1].right + 1.5, loc.y));

  // K2: doble-click UNA palabra ("Render" de la firma)
  loc = await evalJs(`__E2E.locate(${JSON.stringify(TYPES_GO)}, "Record) Render() string", "change-addition")`);
  check(loc && !loc.error, "K2 localizo la firma del Render", loc?.error ?? "");
  if (loc && !loc.error) {
    const rw = await evalJs(`__E2E.locate(${JSON.stringify(TYPES_GO)}, "Render() string", "change-addition")`);
    await kGesture("K2-dblclick-palabra", () => dblclick((rw.chars[2].left + rw.chars[2].right) / 2, rw.y));
  }

  // K3: 3 letras de "Title" en el return nuevo (drag)
  loc = await evalJs(`__E2E.locate(${JSON.stringify(TYPES_GO)}, "return r.Title", "change-addition")`);
  check(loc && !loc.error, "K3 localizo el return r.Title", loc?.error ?? "");
  if (loc && !loc.error) await kGesture("K3-drag-3-letras", () => drag(loc.chars[loc.chars.length - 3].left + 1, loc.y, loc.chars[loc.chars.length - 1].right + 1.5, loc.y));

  // K4: una palabra de la línea MODIFICADA (doble-click "Heading")
  loc = await evalJs(`__E2E.locate(${JSON.stringify(TYPES_GO)}, "Heading string", "change-addition")`);
  check(loc && !loc.error, "K4 localizo la línea modificada Heading", loc?.error ?? "");
  if (loc && !loc.error) await kGesture("K4-dblclick-Heading", () => dblclick((loc.chars[3].left + loc.chars[3].right) / 2, loc.y));

  check(kCount === 4, `las CUATRO pintadas acumulan juntas (${kCount})`, "");
  check(await evalJs(`document.querySelector(".sel-pop") === null`), "SIN popup flotante en modo brocha");

  await click(revBtn.x, revBtn.y); // el rollback GENERAL: ejecuta todo lo pintado
  await waitDisk(TYPES_GO, (c) => c.includes("\tTitle string"), "Title string restaurado");
  const afterK = readDisk(TYPES_GO);
  check(afterK.includes("\tTitle string"), "K4: palabra de línea modificada → línea al original (Title)");
  check(!afterK.includes("formats the record") && afterK.includes("line."), "K1: las 5 palabras del comentario se fueron quirúrgicamente");
  check(afterK.includes("func (r Record) () string {"), "K2: SOLO la palabra 'Render' removida de la firma");
  check(afterK.includes("return r.Ti") && !afterK.includes("return r.Title"), "K3: SOLO las 3 letras 'tle' removidas del return");
  check(await until(async () => (await evalJs(`__E2E.frags(${JSON.stringify(TYPES_GO)})`)).length === 0), "frags despintados tras el rollback general");
  await shot("10-tras-rollback-general-modo-brocha.png");

  await panelStable();
  // ============ L. coexistencia + gemelas + drag lento (spec Damian 0.9.3) ============
  // "no puedo hacer selección multilinea multipalabra: se despinta lo
  // pintado al pintar lo nuevo" + "me selecciona todas las idénticas".
  const PARSER_PY = "tests/diffs/parser.py";
  await expandFile(PARSER_PY);
  const pFrags = async () => (await evalJs(`__E2E.frags(${JSON.stringify(PARSER_PY)})`));

  // L1: DOS palabras en la MISMA fila — coexisten (antes el filtro por filas
  // despintaba la primera al pintar la segunda)
  loc = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, "Marker words:")`);
  check(loc && !loc.error, "L1 localizo la línea Marker", loc?.error ?? "");
  await dblclick((loc.chars[2].left + loc.chars[2].right) / 2, loc.y); // "Marker"
  await sleep(500);
  const locAlpha = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, "alpha (tokens)")`);
  await dblclick((locAlpha.chars[2].left + locAlpha.chars[2].right) / 2, locAlpha.y); // "alpha"
  await sleep(500);
  let pf = await pFrags();
  check(pf.length === 2 && pf.some((f) => f.text === "Marker") && pf.some((f) => f.text === "alpha"),
    `L1: dos palabras de la MISMA fila coexisten (${JSON.stringify(pf.map((f) => f.text))})`);

  // L2: drag MULTILÍNEA multipalabra — de "render" a "join" (dos filas)
  const a2 = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, "def render(tokens):")`);
  // sin re-scroll: el locate del join movería las filas y volvería stale a2
  const b2 = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, 'return " ".join', null, true)`);
  check(a2 && !a2.error && b2 && !b2.error, "L2 localizo render y join", a2?.error ?? b2?.error ?? "");
  await drag((a2.chars[6].left + a2.chars[6].right) / 2, a2.y, b2.chars[b2.chars.length - 1].right + 1.5, b2.y);
  await sleep(700);
  pf = await pFrags();
  check(pf.length === 3 && pf.some((f) => f.first !== f.last),
    `L2: drag multilínea pinta UN frag de dos filas y NO despinta lo anterior (${JSON.stringify(pf.map((f) => f.text.slice(0, 8)))})`);

  // L4: drag LENTO (>1.5s) multilínea — el gesto geométrico sigue vivo.
  // Re-ubico fresco (L2 pintó overlays; coordenadas al día).
  const a4 = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, "def render(tokens):")`);
  const b4 = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, 'return " ".join', null, true)`);
  check(a4 && !a4.error && b4 && !b4.error, "L4 re-localizo render y join", a4?.error ?? b4?.error ?? "");
  await mouse.press((a4.chars[0].left + a4.chars[0].right) / 2, a4.y);
  for (let i = 1; i <= 8; i++) {
    await mouse.move((a4.chars[0].left + a4.chars[0].right) / 2 + ((b4.right - a4.chars[0].left) * i) / 8, a4.y + ((b4.y - a4.y) * i) / 8);
    await sleep(210);
  }
  await mouse.release(b4.right + 1.5, b4.y);
  await sleep(700);
  pf = await pFrags();
  check(pf.length === 3 && pf.some((f) => f.first !== f.last),
    `L4: drag LENTO multilínea (1.7s) pinta igual (${JSON.stringify(pf.map((f) => ({ t: f.text.slice(0, 6), r: f.first + "-" + f.last })))})`);

  // L3: palabra GEMELA ("Response" existe en varios handlers) → UNA sola
  const gem = await evalJs(`__E2E.locate(${JSON.stringify(SERVER_TS)}, 'new Response("missing"')`);
  check(gem && !gem.error, "L3 localizo un Response en server.ts", gem?.error ?? "");
  await dblclick((gem.chars[7].left + gem.chars[7].right) / 2, gem.y); // "Response"
  await sleep(500);
  const sf = await evalJs(`__E2E.frags(${JSON.stringify(SERVER_TS)})`);
  check(sf.length === 1 && sf[0].text === "Response",
    `L3: la palabra gemela pinta UNA sola ocurrencia (${JSON.stringify(sf.map((f) => f.text))})`);
  await shot("11-coexistencia-multilinea-gemelas-lento.png");

  await panelStable();
  // ============ M. diff CLÁSICO línea a línea como GitHub (0.9.11) ============
  // Spec final Damian 28/10: "quiero ver un diff normal, línea a línea, como
  // en GitHub: la línea roja con la palabra en rojo resaltada, y abajo la
  // verde con la palabra verde resaltada. No todo en una misma línea. Y revert
  // tanto a lo rojo como a lo verde seleccionando."
  const mods = await evalJs(`(() => {
    const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(PARSER_PY)});
    const rows = [...e.body.querySelector("diffs-container").shadowRoot.querySelectorAll("[data-line]")].filter((r) => !r.querySelector("[data-line]"));
    const red = rows.find((r) => (r.textContent ?? "").includes("alpha (words)"));
    const green = rows.find((r) => (r.textContent ?? "").includes("alpha (tokens)"));
    return {
      redVisible: red ? getComputedStyle(red).display !== "none" : false,
      greenVisible: green ? getComputedStyle(green).display !== "none" : false,
      redText: red?.textContent ?? null,
      greenText: green?.textContent ?? null,
      redIsDeletion: red?.dataset.lineType === "change-deletion",
      greenIsAddition: green?.dataset.lineType === "change-addition",
      redBeforeGreen: !!(red && green) && (red.compareDocumentPosition(green) & Node.DOCUMENT_POSITION_FOLLOWING) > 0,
      delBoxes: e.body.querySelectorAll(".wc-layer .wc-del").length,
      addBoxes: e.body.querySelectorAll(".wc-layer .wc-add").length,
      delBg: getComputedStyle(e.body.querySelector(".wc-layer .wc-del") ?? document.body).backgroundColor,
      addBg: getComputedStyle(e.body.querySelector(".wc-layer .wc-add") ?? document.body).backgroundColor,
      tachados: rows.reduce((n, r) => n + r.querySelectorAll("[data-da-del]").length, 0),
    };
  })()`);
  check(mods.redVisible && mods.greenVisible && mods.redBeforeGreen, "AMBAS filas visibles: la ROJA arriba, la VERDE abajo");
  check(mods.redIsDeletion && mods.greenIsAddition, "cada fila con su tipo (deletion/adition)");
  check(mods.redText === "Marker words: alpha (words), bravo (numbers), charlie (symbols)." &&
    mods.greenText === "Marker words: alpha (tokens), bravo (numbers), charlie (symbols).",
    `texto EXACTO de cada fila — la roja con (words), la verde con (tokens)`);
  check(mods.delBoxes > 0 && mods.addBoxes > 0,
    `la palabra removida va resaltada en ROJO (cajas .wc-del=${mods.delBoxes}) y la agregada en VERDE (.wc-add=${mods.addBoxes})`);
  check(mods.delBg.includes("0.42") && mods.addBg.includes("0.42"),
    `relleno programático legible (oklch relativo, alpha 0.42): del=${JSON.stringify(mods.delBg.slice(0, 40))} add=${JSON.stringify(mods.addBg.slice(0, 40))}`);
  check(mods.tachados === 0, "sin tachados inline ni mezcla de versiones en una sola fila");
  // orden del toolbar (spec Damian 28/10): ↩archivo · ＋ · ✏️ · ? · ↩multilinea
  const btnOrder = await evalJs(`(() => {
    const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(PARSER_PY)});
    return [...e.section.querySelector(".file-head").querySelectorAll("button")].map((b) => b.className.replace("ghost ", ""));
  })()`);
  check(JSON.stringify(btnOrder) === JSON.stringify(["frev", "fplus", "fedit", "fmode fmode-ask", "fmode fmode-rev"]),
    `orden del toolbar: ↩archivo · ＋ · ✏️ · ? · ↩multilinea (${JSON.stringify(btnOrder)})`);
  await shot("12-diff-clasico-github.png");

  // pintar la palabra de la fila ROJA = restaurar: doble-click en 'words' de
  // la fila ROJA → frag lado old → la línea vuelve AL ORIGINAL y sale del diff
  await evalJs(`__DA.fragSel.delete(${JSON.stringify(PARSER_PY)})`); // suelto las pintadas de L
  const redLoc = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, "(words", "change-deletion")`);
  check(redLoc && !redLoc.error, "localizo la palabra 'words' EN LA FILA ROJA", redLoc?.error ?? "");
  // MEDIA PALABRA de la roja no restaura nada: hay que pintar la palabra
  // entera (regla espejo de la cirugía verde, spec quirúrgica 0.9.14)
  await drag(redLoc.chars[1].left, redLoc.y, redLoc.chars[2].right + 0.5, redLoc.y, 6); // "wo"
  await waitPaint(PARSER_PY, 1);
  await evalJs("document.activeElement?.blur?.()");
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(900);
  check(readDisk(PARSER_PY).includes("alpha (tokens)") && (await evalJs(`__E2E.hasRowText(${JSON.stringify(PARSER_PY)}, "(tokens")`)),
    "media palabra de la ROJA no restaura: la pareja queda igual (noDiff)");
  const redLoc2 = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, "(words", "change-deletion")`);
  await dblclick((redLoc2.chars[2].left + redLoc2.chars[2].right) / 2, redLoc2.y);
  await waitPaint(PARSER_PY, 1);
  pf = await pFrags();
  check(pf.length === 1 && pf[0].text === "words", `doble-click en la fila ROJA pinta el frag de restaurar (${JSON.stringify(pf.map((f) => f.text))})`);
  await evalJs("document.activeElement?.blur?.()");
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitDisk(PARSER_PY, (c) => c.includes("alpha (words)"), "la línea modificada vuelve al original");
  const afterM = readDisk(PARSER_PY);
  check(afterM.includes("Marker words: alpha (words), bravo (numbers), charlie (symbols)."),
    "pintar en la ROJA RESTAURÓ la línea original (chars de 'words' de vuelta)");
  check(afterM.includes("def render(tokens):"), "y el resto del diff de parser.py quedó intacto");
  check(await until(async () => !(await evalJs(`__E2E.hasRowText(${JSON.stringify(PARSER_PY)}, "Marker words")`))),
    "la pareja desapareció del diff (volvió a HEAD)");

  // re-render con contenido idéntico (refresh): el modelo clásico se
  // mantiene — dos filas, cajas, sin duplicación
  const CFG = "tests/diffs/config.json";
  await panelStable(); // el refresh del revert puede seguir re-renderizando
  await expandFile(CFG); // colapsado no hay rects: sin expandir no hay cajas
  await evalJs("__DA.refresh(true)");
  await panelStable();
  const mods2 = await evalJs(`(() => {
    const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(CFG)});
    const rows = [...e.body.querySelector("diffs-container").shadowRoot.querySelectorAll("[data-line]")].filter((r) => !r.querySelector("[data-line]"));
    const reds = rows.filter((r) => (r.textContent ?? "").includes('"port": 8080'));
    const greens = rows.filter((r) => (r.textContent ?? "").includes('"port": 9090'));
    return {
      redVisible: reds.filter((r) => getComputedStyle(r).display !== "none").length,
      greenVisible: greens.filter((r) => getComputedStyle(r).display !== "none").length,
      delBoxes: e.body.querySelectorAll(".wc-layer .wc-del").length,
      addBoxes: e.body.querySelectorAll(".wc-layer .wc-add").length,
    };
  })()`);
  check(mods2.redVisible === 1 && mods2.greenVisible === 1, "tras un refresh idéntico: UNA roja y UNA verde (sin duplicar)");
  check(mods2.delBoxes > 0 && mods2.addBoxes > 0, "y las cajas rojas/verdes siguen sobre las palabras de la pareja port");

  await panelStable();
  // ============ N. texto EXACTO de las dos filas de la pareja (0.9.11) ============
  // Modelo clásico: la verde es la línea NUEVA y la roja la VIEJA, cada una
  // con SU texto exacto (la lección 0.9.7: texto duplicado por hlColorize
  // pasaba inadvertido con aserciones por subcadena).
  const CFG_ROW_GREEN = '    "port": 9090,';
  const CFG_ROW_RED = '    "port": 8080,';
  const exactRows = async () => await evalJs(`(() => {
    const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(CFG)});
    const rows = [...e.body.querySelector("diffs-container").shadowRoot.querySelectorAll("[data-line]")].filter((r) => !r.querySelector("[data-line]"));
    const g = rows.find((r) => r.dataset.lineType === "change-addition" && (r.textContent ?? "").includes('"port"'));
    const d = rows.find((r) => r.dataset.lineType === "change-deletion" && (r.textContent ?? "").includes('"port"'));
    return { green: g?.textContent ?? null, red: d?.textContent ?? null };
  })()`);
  let rowsN = await exactRows();
  check(rowsN.green === CFG_ROW_GREEN && rowsN.red === CFG_ROW_RED,
    `texto EXACTO de la pareja: roja=${JSON.stringify((rowsN.red ?? "").slice(0, 22))} verde=${JSON.stringify((rowsN.green ?? "").slice(0, 22))}`);
  await evalJs("__DA.refresh(true)");
  await panelStable();
  rowsN = await exactRows();
  check(rowsN.green === CFG_ROW_GREEN && rowsN.red === CFG_ROW_RED,
    `texto EXACTO tras refresh + re-colorizar: roja=${JSON.stringify((rowsN.red ?? "").slice(0, 22))} verde=${JSON.stringify((rowsN.green ?? "").slice(0, 22))}`);

  // ============ O. modo edición ✏️: el editor de pierre manda SOLO (0.9.9) ============
  // Reporte Damian 28/10: "empiezo a editar y se pone en negro lo que
  // escribo o borro". Sospecha: el MutationObserver del shadow dispara
  // scheduleAnchors por cada tecla (el editor re-renderiza filas) y
  // hlColorize reescribe filas ENTERAS con tokens del contenido VIEJO
  // (fileData.after no se actualiza mientras se edita) — encima de las
  // filas VIVAS del editor. En edición NO se toca nada nuestro.
  const SHELL_SH = "tests/diffs/shell.sh";
  await expandFile(SHELL_SH);
  const editBtnAt = async () => await evalJs(`(() => {
    const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(SHELL_SH)});
    const b = e?.section.querySelector("button.fedit");
    if (!b) return null;
    e.section.querySelector(".file-head").scrollIntoView({ block: "center" });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  let eb = await editBtnAt();
  check(!!eb, "encuentro el botón ✏️ de shell.sh");
  await click(eb.x, eb.y);
  check(await until(async () => await evalJs(`(() => { const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(SHELL_SH)}); return !!e?.edit; })()`), 4000), "✏️ activa el modo edición");
  await sleep(500);
  let edLoc = await evalJs(`__E2E.locate(${JSON.stringify(SHELL_SH)}, "listing all")`);
  check(edLoc && !edLoc.error, "localizo la fila a editar con el editor activo", edLoc?.error ?? "");
  await click(edLoc.left - 2, edLoc.y); // caret en el borde izquierdo del needle
  await sleep(200);
  const hlBefore = await evalJs(`(() => { const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(SHELL_SH)}); return e?._hlRuns ?? 0; })()`);
  await cdp("Input.insertText", { text: "BRAVO" });
  await sleep(1200); // autosave (900ms) + el rAF del observer structural
  const edState = await evalJs(`(() => {
    const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(SHELL_SH)});
    const host = e.body.querySelector("diffs-container");
    const rows = [...host.shadowRoot.querySelectorAll("[data-line]")].filter((r) => !r.querySelector("[data-line]"));
    // el editor de pierre vive de ESPEJOS: SPANs en el shadow (fuera de las
    // filas [data-line]) con el texto por línea — acá se ve lo tipado
    const mirror = [...host.shadowRoot.querySelectorAll("span")]
      .filter((s) => [...s.childNodes].some((tn) => tn.nodeType === 3 && tn.data.includes("BRAVO")));
    return {
      editOn: !!e.edit,
      typedVisible: mirror.some((s) => (s.textContent ?? "").includes("BRAVO")),
      typedTwice: mirror.filter((s) => (s.textContent ?? "").includes("BRAVO")).length,
      hlRuns: e._hlRuns ?? 0,
      delSpans: rows.reduce((n, r) => n + r.querySelectorAll("[data-da-del]").length, 0),
      editorText: e.edit ? e.edit.editor.getText() : null,
    };
  })()`);
  check(edState.typedVisible && edState.typedTwice === 1, "lo TIPADO vive en la superficie del editor (sin duplicar)");
  check(edState.hlRuns === hlBefore, `hlColorize NO corrió durante la edición (runs ${hlBefore}→${edState.hlRuns})`);
  check(edState.delSpans === 0, "sin tachados nuestros en el editor");
  check((edState.editorText ?? "").includes("BRAVO"), "el documento del editor contiene lo tipado");
  await shot("13-editando-tipado.png");
  // BORRADO también: backspace sobre lo tipado — misma proteccion
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
  await sleep(1800); // nuevo autosave
  const saved = await waitDisk(SHELL_SH, (c) => c.includes("BRAV"), "autosave del editor escribe en disco");
  check(saved && readDisk(SHELL_SH).includes("BRAV"),
    "git/disco: lo tipado llegó (BRAV presente tras el backspace)");
  eb = await editBtnAt();
  await click(eb.x, eb.y); // salir del modo edición (guarda)
  check(await until(async () => await evalJs(`(() => { const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(SHELL_SH)}); return !e?.edit; })()`), 4000), "✏️ sale del modo edición");
  await shot("14-edit-guardado.png");

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
