// E2E of the surgical revert with a REAL MOUSE: launches real Chromium
// (CDP Input.dispatchMouseEvent = the same input pipeline as the user's
// mouse), loads the REAL panel (dist/panel.html) bridged to the REAL MCP
// server (server.mjs over stdio) pointed at THIS repo, and verifies each
// revert by reading the file on disk (git-verifiable). No selection or
// write stubs.
//
// Gestures exercised (Damian's):
//   - double-click → exact word
//   - triple-click → whole line
//   - left→right drag → exact char range
//   - right→left drag → same range, normalized
//   - ONE-letter drag
//   - vertical drag on the gutter → checkboxes (line revert by numbers)
//   - Enter = surgical ↩; a word of a 100% new line → ONLY the word (0.9.2)
//   - header brush mode ↩: N accumulated paints → ONE general rollback (no floating popups)
//   - ONE row per modified line: paired red hidden, original on hover (0.9.4)
//   - coexistence: two words on the SAME row, multi-line multi-word drag,
//     a twin word paints only ONE, and a SLOW drag (>1.5s) stays alive (0.9.3)
//   - mega commit (700 files): opens fast with commit info, and right after
//     it the mode chips + folder picker still respond — no brick (0.9.21)
//   - dead workspace (repo deleted while open): the panel WARNS and its
//     "Pick another folder" button leads back to a valid repo (0.9.24)
//   - turns v2 (0.9.26): the panel boots on Turns; one turn records a dirty
//     file of the session repo AND a commit of a SECOND repo, namespaced
// Usage: node tests/e2e/revert.e2e.mjs   (requires Google Chrome installed)

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAppStore, edited, written } from "../lib/app-store-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PANEL = fs.readFileSync(path.join(REPO, "diff-ask/dist/panel.html"), "utf8");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = path.join(HERE, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

const NOTES = "tests/diffs/notes.md";
const SERVER_TS = "tests/diffs/server.ts";
// INPUT TIMING ONLY — never synchronization. A human double-click interval or
// a slow drag's step cadence IS part of the gesture under test; every wait for
// panel/server state in this rig is a condition (waitForExpr/until) or an
// event (fs.watch), never a fixed sleep.
const pace = (ms) => new Promise((r) => setTimeout(r, ms));
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
// Hermetic plugin state (turns store, inbox, shelved): a tmp dir, never the
// real ~/.zcode/diff-ask — the turn tap tests write events into it.
const TURN_STATE = fs.mkdtempSync(path.join(os.tmpdir(), "da-e2e-state-"));
const TURN_INBOX = path.join(TURN_STATE, "turn-events.jsonl");
// A fake of ZCode's own session store (0.10.10), built by section X. Until
// then the paths do not exist: every earlier turn runs the capture model,
// hermetically — never against the real app database.
const APP_DIR = path.join(TURN_STATE, "app");
const server = spawn("node", [path.join(REPO, "diff-ask/server/server.mjs")], {
  env: {
    ...process.env,
    ZCODE_WORKSPACE_ROOT: REPO,
    ZCODE_DIFF_ASK_STATE: TURN_STATE,
    ZCODE_SESSION_ID: "",
    ZCODE_DIFF_ASK_APP_DB: path.join(APP_DIR, "app.sqlite"),
    ZCODE_DIFF_ASK_APP_ARTIFACTS: path.join(APP_DIR, "artifacts"),
  },
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
      const { tool, args, meta } = JSON.parse(body);
      // `meta` simulates the app's request context (_meta on tools/call) —
      // the W-section exercises the multi-task sticky-sid reality.
      rpc("tools/call", meta ? { name: tool, arguments: args, _meta: meta } : { name: tool, arguments: args })
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
const waitPort = () =>
  new Promise((resolve, reject) => {
    const file = path.join(profile, "DevToolsActivePort");
    const read = () => {
      try {
        const f = fs.readFileSync(file, "utf8");
        return { port: Number(f.split("\n")[0]), path: f.split("\n")[1] };
      } catch {
        return null;
      }
    };
    const ready = read();
    if (ready) return resolve(ready);
    // Chrome WRITES the file when the port is up: wait for that write (event),
    // never a poll. The deadline is the only timer — a Chrome that dies before
    // writing must fail loudly instead of hanging forever.
    const watcher = fs.watch(profile, (_evt, name) => {
      if (name !== "DevToolsActivePort") return;
      const got = read();
      if (got) { cleanup(); resolve(got); }
    });
    const timer = setTimeout(() => { cleanup(); reject(new Error("Chrome did not open the debug port")); }, 15_000);
    const cleanup = () => { try { watcher.close(); } catch {} clearTimeout(timer); };
  });
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
// headless ignores --window-size sometimes: fix the EXACT viewport so
// the Input.dispatchMouseEvent coordinates (CSS px of the viewport) match
// with the getBoundingClientRect we measure from the page.
await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1900, deviceScaleFactor: 1, mobile: false });

