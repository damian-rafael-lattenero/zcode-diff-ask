// Turnos v2 (0.9.26): one prompt→stop window, every repo touched, commits
// made in the window + dirty files at the end. The tap's FSEvents stream is
// replaced by direct noteTapPath() injection (same collector), and the state
// lives in a tmp dir (ZCODE_DIFF_ASK_STATE) thanks to the dynamic import.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "da-state2-"));
process.env.ZCODE_DIFF_ASK_STATE = STATE;
// Neutralize an inherited ZCODE_SESSION_ID (the fork stamps it into every
// Bash child): these tests exercise the GLOBAL store; the session-scoped
// filter has its own test below, which sets/restores the var explicitly.
process.env.ZCODE_SESSION_ID = "";

const server = await import("../diff-ask/server/server.mjs");
const {
  setActiveWorkspace, processInbox, listTurns, buildTurnDiff, deleteTurn, clearTurns,
  parseTurnEvent, isTapNoise, repoRootOf, noteTapPath, outsideEntry, requestTurnFocus,
  suggestWorkspace, whoAmI,
} = server;

const INBOX = path.join(STATE, "turn-events.jsonl");
const T0 = Date.parse("2026-11-17T10:00:00.000Z");

function git(cwd, env, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
}
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-turns2-"));
  git(dir, null, "init", "-q", "-b", "main");
  git(dir, null, "config", "user.email", "t@t");
  git(dir, null, "config", "user.name", "T");
  return dir;
}
function commitAt(dir, ms, file, content, msg) {
  const iso = new Date(ms).toISOString();
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, null, "add", "-A");
  git(dir, { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso }, "commit", "-qm", msg);
}
function sendEvent(ev) {
  fs.appendFileSync(INBOX, `${JSON.stringify(ev)}\n`);
}

test("parseTurnEvent: prompt/stop nuevos, línea legacy del bot, basura", () => {
  const p = parseTurnEvent(JSON.stringify({ type: "prompt", sid: "s1", cwd: "/x", prompt: "hola", at: "2026-11-17T10:00:00.000Z" }));
  assert.deepEqual(p, { type: "prompt", sid: "s1", cwd: "/x", prompt: "hola", atMs: T0 });
  const s = parseTurnEvent(JSON.stringify({ type: "stop", sid: "s1", cwd: "/x", reply: "listo", at: "2026-11-17T10:00:09.000Z" }));
  assert.equal(s.type, "stop");
  assert.equal(s.reply, "listo");
  // legacy bot line: {workspace, prompt, at, source} → prompt event
  const legacy = parseTurnEvent(JSON.stringify({ workspace: "/w", prompt: "viejo", at: "2026-11-17T10:00:00.000Z", source: "bot" }));
  assert.equal(legacy.type, "prompt");
  assert.equal(legacy.cwd, "/w");
  assert.equal(parseTurnEvent("no-json"), null);
  assert.equal(parseTurnEvent(JSON.stringify({ type: "prompt", prompt: "sin fecha" })), null);
});

test("isTapNoise: caches/builds/logs/estado propio fuera; código adentro", () => {
  assert.equal(isTapNoise("Library/Containers/x"), true);
  assert.equal(isTapNoise("Projects/a/node_modules/p/index.js"), true);
  assert.equal(isTapNoise("Projects/a/.venv/lib/x.py"), true);
  assert.equal(isTapNoise("Projects/a/app.log"), true);
  assert.equal(isTapNoise(".zcode/diff-ask/turn-events.jsonl"), true);
  assert.equal(isTapNoise("Projects/a/src/main.rs"), false);
  assert.equal(isTapNoise(".zcode/hooks/turn-tap.nu"), false);
});

test("repoRootOf: archivo en repo/subcarpeta → raíz; fuera de repos → null", () => {
  const repo = makeRepo();
  commitAt(repo, T0 - 100_000, "a.txt", "x\n", "base");
  fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "deep", "f.ts"), "x\n");
  assert.equal(repoRootOf(path.join(repo, "src", "deep", "f.ts")), repo);
  const nope = fs.mkdtempSync(path.join(os.tmpdir(), "da-norepo-"));
  assert.equal(repoRootOf(path.join(nope, "x.txt")), null);
});

test("flujo v2: 2 repos (commits en ventana + dirty), live, delete/clear", async () => {
  // repo A = session workspace; repo B = a second repo (the "worktree" case)
  const A = makeRepo();
  const B = makeRepo();
  commitAt(A, T0 - 100_000, "a.py", "v1\n", "base A");
  commitAt(B, T0 - 100_000, "x.py", "uno\n", "base B");
  await setActiveWorkspace(A);

  // prompt event opens the turn
  sendEvent({ type: "prompt", sid: "sX", cwd: A, prompt: "hacé el trabajo", at: new Date(T0).toISOString() });
  await processInbox();
  let list = listTurns();
  assert.equal(list.count, 1);
  assert.equal(list.turns[0].isLive, true);

  // the agent works: dirty edit in A, a COMMIT in B (inside the window),
  // plus a stray non-git file
  fs.writeFileSync(path.join(A, "a.py"), "v1\nv2\n");
  noteTapPath(path.join(A, "a.py"));
  commitAt(B, T0 + 30_000, "x.py", "uno\ndos\n", "feat: x avanza");
  noteTapPath(path.join(B, "x.py"));
  noteTapPath(path.join(B, ".git", "HEAD")); // commit marker → repo B included
  noteTapPath(path.join(os.tmpdir(), "suelto.txt"));

  // stop event closes it
  sendEvent({ type: "stop", sid: "sX", cwd: A, reply: "hecho: A y B tocados", at: new Date(T0 + 60_000).toISOString() });
  await processInbox();
  list = listTurns();
  assert.equal(list.count, 1);
  const t = list.turns[0];
  assert.equal(t.isLive, false);
  assert.equal(t.prompt, "hacé el trabajo");
  assert.equal(t.reply, "hecho: A y B tocados");
  assert.equal(t.repoCount, 2);
  assert.equal(t.fileCount, 3); // 1 commit (B) + 1 dirty (A) + 1 fuera de git (suelto.txt, nunca existió)

  const d = await buildTurnDiff(t.id);
  assert.equal(d.mode, "turn");
  assert.equal(d.error, undefined);
  const labelA = path.basename(A);
  const labelB = path.basename(B);
  const fileA = d.files.find((f) => f.path === `${labelA}/a.py`);
  const fileB = d.files.find((f) => f.path === `${labelB}/x.py`);
  assert.ok(fileA, "dirty de A presente y namespaced");
  assert.ok(fileB, "commit de B presente y namespaced");
  assert.equal(fileA.before, "v1\n");
  assert.equal(fileA.after, "v1\nv2\n");
  assert.equal(fileB.status, "M");
  assert.equal(fileB.before, "uno\n");
  assert.equal(fileB.after, "uno\ndos\n");
  assert.equal(fileB.commit.length > 0, true);
  assert.equal(d.turn.repos.length, 3); // A + B + el pseudo-repo "~" (fuera de git)
  assert.deepEqual(d.turn.repos.map((r) => r.label).sort(), [labelA, labelB, "~"].sort());
  const ghost = d.files.find((f) => f.path === path.join(os.tmpdir(), "suelto.txt"));
  assert.ok(ghost, "el suelto fuera de git entra al diff");
  assert.equal(ghost.status, "D");
  assert.equal(ghost.gone, true);

  // second turn: prompt supersedes nothing (first is closed); live diff works
  sendEvent({ type: "prompt", sid: "sX", cwd: A, prompt: "segundo", at: new Date(T0 + 120_000).toISOString() });
  await processInbox();
  const live = await buildTurnDiff("latest");
  assert.equal(live.turn.isLive, true);
  assert.equal(live.turn.prompt, "segundo");
  // an ONLY-working repo: nothing noted yet → only A's dirty shows
  assert.ok(live.files.every((f) => f.path.startsWith(`${labelA}/`)));

  // an unfinished turn is persisted as interrupted when a NEW prompt lands
  sendEvent({ type: "prompt", sid: "sX", cwd: A, prompt: "tercero", at: new Date(T0 + 180_000).toISOString() });
  await processInbox();
  list = listTurns();
  assert.ok(list.turns.some((x) => x.interrupted && x.prompt === "segundo"), "el turno sin stop queda marcado interrumpido");

  // delete + clear operate on the global store
  const victim = list.turns.find((x) => x.prompt === "hacé el trabajo");
  assert.equal(deleteTurn(victim.id).ok, true);
  assert.equal(deleteTurn("no-existe").error, "unknown_turn");
  clearTurns();
  assert.ok(listTurns().count <= 1); // only the live one may remain
  assert.equal((await buildTurnDiff("no-existe")).error, "unknown_turn");
});