const evalJs = async (expr) => {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("page: " + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result?.value;
};
// Page-side wait (0.11.1): resolves the moment the expression is truthy —
// driven by the page's OWN frame clock (requestAnimationFrame), with a hard
// deadline. One CDP call, zero polling from Node, zero fixed sleeps.
const waitForExpr = (expr, ms = 8000) =>
  evalJs(`new Promise((resolve) => {
    const end = performance.now() + ${ms};
    const tick = () => {
      let v = null;
      try { v = (${expr}); } catch {}
      if (v) return resolve(v);
      if (performance.now() > end) return resolve(null);
      requestAnimationFrame(tick);
    };
    tick();
  })`);
// Quiescence, frame-driven: the panel is quiet once the render tick, the
// file count and the scroll position stop changing across two frames.
const quiesce = (ms = 10000) =>
  evalJs(`new Promise((resolve) => {
    const end = performance.now() + ${ms};
    let last = null, same = 0;
    const tick = () => {
      const root = document.getElementById("root");
      const sig = [__DA.renderTick, __DA.rendered.size, root?.scrollTop ?? 0].join("|");
      same = sig === last ? same + 1 : 0;
      last = sig;
      if (same >= 2) return resolve(sig);
      if (performance.now() > end) return resolve(null);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })`);
const shot = async (name) => {
  const r = await cdp("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, "base64"));
};

// page helpers: locate rows/chars in the diff's shadow
await cdp("Page.navigate", { url: `http://127.0.0.1:${PORT}/panel` });
await waitForExpr("typeof __DA === 'object' && !!document.getElementById('askbar')", 15000);
await evalJs(`(() => {
  window.__E2E = {
    head(rel) {
      const e = [...__DA.rendered.values()].find((x) => x.path === rel);
      if (!e) return null;
      const h = e.section.querySelector(".file-head");
      if (!h) return null;
      h.scrollIntoView({ block: "center" });
      return new Promise((res) => {
//         // wait for the scroll settle BEFORE measuring (same as locate):
//         // a long scroll measured mid-animation = stale coords. And with
//         // block:"center" the header sits mid-viewport: with
//         // block:"start" it stuck to the top UNDER the sticky modebar
//         // and the click was lost in the bar (seen with config.json). The click
//         // points at the CHEVRON, the real toggle.
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
      const settle = () => new Promise((res) => {
        const root = document.getElementById("root");
        let last = null, same = 0, n = 0;
        const iv = setInterval(() => {
          const y = root.scrollTop;
          if (y === last) { if (++same >= 2) { clearInterval(iv); res(); } }
          else { same = 0; last = y; }
          if (++n > 60) { clearInterval(iv); res(); }
        }, 20);
      });
      const at = (row, target) => {
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
//         // target == EXACT end of the row text: valid range at the end
//         // of the last text node (needles that end with the row)
        if (lastText && pos.n === target) return { node: lastText, offset: lastText.data.length };
        return null;
      };
      const box = (row, a, b) => {
        const A = at(row, a), B = at(row, b);
        if (!A || !B) return null;
        const r = document.createRange();
        r.setStart(A.node, A.offset);
        try { r.setEnd(B.node, B.offset); } catch { return null; }
        return r.getBoundingClientRect();
      };
      // Re-resolve entry/host on EVERY scan: a refresh can REBUILD all the
      // sections while we're here (entry exists but its diffs-container got
      // DETACHED with the old section — rows render zero-width rects and a
//       // captured host would scan a dead tree forever). Seen as "no row with
      // X" right after a revert refresh even with the row present.
      // skip = rows measured WITHOUT geometry (the hidden paired red row,
      // 0.9.4) — skipped by IDENTITY across rebuilds, never by index (the
      // index shifts on every rebuild and would skip past the only match).
      const findFrom = (skip) => {
        const entry = [...__DA.rendered.values()].find((e) => e.path === rel);
        if (!entry) return null;
        const host = entry.body.querySelector("diffs-container");
        if (!host?.shadowRoot) return null;
        const rows = [...host.shadowRoot.querySelectorAll("[data-line]")].filter((r) => !r.querySelector("[data-line]"));
        for (const row of rows) {
          if (skip?.has(row)) continue;
          const t = row.dataset.lineType ?? "";
          if (type && t !== type) continue;
          const text = row.textContent ?? "";
          const idx = text.indexOf(needle);
          if (idx < 0) continue;
          return { row, t, text, idx, host, isConnected: row.isConnected };
        }
        return null;
      };
      const tried = new Set();
      let hit = findFrom(tried);
      for (let i = 0; !hit && i < 15; i++) {
        await new Promise((res) => setTimeout(res, 120));
        hit = findFrom(tried);
      }
      while (hit) {
        const { row, t, text, idx } = hit;
        if (!row.isConnected) { hit = findFrom(tried); continue; } // section rebuilt mid-flight: rescan fresh
        if (!noScroll) row.scrollIntoView({ block: "center" });
//         // wait for the scroll to FINISH before measuring (if it were smooth,
//         // measuring mid-animation gives coords that are already invalid for the gesture).
//         // noScroll = the row is already in view (double measurement without invalidating
//         // the first one with a new scroll): measure directly.
        if (!noScroll) await settle();
        const full = box(row, idx, idx + needle.length);
        if (!full || full.width < 5) {
          tried.add(row); // genuinely hidden row: skip it for good
          hit = findFrom(tried);
          continue;
        }
        const chars = [];
        for (let c = 0; c < needle.length; c++) {
          const cb = box(row, idx + c, idx + c + 1);
          if (cb) chars.push({ left: cb.left, right: cb.right });
        }
        const gutter = hit.host.shadowRoot.querySelector("[data-gutter]")?.getBoundingClientRect();
        return { line: row.dataset.line, type: t, rowText: text, idx,
          left: full.left, right: full.right, top: full.top, bottom: full.bottom,
          y: (full.top + full.bottom) / 2, chars,
          gutterX: gutter ? gutter.right + 2 : null };
      }
      return { error: "no row with " + needle + " (" + type + ")" };
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
// tolerant to boot: with the highlighter stub the bundle can take a
// bit longer than the fixed sleep — wait for __DA to exist before the refresh
await evalJs(`window.__daErr = []; if (!window.__daHooked) { window.__daHooked = 1; window.addEventListener("error", (e) => window.__daErr.push(String(e.message).slice(0, 200) + " @" + String(e.filename).slice(-40) + ":" + e.lineno)); }`).catch(() => {});
await waitForExpr("typeof __DA === 'object'", 15000);
if ((await evalJs(`typeof __DA`).catch(() => "x")) !== "object") {
  console.error("BOOT FAIL — page errors:", await evalJs(`JSON.stringify(window.__daErr)`).catch((e) => "eval: " + e.message));
  console.error("BOOT FAIL — body:", await evalJs(`JSON.stringify((document.body?.innerText ?? "").slice(0, 120))`).catch(() => "?"));
  console.error("BOOT FAIL — scripts:", await evalJs(`[...document.scripts].map((s) => s.src || "inline " + (s.textContent ?? "").length).join(" | ").slice(0, 200)`).catch(() => "?"));
}
if (true) {
//   // 0.9.26: the panel boots on TURNS (first tab). Assert it, then switch to
  // the working diff — every gesture section below operates on that view.
  const bootTab = await evalJs(`(() => {
    const t = document.querySelector('.modebar button[data-mode="turns"]');
    const w = document.querySelector('.modebar button[data-mode="working"]');
    return { turnsActive: !!t?.classList.contains("active"), hasWorking: !!w };
  })()`);
  log(`boot tab: Turns=${bootTab.turnsActive} (expected true), Work chip=${bootTab.hasWorking}`);
  if (!bootTab.turnsActive || !bootTab.hasWorking)
    fails.push(`boot: the first tab must be Turns and the work chip must exist (${JSON.stringify(bootTab)})`);
  await evalJs(`document.querySelector('.modebar button[data-mode="working"]')?.click()`);
  await evalJs(`__DA.refresh(true)`);
  const bootOk = await waitForExpr("__DA.rendered.size >= 9", 10000);
  if (!bootOk) throw new Error("the panel did not render the fixture's 9 files");
  log(`panel: ${await evalJs("__DA.rendered.size")} files in the diff (working, of the chosen repo)`);

  // ---------- language badges (0.12.x–0.13): kind + name-first layout --------
  const langUi = await evalJs(`(() => {
    const chips = {};
    for (const [p, e] of __DA.rendered) {
      const c = e.section.querySelector(".lang-chip");
      const pathEl = e.section.querySelector(".file-head .path");
      chips[p.split("/").pop()] = c ? {
        hasSvg: !!c.querySelector("svg"), title: c.title, text: (c.textContent ?? "").trim(),
        cls: c.className,
        fname: pathEl?.querySelector(".fname")?.textContent ?? null,
        fdir: pathEl?.querySelector(".fdir")?.textContent ?? null,
        pathTitle: pathEl?.title ?? null,
      } : null;
    }
    const sum = document.querySelector(".header .lang-sum");
    return { chips, sum: sum ? { text: sum.textContent, title: sum.title, svgs: sum.querySelectorAll("svg").length, mono: sum.querySelectorAll(".is-mono").length, dark: sum.querySelectorAll(".is-dark").length } : null };
  })()`);
  // Fixture files all have an official mark; the monogram is only the fallback.
  const expectedIcons = [
    "notes.md", "server.ts", "parser.py", "runner.nu", "config.json",
    "types.go", "styles.css", "data.yaml", "shell.sh", "Makefile",
  ];
  for (const file of expectedIcons) {
    if (!(file in langUi.chips)) continue; // fixture file not in this diff view
    check(langUi.chips[file]?.hasSvg === true,
      `file type: ${file} shows its official ICON (${JSON.stringify(langUi.chips[file])})`);
  }
  check(Object.values(langUi.chips).every((c) => c && (c.hasSvg || c.text.length > 0)),
    `no file stays anonymous: official icon or monogram (${JSON.stringify(Object.fromEntries(Object.entries(langUi.chips).map(([k, v]) => [k, v?.hasSvg ? "svg" : v?.text])))})`);
  check(/TypeScript/.test(langUi.chips["server.ts"]?.title ?? "") && /\.ts/.test(langUi.chips["server.ts"]?.title ?? ""),
    `the badge names language and extension in the tooltip (${JSON.stringify(langUi.chips["server.ts"]?.title)})`);
  // Contrast traits: markdown is a glyph with NO paint → inherits (mono);
  // yaml paints dark → lifted on dark themes.
  check(/\bis-mono\b/.test(langUi.chips["notes.md"]?.cls ?? ""),
    `the colorless icon (markdown) inherits the text color (${JSON.stringify(langUi.chips["notes.md"]?.cls)})`);
  check(/\bis-dark\b/.test(langUi.chips["data.yaml"]?.cls ?? ""),
    `the dark icon (yaml) carries the contrast flag (${JSON.stringify(langUi.chips["data.yaml"]?.cls)})`);
  check(!/\bis-dark\b/.test(langUi.chips["server.ts"]?.cls ?? ""),
    `un icono colorido (TS) NO lleva filtro (${JSON.stringify(langUi.chips["server.ts"]?.cls)})`);
  // Layout: NAME primary, full directory to its right; whole path in the title.
  check(langUi.chips["server.ts"]?.fname === "server.ts",
    `the file NAME is the protagonist (${JSON.stringify(langUi.chips["server.ts"]?.fname)})`);
  check(/tests\/diffs$/.test(langUi.chips["server.ts"]?.fdir ?? ""),
    `the path (without the name) goes to the right (${JSON.stringify(langUi.chips["server.ts"]?.fdir)})`);
  check((langUi.chips["server.ts"]?.pathTitle ?? "").endsWith("tests/diffs/server.ts"),
    `the tooltip keeps the full path (${JSON.stringify(langUi.chips["server.ts"]?.pathTitle)})`);
  // Real contrast on DARK: force the theme attribute (CSS is the source of
  // truth) and read what the browser computes for both trait kinds.
  const darkUi = await evalJs(`(() => {
    const prev = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = "dark";
    const by = (suffix) => [...__DA.rendered.values()].find((e) => e.path.endsWith(suffix));
    const yamlSvg = by("data.yaml")?.section.querySelector(".lang-chip svg");
    const mdChip = by("notes.md")?.section.querySelector(".lang-chip");
    const out = {
      darkFilter: yamlSvg ? getComputedStyle(yamlSvg).filter : null,
      monoColor: mdChip ? getComputedStyle(mdChip).color : null,
    };
    document.documentElement.dataset.theme = prev ?? "light";
    return out;
  })()`);
  const monoRgb = (darkUi.monoColor ?? "").match(/\d+/g)?.map(Number) ?? [0, 0, 0];
  check(/brightness/.test(darkUi.darkFilter ?? ""),
    `in dark, a dark icon is lifted with brightness (${JSON.stringify(darkUi.darkFilter)})`);
  check(Math.min(...monoRgb.slice(0, 3)) > 170,
    `in dark, the colorless icon inherits the light text (${JSON.stringify(darkUi.monoColor)})`);
  check(!!langUi.sum && /: \d/.test(langUi.sum.title ?? ""),
    `the header carries the recount per type with its breakdown (${JSON.stringify(langUi.sum)})`);
  check((langUi.sum?.svgs ?? 0) > 0,
    `the recount uses the same icons (${langUi.sum?.svgs} svg)`);
  check((langUi.sum?.mono ?? 0) > 0,
    `the recount respects the traits (mono=${langUi.sum?.mono}; dark is checked per chip)`);
  check((langUi.sum?.title ?? "").split("\n").some((l) => /^TypeScript: \d+$/.test(l)),
    `the recount breaks down TypeScript with its count (${JSON.stringify(langUi.sum?.title)})`);
}

// ------------------------------------------------ mouse real
const mouse = {
  press: (x, y, c = 1) => cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: c }),
  release: (x, y, c = 1) => cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: c }),
//   // button:"left" on the moves is MANDATORY: with "none" Chromium treats them
//   // as hover and never extends the selection (the drag selects nothing).
  move: (x, y) => cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 }),
};
async function click(x, y) { await mouse.press(x, y); await mouse.release(x, y); }
async function dblclick(x, y) {
  await mouse.press(x, y); await mouse.release(x, y); await pace(80);
  await mouse.press(x, y, 2); await mouse.release(x, y, 2);
}
async function tripleclick(x, y) {
  await mouse.press(x, y); await mouse.release(x, y); await pace(80);
  await mouse.press(x, y, 2); await mouse.release(x, y, 2); await pace(80);
  await mouse.press(x, y, 3); await mouse.release(x, y, 3);
}
async function drag(x0, y0, x1, y1, steps = 14) {
  await mouse.press(x0, y0);
  for (let i = 1; i <= steps; i++) { await mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps); await pace(14); }
  await mouse.release(x1, y1);
}
const until = async (fn, ms = 5000, stepMs = 90) => {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await pace(stepMs); }
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
// Settle: no bridge work in flight (panel busy counter off) AND the render
// stopped changing across two frames. Used for NEGATIVE checks ("this must
// NOT write") — the deadline is the only timer, and it returns the moment the
// panel is quiet.
const settle = async (ms = 5000) => {
  await waitForExpr("!__DA.refreshBusy && !__DA.busy", ms);
  await quiesce(ms);
};
const readDisk = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
// Disk waits are EVENT waits (fs.watch on the file's folder), never polls:
// the panel's write lands → the watcher fires → the predicate decides. The
// timeout is a hard deadline so a broken write fails loudly.
const waitDisk = async (rel, pred, label) => {
  const abs = path.join(REPO, rel);
  const dir = path.dirname(abs);
  const started = Date.now();
  const ok = await new Promise((resolve) => {
    if (pred(readDisk(rel))) return resolve(true);
    let watcher = null;
    let timer = null;
    const finish = (v) => {
      try { watcher?.close(); } catch {}
      clearTimeout(timer);
      resolve(v);
    };
    try {
      watcher = fs.watch(dir, () => {
        try { if (pred(readDisk(rel))) finish(true); } catch {}
      });
    } catch { /* folder gone: the deadline still decides */ }
    timer = setTimeout(() => finish(pred(readDisk(rel))), 6000);
  });
  if (!ok) {
    console.error(`    chips: ${JSON.stringify(await evalJs(`[...document.querySelectorAll(".sent-chip")].map((c) => c.textContent)`).catch(() => "?"))}`);
    console.error(`    ring:  ${(await evalJs("window.__evts").catch(() => "?")).slice(-16).join(" ")}`);
    console.error(`    diag:  ${(await evalJs(`(document.querySelector('.diag-chip')?.__log ?? []).join(' ⏐ ')`).catch(() => "?")).slice(-400)}`);
    console.error(`    disk:  ${rel} not matching after ${Date.now() - started}ms`);
    await shot("debug-disk.png");
  }
  return ok;
};
// // The reactive post-write refresh arrives ASYNCHRONOUSLY (server debounce + SSE):
// // if a gesture starts before the re-render finishes, the coords measured
// // go stale and the mouse paints ANOTHER row. Quiescence is FRAME-driven
// (0.11.1): the page resolves once renderTick/files/scroll stop changing
// across two frames — no fixed sleep, and it returns as soon as it settles.
const panelStable = async () => {
  await quiesce();
  return JSON.parse(
    await evalJs(`JSON.stringify({ g: __DA.diffData?.generatedAt, n: __DA.rendered.size, y: document.getElementById("root").scrollTop })`),
  );
};
const expandFile = async (rel) => {
//   // Up to 3 attempts: the click can land on a header button or be measured
//   // against a layout that is still settling. "Expanded" = the section is
  // open AND hydrated (fd mounted, or an honest plain note) — the wait is on
  // that condition, never a timer.
  const hydrated = `(() => {
    const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(rel)});
    return e && !e.section.classList.contains("collapsed") && (!!e.fd || !!e.noDiff);
  })()`;
  for (let i = 0; i < 3; i++) {
    const h = await evalJs(`__E2E.head(${JSON.stringify(rel)})`);
    if (!h) throw new Error("sin header para " + rel);
    if (!h.collapsed) {
      await waitForExpr(hydrated, 15000);
      return h;
    }
    await click(h.x, h.y);
    if (await waitForExpr(hydrated, 15000)) return await evalJs(`__E2E.head(${JSON.stringify(rel)})`);
  }
  const h2 = await evalJs(`__E2E.head(${JSON.stringify(rel)})`);
  if (h2.collapsed) throw new Error("no pude expandir " + rel);
  return h2;
};
const clickRevert = async () => {
  // The ↩ popup rides the selectionchange/rAF pipeline: under load it can
  // take a beat longer than 3s to show (flake seen twice at the ONE-LETTER
  // drag step). Give it a wider window before giving up.
  const p = await until(async () => await evalJs("__E2E.popRev()"), 8000);
  if (!p) {
    console.error("    diag pop:", await evalJs(`(document.querySelector('.diag-chip')?.__log ?? []).slice(-8).join(' ⏐ ')`).catch((e) => "?" + e.message));
    console.error("    pop state:", JSON.stringify(await evalJs(`(() => ({
      pop: !!document.querySelector(".sel-pop"),
      kids: document.querySelector(".sel-pop")?.children?.length ?? 0,
      files: __DA.fragSel.size,
      frags: [...__DA.fragSel.values()].reduce((n, v) => n + v.length, 0),
      rendered: __DA.rendered.size,
      hydrated: [...__DA.rendered.values()].filter((e) => e.fd).length,
    }))()`).catch((e) => "?" + e.message)));
    await shot("debug-no-pop.png").catch(() => {});
  }
  if (!p) throw new Error("the ↩ popup did not appear");
  await click(p.x, p.y);
};

try {
await mouse.move(500, 900);
await quiesce();
console.error("    viewport:", JSON.stringify(await evalJs(`({iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, pm: window.__pm, scrollY: document.getElementById("root").scrollTop})`)));
  // ============ A. doble-click en la palabra cambiada "singular" ============
  await expandFile(NOTES);
  let loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "singular", "change-addition")`);
  check(loc && !loc.error, "I locate the green row with 'singular'", loc?.error ?? "");
  await dblclick((loc.left + loc.right) / 2, loc.y);
  await waitPaint(NOTES, 1);
  let frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
  check(frags.length === 1 && frags[0].text === "singular", `double-click paints the exact word (frags: ${JSON.stringify(frags.map((f) => f.text))})`);

  await panelStable();
  // ============ B. drag izq→der de 3 letras "pai" de la palabra AGREGADA "painted" ============
  loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "painted", "change-addition")`);
  check(loc && !loc.error, "I locate the green row with 'painted'", loc?.error ?? "");
  await drag(loc.chars[0].left + 1, loc.y, loc.chars[2].right + 1.5, loc.y);
  await waitPaint(NOTES, 2);
  frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
  const painted3 = frags[frags.length - 1]?.text ?? "";
  check(frags.length === 2, "BOTH selections stay painted (accumulation)", JSON.stringify(frags.map((f) => f.text)));
  check(frags.some((f) => f.text === "singular"), "the first word is STILL painted after the second selection");
  check(painted3.length >= 2 && painted3.length <= 4 && "painted".startsWith(painted3),
    `drag izq→der toma letras exactas de 'painted' (${JSON.stringify(painted3)})`);
  const stripes = await evalJs(`__E2E.stripes(${JSON.stringify(NOTES)})`);
  check(stripes >= 2, `franjas visibles: ${stripes}`);
  await shot("01-dos-frags-pintadas.png");

//   // ============ C. ↩ of the popup: word+letters revert in ONE write ============
  const beforeDisk = readDisk(NOTES);
  check(beforeDisk.includes("singular words inside") && beforeDisk.includes("amber painted stripes"), "pre-revert disk has both changes");
  await clickRevert();
  await waitDisk(NOTES, (c) => c.includes("individual words inside"), "m1 restaurada");
  const afterC = readDisk(NOTES);
  check(afterC.includes("individual words inside"), "git/disk: 'singular' went back to 'individual' (line restored to the original)");
  check(!afterC.includes("amber painted stripes") && afterC.includes("amber " + "painted".replace(painted3, "") + " stripes"),
    `git/disk: the 3 letters '${painted3}' left 'painted' (left 'painted'.replace)`, JSON.stringify(afterC.match(/visible as amber.*stripes/)?.[0] ?? ""));
  check(await until(async () => (await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`)).length === 0), "frags unpainted after the revert");
  check(await until(async () => !(await evalJs(`__E2E.hasRowText(${JSON.stringify(NOTES)}, "singular")`))), "the panel RELOADED the diff: 'singular' is no longer in the rows");
  await shot("02-after-revert-word+letters.png");

  await panelStable();
  // ============ D. drag DER→IZQ de 3 letras "cit" de "explicitly" ============
  loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "explicitly", "change-addition")`);
  check(loc && !loc.error, "I locate the green row with 'explicitly'", loc?.error ?? "");
//   // right→left: from the center of the LAST letter to the center of the fifth
//   // (starting 1.5px past the right edge was no man's land between
//   // words: under system load the drag there selected nothing)
  // Forense (this check kept failing under load): WHO is really under the drag's
  // start point, and what does the screen look like if it paints nothing.
  if (loc && !loc.error) {
    const dx = (loc.chars[9].left + loc.chars[9].right) / 2;
    const under = await evalJs(`__E2E.rowAt(${JSON.stringify(NOTES)}, ${dx}, ${loc.y})`);
    console.error("    D forense: start", JSON.stringify({ x: dx, y: loc.y, char9: loc.chars[9], under, active: (await evalJs(`document.activeElement?.className ?? ""`)) }));
    await shot("04-pre-D.png");
  }
  await drag((loc.chars[9].left + loc.chars[9].right) / 2, loc.y, (loc.chars[5].left + loc.chars[5].right) / 2, loc.y);
  await waitPaint(NOTES, 1);
  frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
  const cit = frags[0]?.text ?? "";
  const dOk = frags.length === 1 && frags[0].offA < frags[0].offB && cit.length >= 2 && "explicitly".includes(cit);
  if (!dOk) await shot("04-D-fail.png");
  check(dOk,
    `right→left drag paints letters of 'explicitly' normalized offA<offB (${JSON.stringify(cit)})`);

  await panelStable();
  // ============ E. drag de UNA letra "m" de "simple" ============
  loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "simple", "change-addition")`);
  check(loc && !loc.error, "I locate the green row with 'simple'", loc?.error ?? "");
  await drag(loc.chars[2].left + 1, loc.y, loc.chars[2].right + 1.5, loc.y); // la "m" solita
  await waitPaint(NOTES, 2);
  frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
  const oneLetter = frags[frags.length - 1]?.text ?? "";
  check(frags.length === 2 && oneLetter.length === 1, `selecting ONE letter works (${JSON.stringify(frags.map((f) => f.text))})`);
  await shot("03-letra-unica+y-cit.png");

//   // ============ F. ↩ of the two surgical ones together ============
  await clickRevert();
  await waitDisk(NOTES, (c) => !c.includes("explicitly talks") && !c.includes("simple bullet"), "D+E aplicadas");
  const afterF = readDisk(NOTES);
//   // the exact span depends on the drag's mid-char rounding: what
//   // that has to hold SEMANTICALLY is "explicitly" truncated SURGICALLY
//   // (a remainder of the word stayed, the line still exists) — not a span
  // hardcodeado
  check(/bravo section expl[a-z]{0,4} talks/.test(afterF) && !afterF.includes("explicitly talks"),
    `git/disk: D's drag removed SURGICALLY inside 'explicitly' (frag=${JSON.stringify(cit)}: ${afterF.match(/bravo section.*talks/)?.[0] ?? ""})`);
  check(afterF.includes("simple".replace(oneLetter, "") + " bullet lists"), `git/disk: the letter '${oneLetter}' removed → 'siple' (${afterF.match(/Delta adds.*lists/)?.[0] ?? ""})`);
  await shot("04-tras-revert-letras.png");

  await panelStable();