test("turn dirty list: node_modules-style junk filtered + cap + hidden count", async () => {
  const C = makeRepo();
  commitAt(C, T0 - 100_000, "src/real.py", "ok\n", "base C");
  await setActiveWorkspace(C);

  sendEvent({ type: "prompt", sid: "sN", cwd: C, prompt: "turno con ruido", at: new Date(T0 + 300_000).toISOString() });
  await processInbox();
  // the agent touches ONE real file; the repo is full of untracked junk
  // (node_modules without a .gitignore — Damian's 2052-file turn)
  fs.writeFileSync(path.join(C, "src", "real.py"), "ok\nedit\n");
  noteTapPath(path.join(C, "src", "real.py"));
  for (let i = 0; i < 5; i++) {
    fs.mkdirSync(path.join(C, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(C, "node_modules", "pkg", `f${i}.md`), `junk ${i}\n`);
  }
  noteTapPath(path.join(C, "node_modules", "pkg", "f0.md"));
  sendEvent({ type: "stop", sid: "sN", cwd: C, reply: "hecho", at: new Date(T0 + 360_000).toISOString() });
  await processInbox();

  const list = listTurns();
  const turn = list.turns.find((t) => t.prompt === "turno con ruido");
  assert.ok(turn, "el turno existe");
  assert.equal(turn.fileCount, 1, "sólo el archivo real entra al turno");
  const d = await buildTurnDiff(turn.id);
  const repoC = d.turn.repos.find((r) => r.label === path.basename(C));
  assert.equal(repoC.dirty, 1);
  assert.equal(repoC.dirtyHidden, 5, "el ruido filtrado viaja como hidden count");
  assert.equal(d.fileCount, 1);
  const fileC = d.files.find((f) => f.path === `${path.basename(C)}/src/real.py`);
  assert.ok(fileC, "el archivo real está en el payload");
  assert.equal(fileC.after, "ok\nedit\n");
  assert.ok(!d.files.some((f) => f.path.includes("node_modules")), "node_modules jamás en el payload");
});

test("outsideEntry: key ~/rel bajo home, abs fuera de home, vacío → null", () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "da-home-"));
  fs.mkdirSync(path.join(fakeHome, "notes"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, "notes", "x.md"), "hola\n");
  const live = outsideEntry("notes/x.md", fakeHome);
  assert.equal(live.status, "?");
  assert.equal(live.path, "~/notes/x.md");
  assert.equal(live.repoLabel, "~");
  assert.equal(live._src.abs, path.join(fakeHome, "notes", "x.md"));
  assert.equal(live.gone, undefined);
  const gone = outsideEntry("notes/y.md", fakeHome);
  assert.equal(gone.status, "D");
  assert.equal(gone.gone, true);
  assert.equal(gone.before, undefined);
  assert.equal(outsideEntry("", fakeHome), null);
  const abs = outsideEntry("/tmp/da-abs-zzz.txt", fakeHome);
  assert.equal(abs.path, "/tmp/da-abs-zzz.txt");
  assert.equal(abs.status, "D"); // nunca existió
});

test("outside: archivos fuera de git entran al diff en verde; los borrados, como nota", async () => {
  const D = makeRepo();
  commitAt(D, T0 - 100_000, "d.py", "v1\n", "base D");
  await setActiveWorkspace(D);
  const loose = fs.mkdtempSync(path.join(os.tmpdir(), "da-loose-"));
  fs.writeFileSync(path.join(loose, "notas.md"), "linea uno\nlinea dos\n");
  const vanished = path.join(loose, "fantasma.txt");

  sendEvent({ type: "prompt", sid: "sO", cwd: D, prompt: "turno con sueltos", at: new Date(T0 + 400_000).toISOString() });
  await processInbox();
  fs.writeFileSync(path.join(D, "d.py"), "v1\nv2\n");
  noteTapPath(path.join(D, "d.py"));
  noteTapPath(path.join(loose, "notas.md"));
  noteTapPath(vanished); // tocado pero jamás fue un archivo real
  sendEvent({ type: "stop", sid: "sO", cwd: D, reply: "ok", at: new Date(T0 + 460_000).toISOString() });
  await processInbox();

  const turn = listTurns().turns.find((t) => t.prompt === "turno con sueltos");
  assert.equal(turn.fileCount, 3); // dirty d.py + notas.md + fantasma.txt
  const d = await buildTurnDiff(turn.id);
  const green = d.files.find((f) => f.path === path.join(loose, "notas.md"));
  assert.ok(green, "el archivo suelto entra al diff");
  assert.equal(green.status, "?");
  assert.equal(green.before, "");
  assert.equal(green.after, "linea uno\nlinea dos\n");
  assert.equal(green.added, "2");
  assert.equal(green.deleted, "0");
  assert.equal(green.repoLabel, "~");
  const ghost = d.files.find((f) => f.path === vanished);
  assert.ok(ghost, "el tocado-y-desaparecido también entra");
  assert.equal(ghost.status, "D");
  assert.equal(ghost.gone, true);
  const outside = d.turn.repos.find((r) => r.label === "~");
  assert.ok(outside, "el pseudo-repo ~ viaja en turn.repos para el header");
  assert.equal(outside.outside, 2);
  assert.equal(outside.commits, 0);
  assert.equal(outside.dirty, 0);
});

test("focus: el click del fork resuelve al entry del turno, se consume y expira", async () => {
  const E = makeRepo();
  commitAt(E, T0 - 100_000, "e.py", "v1\n", "base E");
  await setActiveWorkspace(E);
  const loose = fs.mkdtempSync(path.join(os.tmpdir(), "da-loose2-"));
  const suelto = path.join(loose, "suelto.md");
  fs.writeFileSync(suelto, "hola\n");

  sendEvent({ type: "prompt", sid: "sF", cwd: E, prompt: "turno foco", at: new Date(T0 + 500_000).toISOString() });
  await processInbox();
  fs.writeFileSync(path.join(E, "e.py"), "v1\nv2\n");
  noteTapPath(path.join(E, "e.py"));
  noteTapPath(suelto);
  sendEvent({ type: "stop", sid: "sF", cwd: E, reply: "ok", at: new Date(T0 + 560_000).toISOString() });
  await processInbox();
  const turn = listTurns().turns.find((t) => t.prompt === "turno foco");
  assert.ok(turn, "el turno foco existe");

  // click sobre el archivo suelto → focusPath = su key (abs, fuera de home)
  assert.equal(requestTurnFocus(suelto, turn.id).ok, true);
  const d1 = await buildTurnDiff(turn.id);
  assert.equal(d1.focusPath, suelto);
  const d2 = await buildTurnDiff(turn.id);
  assert.equal(d2.focusPath, undefined, "el focus se consume en el primer read");

  // click sobre un repo-file leyendo OTRO turno: hint de navegación, sin consume
  requestTurnFocus(path.join(E, "e.py"), turn.id);
  const other = listTurns().turns.find((t) => t.prompt === "turno con sueltos");
  const dOther = await buildTurnDiff(other.id);
  assert.equal(dOther.focusPath, undefined);
  assert.deepEqual(dOther.pendingTurnFocus, { turn: turn.id });
  const d3 = await buildTurnDiff(turn.id);
  assert.equal(d3.focusPath, `${path.basename(E)}/e.py`);

  // TTL vencido: no resuelve
  requestTurnFocus(suelto, turn.id, Date.now() - 60_000);
  const d4 = await buildTurnDiff(turn.id);
  assert.equal(d4.focusPath, undefined);
});