//   // ============ G. triple-click on the changed table row → whole line ============
  loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "chosen", "change-addition")`);
  check(loc && !loc.error, "I locate the green table row with 'chosen'", loc?.error ?? "");
  await tripleclick((loc.left + loc.right) / 2, loc.y);
  console.error(`    dragPath tras triple: ${JSON.stringify(await evalJs("(() => { const d = __DA.dragPath; return d ? { d: d.detail, x0: d.x0, y0: d.y0 } : null; })()"))}`);
  await waitPaint(NOTES, 1);
  frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
//   // the gesture IS click,click,click: the middle dblclick paints the word
//   // (native behavior) and the 3rd click promotes it to the whole line —
//   // we accept the word if the click-merge lost the race; disk is the authority
  check(frags.length >= 1 && frags.some((f) => f.offA === 0 || f.text === "chosen"),
    `triple-click pinta (frags: ${JSON.stringify(frags.map((f) => f.text.slice(0, 14)))})`);
  await clickRevert();
  await waitDisk(NOTES, (c) => c.includes("| alpha  | select   |") && !c.includes("chosen"), "table line restored");
  check(readDisk(NOTES).includes("| alpha  | select   |"), "git/disk: whole line reverted to the original (no bounce)");
  check(await until(async () => !(await evalJs(`__E2E.hasRowText(${JSON.stringify(NOTES)}, "chosen")`))), "panel reloaded: 'chosen' vanished from the diff");
  await shot("05-after-revert-tripleclick-line.png");

  await panelStable();
//   // ============ H. word on a RED row (deleted line) → the line comes back ============
  loc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "second bullet", "change-deletion")`);
  check(loc && !loc.error, "I locate the RED row with 'second bullet'", loc?.error ?? "");
  const wordLoc = await evalJs(`__E2E.locate(${JSON.stringify(NOTES)}, "second", "change-deletion")`);
  await dblclick((wordLoc.left + wordLoc.right) / 2, wordLoc.y);
  await waitPaint(NOTES, 1);
  frags = await evalJs(`__E2E.frags(${JSON.stringify(NOTES)})`);
  check(frags.length === 1 && frags[0].text === "second", `double-click on the red row paints '${frags[0]?.text}'`);
  await clickRevert();
  await waitDisk(NOTES, (c) => c.includes("- second bullet with the word bravo inside"), "deleted line restored");
  check(readDisk(NOTES).includes("- second bullet with the word bravo inside"), "git/disk: the DELETED line came back whole");
  await shot("06-after-revert-red-row.png");

  await panelStable();
//   // ============ I. gutter checkboxes (vertical drag) → line revert in server.ts ============
  await expandFile(SERVER_TS);
  loc = await evalJs(`__E2E.locate(${JSON.stringify(SERVER_TS)}, '"ready"', "change-addition")`);
  check(loc && !loc.error, "I locate the green row with \"ready\" in server.ts", loc?.error ?? "");
  check(loc.gutterX, "I have the gutter coordinate");
  await drag(loc.gutterX, loc.y, loc.gutterX + 2, loc.y + 9, 6);
  await until(async () => (await evalJs(`__DA.boxSel.size`)) > 0);
  await clickRevert();
  await waitDisk(SERVER_TS, (c) => c.includes('status: "running"'), "server.ts restored");
  check(readDisk(SERVER_TS).includes('status: "running"') && !readDisk(SERVER_TS).includes('"ready"'),
    "git/disk: gutter checkboxes revert the server.ts line");
  await shot("07-after-revert-gutter-checkboxes.png");

  await panelStable();
//   // ============ J. Enter + word on a PURE ADDITION line: surgical (0.9.2) ============
//   // Damian's report: "I pick 3 words from 3 rows, I press enter on the
//   // rollback and it rolls back the 3 LINES" [translated]. Enter now IS the surgical ↩
//   // shortcut, and painting a word of a 100% new line deletes ONLY the
//   // word — the line stays (0.9.1 removed it whole).
  loc = await evalJs(`__E2E.locate(${JSON.stringify(SERVER_TS)}, "/delta", "change-addition")`);
  if (!loc || loc.error) {
    // diagnostics: WHERE did /delta go — disk, diff data, or render?
    console.error("    diag disk /delta:", readDisk(SERVER_TS).includes("/delta"));
    console.error("    diag state:", JSON.stringify(await evalJs(`(() => {
      const d = (__DA.diffData?.files ?? []).find((f) => f.path === ${JSON.stringify(SERVER_TS)});
      const e = __DA.rendered.get(${JSON.stringify(SERVER_TS)});
      const host = e?.body?.querySelector("diffs-container");
      const rows = host?.shadowRoot
        ? [...host.shadowRoot.querySelectorAll("[data-line]")].filter((r) => !r.querySelector("[data-line]")).map((r) => (r.dataset.lineType ?? "?") + "|" + (r.textContent ?? "").replace(/\\s+/g, " ").slice(0, 50))
        : null;
      return {
        workspace: __DA.diffData?.workspace ?? null,
        dataHasDelta: d ? ((d.after ?? "") + (d.patch ?? "")).includes("/delta") : null,
        hasContent: d ? d.before !== undefined : null,
        entryMatchesData: d ? e?.fileData === d : null,
        afterLen: d?.after?.length ?? null,
        entryAfterLen: e?.fileData?.after?.length ?? null,
        collapsed: e?.section?.classList?.contains("collapsed") ?? null,
        rowCount: rows?.length ?? null,
        rows: rows,
        gen: __DA.diffData?.generatedAt ?? null,
      };
    })()`)));
  }
  check(loc && !loc.error, "I can locate the new line of the /delta route", loc?.error ?? "");
  const jx = (loc.left + loc.right) / 2;
//   // aiming diagnostic: which row is under the point BEFORE the gesture and
//   // after the double-click's first click? (if the panel moved, it shows here)
  const jRowBefore = await evalJs(`__E2E.rowAt(${JSON.stringify(SERVER_TS)}, ${jx}, ${loc.y})`);
  await dblclick(jx, loc.y);
  const jRowAfter = await evalJs(`__E2E.rowAt(${JSON.stringify(SERVER_TS)}, ${jx}, ${loc.y})`);
  const jSel = await evalJs("String(getSelection())");
  await waitPaint(SERVER_TS, 1);
  frags = await evalJs(`__E2E.frags(${JSON.stringify(SERVER_TS)})`);
  check(frags.length === 1 && frags[0].text === "delta",
    `double-click paints 'delta' on the new line`,
    `frags=${JSON.stringify(frags.map((f) => f.text))} sel=${JSON.stringify(jSel)} rowBefore=${JSON.stringify(jRowBefore)} rowAfter=${JSON.stringify(jRowAfter)} locRow=${JSON.stringify((loc?.rowText ?? "").slice(0, 40))}`);
  await evalJs("document.activeElement?.blur?.()");
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitDisk(SERVER_TS, (c) => c.includes('register("GET", "/", async () => {'), "word delta removed surgically");
  const afterJ = readDisk(SERVER_TS);
  check(afterJ.includes('register("GET", "/", async () => {') && !afterJ.includes('"/delta"'),
    "git/disk: ONLY the word 'delta' left — the new line STILL exists in the file");
  check(afterJ.includes('return new Response("delta", { status: 200 });') && afterJ.includes("});"),
    "the block's sibling lines were NOT touched");
  const jReload = await until(async () => !(await evalJs(`__E2E.hasRowText(${JSON.stringify(SERVER_TS)}, "/delta")`)), 8000);
  if (!jReload) {
    console.error("    diag J disk:", JSON.stringify({
      hasDeltaRoute: readDisk(SERVER_TS).includes('"/delta"'),
      hasRegisterSlash: readDisk(SERVER_TS).includes('register("GET", "/",'),
      around: (readDisk(SERVER_TS).match(/.{0,60}delta.{0,60}/) ?? [""])[0],
    }));
    console.error("    diag J shelved:", fs.readdirSync(path.join(os.homedir(), ".zcode", "diff-ask", "shelved"), { recursive: true }).length);
    console.error("    diag J:", JSON.stringify(await evalJs(`(() => {
      const f = (__DA.diffData?.files ?? []).find((x) => x.path === ${JSON.stringify(SERVER_TS)});
      const e = __DA.rendered.get(${JSON.stringify(SERVER_TS)});
      return {
        gen: __DA.diffData?.generatedAt ?? null,
        dataHasDelta: (f?.after ?? f?.patch ?? "").includes("/delta"),
        afterTail: (f?.after ?? "").slice(-80),
        frags: (__DA.fragSel.get(${JSON.stringify(SERVER_TS)}) ?? []).map((x) => x.text),
        editing: __DA.editingCount,
        hydrated: !!e?.fd,
        refreshCalls: __DA.refreshCalls,
        refreshBusy: __DA.refreshBusy,
        lastUri: __DA.lastRenderedUri,
        mode: __DA.mode,
        chips: [...document.querySelectorAll(".sent-chip")].map((c) => c.textContent),
      };
    })()`)));
    const freshRaw = await evalJs(`fetch("/mcp?read=" + encodeURIComponent("diff://workspace")).then((r) => r.text())`);
    console.error("    diag J freshRead hasDelta:", freshRaw.includes("/delta"), "len:", freshRaw.length);
  }
  check(jReload, "panel reloaded: the /delta word vanished from the diff");
  await shot("09-tras-enter-quirurgico-adicion-pura.png");

  await panelStable();
//   // ============ K. cumulative brush + ONE general rollback (spec Damian) ============
//   // "I paint 6 words in a row, 4 words on another line, double-click one
//   // word on another, 3 letters on another → ONE general rollback and all
//   // those chars are reverted" [translated]. 0.9.17: no brush-mode buttons — the ＋/↩ popup
//   // appears after each paint (feedback) and Enter executes EVERYTHING painted.
  const TYPES_GO = "tests/diffs/types.go";
  await expandFile(TYPES_GO);

//   // one gesture at a time, with a full trace if it does not paint
  let kCount = 0;
  const kGesture = async (tag, fn) => {
    await evalJs("window.__evts.length = 0");
    await fn();
    // The paint lands through the pointerup fallback / selectionchange
    // pipeline: wait for the FRAG COUNT to grow, then for the panel to settle
    // (two quiet frames) so a mid-gesture native selection never counts.
    await waitForExpr(`__E2E.frags(${JSON.stringify(TYPES_GO)}).length > ${kCount}`, 5000);
    await quiesce();
    const now = (await evalJs(`__E2E.frags(${JSON.stringify(TYPES_GO)})`)).length;
    if (now <= kCount) {
      console.error(`    [${tag}] evts: ${(await evalJs("window.__evts")).join(" ")}`);
      console.error(`    [${tag}] sel:   ${JSON.stringify(await evalJs("String(document.getSelection())"))}`);
      console.error(`    [${tag}] dragP: ${JSON.stringify(await evalJs("(() => { const d = __DA.dragPath; return d ? { x0: d.x0, y0: d.y0, age: Date.now() - d.at, detail: d.detail } : null; })()"))}`);
      console.error(`    [${tag}] uiPtr: ${JSON.stringify(await evalJs("window.__DA ? (__DA.lastUiPointerRef ? __DA.lastUiPointerRef.value : 'n/a') : 'n/a'"))}`);
      console.error(`    [${tag}] diag:  ${await evalJs("(document.querySelector('.diag-chip')?.__log ?? []).slice(-6).join(' ⏐ ')")}`);
    }
    check(now > kCount, `${tag}: the gesture painted`);
    kCount = now;
  };

//   // K1: 5 consecutive words of the new comment (drag)
  loc = await evalJs(`__E2E.locate(${JSON.stringify(TYPES_GO)}, "Render formats the record as one", "change-addition")`);
  check(loc && !loc.error, "K1 I locate the comment's 5 words", loc?.error ?? "");
  if (loc && !loc.error) await kGesture("K1-drag-5-words", () => drag(loc.chars[0].left + 1, loc.y, loc.chars[loc.chars.length - 1].right + 1.5, loc.y));

//   // K2: double-click ONE word ("Render" of the signature)
  loc = await evalJs(`__E2E.locate(${JSON.stringify(TYPES_GO)}, "Record) Render() string", "change-addition")`);
  check(loc && !loc.error, "K2 I locate the Render signature", loc?.error ?? "");
  if (loc && !loc.error) {
    const rw = await evalJs(`__E2E.locate(${JSON.stringify(TYPES_GO)}, "Render() string", "change-addition")`);
    await kGesture("K2-dblclick-palabra", () => dblclick((rw.chars[2].left + rw.chars[2].right) / 2, rw.y));
  }

//   // K3: 3 letters of "Title" in the new return (drag)
  loc = await evalJs(`__E2E.locate(${JSON.stringify(TYPES_GO)}, "return r.Title", "change-addition")`);
  check(loc && !loc.error, "K3 I locate the r.Title return", loc?.error ?? "");
  if (loc && !loc.error) await kGesture("K3-drag-3-letras", () => drag(loc.chars[loc.chars.length - 3].left + 1, loc.y, loc.chars[loc.chars.length - 1].right + 1.5, loc.y));

//   // K4: one word of the MODIFIED line (double-click "Heading")
  loc = await evalJs(`__E2E.locate(${JSON.stringify(TYPES_GO)}, "Heading string", "change-addition")`);
  check(loc && !loc.error, "K4 I locate the modified Heading line", loc?.error ?? "");
  if (loc && !loc.error) await kGesture("K4-dblclick-Heading", () => dblclick((loc.chars[3].left + loc.chars[3].right) / 2, loc.y));

  check(kCount === 4, `the FOUR paints accumulate together (${kCount})`, "");
  check(await evalJs(`document.querySelector(".sel-pop") !== null`), "the ＋/↩ popup appears after painting (feedback, no brush mode)");

  await evalJs("document.activeElement?.blur?.()");
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }); // the GENERAL rollback: runs everything painted
  await waitDisk(TYPES_GO, (c) => c.includes("\tTitle string"), "Title string restaurado");
  const afterK = readDisk(TYPES_GO);
  check(afterK.includes("\tTitle string"), "K4: word of a modified line → line back to the original (Title)");
  check(!afterK.includes("formats the record") && afterK.includes("line."), "K1: the 5 words of the comment were removed surgically");
  check(afterK.includes("func (r Record) () string {"), "K2: ONLY the word 'Render' removed from the signature");
  check(afterK.includes("return r.Ti") && !afterK.includes("return r.Title"), "K3: ONLY the 3 letters 'tle' removed from the return");
  check(await until(async () => (await evalJs(`__E2E.frags(${JSON.stringify(TYPES_GO)})`)).length === 0), "frags unpainted after the general rollback");
  await shot("10-tras-rollback-general-modo-brocha.png");

  await panelStable();
//   // ============ L. coexistence + twins + slow drag (spec Damian 0.9.3) ============
//   // "I cannot do a multi-line multi-word selection: what is painted gets
//   // unpainted when painting the new" + "it selects all the identical ones".
  const PARSER_PY = "tests/diffs/parser.py";
  await expandFile(PARSER_PY);
  const pFrags = async () => (await evalJs(`__E2E.frags(${JSON.stringify(PARSER_PY)})`));

//   // L1: TWO words on the SAME row — they coexist (before, the per-row filter
  // despintaba la primera al pintar la segunda)
  loc = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, "Marker words:")`);
  check(loc && !loc.error, "L1 I locate the Marker line", loc?.error ?? "");
  await dblclick((loc.chars[2].left + loc.chars[2].right) / 2, loc.y); // "Marker"
  await waitForExpr(`__E2E.frags(${JSON.stringify(PARSER_PY)}).length >= 1`, 4000);
  await quiesce();
  const locAlpha = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, "alpha (tokens)")`);
  await dblclick((locAlpha.chars[2].left + locAlpha.chars[2].right) / 2, locAlpha.y); // "alpha"
  await waitForExpr(`__E2E.frags(${JSON.stringify(PARSER_PY)}).length >= 2`, 4000);
  await quiesce();
  let pf = await pFrags();
  check(pf.length === 2 && pf.some((f) => f.text === "Marker") && pf.some((f) => f.text === "alpha"),
    `L1: two words of the SAME row coexist (${JSON.stringify(pf.map((f) => f.text))})`);