test("suggestWorkspace: repo con más cambios del último turno, empate → commits, todo suelto → null", async () => {
  // Hermetic store: earlier tests finalize superseded turns with stoppedAt =
  // Date.now() (real clock), which would outrank these T0-dated turns — clear
  // so the "last turn" this test builds IS the last turn.
  clearTurns();
  const P = makeRepo();
  const Q = makeRepo();
  commitAt(P, T0 - 100_000, "p.py", "v1\n", "base P");
  commitAt(Q, T0 - 100_000, "q.py", "v1\n", "base Q");
  await setActiveWorkspace(P);

  // last turn: 2 commits land in P, 1 dirty file stays in Q → P (score 2 vs 1)
  sendEvent({ type: "prompt", sid: "sS", cwd: P, prompt: "turno sugerencia", at: new Date(T0 + 600_000).toISOString() });
  await processInbox();
  commitAt(P, T0 + 610_000, "p1.py", "x\n", "feat: p1");
  noteTapPath(path.join(P, ".git", "HEAD"));
  commitAt(P, T0 + 620_000, "p2.py", "y\n", "feat: p2");
  fs.writeFileSync(path.join(Q, "q.py"), "v1\nv2\n");
  noteTapPath(path.join(Q, "q.py"));
  sendEvent({ type: "stop", sid: "sS", cwd: P, reply: "ok", at: new Date(T0 + 630_000).toISOString() });
  await processInbox();

  const s = await suggestWorkspace();
  assert.equal(s.ok, true);
  assert.equal(s.workspace, P);
  assert.equal(s.commits, 2);
  assert.equal(s.dirty, 0);
  assert.equal(s.turnId, listTurns().turns[0].id, "sugiere sobre el turno más nuevo");

  // tie at score 1: the repo with a COMMIT beats the repo with a dirty file.
  // (first settle Q's dirty with an out-of-window commit so both start clean)
  commitAt(Q, T0 + 640_000, "q.py", "v1\nv2\n", "fix: q");
  sendEvent({ type: "prompt", sid: "sT", cwd: P, prompt: "empate", at: new Date(T0 + 650_000).toISOString() });
  await processInbox();
  commitAt(P, T0 + 655_000, "p3.py", "z\n", "feat: p3");
  noteTapPath(path.join(P, ".git", "HEAD"));
  fs.writeFileSync(path.join(Q, "q3.py"), "suelto\n");
  noteTapPath(path.join(Q, "q3.py"));
  sendEvent({ type: "stop", sid: "sT", cwd: P, reply: "ok", at: new Date(T0 + 660_000).toISOString() });
  await processInbox();
  const sT = await suggestWorkspace();
  assert.equal(sT.workspace, P, "empate 1-1: gana el repo con commit");

  // an all-outside turn (cwd outside git, only loose files) → nothing to
  // suggest: the panel shows "seleccionar repositorio..." and waits
  const looseDir = fs.mkdtempSync(path.join(os.tmpdir(), "da-sug-"));
  fs.writeFileSync(path.join(looseDir, "nota.md"), "hola\n");
  sendEvent({ type: "prompt", sid: "sS2", cwd: looseDir, prompt: "todo suelto", at: new Date(T0 + 700_000).toISOString() });
  await processInbox();
  noteTapPath(path.join(looseDir, "nota.md"));
  sendEvent({ type: "stop", sid: "sS2", cwd: looseDir, reply: "ok", at: new Date(T0 + 710_000).toISOString() });
  await processInbox();
  const s2 = await suggestWorkspace();
  assert.equal(s2.ok, true);
  assert.equal(s2.workspace, null);
  assert.equal(s2.reason, "no_repos");
});

test("session filter: list/build scoped al env, prompt ajeno no interrumpe, clear scoped, cache", async () => {
  clearTurns();
  const A = makeRepo();
  const B = makeRepo();
  commitAt(A, T0 - 100_000, "a.py", "v1\n", "base A");
  commitAt(B, T0 - 100_000, "b.py", "v1\n", "base B");
  await setActiveWorkspace(A);

  // a foreign (sF) turn first, recorded with the filter OFF (global)
  sendEvent({ type: "prompt", sid: "sF", cwd: B, prompt: "turno extranjero", at: new Date(T0).toISOString() });
  await processInbox();
  fs.writeFileSync(path.join(B, "b.py"), "v1\nedit\n");
  noteTapPath(path.join(B, "b.py"));
  sendEvent({ type: "stop", sid: "sF", cwd: B, reply: "ok F", at: new Date(T0 + 10_000).toISOString() });
  await processInbox();
  assert.equal(listTurns().count, 1, "sin filtro: el turno extranjero está");

  // scope to sA: from here the server only sees sA events as its own
  process.env.ZCODE_SESSION_ID = "sA";
  try {
    sendEvent({ type: "prompt", sid: "sA", cwd: A, prompt: "turno propio", at: new Date(T0 + 20_000).toISOString() });
    await processInbox();
    // while sA's turn is OPEN, a foreign sF prompt must NOT interrupt it
    sendEvent({ type: "prompt", sid: "sF", cwd: B, prompt: "ajeno", at: new Date(T0 + 30_000).toISOString() });
    await processInbox();
    sendEvent({ type: "stop", sid: "sA", cwd: A, reply: "ok A", at: new Date(T0 + 35_000).toISOString() });
    await processInbox();
    const list = listTurns();
    assert.equal(list.count, 1, "con filtro: sólo los turnos de sA");
    assert.equal(list.sessionFilter, "sA");
    assert.equal(list.turns[0].prompt, "turno propio");
    assert.equal(list.turns[0].isLive, false);
    assert.equal(list.turns[0].interrupted, false, "el prompt ajeno NO marcó el turno como interrumpido");
    const d = await buildTurnDiff(list.turns[0].id);
    assert.equal(d.error, undefined);
    assert.equal(d.turn.prompt, "turno propio");
    assert.equal((await buildTurnDiff("latest")).turn.prompt, "turno propio", "latest de la sesión = su último turno");
    assert.equal((await suggestWorkspace()).turnId, list.turns[0].id, "suggest también queda scoped");

    // scoped clear: wipes ONLY sA's turns; sF's stay on disk
    const cleared = clearTurns();
    assert.equal(cleared.scoped, "sA");
    assert.equal(listTurns().count, 0);
    process.env.ZCODE_SESSION_ID = "";
    assert.equal(listTurns().count, 1, "sin filtro: el turno de sF sobrevivió al clear scoped");

    // store cache: a NEW turn file is picked up by the next read (invalidation)
    sendEvent({ type: "prompt", sid: "sG", cwd: B, prompt: "otro turno", at: new Date(T0 + 40_000).toISOString() });
    await processInbox();
    sendEvent({ type: "stop", sid: "sG", cwd: B, reply: "ok G", at: new Date(T0 + 50_000).toISOString() });
    await processInbox();
    assert.equal(listTurns().count, 2, "el cache del store se invalida cuando el dir cambia");

    // whoami reflects the env identity
    process.env.ZCODE_SESSION_ID = "sZ";
    assert.equal(whoAmI().sessionId, "sZ");
    process.env.ZCODE_SESSION_ID = "";
    assert.equal(whoAmI().sessionId, null, "sin env ni request-context → global (sessionId null)");
  } finally {
    process.env.ZCODE_SESSION_ID = "";
  }
});