//   // L2: MULTI-LINE multi-word drag — from "render" to "join" (two rows)
  const a2 = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, "def render(tokens):")`);
//   // without re-scroll: locating join would move the rows and make a2 stale
  const b2 = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, 'return " ".join', null, true)`);
  check(a2 && !a2.error && b2 && !b2.error, "L2 I locate render and join", a2?.error ?? b2?.error ?? "");
  await drag((a2.chars[6].left + a2.chars[6].right) / 2, a2.y, b2.chars[b2.chars.length - 1].right + 1.5, b2.y);
  await waitForExpr(`__E2E.frags(${JSON.stringify(PARSER_PY)}).length >= 3`, 4000);
  pf = await pFrags();
  check(pf.length === 3 && pf.some((f) => f.first !== f.last),
    `L2: multi-line drag paints ONE frag of two rows and does NOT unpaint the previous one (${JSON.stringify(pf.map((f) => f.text.slice(0, 8)))})`);

//   // L4: SLOW (>1.5s) multi-line drag — the geometric gesture stays alive.
//   // Fresh re-locate (L2 painted overlays; coordinates up to date).
  const a4 = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, "def render(tokens):")`);
  const b4 = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, 'return " ".join', null, true)`);
  check(a4 && !a4.error && b4 && !b4.error, "L4 I re-locate render and join", a4?.error ?? b4?.error ?? "");
  await mouse.press((a4.chars[0].left + a4.chars[0].right) / 2, a4.y);
  for (let i = 1; i <= 8; i++) {
    await mouse.move((a4.chars[0].left + a4.chars[0].right) / 2 + ((b4.right - a4.chars[0].left) * i) / 8, a4.y + ((b4.y - a4.y) * i) / 8);
    await pace(210); // INPUT TIMING: the slow (>1.5 s) drag IS what this case tests
  }
  await mouse.release(b4.right + 1.5, b4.y);
  await waitForExpr(`__E2E.frags(${JSON.stringify(PARSER_PY)}).length >= 3`, 4000);
  pf = await pFrags();
  check(pf.length === 3 && pf.some((f) => f.first !== f.last),
    `L4: SLOW multi-line drag (1.7s) paints the same (${JSON.stringify(pf.map((f) => ({ t: f.text.slice(0, 6), r: f.first + "-" + f.last })))})`);

  // L3: palabra GEMELA ("Response" existe en varios handlers) → UNA sola
  const gem = await evalJs(`__E2E.locate(${JSON.stringify(SERVER_TS)}, 'new Response("missing"')`);
  check(gem && !gem.error, "L3 I locate a Response in server.ts", gem?.error ?? "");
  await dblclick((gem.chars[7].left + gem.chars[7].right) / 2, gem.y); // "Response"
  await waitForExpr(`__E2E.frags(${JSON.stringify(SERVER_TS)}).length >= 1`, 4000);
  await quiesce();
  const sf = await evalJs(`__E2E.frags(${JSON.stringify(SERVER_TS)})`);
  check(sf.length === 1 && sf[0].text === "Response",
    `L3: the twin word paints ONE occurrence (${JSON.stringify(sf.map((f) => f.text))})`);
  await shot("11-coexistencia-multiline-twins-slow.png");

  await panelStable();
//   // ============ M. CLASSIC line-by-line diff like GitHub (0.9.11) ============
//   // Final spec Damian 28/10: "I want to see a normal diff, line by line, like
//   // on GitHub: the red line with the word highlighted in red, and below the
//   // green one with the word in green highlighted. Not everything on one line. And revert
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
      strikes: rows.reduce((n, r) => n + r.querySelectorAll("[data-da-del]").length, 0),
    };
  })()`);
  check(mods.redVisible && mods.greenVisible && mods.redBeforeGreen, "BOTH rows visible: the RED one above, the GREEN one below");
  check(mods.redIsDeletion && mods.greenIsAddition, "each row with its type (deletion/addition)");
  check(mods.redText === "Marker words: alpha (words), bravo (numbers), charlie (symbols)." &&
    mods.greenText === "Marker words: alpha (tokens), bravo (numbers), charlie (symbols).",
    `EXACT text of each row — the red one with (words), the green one with (tokens)`);
  check(mods.delBoxes > 0 && mods.addBoxes > 0,
    `the removed word is highlighted in RED (.wc-del boxes=${mods.delBoxes}) and the added one in GREEN (.wc-add=${mods.addBoxes})`);
  check(mods.delBg.includes("0.42") && mods.addBg.includes("0.42"),
    `readable programmatic fill (relative oklch, alpha 0.42): del=${JSON.stringify(mods.delBg.slice(0, 40))} add=${JSON.stringify(mods.addBg.slice(0, 40))}`);
  check(mods.strikes === 0, "no inline strikethroughs and no version mix on a single row");
//   // toolbar order (spec Damian 28/10): ↩file · ＋ · ✏️ · ? · ↩multiline
  const btnOrder = await evalJs(`(() => {
    const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(PARSER_PY)});
    return [...e.section.querySelector(".file-head").querySelectorAll("button")].map((b) => b.className.replace("ghost ", ""));
  })()`);
  check(JSON.stringify(btnOrder) === JSON.stringify(["frev", "fplus", "fedit"]),
    `toolbar order (3 buttons, no ? and no ↩↩): ↩file · ＋ · ✏️ (${JSON.stringify(btnOrder)})`);
  await shot("12-diff-clasico-github.png");

//   // EXACT MARKS of the ask (bug Damian 28/10: two words from
//   // distant rows underlined ALL the rows in between): I paint "Marker" (row 2) and
//   // "render" (a distant row), ask about the fragments, and ONLY
//   // those two rows get marked — none in between. The block starts from a CLEAN
  // selection state: earlier sections painted frags in this very file, and
  // this check is about what THIS block paints (never timing-dependent).
  {
    await evalJs(`__DA.fragSel.clear(); __DA.fragModes.clear(); __DA.boxSel.clear();`);
    await evalJs(`__DA.refresh(true)`);
    await panelStable();
    const mk1 = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, "Marker words:")`);
    await dblclick((mk1.chars[2].left + mk1.chars[2].right) / 2, mk1.y); // "Marker"
    await waitForExpr(`__E2E.frags(${JSON.stringify(PARSER_PY)}).length >= 1`, 4000);
    // Settle BEFORE the second gesture: a mid-gesture native selection must
    // never be mistaken for a painted frag (it used to duplicate the line).
    await quiesce();
    const mk2 = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, "def render")`);
    await dblclick((mk2.chars[5].left + mk2.chars[5].right) / 2, mk2.y); // "render"
    await waitPaint(PARSER_PY, 2);
    await quiesce();
    const askBtn = await waitForExpr(`(() => { const b = document.querySelector(".sel-pop button"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`, 4000);
    check(!!askBtn, "the ＋ popup appears after painting");
    await click(askBtn.x, askBtn.y); // ＋ → composer de fragmentos
    await waitForExpr(`!!document.querySelector(".composer")`, 4000);
    await cdp("Input.insertText", { text: "why did you change this?" });
    await waitForExpr(`document.querySelector(".composer textarea")?.value === "why did you change this?"`, 3000);
    const send = await evalJs(`(() => { const b = document.querySelector(".composer .ask"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    check(!!send, "opens the composer for the fragment ask");
    await click(send.x, send.y); // Ask
    await waitForExpr(`__DA.pendingAsks.length === 1`, 4000);
    const marks = await evalJs(`(() => {
      const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(PARSER_PY)});
      const sr = e.body.querySelector("diffs-container").shadowRoot;
//       // only CONTENT rows — the gutter (the number cell) is marked
//       // too and would count twice
      const marked = [...sr.querySelectorAll("[data-content] [data-qa]")];
      return {
        n: marked.length,
        texts: marked.map((r) => (r.textContent ?? "").slice(0, 22)),
        label: __DA.pendingAsks[0]?.label ?? null,
        frags: (__DA.fragSel.get(${JSON.stringify(PARSER_PY)}) ?? []).map((f) => ({ side: f.side, line: f.line, a: f.offA, b: f.offB, t: f.text })),
      };
    })()`);
    check(marks.n === 2, `ONLY the two asked rows are marked (${marks.n}): ${JSON.stringify(marks.texts)} frags=${JSON.stringify(marks.frags)}`);
    check(marks.texts.some((t) => t.includes("Marker words")) && marks.texts.some((t) => t.includes("def render")),
      "the marked ones are 'Marker' and 'def render' — none in between");
    check(/^lines \d+, \d+$/.test(marks.label ?? ""), `the anchor names the exact lines (${JSON.stringify(marks.label)})`);
//     // cleanup: empty pile + refresh (the marks go on the next render)
    await evalJs("__DA.pendingAsks.length = 0");
    await evalJs(`__DA.fragSel.delete(${JSON.stringify(PARSER_PY)})`);
    await evalJs("__DA.refresh(true)");
    await panelStable();
  }

//   // painting the RED row's word = restoring: double-click on 'words' of
//   // the RED row → old-side frag → the line goes back TO THE ORIGINAL and leaves the diff
  await evalJs(`__DA.fragSel.delete(${JSON.stringify(PARSER_PY)})`); // suelto las pintadas de L
  const redLoc = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, "(words", "change-deletion")`);
  check(redLoc && !redLoc.error, "I locate the word 'words' IN THE RED ROW", redLoc?.error ?? "");
//   // HALF a word of the red one restores nothing: the whole word must be painted
//   // whole (mirror rule of the green surgery, surgical spec 0.9.14)
  await drag(redLoc.chars[1].left, redLoc.y, redLoc.chars[2].right + 0.5, redLoc.y, 6); // "wo"
  await waitPaint(PARSER_PY, 1);
  await evalJs("document.activeElement?.blur?.()");
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await settle();
  check(readDisk(PARSER_PY).includes("alpha (tokens)") && (await evalJs(`__E2E.hasRowText(${JSON.stringify(PARSER_PY)}, "(tokens")`)),
    "half a word of the RED one restores nothing: the pair stays the same (noDiff)");
  const redLoc2 = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, "(words", "change-deletion")`);
  await dblclick((redLoc2.chars[2].left + redLoc2.chars[2].right) / 2, redLoc2.y);
  await waitPaint(PARSER_PY, 1);
  pf = await pFrags();
  check(pf.length === 1 && pf[0].text === "words", `double-click on the RED row paints the restore frag (${JSON.stringify(pf.map((f) => f.text))})`);
  await evalJs("document.activeElement?.blur?.()");
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await waitDisk(PARSER_PY, (c) => c.includes("alpha (words)"), "the modified line goes back to the original");
  const afterM = readDisk(PARSER_PY);
  check(afterM.includes("Marker words: alpha (words), bravo (numbers), charlie (symbols)."),
    "painting on the RED one RESTORED the original line (chars of 'words' back)");
  check(afterM.includes("def render(tokens):"), "and the rest of the parser.py diff stayed untouched");
  check(await until(async () => !(await evalJs(`__E2E.hasRowText(${JSON.stringify(PARSER_PY)}, "Marker words")`))),
    "the pair vanished from the diff (back to HEAD)");

//   // re-render with identical content (refresh): the classic model is
//   // kept — two rows, boxes, no duplication
  const CFG = "tests/diffs/config.json";
  await panelStable(); // the revert refresh may keep re-rendering
  await expandFile(CFG); // collapsed there are no rects: without expanding there are no boxes
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
  check(mods2.redVisible === 1 && mods2.greenVisible === 1, "after an identical refresh: ONE red and ONE green (no duplication)");
  check(mods2.delBoxes > 0 && mods2.addBoxes > 0, "and the red/green boxes still sit over the pair's words");

  await panelStable();
//   // ============ N. EXACT text of the pair's two rows (0.9.11) ============
//   // Classic model: the green one is the NEW line and the red one the OLD, each
//   // with ITS exact text (the 0.9.7 lesson: duplicated text from hlColorize
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

  // Nushell (0.9.19): .nu colorizado por el subset REAL — pierre mapea
//   // .nu → "nushell", the nu grammar is bundled and hlColorize applies it.
  // Colors are DEFERRED (0.11.1): wait for the condition, not a timer.
  const NU = "tests/diffs/runner.nu";
  await expandFile(NU);
  await waitForExpr(`(() => {
    const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(NU)});
    const sr = e?.body?.querySelector("diffs-container")?.shadowRoot;
    return !!sr && [...sr.querySelectorAll("[data-line][data-hl]")].length > 0;
  })()`, 15000);
  const nuState = await evalJs(`(() => {
    const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(NU)});
    const rows = [...e.body.querySelector("diffs-container").shadowRoot.querySelectorAll("[data-line]")].filter((r) => !r.querySelector("[data-line]"));
    const grand = rows.find((r) => (r.textContent ?? "").includes("grand total"));
    return {
      hlN: rows.filter((r) => r.dataset.hl).length,
      total: rows.length,
      engineHasNu: typeof __DA_HL_READY?.langs === "function" ? (__DA_HL_READY.langs() ?? []).includes("nushell") : null,
      grandHl: grand?.dataset.hl ?? null,
      grandTxt: grand?.textContent ?? null,
    };
  })()`);
  check(nuState.engineHasNu === true, `the REAL engine has the nushell grammar loaded (${JSON.stringify(nuState.engineHasNu)})`);
  check(nuState.hlN > 0, `the .nu gets COLORIZED (${nuState.hlN}/${nuState.total} rows with dataset.hl)`);
  check(nuState.grandHl !== null && nuState.grandTxt === '  echo $"alpha grand total: ($total)"',
    `the nu1 change row colorized with EXACT text (${JSON.stringify((nuState.grandTxt ?? "").slice(0, 36))})`);
  await shot("13-nushell-highlight.png");

//   // ============ O. ✏️ edit mode: pierre's editor rules ALONE (0.9.9) ============
  // Reporte Damian 28/10: "empiezo a editar y se pone en negro lo que
  // escribo o borro". Sospecha: el MutationObserver del shadow dispara
//   // scheduleAnchors on every keystroke (the editor re-renders rows) and
//   // hlColorize rewrites WHOLE rows with tokens from the OLD content
  // (fileData.after no se actualiza mientras se edita) — encima de las
//   // LIVE rows of the editor. In edit mode NONE of our stuff is touched.
  const SHELL_SH = "tests/diffs/shell.sh";
  await expandFile(SHELL_SH);
  // Let the DEFERRED first highlight land before the edit session starts, so
  // "hlColorize never ran during editing" measures editing alone.
  await waitForExpr(`(() => {
    const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(SHELL_SH)});
    const sr = e?.body?.querySelector("diffs-container")?.shadowRoot;
    return !!sr && [...sr.querySelectorAll("[data-line][data-hl]")].length > 0;
  })()`, 15000);
  const editBtnAt = async () => await evalJs(`(() => {
    const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(SHELL_SH)});
    const b = e?.section.querySelector("button.fedit");
    if (!b) return null;
    e.section.querySelector(".file-head").scrollIntoView({ block: "center" });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  let eb = await editBtnAt();
  check(!!eb, "I find the shell.sh ✏️ button");
  await click(eb.x, eb.y);
  check(await until(async () => await evalJs(`(() => { const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(SHELL_SH)}); return !!e?.edit; })()`), 4000), "✏️ turns edit mode on");
  await quiesce();
  let edLoc = await evalJs(`__E2E.locate(${JSON.stringify(SHELL_SH)}, "listing all")`);
  check(edLoc && !edLoc.error, "I locate the row to edit with the editor active", edLoc?.error ?? "");
  await click(edLoc.left - 2, edLoc.y); // caret en el borde izquierdo del needle
  await quiesce();
  const hlBefore = await evalJs(`(() => { const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(SHELL_SH)}); return e?._hlRuns ?? 0; })()`);
  await cdp("Input.insertText", { text: "BRAVO" });
  await waitDisk(SHELL_SH, (c) => c.includes("BRAVO"), "autosave writes to disk");
  const edState = await evalJs(`(() => {
    const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(SHELL_SH)});
    const host = e.body.querySelector("diffs-container");
    const rows = [...host.shadowRoot.querySelectorAll("[data-line]")].filter((r) => !r.querySelector("[data-line]"));