test("turn id determinista: re-finalización sobreescribe; interrumpido zombie NO pisa completado; dedupe legacy", async () => {
  clearTurns();
  const D = makeRepo();
  commitAt(D, T0 - 100_000, "d.py", "v1\n", "base D");
  await setActiveWorkspace(D);

  // a window that completes with a reply
  sendEvent({ type: "prompt", sid: "sK", cwd: D, prompt: "ventana que completa", at: new Date(T0).toISOString() });
  await processInbox();
  sendEvent({ type: "stop", sid: "sK", cwd: D, reply: "respuesta real", at: new Date(T0 + 10_000).toISOString() });
  await processInbox();
  let list = listTurns();
  assert.equal(list.count, 1);
  assert.equal(list.turns[0].reply, "respuesta real");
  assert.equal(list.turns[0].interrupted, false);
  const doneId = list.turns[0].id;

  // a zombie re-opens the SAME prompt window and gets superseded → its
  // interrupted finalize must NOT regress the completed record
  sendEvent({ type: "prompt", sid: "sK", cwd: D, prompt: "ventana que completa", at: new Date(T0).toISOString() });
  await processInbox();
  sendEvent({ type: "prompt", sid: "sK", cwd: D, prompt: "siguiente prompt", at: new Date(T0 + 20_000).toISOString() });
  await processInbox();
  list = listTurns();
  const kept = list.turns.find((t) => t.prompt === "ventana que completa");
  assert.ok(kept, "la ventana completada sigue");
  assert.equal(kept.interrupted, false, "el finalize interrumpido del zombie NO pisó el turno completado");
  assert.equal(kept.reply, "respuesta real");
  assert.equal(kept.id, doneId, "mismo id determinista (startMs-keyed) tras la re-apertura");

  // the same window re-finalized WITH a real stop overwrites in place (one file)
  sendEvent({ type: "prompt", sid: "sK", cwd: D, prompt: "ventana que completa", at: new Date(T0).toISOString() });
  await processInbox();
  sendEvent({ type: "stop", sid: "sK", cwd: D, reply: "respuesta mejorada", at: new Date(T0 + 30_000).toISOString() });
  await processInbox();
  list = listTurns();
  const windows = list.turns.filter((t) => t.prompt === "ventana que completa");
  assert.equal(windows.length, 1, "una sola fila por ventana de prompt (id determinista)");
  assert.equal(windows[0].reply, "respuesta mejorada", "el stop real sobreescribe en el mismo archivo");

  // legacy pollution: hand-written stopMs-keyed duplicates collapse at read
  const dupes = [
    { id: "legac0001-sK", sid: "sK", workspace: D, prompt: "legado", reply: "", startedAt: new Date(T0 + 40_000).toISOString(), stoppedAt: new Date(T0 + 50_000).toISOString(), interrupted: true, repos: [], outside: [] },
    { id: "legac0002-sK", sid: "sK", workspace: D, prompt: "legado", reply: "la buena", startedAt: new Date(T0 + 40_000).toISOString(), stoppedAt: new Date(T0 + 60_000).toISOString(), repos: [], outside: [] },
    { id: "legac0003-sK", sid: "sK", workspace: D, prompt: "legado", reply: "", startedAt: new Date(T0 + 40_000).toISOString(), stoppedAt: new Date(T0 + 45_000).toISOString(), interrupted: true, repos: [], outside: [] },
  ];
  for (const d of dupes) fs.writeFileSync(path.join(STATE, "turns2", `${d.id}.json`), JSON.stringify(d));
  list = listTurns();
  const legacy = list.turns.filter((t) => t.prompt === "legado");
  assert.equal(legacy.length, 1, "los duplicados legacy colapsan a una fila (sid+startedAt)");
  assert.equal(legacy[0].reply, "la buena", "gana la copia COMPLETADA");
  assert.equal(legacy[0].interrupted, false);
});