//     // pierre's editor lives on MIRRORS: SPANs in the shadow (outside the
//     // rows [data-line]) with the per-line text — here you can see what was typed
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
  check(edState.typedVisible && edState.typedTwice === 1, "what was TYPED lives on the editor surface (no duplication)");
  check(edState.hlRuns === hlBefore, `hlColorize did NOT run during the edit (runs ${hlBefore}→${edState.hlRuns})`);
  check(edState.delSpans === 0, "no strikethroughs of ours in the editor");
  check((edState.editorText ?? "").includes("BRAVO"), "el documento del editor contiene lo tipado");
  await shot("13-editando-tipado.png");
//   // DELETE too: backspace over what was typed — same protection
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
  // (the disk watch below is the wait — no fixed delay)
  const saved = await waitDisk(SHELL_SH, (c) => c.includes("BRAV"), "the editor's autosave writes to disk");
  check(saved && readDisk(SHELL_SH).includes("BRAV"),
    "git/disk: what was typed arrived (BRAV present after the backspace)");
  eb = await editBtnAt();
  await click(eb.x, eb.y); // leave edit mode (saves)
  check(await until(async () => await evalJs(`(() => { const e = [...__DA.rendered.values()].find((x) => x.path === ${JSON.stringify(SHELL_SH)}); return !e?.edit; })()`), 4000), "✏️ leaves edit mode");
  await shot("14-edit-guardado.png");

//   // ============ P. repo picker of the 📁 chip (0.9.18) ============
//   // Spec Damian 28/10: "a small tree that I can go up and that
//   // filters only the folders that have .git" [translated]. Starts at the PARENT
//   // of the workspace, ⬆ goes up one level, lists ONLY git repos (bounded recursion,
//   // the server resolves it) and a live text filter.
//   // 0.9.23: hermetic fixture — a REAL worktree (git = file) in the
//   // GLOBAL ~/Projects/.worktrees container to assert the [.worktrees] tag +
//   // order (it goes on top) without depending on the user's real worktrees. It goes
//   // THERE and not inside the repo because the filter needle is the
//   // workspace path: a fixture nested below would match the filter too.
  const WTD = path.join(os.homedir(), "Projects", ".worktrees");
  const FXT = path.join(WTD, "e2e-picker-fixture-wt");
  fs.mkdirSync(FXT, { recursive: true });
  fs.writeFileSync(path.join(FXT, ".git"), "gitdir: /dev/null/e2e/main/.git/worktrees/e2e-picker-fixture-wt\n");
  const wsBtn = await evalJs(`(() => { const b = document.querySelector("button.ws"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  check(!!wsBtn, "encuentro el chip 📁 del workspace");
  await click(wsBtn.x, wsBtn.y);
  check(await until(async () => (await evalJs(`document.querySelector(".ws-picker")`)) !== null, 3000), "the click opens the PICKER (not the path editor)");
  await until(async () => (await evalJs(`[...document.querySelectorAll(".ws-picker .ws-row")].length`)) > 0, 10000);
  const pk1 = await evalJs(`(() => {
    const rows = [...document.querySelectorAll(".ws-picker .ws-row")];
    return {
      crumb: document.querySelector(".ws-picker .crumb")?.textContent ?? "",
      n: rows.length,
      hasRepo: rows.some((r) => r.textContent.includes("zcode-diff-ask")),
      current: document.querySelector(".ws-picker .ws-row.current")?.textContent?.slice(0, 34) ?? null,
      upDisabled: document.querySelector(".ws-picker .up")?.disabled ?? null,
    };
  })()`);
  const wsParent = await evalJs(`(__DA.diffData?.workspace ?? "").replace(/\\/+$/, "").split("/").slice(0, -1).join("/")`);
  check(pk1.crumb === wsParent, `it starts at the workspace PARENT (${JSON.stringify(pk1.crumb.slice(-26))})`);
  check(pk1.n > 0 && pk1.hasRepo, `the list has git repos, the current one included (${pk1.n} rows)`);
  check((pk1.current ?? "").includes("zcode-diff-ask"), `the current repo is marked (${JSON.stringify(pk1.current)})`);
//   // 0.9.23: the fixture worktree comes out tagged .worktrees and ABOVE the current repo
  const pkW = await evalJs(`(() => {
    const rows = [...document.querySelectorAll(".ws-picker .ws-row")];
    const iWt = rows.findIndex((r) => r.textContent.includes("e2e-picker-fixture-wt"));
    return {
      iWt,
      tag: iWt >= 0 ? rows[iWt].querySelector(".wt")?.textContent ?? null : null,
      iCur: rows.findIndex((r) => r.classList.contains("current")),
      nTags: rows.filter((r) => r.querySelector(".wt")).length,
    };
  })()`);
  check(pkW.iWt >= 0 && pkW.tag === ".worktrees", `the fixture worktree comes out tagged [.worktrees] (${JSON.stringify(pkW)})`);
  check(pkW.iWt >= 0 && pkW.iWt < pkW.iCur, `the worktree goes ABOVE the current repo (idx ${pkW.iWt} < ${pkW.iCur})`);
//   // live text filter: the input already has focus — needle = the full
//   // workspace PATH: unique (only the current row contains it) and independent of
//   // where the checkout lives (master or a .worktrees/* worktree, 0.9.21/0.9.23)
  const filterNeedle = await evalJs(`(__DA.diffData?.workspace ?? "").toLowerCase()`);
  await cdp("Input.insertText", { text: filterNeedle });
  await waitForExpr(`document.querySelectorAll(".ws-picker .ws-row").length === 1`, 4000);
  const pkF = await evalJs(`[...document.querySelectorAll(".ws-picker .ws-row")].map((r) => r.textContent.slice(0, 26))`);
  check(pkF.length === 1 && pkF[0].includes("zcode-diff-ask"), `the live filter leaves only the match (${JSON.stringify(pkF)})`);
//   // ⬆ goes up one level and re-lists
  await evalJs(`(() => { const i = document.querySelector(".ws-picker input"); if (i) { i.value = ""; i.dispatchEvent(new Event("input")); } })()`);
  await waitForExpr(`document.querySelectorAll(".ws-picker .ws-row").length > 1`, 4000);
  const upBtnP = await evalJs(`(() => { const b = document.querySelector(".ws-picker .up"); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: b.disabled }; })()`);
  check(upBtnP && !upBtnP.disabled, "⬆ enabled (there is a level above)");
  await click(upBtnP.x, upBtnP.y);
  const upTarget = pk1.crumb.replace(/\/[^/]+$/, ""); // one ⬆ = parent of the initial parent
  check(await until(async () => (await evalJs(`document.querySelector(".ws-picker .crumb")?.textContent ?? ""`)) === upTarget, 10000),
    `⬆ goes up one level (crumb ${JSON.stringify(upTarget)})`);
  // Esc cierra sin cambiar el workspace
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  check(await until(async () => (await evalJs(`document.querySelector(".ws-picker")`)) === null, 2000), "Esc closes the picker without changing the workspace");
  fs.rmSync(FXT, { recursive: true, force: true }); // hermetic fixture out
  await shot("15-picker-repos.png");

//   // ============ Q. the DRAFT survives the reactive refresh (0.9.20) ============
//   // URGENT Damian 28/10: I type in the composer, a change to the diff arrives
//   // (reactive refresh), and the box with what I wrote is wiped. The composer has
//   // to stay — text, listeners and focus — in the NEW section.
  await panelStable();
  await expandFile(PARSER_PY);
  await evalJs(`__DA.fragSel.delete(${JSON.stringify(PARSER_PY)})`);
//   // CAREFUL: section M reverts the "Marker words:" line to HEAD and that row
//   // leaves the diff, so Q anchors to an addition that is still alive: the
//   // inserted `def render(tokens):` function (green row of parser.py).
  const qLoc = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, "def render(tokens):")`);
  check(qLoc && !qLoc.error, "Q: I locate a live parser.py row (def render)", qLoc?.error ?? "");
  if (!qLoc || qLoc.error) throw new Error("Q: parser.py is not locatable — I cannot test the draft");
  await dblclick((qLoc.chars[5].left + qLoc.chars[5].right) / 2, qLoc.y); // pintar "render"
  await waitPaint(PARSER_PY, 1);
  const qAsk = await waitForExpr(`(() => { const b = document.querySelector(".sel-pop button"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`, 4000);
  check(!!qAsk, "popup ＋ disponible para abrir el composer");
  await click(qAsk.x, qAsk.y); // ＋ → composer de fragmentos
  await waitForExpr(`!!document.querySelector(".composer")`, 4000);
  await cdp("Input.insertText", { text: "question typed while the folder changes" });
  await waitForExpr(`document.querySelector(".composer textarea")?.value === "question typed while the folder changes"`, 3000);
//   // a change on disk triggers the reactive refresh (fs.watch → SSE → renderAll)
  fs.appendFileSync(path.join(REPO, "tests/diffs/notes.md"), "\n<!-- borrador: cambio reactivo -->\n");
  await panelStable();
  const draft = await evalJs(`(() => {
    const card = document.querySelector(".composer");
    const ta = card?.querySelector("textarea");
    return {
      alive: !!card,
      text: ta?.value ?? null,
      anchored: card?.closest("section.file")?.querySelector(".fname")?.textContent?.slice(0, 30) ?? null,
      focused: document.activeElement === ta,
      caretAtEnd: ta ? ta.selectionStart === ta.value.length : null,
    };
  })()`);
  check(draft.alive, "el composer SIGUE tras el refresh reactivo");
  check(draft.text === "question typed while the folder changes", `what was WRITTEN survives (${JSON.stringify((draft.text ?? "").slice(0, 30))})`);
  check((draft.anchored ?? "").includes("parser.py"), "and it lives inside the new parser.py section");
  check(draft.focused && draft.caretAtEnd, `focus returns to the textarea with the caret at the end (focused=${draft.focused} caret=${draft.caretAtEnd})`);
  await shot("16-borrador-sobrevive.png");