test("atribución cross-session: el repo de OTRA task activa NO entra a mi turno (y simétrico)", async () => {
  clearTurns();
  const A = makeRepo(); // this task's cwd
  const B = makeRepo(); // the OTHER task's cwd
  commitAt(A, T0 - 100_000, "a.py", "v1\n", "base A");
  commitAt(B, T0 - 100_000, "b.py", "v1\n", "base B");

  // Phase 1 runs as OUR session (each real server knows its sid: foreign
  // prompts never supersede OUR open turn — the global-mode test process
  // must emulate that or a foreign prompt would interrupt-spam records).
  // NOTE: the inbox offset starts at EOF on the FIRST processInbox
  // (cold-start rule) — process each event or the server never sees it.
  process.env.ZCODE_SESSION_ID = "sess_mine";
  sendEvent({ type: "prompt", sid: "sess_other-task", cwd: B, prompt: "otra task trabajando", at: new Date(T0 - 10_000).toISOString() });
  await processInbox(); // foreign prompt: ignored as a turn, lands in the timeline
  sendEvent({ type: "prompt", sid: "sess_mine", cwd: A, prompt: "mi turno", at: new Date(T0).toISOString() });
  await processInbox();
  fs.writeFileSync(path.join(A, "a.py"), "v1\nmia\n");
  noteTapPath(path.join(A, "a.py"));
  fs.writeFileSync(path.join(B, "b.py"), "v1\najena\n");
  noteTapPath(path.join(B, "b.py"));
  sendEvent({ type: "stop", sid: "sess_mine", cwd: A, reply: "ok", at: new Date(T0 + 5_000).toISOString() });
  await processInbox();
  sendEvent({ type: "stop", sid: "sess_other-task", cwd: B, reply: "ok", at: new Date(T0 + 6_000).toISOString() });
  await processInbox(); // foreign stop: ignored (we never opened it)

  try {
    const d = await buildTurnDiff("latest");
    const labels = (d.turn.repos ?? []).map((r) => r.label);
    assert.ok(labels.includes(path.basename(A)), `mi repo está (${JSON.stringify(labels)})`);
    assert.ok(!labels.includes(path.basename(B)), "el repo de la OTRA task NO entra a mi turno");
  } finally {
    process.env.ZCODE_SESSION_ID = "";
  }

  // Phase 2 runs as THEIR session (their own turn, after mine closed): they
  // see THEIR repo — and not a trace of mine.
  process.env.ZCODE_SESSION_ID = "sess_other-task";
  sendEvent({ type: "prompt", sid: "sess_other-task", cwd: B, prompt: "su turno ahora", at: new Date(T0 + 10_000).toISOString() });
  await processInbox();
  fs.writeFileSync(path.join(B, "b.py"), "v1\nsuya\n");
  noteTapPath(path.join(B, "b.py"));
  sendEvent({ type: "stop", sid: "sess_other-task", cwd: B, reply: "ok B", at: new Date(T0 + 12_000).toISOString() });
  await processInbox();
  try {
    const d2 = await buildTurnDiff("latest");
    const labels2 = (d2.turn.repos ?? []).map((r) => r.label);
    assert.ok(labels2.includes(path.basename(B)) && !labels2.includes(path.basename(A)),
      `la otra task ve SU repo y no el mío (${JSON.stringify(labels2)})`);
  } finally {
    process.env.ZCODE_SESSION_ID = "";
  }
});