//   // cleanup: close the composer and return the fixture to its standard state
  const qClose = await evalJs(`(() => { const b = document.querySelector(".composer .close"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (qClose) await click(qClose.x, qClose.y);
  await evalJs(`__DA.fragSel.delete(${JSON.stringify(PARSER_PY)})`);
  execFileSync("git", ["-C", REPO, "checkout", "--", "tests/diffs/notes.md"]);
  execFileSync("node", [path.join(HERE, "apply-fixture-mods.mjs")], { stdio: "ignore" });
  await evalJs("__DA.refresh(true)");
  await panelStable();

  // ============ R. mega commit: no hang, no brick (0.9.21) ============
  // Damian's report: opening a commit from the ZCode repo (an upstream-sync
  // merge with 5103 files) hung the server (2 git-shows PER file, serial) and
  // bricked the panel: mode chips, folder picker, everything dead — every
  // action coalesced into the same stuck refresh promise. Fixture: a tmp repo
  // whose single commit touches 700 files (> MAX_LIST_FILES=600 → pruned list
  // + banner). Workspace switch via the REAL picker flow ("a mano" editor).
  const MEGA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "da-e2e-mega-"));
  execFileSync("git", ["-C", MEGA_DIR, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", MEGA_DIR, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", MEGA_DIR, "config", "user.name", "T"]);
  for (let i = 0; i < 700; i++) fs.writeFileSync(path.join(MEGA_DIR, `f${i}.txt`), `mega ${i}\n`);
  execFileSync("git", ["-C", MEGA_DIR, "add", "-A"]);
  execFileSync("git", ["-C", MEGA_DIR, "commit", "-qm", "mega commit: 700 files"]);
  const megaShort = execFileSync("git", ["-C", MEGA_DIR, "rev-parse", "--short", "HEAD"]).toString().trim();
  check(megaShort.length >= 7, `R: fixture ready — tmp repo with a 700-file commit (${megaShort})`);

  const clickAt = async (sel) => {
    const p = await evalJs(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!p) throw new Error("sin elemento para " + sel);
    await click(p.x, p.y);
  };
//   // Real-click flow: 📁 chip → "type the path by hand…" → editor → type →
  // Enter. Each step RETRIES via until (single CDP clicks race the picker's
  // own row loading) and the WHOLE cycle retries up to 3 times: focus/typing
  // races made the switch land late sometimes (workspace never switched
  // within the window, then appeared right after — retry until it sticks).
  // switchWorkspace: the server CANONICALIZES the workspace (realpathSync,
  // audit wave 5) — on macOS tmp dirs (/var/folders...) resolve to
  // /private/var/... so the wanted path must be canonicalized too or the
  // equality check never matches.
  const switchWorkspace = async (rawWant) => {
    const want = fs.realpathSync(rawWant);
    for (let attempt = 0; attempt < 3; attempt++) {
      const opened = await (async () => {
        if (!(await evalJs(`!!document.querySelector(".ws-editor input")`))) {
          if (!(await evalJs(`!!document.querySelector(".ws-picker")`))) {
            await clickAt("button.ws").catch(() => {});
            await waitForExpr(`!!document.querySelector(".ws-picker")`, 4000);
          }
          await clickAt(".ws-picker .manual").catch(() => {});
          await waitForExpr(`!!document.querySelector(".ws-editor input")`, 4000);
        }
        return !!(await evalJs(`document.querySelector(".ws-editor input")`));
      })();
      if (!opened) throw new Error("R: the path editor never opened");
      await evalJs(`(() => { const i = document.querySelector(".ws-editor input"); i.focus(); i.select(); })()`);
      await cdp("Input.insertText", { text: want });
      await waitForExpr(`document.querySelector(".ws-editor input")?.value === ${JSON.stringify(want)}`, 3000);
      await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
      // 12s per attempt: a switch under load (Chrome busy rendering the mega
      // view, FSEvents bursts) can land past 6s but well before the next try
      const ok = await until(async () => (await evalJs(`__DA.diffData?.workspace ?? null`)) === want, 12000);
      if (ok) return true;
    }
    console.error("    diag switch:", JSON.stringify(await evalJs(`(() => ({
      want: ${JSON.stringify(want)},
      ws: __DA.diffData?.workspace ?? null,
      mode: __DA.diffData?.mode ?? null,
      error: __DA.diffData?.error ?? null,
      errMsg: __DA.diffData?.message?.slice(0, 60) ?? null,
      files: __DA.diffData?.files?.length ?? null,
      picker: !!document.querySelector(".ws-picker"),
      editor: !!document.querySelector(".ws-editor"),
    }))()`)));
    await shot("debug-switch.png");
    return false;
  };
  await clickAt("button.ws");
  check(await until(async () => (await evalJs(`document.querySelector(".ws-picker")`)) !== null, 3000), "R: el picker 📁 abre");
  check(await switchWorkspace(MEGA_DIR), "R: workspace cambiado al repo mega (flujo real del picker)");

  await clickAt('.modebar button.ws-commits');
  check(await until(async () => (await evalJs(`[...document.querySelectorAll(".commit-row")].length`)) > 0, 6000), "R: the commit list shows the mega commit");
  const rowR = await evalJs(`(() => { const b = document.querySelector(".commit-row"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, hash: b.querySelector(".hash-chip")?.textContent }; })()`);
  check(rowR?.hash === megaShort, `R: the row is the mega commit (${JSON.stringify(rowR?.hash)})`);
  const tR = Date.now();
  await click(rowR.x, rowR.y);
  const openedR = await until(async () => (await evalJs(`__DA.diffData?.commit?.short ?? null`)) === megaShort, 20000);
  const dtR = Date.now() - tR;
  check(openedR, `R: the mega commit's diff opens with the commit info (${dtR}ms)`);
  check(dtR < 15000, `R: the 700-file commit opens in bounded time (${dtR}ms < 15s)`);
  const mdR = JSON.parse(await evalJs(`JSON.stringify({ fc: __DA.diffData?.fileCount, n: __DA.diffData?.files?.length, tr: __DA.diffData?.truncated, banner: document.querySelector(".state.warn")?.textContent ?? null, meta: document.querySelector(".header .meta")?.textContent ?? "" })`));
  check(mdR.fc === 700 && mdR.n === 600, `R: pruned payload — fileCount ${mdR.fc}, ${mdR.n} sections in the panel`);
  check(mdR.tr === true && (mdR.banner ?? "").includes("700"), `R: banner de recorte visible (${JSON.stringify((mdR.banner ?? "").slice(0, 70))})`);
  check((mdR.meta ?? "").includes(megaShort), `R: the header shows the commit hash and subject (${JSON.stringify((mdR.meta ?? "").slice(0, 60))})`);

  // ANTI-BRICK: right after the mega commit, everything must respond. This is
  // the exact freeze Damian hit: before the fix every later action queued
  // behind the stuck refresh promise.
  await clickAt('.modebar button[data-mode="working"]');
  check(await until(async () => (await evalJs(`__DA.diffData?.mode ?? null`)) === "working", 6000), "R: ANTI-BRICK — the Work chip responds right after the mega commit");
  await clickAt("button.ws");
  check(await until(async () => (await evalJs(`document.querySelector(".ws-picker")`)) !== null, 3000), "R: ANTI-BRICK — el picker 📁 sigue vivo");
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  check(await until(async () => (await evalJs(`document.querySelector(".ws-picker")`)) === null, 2000), "R: Esc cierra el picker");

  // restore: back to the fixture workspace so the final health checks run on it
  check(await switchWorkspace(REPO), "R: vuelvo al workspace del fixture");
  try { fs.rmSync(MEGA_DIR, { recursive: true, force: true }); } catch {}
  await shot("17-mega-commit.png");

  // ============ S. dead workspace: warn + way out (0.9.24) ============
  // The repo can VANISH while the panel is open (deleted project/worktree).
  // It must WARN and keep a working escape hatch to a valid repo — never
  // brick. Report: deleting the folder left the panel stuck with no usable
  // control.
  const DEAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "da-e2e-dead-"));
  execFileSync("git", ["-C", DEAD_DIR, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", DEAD_DIR, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", DEAD_DIR, "config", "user.name", "T"]);
  fs.writeFileSync(path.join(DEAD_DIR, "x.txt"), "x\n");
  execFileSync("git", ["-C", DEAD_DIR, "add", "-A"]);
  execFileSync("git", ["-C", DEAD_DIR, "commit", "-qm", "base"]);
  check(await switchWorkspace(DEAD_DIR), "S: the workspace points at the ephemeral repo");
  fs.rmSync(DEAD_DIR, { recursive: true, force: true });
  await evalJs("__DA.refresh(true)");
  check(await until(async () => !!(await evalJs(`document.querySelector(".state.error")`)), 6000), "S: workspace DELETED → the panel WARNS");
  const sBtns = await evalJs(`(() => {
    const sw = document.querySelector(".ws-switch");
    const wsChip = document.querySelector(".modebar button.ws");
    return { switchBtn: !!sw, modebarChip: !!wsChip, msg: document.querySelector(".state.error")?.textContent?.slice(0, 60) ?? "" };
  })()`);
  check(sBtns.switchBtn, `S: the "Pick another folder" button EXISTS (${JSON.stringify(sBtns.msg)})`);
  check(sBtns.modebarChip, "S: the modebar with the 📁 chip is still present in the error");
  const swXY = await evalJs(`(() => { const b = document.querySelector(".ws-switch"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await click(swXY.x, swXY.y);
  check(await until(async () => !!(await evalJs(`document.querySelector(".ws-picker")`)), 3000), "S: the button opens the picker");
  check(await switchWorkspace(REPO), "S: it can go back to a VALID repo from the error state");
  check(await until(async () => !(await evalJs(`!!document.querySelector(".state.error")`)), 6000), "S: el aviso desaparece tras cambiar de carpeta (panel recuperado)");
  await shot("18-dead-workspace.png");

  // ============ T. pending asks: delete + auto-drop on edit (0.9.25) ============
  // Report: after asking about a painted selection, once the agent edited the
  // line the highlight could never be removed again — the pile ✕ re-rendered
  // the pile but left the painted rows behind. Rules: ✕ removes ask AND
  // marks, the bottom trash clears everything, and an ask auto-drops when
  // its cited line was edited (the quote is gone from the row).
  const askCount = async () => await evalJs(`__DA.pendingAsks.length`);
  const markCount = async () => await evalJs(`[...document.querySelectorAll("diffs-container")].reduce((n, h) => n + (h.shadowRoot?.querySelectorAll("[data-qa]").length ?? 0), 0)`);
  const askAbout = async (needle, note) => {
    await panelStable();
    await evalJs(`__DA.fragSel.delete(${JSON.stringify(PARSER_PY)})`); // fresh paint per ask
    // reset any leftover selection state so each ask starts clean
    await evalJs(`__DA.fragModes.delete(${JSON.stringify(PARSER_PY)})`);
    await evalJs(`__DA.boxSel.clear()`);
    // after a workspace switch every section is born COLLAPSED: rows exist in
    // the shadow but measure zero, so locate would never find them
    await expandFile(PARSER_PY);
    const l = await evalJs(`__E2E.locate(${JSON.stringify(PARSER_PY)}, ${JSON.stringify(needle)}, "change-addition")`);
    if (!l || l.error) {
      console.error("    diag T state:", JSON.stringify(await evalJs(`(() => {
        const e = __DA.rendered.get(${JSON.stringify(PARSER_PY)});
        const host = e?.body?.querySelector("diffs-container");
        const rows = host?.shadowRoot ? [...host.shadowRoot.querySelectorAll("[data-line]")].filter((r) => !r.querySelector("[data-line]")) : [];
        return {
          mode: __DA.diffData?.mode ?? null,
          ws: __DA.diffData?.workspace ?? null,
          files: __DA.diffData?.files?.length ?? null,
          hasEntry: !!e,
          after: (e?.fileData?.after ?? "").includes(${JSON.stringify(needle)}),
          rows: rows.filter((r) => r.dataset.lineType === "change-addition").map((r) => (r.textContent ?? "").slice(0, 40)),
        };
      })()`)));
      console.error("    diag T disk:", readDisk(PARSER_PY).includes(needle));
      throw new Error("T: I cannot locate " + needle + " — " + (l?.error ?? "?"));
    }
    // Paint via the GUTTER (one deterministic drag → box selection → the
    // ＋/↩ popup): the dblclick-on-text path toggles under load here (second
    // click + dblclick selectionchange race), the gutter drag is the gesture
    // clickRevert has used reliably across every run.
    await drag(l.gutterX, l.y, l.gutterX + 2, l.y + 6, 5);
    check(await until(async () => (await evalJs(`__DA.boxSel.size`)) > 0, 4000), "T: the gutter drag paints the line");
    const pop = await until(async () => (await evalJs(`(() => { const b = document.querySelector(".sel-pop button"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`)), 8000);
    if (!pop) {
      console.error("    diag T popup:", JSON.stringify(await evalJs(`(() => ({
        boxes: __DA.boxSel.size,
        brush: !!__DA.fragModes.get(${JSON.stringify(PARSER_PY)}),
        selPop: !!document.querySelector(".sel-pop"),
        sel: String(getSelection()).slice(0, 40),
        mode: __DA.diffData?.mode ?? null,
      }))()`)));
      await shot("debug-T-popup.png");
      throw new Error("T: the ＋ popup did not appear");
    }
    await click(pop.x, pop.y);
    await waitForExpr(`!!document.querySelector(".composer")`, 4000);
    const before = await askCount();
    await cdp("Input.insertText", { text: note });
    await waitForExpr(`document.querySelector(".composer textarea")?.value === ${JSON.stringify(note)}`, 3000);
    const okBtn = await evalJs(`(() => { const b = document.querySelector(".composer .ask"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    if (!okBtn) throw new Error("T: there is no Ask button");
    await click(okBtn.x, okBtn.y);
    return await waitForExpr(`__DA.pendingAsks.length === ${before + 1}`, 4000);
  };

  check(await askAbout("def render(tokens):", "T1: what does this do?"), "T: the ask enters the pile");
  check((await markCount()) > 0, "T: the row stays MARKED (data-qa)");
  // ✕ via DOM click: what T guards is the HANDLER's effect (pile + painted
  // marks); the real-mouse hit-testing is already exercised all over the rig,
  // and the pile sits under a sticky askbar that can eat the press.
  const rmHit = await evalJs(`(() => { const b = document.querySelector("#pile .pile-item .rm"); if (!b) return false; b.click(); return true; })()`);
  check(rmHit, "T: the pile's ✕ exists");
  check(await until(async () => (await askCount()) === 0, 3000), "T: the ✕ takes the ask out of the pile");
  check(await until(async () => (await markCount()) === 0, 3000), "T: and CLEARS the painted mark (before, it stayed forever)");

  check(await askAbout("def render(tokens):", "T2: the line is about to be edited"), "T: second ask in the pile");
  // the agent edits THAT line on disk → the panel's OWN reactive refresh must
  // drop the ask (this is the behavior under test). Wait for the drop, with a
  // manual refresh as the documented fallback for a missed fs.watch event.
  const parserDisk = readDisk(PARSER_PY);
  fs.writeFileSync(path.join(REPO, PARSER_PY), parserDisk.replace("def render(tokens):", "def painted(tokens):"));
  let dropped = await waitForExpr(`__DA.pendingAsks.length === 0`, 8000);
  if (!dropped) {
    await evalJs("__DA.refresh(true)");
    dropped = await waitForExpr(`__DA.pendingAsks.length === 0`, 8000);
  }
  check(dropped, "T: the ask DROPS BY ITSELF when the cited line was edited");
  check(await waitForExpr(`[...document.querySelectorAll("diffs-container")].reduce((n, h) => n + (h.shadowRoot?.querySelectorAll("[data-qa]").length ?? 0), 0) === 0`, 4000),
    "T: and its mark goes with it");

  execFileSync("git", ["-C", REPO, "checkout", "--", PARSER_PY]);
  execFileSync("node", [path.join(HERE, "apply-fixture-mods.mjs")], { stdio: "ignore" });
  await evalJs("__DA.refresh(true)");
  await panelStable();

  // trash: two asks (one line + one free) → the bottom trash clears all marks
  check(await askAbout("def render(tokens):", "T3: pile one"), "T: line ask for the trash");
  await evalJs(`(() => { const i = document.getElementById("askbar-input"); i.value = "libre para el tacho"; i.focus(); i.dispatchEvent(new Event("input")); })()`);
  await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter" });
  check(await until(async () => (await askCount()) === 2, 3000), "T: there are 2 pending ones (line + free)");
  const trashXY = await evalJs(`(() => { const b = document.getElementById("askbar-clear"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  check(!!trashXY, "T: the 🗑 Delete all trash exists");
  await click(trashXY.x, trashXY.y);
  check(await until(async () => (await askCount()) === 0, 3000), "T: the trash deletes ALL the selections");
  check(await until(async () => (await markCount()) === 0, 3000), "T: and no painted mark is left");
  await shot("19-asks-borrables.png");

//   // ============ U. turns v2: one turn, TWO repos (0.9.26) ============
  // The turn tap listens on the plugin inbox (prompt/stop events) and a
  // home-wide FSEvents stream; at Stop it records commits made in the window
  // and dirty files, grouped by repo. Fixture: a real second repo under the
  // global agent-worktrees container (outside this checkout) + a dirty file
  // in the fixture repo — both must show up namespaced in ONE turn.
  const SECOND = path.join(os.homedir(), "Projects", ".worktrees", `da-e2e-turn-${Date.now().toString(36)}`);
  execFileSync("git", ["init", "-q", "-b", "main", SECOND]);
  execFileSync("git", ["-C", SECOND, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", SECOND, "config", "user.name", "T"]);
  const U_DIRTY = "tests/diffs/u-turn-dirty.txt";
  const sendTurnEvent = (ev) => fs.appendFileSync(TURN_INBOX, `${JSON.stringify(ev)}\n`);
  // Explicit, DETERMINISTIC window: the turn's stamps and the commits'
  // author dates are all pinned inside [uAt, uAt+8000] — no wall-clock
  // spacing, no race between "commit at now" and a stop clamped to now.
  const uAt = Date.now() - 10_000;
  const uEnv = (ms) => ({
    ...process.env,
    GIT_AUTHOR_DATE: new Date(ms).toISOString(),
    GIT_COMMITTER_DATE: new Date(ms).toISOString(),
  });
  fs.writeFileSync(path.join(SECOND, "x.txt"), "base\n");
  execFileSync("git", ["-C", SECOND, "add", "-A"]);
  execFileSync("git", ["-C", SECOND, "commit", "-qm", "base"], { env: uEnv(uAt + 1000) });
  const tapStateNow = async () => await evalJs(`fetch("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "tap_state", args: {} }) }).then((r) => r.json())`);
  sendTurnEvent({ type: "prompt", sid: "e2e-u", cwd: REPO, prompt: "U: hello turn of two repos", at: new Date(uAt).toISOString() });
  // The tap only records while a turn window is OPEN: wait for the prompt to
  // be folded BEFORE writing, else the writes are dropped (the old sleeps hid
  // this by giving the inbox drain time). State waits, no timers.
  const turnOpen = await until(async () => ((await tapStateNow())?.openTurns ?? 0) >= 1, 8000);
  check(turnOpen, "U: the turn is open before writing (the tap only records with an open window)");
  fs.writeFileSync(path.join(REPO, U_DIRTY), "dirty line of the turn\n"); // dirty in the fixture repo
  fs.writeFileSync(path.join(SECOND, "x.txt"), "base\nturn progress\n");
  execFileSync("git", ["-C", SECOND, "add", "-A"]);
  execFileSync("git", ["-C", SECOND, "commit", "-qm", "feat: turn progress"], { env: uEnv(uAt + 2000) });
  // The capture model needs the WRITE TAP to have seen the second repo before
  // the window closes.
  const secondReal = fs.realpathSync(SECOND);
  const tapped = await until(async () => ((await tapStateNow())?.gitRoots ?? []).includes(secondReal), 8000);
  check(tapped, "U: the tap already knows the second repo before closing the window");
  sendTurnEvent({ type: "stop", sid: "e2e-u", cwd: REPO, reply: "U: done, I touched two repos", at: new Date(uAt + 8000).toISOString() });
  check(await waitForExpr(`!!document.querySelector(".modebar button[data-mode='turns']")`, 4000), "U: the Turns tab exists");
  await evalJs(`document.querySelector('.modebar button[data-mode="turns"]')?.click()`);
  await waitForExpr(`!!document.querySelector(".header .back")`, 6000);
  await evalJs(`document.querySelector(".header .back")?.click()`); // ← Turns: the list
  const rowU = await waitForExpr(`(() => {
    const rows = [...document.querySelectorAll(".turn-row")];
    const row = rows.find((r) => (r.textContent ?? "").includes("dos repos"));
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: row.textContent.slice(0, 120) };
  })()`, 10000);
  check(!!rowU, "U: the turn appears in the Turns list with its prompt");
  if (!rowU) throw new Error("U: no turn row — I cannot open the diff");
  check(/\d+ repos/.test(rowU?.text ?? ""), `U: the row summarizes the turn's repos (${JSON.stringify((rowU?.text ?? "").slice(0, 80))})`);
  check((rowU?.text ?? "").includes("done, I touched two repos"), "U: the row shows the reply summary");
  await click(rowU.x, rowU.y);
  check(await until(async () => (await evalJs(`__DA.diffData?.mode ?? null`)) === "turn", 6000), "U: the click opens the turn's diff");
  const uState = await evalJs(`(() => {
    const d = __DA.diffData;
    const paths = (d?.files ?? []).map((f) => f.path);
    return {
      repos: (d?.turn?.repos ?? []).map((r) => r.label),
      hasDirty: paths.some((p) => p.endsWith("/" + ${JSON.stringify(U_DIRTY)})),
      hasCommit: paths.some((p) => p.endsWith("/x.txt") && p.split("/")[0] !== ${JSON.stringify(path.basename(REPO))}),
      editable: [...document.querySelectorAll(".file-head .fedit")].length,
      revertable: [...document.querySelectorAll(".file-head .frev")].length,
      meta: document.querySelector(".header .meta")?.textContent ?? "",
    };
  })()`);
  // 0.9.29: the turn may ALSO carry a "~" pseudo-repo for files touched
  // OUTSIDE any git repo during the window. 0.10.4: the $HOME-wide tap can
  // also catch REAL background activity (the bot daemon's repo, etc.) — the
  // turn model is global by design, so the rig asserts the two FIXTURE
  // repos are present (not that nothing else exists) and that "~" closes
  // the list when present.
  check((uState.repos ?? []).includes(path.basename(REPO)) && (uState.repos ?? []).includes(path.basename(SECOND)),
    `U: the turn groups the fixture's TWO repos (${JSON.stringify(uState.repos)})`);
  check((uState.repos ?? []).length === 2 || uState.repos?.[uState.repos.length - 1] === "~",
    `U: the outside-git group, if present, closes turn.repos (${JSON.stringify(uState.repos)})`);
  check(uState.hasDirty, "U: the session repo's dirty file is in the diff");
  check(uState.hasCommit, "U: the second repo's COMMIT is in the diff");
  check(uState.editable === 0 && uState.revertable === 0, `U: turn = read-only cross-repo (edit=${uState.editable} rev=${uState.revertable})`);
  check((uState.meta ?? "").includes("2 files") || (uState.meta ?? "").includes("file"), `U: the header summarizes the turn (${JSON.stringify((uState.meta ?? "").slice(0, 90))})`);
//   // visual grouping per repo: one header per repo, each with its
//   // counts, and its own files right below
  const groupsU = await evalJs(`(() => {
    const heads = [...document.querySelectorAll(".turn-repo-head")];
    return {
      n: heads.length,
      labels: heads.map((h) => h.querySelector(".trh-label")?.textContent),
      counts: heads.map((h) => h.querySelector(".trh-counts")?.textContent ?? ""),
    };
  })()`);
  // 0.9.29: headers are ALWAYS on (single repo too); 0.10.4: background
  // repos may ride along — assert the FIXTURE repos' headers are present.
  check((groupsU.labels ?? []).includes(path.basename(REPO)) && (groupsU.labels ?? []).includes(path.basename(SECOND)),
    `U: one header per fixture repo (${JSON.stringify(groupsU.labels)})`);
  check(groupsU.n === 2 || groupsU.labels?.[groupsU.n - 1] === "Outside git",
    `U: the Outside git header, if present, goes last (${JSON.stringify(groupsU.labels)})`);
  check(groupsU.labels?.includes(path.basename(REPO)) && groupsU.labels?.includes(path.basename(SECOND)), "U: los encabezados nombran los DOS repos");
  check(groupsU.counts?.some((c) => c.includes("2 commits")), "U: the second repo's header shows its 2 commits");
  // 0.10.0: folder sub-headers sort the browsing inside each repo group
  // ("categorizados por repositorios y carpetas"). The first repo block's
  // files follow its head (folder heads in between are not files).
  const orderU = await evalJs(`(() => {
    const kids = [...document.getElementById("root").children];
    const idx = kids.findIndex((k) => k.classList?.contains("turn-repo-head"));
    const label = kids[idx]?.querySelector(".trh-label")?.textContent ?? null;
    const firstFile = kids.slice(idx + 1).find((k) => k.classList?.contains("file"));
    return { firstIsHead: idx >= 0, label, firstFilePrefix: firstFile?.querySelector(".fdir")?.textContent?.slice(0, 40) ?? null };
  })()`);
  check(orderU.firstIsHead && (orderU.firstFilePrefix ?? "").startsWith(orderU.label), `U: the header precedes ITS files (${JSON.stringify(orderU)})`);
  const foldersU = await evalJs(`[...document.querySelectorAll(".turn-folder-head")].map((h) => h.querySelector(".tfh-label")?.textContent)`);
  check((foldersU ?? []).includes("tests/diffs") && (foldersU ?? []).includes("(root)"),
    `U: sub-encabezados de carpeta por grupo (${JSON.stringify(foldersU)})`);
  await shot("20-turns-two-repos.png");

  // U2 (0.14.1) — same-tab re-entry means THE LAST TURN. With a turn opened
//   // from the list (turnSel = its id), clicking the Turns tab used to only
  // refresh that view: the tab stayed pinned to the old turn and the latest
  // one seemed to never load. Re-entry must reset the selection to "latest".
  const reentryBefore = await evalJs(`({ sel: __DA.turnSel, mode: __DA.mode })`);
  check(reentryBefore.mode === "turns" && reentryBefore.sel !== "latest",
    `U2: we start from a turn opened from the list (${JSON.stringify(reentryBefore)})`);
  await evalJs(`document.querySelector('.modebar button[data-mode="turns"]')?.click()`);
  check(await until(async () => (await evalJs(`__DA.turnSel`)) === "latest", 8000),
    "U2: clicking Turns with an old turn open goes back to the LAST turn");
  check(await until(async () => (await evalJs(`__DA.diffData?.mode ?? null`)) === "turn", 8000),
    "U2: the view re-reads that turn (it does not stay on the old one)");
  check(await evalJs(`document.querySelectorAll(".turn-repo-head").length > 0`),
    "U2: the latest turn rendered with its repo groups");

  // ============ V. 0.10.0: dos tabs + repo tab (sugerencia/prompt/Commits) ====
//   // The mode bar has exactly TWO tabs now (Turns + Work per repository);
//   // "Unpushed" is gone. The repo tab without a chosen repo asks the server
  // which repo the LAST turn changed the most and adopts it; with no turns it
  // shows its picker prompt instead. Commits is a sub-view reached through the
  // repo tab's own button.
  const tabsV = await evalJs(`[...document.querySelectorAll('.modebar button[data-mode]')].map((b) => b.dataset.mode)`);
  check(tabsV.length === 2 && tabsV.includes("turns") && tabsV.includes("working"),
    `V: la modebar tiene exactamente DOS tabs (${JSON.stringify(tabsV)})`);
  check(await evalJs(`[...document.querySelectorAll('.modebar button')].every((b) => !/Unpushed/.test(b.textContent))`),
    "V: the Unpushed button no longer exists");

  // V1 — suggestion: reset wsChosen and enter the repo tab. The U turn left
  // the fixture repo with ~11 dirty files vs the second repo's 2 commits —
  // the fixture repo is the "most changes" repo and must be adopted alone.
  await evalJs(`__DA.wsChosen = false`);
  await evalJs(`document.querySelector('.modebar button[data-mode="working"]')?.click()`);
  check(await until(async () => (await evalJs(`__DA.wsChosen && (__DA.diffData?.mode ?? null)`)) === "working", 10000),
    "V: with no repo chosen, the last turn's suggestion applies by itself");
  const wsV = await evalJs(`(() => ({ ws: __DA.diffData?.workspace, chip: document.querySelector(".modebar button.ws")?.textContent ?? "", commitsBtn: !!document.querySelector(".modebar button.ws-commits") }))()`);
  // 0.10.4: with background repos riding the turns (global tap), the exact
  // winner can vary — the FLOW assertion is that a valid repo was adopted
  // and the chip names it (the ranking itself is unit-tested).
  check(!!(wsV.ws ?? "") && fs.existsSync(wsV.ws), `V: the suggestion adopted a valid repo (${JSON.stringify((wsV.ws ?? "").slice(-24))})`);
  check((wsV.chip ?? "").includes((wsV.ws ?? "").split("/").pop() ?? "@") || (wsV.ws ?? "") === fs.realpathSync(REPO),
    `V: the chip shows the suggested repo (${JSON.stringify(wsV.chip)})`);
  check(wsV.commitsBtn, "V: the Commits button appears with the repo chosen");

  // V2 — Commits sub-view: list → one commit's diff → back to the list →
  // back to the SAME repo's working tree.
  await clickAt('.modebar button.ws-commits');
  check(await until(async () => (await evalJs(`document.querySelectorAll(".commit-row").length > 0 && !!document.querySelector(".back-ws")`)), 8000),
    "V: Commits opens the chosen repo's list with its back button");
  // 0.10.3: the ACTIVE Commits sub-button must keep its subtle outline — the
  // generic tab fill (.modebar button.active) used to paint it solid.
  const styleV = await evalJs(`(() => {
    const tab = document.querySelector('.modebar button[data-mode="working"]');
    const cb = document.querySelector(".modebar button.ws-commits");
    if (!tab || !cb) return null;
    return { tabBg: getComputedStyle(tab).backgroundColor, cbBg: getComputedStyle(cb).backgroundColor, cbCls: cb.className };
  })()`);
  check(!!styleV && styleV.tabBg !== styleV.cbBg && /active/.test(styleV.cbCls),
    `V: active Commits does NOT use the tab fill (${JSON.stringify(styleV)})`);
  const rowV = await evalJs(`(() => { const b = document.querySelector(".commit-row"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!rowV) throw new Error("V: sin commit rows");
  await click(rowV.x, rowV.y);
  check(await until(async () => !!(await evalJs(`__DA.diffData?.commit`)), 8000), "V: el diff de un commit abre desde la sub-vista");
  await evalJs(`document.querySelector(".header .back")?.click()`); // ← Commits (the list)
  check(await until(async () => (await evalJs(`document.querySelectorAll(".commit-row").length > 0`)), 6000), "V: ← Commits goes back to the list");
  await evalJs(`document.querySelector(".back-ws")?.click()`); // ← Trabajo del repo
  check(await until(async () => (await evalJs(`__DA.diffData?.mode ?? null`)) === "working", 6000), "V: ← Work per repository returns to the SAME repo's tree");
  check((await evalJs(`__DA.diffData?.workspace ?? ""`)) === fs.realpathSync(REPO), "V: the workspace was kept through the whole Commits cycle");

  // V3 — the turn list pages 10 at a time ("de a diez hacia el pasado"):
  // pump cheap all-outside turns (no repos to scan) and read page 1.
  const TURN_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "da-e2e-vturn-"));
  const t0v = Date.now() - 12 * 90_000;
  for (let i = 0; i < 12; i++) {
    const at = new Date(t0v + i * 60_000).toISOString();
    sendTurnEvent({ type: "prompt", sid: `e2e-v${i}`, cwd: TURN_TMP, prompt: `V page turn ${i}`, at });
    sendTurnEvent({ type: "stop", sid: `e2e-v${i}`, cwd: TURN_TMP, reply: `V ok ${i}`, at: new Date(t0v + i * 60_000 + 30_000).toISOString() });
  }
  await evalJs(`document.querySelector('.modebar button[data-mode="turns"]')?.click()`);
  await until(async () => !!(await evalJs(`document.querySelector(".header .back")`)), 5000);
  await evalJs(`document.querySelector(".header .back")?.click()`); // ← Turns (the list)
  const pageV = await until(async () => (await evalJs(`(() => {
    const rows = document.querySelectorAll(".turn-row").length;
    const more = document.querySelector(".more-btn");
    return rows > 0 ? { rows, more: !!more, moreTitle: more?.title ?? "" } : null;
  })()`)), 8000);
  if (!pageV)
    console.error("    diag V3:", JSON.stringify(await evalJs(`(() => ({
      mode: __DA.mode, turnSel: __DA.turnSel, turns: __DA.turnsState?.list?.length,
      err: document.querySelector(".state.error")?.textContent?.slice(0, 80) ?? null,
      empty: document.querySelector(".state")?.textContent?.slice(0, 60) ?? null,
    }))()`)));
  check((pageV?.rows ?? 0) === 10, `V: the turns list pages TEN at a time (${pageV?.rows} rows)`);
  check(pageV?.more && /10 turns/.test(pageV.moreTitle ?? ""), `V: the "…" loads 10 at a time (${JSON.stringify(pageV?.moreTitle)})`);

  // V5 — two CONTENT turns, then pick A → back → pick B: both must render
  // their sections (0.10.4 reconciliation vs stale entries; report 22/11:
//   // "I pick any turn from the list and it comes up empty").
  const mark = (tag) => `V5-${tag}-${Date.now().toString(36)}`;
  const contentTurn = async (tag, file, line) => {
    const sid = `e2e-v5-${tag}`;
    const now = Date.now();
    // Explicit window: prompt in the past, stop in the future, the write in
    // between — no wall-clock spacing needed (the fold keys on the stamps).
    sendTurnEvent({ type: "prompt", sid, cwd: REPO, prompt: mark(tag), at: new Date(now - 2000).toISOString() });
    fs.writeFileSync(path.join(REPO, file), line);
    sendTurnEvent({ type: "stop", sid, cwd: REPO, reply: `ok ${tag}`, at: new Date(now + 1000).toISOString() });
  };
  await contentTurn("a", "tests/diffs/notes.md", `v5 A ${Date.now()}\n`);
  await contentTurn("b", "tests/diffs/notes.md", `v5 B ${Date.now()}\n`);
  const pickByPrompt = async (needle) => {
    const p = await waitForExpr(`(() => {
      const row = [...document.querySelectorAll(".turn-row")].find((r) => (r.textContent ?? "").includes(${JSON.stringify(needle)}));
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`, 8000);
    if (!p) throw new Error("V5: no row for " + needle);
    await click(p.x, p.y);
    return waitForExpr(`(() => {
      const id = __DA.diffData?.turn?.id ?? null;
      const n = __DA.rendered.size;
      return id && n > 0 ? { id, files: n } : null;
    })()`, 10000);
  };
  const pickA = await pickByPrompt("V5-a");
  check(!!pickA && pickA.files > 0, `V: turn A (with content) opens with sections (${JSON.stringify(pickA)})`);
  await evalJs(`document.querySelector(".header .back")?.click()`); // ← Turns (the list)
  await until(async () => !!(await evalJs(`document.querySelector(".turn-row")`)), 6000);
  const pickB = await pickByPrompt("V5-b");
  check(!!pickB && pickB.files > 0 && pickB.id !== pickA.id,
    `V: a DIFFERENT turn B re-renders with its sections (${JSON.stringify(pickB)})`);
  await evalJs(`document.querySelector(".header .back")?.click()`); // ← Turns (the list)
  await until(async () => !!(await evalJs(`document.querySelector(".turn-row")`)), 6000);
  const pickA2 = await pickByPrompt("V5-a");
  check(!!pickA2 && pickA2.files > 0 && pickA2.id === pickA.id,
    `V: volver a A re-renderiza (${JSON.stringify(pickA2)})`);

  // V4 — no turns at all → the repo tab shows its picker prompt (nothing is
  // auto-diffed) and a manual pick recovers the view. (Enter the repo tab
  // FIRST: V3 left the panel on the turns LIST.)
  await evalJs(`fetch("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "clear_turns", args: {} }) }).then(() => 0)`);
  await evalJs(`document.querySelector('.modebar button[data-mode="working"]')?.click()`);
  await until(async () => (await evalJs(`__DA.mode`)) === "working", 6000);
  await evalJs(`__DA.wsChosen = false`);
  await evalJs(`__DA.refresh(true)`);
  check(await until(async () => (await evalJs(`!!document.querySelector(".state .ws-switch") && !__DA.wsChosen`)), 10000),
    "V: with no turns, the repo tab shows the picker prompt (nothing auto-diffed)");
  check(/select repository/.test((await evalJs(`document.querySelector(".modebar button.ws")?.textContent ?? ""`))),
    "V: the chip says select repository...");
  check(await switchWorkspace(REPO), "V: manual fixture selection from the prompt");
  fs.rmSync(TURN_TMP, { recursive: true, force: true });
  await shot("21-repo-tab-flow.png");
//   // cleanup: ephemeral repo + dirty file (the state dir is the rig's tmp)
  fs.rmSync(SECOND, { recursive: true, force: true });
  fs.rmSync(path.join(REPO, U_DIRTY), { force: true });
  await evalJs(`document.querySelector('.modebar button[data-mode="working"]')?.click()`);
  await evalJs("__DA.refresh(true)");

  // ============ W. 0.10.8: the multi-task reality (sticky sid) ============
  // One server, several tasks: the app stamps _meta on every tools/call, so
  // the server's sticky sid is whoever called LAST. Recording must stay
  // session-agnostic (the live both-tabs-empty failure) and the panel's
  // explicit-scope read must pin its own task.
  const postTool = (tool, args, meta) =>
    evalJs(`fetch("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: ${JSON.stringify(JSON.stringify({ tool, args, meta }))} }).then((r) => r.json())`);
  {
    // task sPanel-A talks (sticky sid ← _meta), then task sWork-B works:
    const rc1 = JSON.stringify(await postTool("whoami", {}, { "com.zcode/request-context": { session_id: "e2e-w-panel" } }));
    check(/e2e-w-panel/.test(rc1), "W: the sticky sid stayed on the panel's task (like the app)");
    sendTurnEvent({ type: "prompt", sid: "e2e-w-work", cwd: REPO, prompt: "W turn of the OTHER task", at: new Date().toISOString() });
    sendTurnEvent({ type: "stop", sid: "e2e-w-work", cwd: REPO, reply: "W trabajo hecho", at: new Date(Date.now() + 1000).toISOString() });
    // a read from the panel's task must NOT see the other task's turn…
    const scoped = await postTool("list_turns", {}, { "com.zcode/request-context": { session_id: "e2e-w-panel" } });
    check(!JSON.stringify(scoped).includes("W turn of the OTHER task"),
      "W: the panel task's view does NOT see the foreign turn (scoped)");
    // …but the recording HAPPENED: the other task's own scoped read sees it.
    const own = await postTool("list_turns", {}, { "com.zcode/request-context": { session_id: "e2e-w-work" } });
    check(JSON.stringify(own).includes("W turn of the OTHER task") && JSON.stringify(own).includes("W work done"),
      "W: the other task's turn WAS RECORDED despite the foreign sticky sid (the live regression)");
    // and the panel's explicit-scope read (turn://list?sid=) pins its task
    // even with the server's sticky elsewhere.
    const panelList = await evalJs(`fetch("/mcp?read=" + encodeURIComponent("turn://list?skip=0&limit=10&sid=" + encodeURIComponent("e2e-w-work"))).then((r) => r.json())`);
    check(JSON.stringify(panelList).includes("W turn of the OTHER task"),
      "W: the panel's read with an explicit sid sees ITS task");
    // cleanup: this rig state is tmp, but keep later sections' lists clean
    await evalJs(`fetch("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "clear_turns", args: {}, meta: { "com.zcode/request-context": { session_id: "e2e-w-work" } } }) }).then(() => 0)`);
  }

  // ============ X. 0.10.10: a turn shows what ZCode's summary shows =======
  // ZCode's end-of-turn summary comes from the session's workspace
  // checkpoints. The turn view must list exactly those files — not the dirty
  // tree, not what a shell wrote, not background noise.
  const X_DIR = path.join(REPO, "tests/diffs/x-e2e-app");
  const appStore = createAppStore(APP_DIR);
  try {
    const xSid = "e2e-x-app";
    appStore.know(xSid);
    const xMark = `X-turn-of-the-app-${Date.now().toString(36)}`;
    fs.mkdirSync(X_DIR, { recursive: true });
    const [xOne, xTwo, xShell] = ["one.ts", "two.ts", "shell-only.txt"].map((f) => path.join(X_DIR, f));
    const t0x = Date.now();
    sendTurnEvent({ type: "prompt", sid: xSid, cwd: REPO, prompt: xMark, at: new Date(t0x).toISOString() });
    // Written by the agent's tools — the app checkpoints each one…
    fs.writeFileSync(xOne, "export const one = 1;\n");
    appStore.checkpoint(xSid, t0x + 1000, "Write", [written(xOne, "export const one = 1;\n")]);
    fs.writeFileSync(xTwo, "const two = 2;\nconst THREE = 3;\n");
    appStore.checkpoint(xSid, t0x + 1500, "Edit", [edited(xTwo, "const two = 2;\nconst three = 3;\n", "const two = 2;\nconst THREE = 3;\n")]);
    // …and by a shell command only, which the app never checkpoints.
    fs.writeFileSync(xShell, "made by a shell command\n");
    sendTurnEvent({ type: "stop", sid: xSid, cwd: REPO, reply: "X listo", at: new Date(t0x + 3000).toISOString() });

    // The rig's panel learned no sid at boot, so its reads follow the
    // server's cached one — and section W left it on ITS task. Speak for X's
    // task first, exactly as a real panel does at boot (whoami).
    await evalJs(`fetch("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tool: "whoami", args: {}, meta: { "com.zcode/request-context": { session_id: ${JSON.stringify(xSid)} } } }) }).then(() => 0)`);

    await evalJs(`document.querySelector('.modebar button[data-mode="turns"]')?.click()`);
    await until(async () => !!(await evalJs(`document.querySelector(".header .back")`)), 6000);
    await evalJs(`document.querySelector(".header .back")?.click()`); // ← the list
    // Page-side snippet: an element's text, whitespace-normalized.
    const rowText = (expr) => `((${expr}).textContent ?? "").replace(/\\s+/g, " ").trim()`;
    const rowX = await until(async () => evalJs(`(() => {
      const row = [...document.querySelectorAll(".turn-row")].find((r) => (r.textContent ?? "").includes(${JSON.stringify(xMark)}));
      return row ? ${rowText("(row)")} : null;
    })()`), 8000);
    check(/1 repos? · 2 files/.test(rowX ?? ""), `X: the row counts what ZCode's summary counts (${JSON.stringify((rowX ?? "").slice(-70))})`);

    const pickX = await pickByPrompt(xMark);
    check(!!pickX && pickX.files === 2, `X: the turn opens with EXACTLY its two files (${JSON.stringify(pickX)})`);
    const rel = (f) => `${path.basename(REPO)}/tests/diffs/x-e2e-app/${f}`;
    const viewX = await evalJs(`(() => ({
      source: __DA.diffData?.turn?.source ?? null,
      light: __DA.diffData?.light ?? null,
      files: (__DA.diffData?.files ?? []).map((f) => ({ path: f.path, status: f.status, deferred: f.deferred, before: f.before, after: f.after, added: f.added, deleted: f.deleted })),
      heads: [...document.querySelectorAll(".turn-repo-head")].map((h) => ${rowText("(h)")}),
    }))()`);
    check(viewX.source === "app", `X: the turn comes from the app (${viewX.source})`);
    check(JSON.stringify(viewX.files.map((f) => f.path)) === JSON.stringify([rel("one.ts"), rel("two.ts")]),
      `X: only the two files the app checkpointed (${JSON.stringify(viewX.files.map((f) => f.path))})`);
    // 0.11.0: the turn arrives LIGHT — headers/counts now, content per file
    // when the user expands it (a big turn must not move megabytes to show
    // its headers).
    check(viewX.light === true, `X: the turn arrives light — headers, content per file (light=${viewX.light})`);
    check(viewX.files.every((f) => f.deferred === true && f.before === undefined && f.after === undefined),
      `X: el payload liviano no lleva before/after (${JSON.stringify(viewX.files.map((f) => [f.deferred, f.before, f.after]))})`);
    check(viewX.files.map((f) => `${f.added}/${f.deleted}`).join(",") === "1/0,1/1", `X: the +N −M are the app's (${JSON.stringify(viewX.files.map((f) => [f.added, f.deleted]))})`);
    // Expanding fetches THAT file's content (the Edit's before rebuilt through
    // the app's patch applier) and caches it.
    await expandFile(rel("two.ts"));
    const bodyX = await until(async () => evalJs(`(() => {
      const e = __DA.rendered.get(${JSON.stringify(rel("two.ts"))});
      const f = e?.fileData;
      return f && typeof f.before === "string" ? { before: f.before, after: f.after ?? "" } : null;
    })()`), 8000);
    check(bodyX?.before === "const two = 2;\nconst three = 3;\n" && bodyX?.after === "const two = 2;\nconst THREE = 3;\n",
      `X: the Edit shows the before and the AFTER rebuilt on expand (${JSON.stringify([bodyX?.before, bodyX?.after])})`);
    check((await evalJs(`__DA.fileContents.size`)) >= 1, "X: the content stayed cached per turn+file");
    check(/2 files/.test(viewX.heads.join(" | ")) && !/commit|dirty|noise/.test(viewX.heads.join(" | ")),
      `X: the repo header counts files, not commits or dirty ones (${JSON.stringify(viewX.heads)})`);
    // FOCUS (0.14.0): the host's end-of-turn click names ONE file — that file
    // opens, every other section collapses (and unmounts).
    await expandFile(rel("one.ts"));
    await postTool("get_turn_diff", { turn: pickX.id, focus: xTwo });
    // The parked focus is consumed by the panel's next TURN read (the notify
    // path or this explicit refresh — both hit the same one-shot).
    await evalJs(`__DA.refresh(true)`);
    const focusX = await waitForExpr(`(() => {
      if (__DA.diffData?.focusPath !== ${JSON.stringify(rel("two.ts"))}) return null;
      const one = __DA.rendered.get(${JSON.stringify(rel("one.ts"))});
      const two = __DA.rendered.get(${JSON.stringify(rel("two.ts"))});
      const open = [...__DA.rendered.values()].filter((e) => !e.section.classList.contains("collapsed")).map((e) => e.path);
      return { oneCollapsed: one?.section.classList.contains("collapsed"), oneFd: Boolean(one?.fd), twoFd: Boolean(two?.fd), open };
    })()`, 15000);
    check(!!focusX && focusX.oneCollapsed === true && focusX.oneFd === false,
      `X: the host click COLLAPSES the file you did not touch (${JSON.stringify(focusX)})`);
    check(!!focusX && focusX.twoFd === true && JSON.stringify(focusX.open) === JSON.stringify([rel("two.ts")]),
      `X: only the clicked file stays open (${JSON.stringify(focusX?.open)})`);
    await shot("22-app-turn.png");
    await evalJs(`document.querySelector(".header .back")?.click()`); // ← the list
    await until(async () => !!(await evalJs(`document.querySelector(".turn-row")`)), 6000);

    // The fixture tree is dirty all over (the rig's edits) and the shell file
    // exists on disk: a turn that wrote NOTHING shows nothing, like the app.
    const x2 = `X-sin-escrituras-${Date.now().toString(36)}`;
    // Real turns sit tens of seconds apart; stamp this one 30 s after the
    // first one's stop so the two windows never touch.
    const t0x2 = t0x + 3000 + 30_000;
    sendTurnEvent({ type: "prompt", sid: xSid, cwd: REPO, prompt: x2, at: new Date(t0x2).toISOString() });
    sendTurnEvent({ type: "stop", sid: xSid, cwd: REPO, reply: "nada", at: new Date(t0x2 + 1000).toISOString() });
    const p2 = await until(async () => evalJs(`(() => {
      const row = [...document.querySelectorAll(".turn-row")].find((r) => (r.textContent ?? "").includes(${JSON.stringify(x2)}));
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: ${rowText("(row)")} };
    })()`), 8000);
    // The row omits its counts at zero: what matters is that it claims none.
    check(!!p2 && !/\d+ files|\d+ repos? ·/.test(p2?.text ?? ""), `X: the turn row with no writes claims no files (${JSON.stringify(p2?.text?.slice(-50))})`);
    if (p2) await click(p2.x, p2.y);
    const emptyX = await until(async () => {
      const v = await evalJs(`(() => ({ id: __DA.diffData?.turn?.id ?? null, n: (__DA.diffData?.files ?? []).length, state: ${rowText("(document.querySelector('.state.clean') ?? document.createElement('i'))")} }))()`);
      return v.id && v.id !== pickX?.id ? v : null;
    }, 8000);
    check(!!emptyX && emptyX.n === 0 && /wrote no files/.test(emptyX.state ?? ""),
      `X: the turn with no writes tells the truth, inventing no changes (${JSON.stringify(emptyX)})`);
    await evalJs(`document.querySelector(".header .back")?.click()`); // ← the list
  } finally {
    appStore.close();
    fs.rmSync(X_DIR, { recursive: true, force: true });
  }

//   // ============ overall panel health ============
  check(await evalJs(`!!document.getElementById("loadbar")`), "UI: la barra de progreso (0.11.0) existe en el shell");
  check(await evalJs(`(() => {
    const d = document.createElement("div"); d.className = "sk-line w40"; document.body.appendChild(d);
    const anim = getComputedStyle(d).animationName; d.remove(); return anim !== "none";
  })()`), "UI: the skeletons' shimmer is wired (CSS animation)");
  check(pageErrors.length === 0, `no exceptions on the page (${pageErrors.length})`, pageErrors.slice(0, 3).join(" | "));
  check((await evalJs("__E2E.errors()")).length === 0, "no error banners in the panel", JSON.stringify(await evalJs("__E2E.errors()")));
} catch (e) {
    fails.push(`EXCEPTION: ${e?.message ?? e}`);
  await shot("FAIL.png").catch(() => {});
} finally {
  clearInterval(drainNotifications);
  await shot("08-final.png").catch(() => {});
  try { fs.rmSync(path.join(os.homedir(), "Projects", ".worktrees", "e2e-picker-fixture-wt"), { recursive: true, force: true }); } catch {} // fixture del picker (P)
  try { if (SECOND) fs.rmSync(SECOND, { recursive: true, force: true }); } catch {} // U's second repo — inline cleanup is skipped when a section throws mid-way (leaked da-e2e-turn-* twice)
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
// // the playground is left in its complete state for manual play
execFileSync("node", [path.join(HERE, "apply-fixture-mods.mjs")], { stdio: "inherit" });
