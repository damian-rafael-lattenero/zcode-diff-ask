// Turns v2 (0.9.26): one prompt→stop window, every repo touched, commits
// made in the window + dirty files at the end. The tap's FSEvents stream is
// replaced by direct noteTapPath() injection (same collector), and the state
// lives in a tmp dir (ZCODE_DIFF_ASK_STATE) thanks to the dynamic import.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "da-state2-"));
process.env.ZCODE_DIFF_ASK_STATE = STATE;
// Hermetic app store (0.10.10): turns may read ZCode's own session DB for
// the files a turn wrote. These tests exercise the CAPTURE model (sessions
// the app does not know) — point the edge at a database that does not exist.
// The app-backed path has its own file with a real fake store.
process.env.ZCODE_DIFF_ASK_APP_DB = path.join(STATE, "no-app-db.sqlite");
// Neutralize an inherited ZCODE_SESSION_ID (the fork stamps it into every
// Bash child): these tests exercise the GLOBAL store; the session-scoped
// filter has its own test below, which sets/restores the var explicitly.
process.env.ZCODE_SESSION_ID = "";

const server = await import("../diff-ask/server/server.mjs");
const {
  setActiveWorkspace, processInbox, listTurns, buildTurnDiff, deleteTurn, clearTurns,
  parseTurnEvent, isTapNoise, repoRootOf, noteTapPath, outsideEntry, requestTurnFocus,
  suggestWorkspace, whoAmI, noteRequestMeta, resetRequestMetaForTests,
} = server;

const INBOX = path.join(STATE, "turn-events.jsonl");
// RECENT base fixture (now - 30 min): the anti-zombie guard (0.10.6) drops
// interrupted finalizes of windows older than 2h — old dates would break
// the supersede tests. The relative order of the events is what matters.
const T0 = Date.now() - 30 * 60 * 1000;

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

test("parseTurnEvent: new prompt/stop, legacy bot line, junk", () => {
  const p = parseTurnEvent(JSON.stringify({ type: "prompt", sid: "s1", cwd: "/x", prompt: "hola", at: "2026-11-17T10:00:00.000Z" }));
  assert.deepEqual(p, { type: "prompt", sid: "s1", cwd: "/x", prompt: "hola", atMs: Date.parse("2026-11-17T10:00:00.000Z") });
  const s = parseTurnEvent(JSON.stringify({ type: "stop", sid: "s1", cwd: "/x", reply: "listo", at: "2026-11-17T10:00:09.000Z" }));
  assert.equal(s.type, "stop");
  assert.equal(s.reply, "listo");
  // legacy bot line: {workspace, prompt, at, source} → prompt event
  const legacy = parseTurnEvent(JSON.stringify({ workspace: "/w", prompt: "old", at: "2026-11-17T10:00:00.000Z", source: "bot" }));
  assert.equal(legacy.type, "prompt");
  assert.equal(legacy.cwd, "/w");
  assert.equal(parseTurnEvent("no-json"), null);
  assert.equal(parseTurnEvent(JSON.stringify({ type: "prompt", prompt: "sin fecha" })), null);
});

test("isTapNoise: caches/builds/logs/own state out; code in", () => {
  assert.equal(isTapNoise("Library/Containers/x"), true);
  assert.equal(isTapNoise("Projects/a/node_modules/p/index.js"), true);
  assert.equal(isTapNoise("Projects/a/.venv/lib/x.py"), true);
  assert.equal(isTapNoise("Projects/a/app.log"), true);
  assert.equal(isTapNoise(".zcode/diff-ask/turn-events.jsonl"), true);
  assert.equal(isTapNoise("Projects/a/src/main.rs"), false);
  assert.equal(isTapNoise(".zcode/hooks/turn-tap.nu"), true, "hooks plumbing = noise since 0.10.9");
  assert.equal(isTapNoise(".zcode/plans/plan-sess_x.md"), false, "the session's plans speak");
  assert.equal(isTapNoise(".zcode/cli/memories/projects/x/memory.md"), false, "the session's memories speak");
  assert.equal(isTapNoise(".zcode/bot-kotlin/state/hb-stream-effects"), true, "bot daemon heartbeats = noise");
  assert.equal(isTapNoise(".zcode/cli/memory-diagnostics/memory-1.jsonl"), true, "app diagnostics = noise");
  assert.equal(isTapNoise(".zcode/cli/artifacts/sess_5b7/call-x.json"), true, "tool-call artifacts = noise");
  assert.equal(isTapNoise(".zcode/bot-recordings/replay.jsonl"), true, "recorder = noise");
});

test("repoRootOf: file in repo/subfolder → root; outside repos → null", () => {
  const repo = makeRepo();
  commitAt(repo, T0 - 100_000, "a.txt", "x\n", "base");
  fs.mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "deep", "f.ts"), "x\n");
  assert.equal(repoRootOf(path.join(repo, "src", "deep", "f.ts")), repo);
  const nope = fs.mkdtempSync(path.join(os.tmpdir(), "da-norepo-"));
  assert.equal(repoRootOf(path.join(nope, "x.txt")), null);
});

test("v2 flow: 2 repos (commits in window + dirty), live, delete/clear", async () => {
  // repo A = session workspace; the second repo lives in a .worktrees
  // container (the real agent flow — inside the session's territory)
  const A = makeRepo();
  commitAt(A, T0 - 100_000, "a.py", "v1\n", "base A");
  await setActiveWorkspace(A);

  // prompt event opens the turn
  sendEvent({ type: "prompt", sid: "sX", cwd: A, prompt: "do the job", at: new Date(T0).toISOString() });
  await processInbox();
  let list = (await listTurns());
  assert.equal(list.count, 1);
  assert.equal(list.turns[0].isLive, true);

  // the agent works: dirty edit in A, a COMMIT in an agent WORKTREE (inside
  // the window), plus a stray non-git file. 0.10.6 territory: only the cwd
  // tree, .worktrees containers and ~/.zcode are captured — machine-wide
  // writes are other tasks'. B lives in a .worktrees container (the real
  // agent flow) so its commit marker enters; the stray file must live IN
  // territory (~/.zcode) to show as "Outside git".
  const WT = path.join(os.homedir(), "Projects", ".worktrees", `da-unit-wt-${Date.now()}`);
  fs.mkdirSync(WT, { recursive: true });
  git(WT, null, "init", "-q", "-b", "main");
  git(WT, null, "config", "user.email", "t@t");
  git(WT, null, "config", "user.name", "T");
  commitAt(WT, T0 - 50_000, "x.py", "uno\n", "base WT");
  fs.writeFileSync(path.join(A, "a.py"), "v1\nv2\n");
  noteTapPath(path.join(A, "a.py"));
  commitAt(WT, T0 + 30_000, "x.py", "uno\ndos\n", "feat: x avanza");
  noteTapPath(path.join(WT, ".git", "HEAD")); // commit marker → worktree repo included
  const stray = path.join(os.homedir(), ".zcode", "plans", `da-unit-stray-${Date.now()}.txt`);
  noteTapPath(stray); // touched but never a real file → the honest "gone" note

  // stop event closes it
  sendEvent({ type: "stop", sid: "sX", cwd: A, reply: "hecho: A y B tocados", at: new Date(T0 + 60_000).toISOString() });
  await processInbox();
  list = (await listTurns());
  assert.equal(list.count, 1);
  const t = list.turns[0];
  assert.equal(t.isLive, false);
  assert.equal(t.prompt, "do the job");
  assert.equal(t.reply, "hecho: A y B tocados");
  assert.equal(t.repoCount, 2);
  assert.equal(t.fileCount, 3); // 1 commit (B) + 1 dirty (A) + 1 outside git (stray, never existed)

  const d = await buildTurnDiff(t.id);
  assert.equal(d.mode, "turn");
  assert.equal(d.error, undefined);
  const labelA = path.basename(A);
  const labelB = path.basename(WT);
  const fileA = d.files.find((f) => f.path === `${labelA}/a.py`);
  const fileB = d.files.find((f) => f.path === `${labelB}/x.py`);
  assert.ok(fileA, "A's dirty file present and namespaced");
  assert.ok(fileB, "B's commit present and namespaced");
  assert.equal(fileA.before, "v1\n");
  assert.equal(fileA.after, "v1\nv2\n");
  assert.equal(fileB.status, "M");
  assert.equal(fileB.before, "uno\n");
  assert.equal(fileB.after, "uno\ndos\n");
  assert.equal(fileB.commit.length > 0, true);
  assert.equal(d.turn.repos.length, 3); // A + B + the "~" pseudo-repo (outside git)
  assert.deepEqual(d.turn.repos.map((r) => r.label).sort(), [labelA, labelB, "~"].sort());
  const ghost = d.files.find((f) => f.path === `~/${path.relative(os.homedir(), stray)}`);
  assert.ok(ghost, "the stray outside git enters the diff");
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
  list = (await listTurns());
  assert.ok(list.turns.some((x) => x.interrupted && x.prompt === "segundo"), "a turn without a stop is marked interrupted");
  // hygiene: CLOSE the leftover window — its open interval would otherwise
  // cover later tests' writes and the "~" attribution would drop them
  sendEvent({ type: "stop", sid: "sX", cwd: A, reply: "cerrado", at: new Date(T0 + 190_000).toISOString() });
  await processInbox();

  // delete + clear operate on the global store
  const victim = list.turns.find((x) => x.prompt === "do the job");
  assert.equal((await deleteTurn(victim.id)).ok, true);
  assert.equal((await deleteTurn("no-existe")).error, "unknown_turn");  try { fs.rmSync(WT, { recursive: true, force: true }); } catch { /* cleanup */ }
  await clearTurns();
  assert.ok((await listTurns()).count <= 1); // only the live one may remain
  assert.equal((await buildTurnDiff("no-existe")).error, "unknown_turn");
});

test("turn dirty list: node_modules-style junk filtered + cap + hidden count", async () => {
  const C = makeRepo();
  commitAt(C, T0 - 100_000, "src/real.py", "ok\n", "base C");
  await setActiveWorkspace(C);

  sendEvent({ type: "prompt", sid: "sN", cwd: C, prompt: "noisy turn", at: new Date(T0 + 300_000).toISOString() });
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

  const list = (await listTurns());
  const turn = list.turns.find((t) => t.prompt === "noisy turn");
  assert.ok(turn, "the turn exists");
  assert.equal(turn.fileCount, 1, "only the real file enters the turn");
  const d = await buildTurnDiff(turn.id);
  const repoC = d.turn.repos.find((r) => r.label === path.basename(C));
  assert.equal(repoC.dirty, 1);
  assert.equal(repoC.dirtyHidden, 5, "el ruido filtrado viaja como hidden count");
  assert.equal(d.fileCount, 1);
  const fileC = d.files.find((f) => f.path === `${path.basename(C)}/src/real.py`);
  assert.ok(fileC, "the real file is in the payload");
  assert.equal(fileC.after, "ok\nedit\n");
  assert.ok(!d.files.some((f) => f.path.includes("node_modules")), "node_modules never in the payload");
});

test("outsideEntry: key ~/rel under home, abs outside home, empty → null", () => {
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
  assert.equal(abs.status, "D"); // never existed
});

test("outside: files outside git enter the diff in green; deleted ones as a note", async () => {
  const D = makeRepo();
  commitAt(D, T0 - 100_000, "d.py", "v1\n", "base D");
  await setActiveWorkspace(D);
  // territory (~/.zcode): loose non-git files live there since 0.10.6
  const loose = path.join(os.homedir(), ".zcode", "plans", `da-unit-loose-${Date.now()}`);
  fs.mkdirSync(loose, { recursive: true });
  fs.writeFileSync(path.join(loose, "notas.md"), "line one\nline two\n");
  const vanished = path.join(loose, "fantasma.txt");

  sendEvent({ type: "prompt", sid: "sO", cwd: D, prompt: "turn with strays", at: new Date(T0 + 400_000).toISOString() });
  await processInbox();
  fs.writeFileSync(path.join(D, "d.py"), "v1\nv2\n");
  noteTapPath(path.join(D, "d.py"));
  noteTapPath(path.join(loose, "notas.md"));
  noteTapPath(vanished); // touched but was never a real file
  sendEvent({ type: "stop", sid: "sO", cwd: D, reply: "ok", at: new Date(T0 + 460_000).toISOString() });
  await processInbox();

  const turn = (await listTurns()).turns.find((t) => t.prompt === "turn with strays");
  assert.equal(turn.fileCount, 3); // dirty d.py + notas.md + fantasma.txt
  const d = await buildTurnDiff(turn.id);
  // outside keys under $HOME are home-relative ("~/...")
  const rel = (p) => `~/${path.relative(os.homedir(), p)}`;
  const green = d.files.find((f) => f.path === rel(path.join(loose, "notas.md")));
  assert.ok(green, "the loose file enters the diff");
  assert.equal(green.status, "?");
  assert.equal(green.before, "");
  assert.equal(green.after, "line one\nline two\n");
  assert.equal(green.added, "2");
  assert.equal(green.deleted, "0");
  assert.equal(green.repoLabel, "~");
  const ghost = d.files.find((f) => f.path === rel(vanished));
  assert.ok(ghost, "the touched-and-vanished one also enters");
  assert.equal(ghost.status, "D");
  assert.equal(ghost.gone, true);
  const outside = d.turn.repos.find((r) => r.label === "~");
  assert.ok(outside, "the ~ pseudo-repo rides turn.repos for the header");
  assert.equal(outside.outside, 2);
  assert.equal(outside.commits, 0);
  assert.equal(outside.dirty, 0);
});

test("focus: the fork's click resolves to the turn's entry, is consumed and expires", async () => {
  const E = makeRepo();
  commitAt(E, T0 - 100_000, "e.py", "v1\n", "base E");
  await setActiveWorkspace(E);
  const loose = path.join(os.homedir(), ".zcode", "plans", `da-unit-loose2-${Date.now()}`);
  fs.mkdirSync(loose, { recursive: true });
  const stray = path.join(loose, "stray.md");
  fs.writeFileSync(stray, "hola\n");

  sendEvent({ type: "prompt", sid: "sF", cwd: E, prompt: "focus turn", at: new Date(T0 + 500_000).toISOString() });
  await processInbox();
  fs.writeFileSync(path.join(E, "e.py"), "v1\nv2\n");
  noteTapPath(path.join(E, "e.py"));
  noteTapPath(stray);
  sendEvent({ type: "stop", sid: "sF", cwd: E, reply: "ok", at: new Date(T0 + 560_000).toISOString() });
  await processInbox();
  const turn = (await listTurns()).turns.find((t) => t.prompt === "focus turn");
  assert.ok(turn, "the focus turn exists");

  // click on the loose file → focusPath = its key (home-relative "~/")
  const strayKey = `~/${path.relative(os.homedir(), stray)}`;
  assert.equal(requestTurnFocus(stray, turn.id).ok, true);
  const d1 = await buildTurnDiff(turn.id);
  assert.equal(d1.focusPath, strayKey);
  const d2 = await buildTurnDiff(turn.id);
  assert.equal(d2.focusPath, undefined, "el focus se consume en el primer read");

  // click on a repo-file reading ANOTHER turn: navigation hint, no consume
  requestTurnFocus(path.join(E, "e.py"), turn.id);
  const other = (await listTurns()).turns.find((t) => t.prompt === "turn with strays");
  const dOther = await buildTurnDiff(other.id);
  assert.equal(dOther.focusPath, undefined);
  assert.deepEqual(dOther.pendingTurnFocus, { turn: turn.id });
  const d3 = await buildTurnDiff(turn.id);
  assert.equal(d3.focusPath, `${path.basename(E)}/e.py`);

  // TTL expired: it does not resolve
  requestTurnFocus(stray, turn.id, Date.now() - 60_000);
  const d4 = await buildTurnDiff(turn.id);
  assert.equal(d4.focusPath, undefined);
});

test("suggestWorkspace: repo with most changes of the last turn, tie → commits, all loose → null", async () => {
  // Hermetic store: earlier tests finalize superseded turns with stoppedAt =
  // Date.now() (real clock), which would outrank these T0-dated turns — clear
  // so the "last turn" this test builds IS the last turn.
  await clearTurns();
  const P = makeRepo();
  const Q = makeRepo();
  commitAt(P, T0 - 100_000, "p.py", "v1\n", "base P");
  commitAt(Q, T0 - 100_000, "q.py", "v1\n", "base Q");
  await setActiveWorkspace(P);

  // last turn: 2 commits land in P, 1 dirty file stays in Q → P (score 2 vs 1)
  sendEvent({ type: "prompt", sid: "sS", cwd: P, prompt: "suggestion turn", at: new Date(T0 + 600_000).toISOString() });
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
  assert.equal(s.turnId, (await listTurns()).turns[0].id, "suggests the newest turn");

  // tie at score 1: the repo with a COMMIT beats the repo with a dirty file.
  // (first settle Q's dirty with an out-of-window commit so both start clean)
  commitAt(Q, T0 + 640_000, "q.py", "v1\nv2\n", "fix: q");
  sendEvent({ type: "prompt", sid: "sT", cwd: P, prompt: "empate", at: new Date(T0 + 650_000).toISOString() });
  await processInbox();
  commitAt(P, T0 + 655_000, "p3.py", "z\n", "feat: p3");
  noteTapPath(path.join(P, ".git", "HEAD"));
  fs.writeFileSync(path.join(Q, "q3.py"), "stray\n");
  noteTapPath(path.join(Q, "q3.py"));
  sendEvent({ type: "stop", sid: "sT", cwd: P, reply: "ok", at: new Date(T0 + 660_000).toISOString() });
  await processInbox();
  const sT = await suggestWorkspace();
  assert.equal(sT.workspace, P, "empate 1-1: gana el repo con commit");

  // an all-outside turn (cwd outside git, only loose files) → nothing to
  // suggest: the panel shows "select repository..." and waits
  const looseDir = fs.mkdtempSync(path.join(os.tmpdir(), "da-sug-"));
  fs.writeFileSync(path.join(looseDir, "nota.md"), "hola\n");
  sendEvent({ type: "prompt", sid: "sS2", cwd: looseDir, prompt: "todo stray", at: new Date(T0 + 700_000).toISOString() });
  await processInbox();
  noteTapPath(path.join(looseDir, "nota.md"));
  sendEvent({ type: "stop", sid: "sS2", cwd: looseDir, reply: "ok", at: new Date(T0 + 710_000).toISOString() });
  await processInbox();
  const s2 = await suggestWorkspace();
  assert.equal(s2.ok, true);
  assert.equal(s2.workspace, null);
  assert.equal(s2.reason, "no_repos");
});

test("session filter: list/build scoped to the env, foreign prompt does not interrupt, scoped clear, cache", async () => {
  await clearTurns();
  const A = makeRepo();
  const B = makeRepo();
  commitAt(A, T0 - 100_000, "a.py", "v1\n", "base A");
  commitAt(B, T0 - 100_000, "b.py", "v1\n", "base B");
  await setActiveWorkspace(A);

  // a foreign (sF) turn first, recorded with the filter OFF (global)
  sendEvent({ type: "prompt", sid: "sF", cwd: B, prompt: "foreign turn", at: new Date(T0).toISOString() });
  await processInbox();
  fs.writeFileSync(path.join(B, "b.py"), "v1\nedit\n");
  noteTapPath(path.join(B, "b.py"));
  sendEvent({ type: "stop", sid: "sF", cwd: B, reply: "ok F", at: new Date(T0 + 10_000).toISOString() });
  await processInbox();
    assert.equal((await listTurns()).count, 1, "without filter: the foreign turn is there");

  // scope to sA: from here the server only sees sA events as its own
  process.env.ZCODE_SESSION_ID = "sA";
  try {
    sendEvent({ type: "prompt", sid: "sA", cwd: A, prompt: "own turn", at: new Date(T0 + 20_000).toISOString() });
    await processInbox();
    // while sA's turn is OPEN, a foreign sF prompt must NOT interrupt it —
    // and since 0.10.8 the foreign prompt opens ITS OWN lane instead of
    // being dropped by the caller's sticky sid (the live both-tabs-empty
    // failure: with several tasks open, the gate starved the store).
    sendEvent({ type: "prompt", sid: "sF", cwd: B, prompt: "ajeno", at: new Date(T0 + 30_000).toISOString() });
    await processInbox();
    sendEvent({ type: "stop", sid: "sA", cwd: A, reply: "ok A", at: new Date(T0 + 35_000).toISOString() });
    await processInbox();
    const list = (await listTurns());
    assert.equal(list.count, 1, "with filter: only sA's turns");
    assert.equal(list.sessionFilter, "sA");
    assert.equal(list.turns[0].prompt, "own turn");
    assert.equal(list.turns[0].isLive, false);
    assert.equal(list.turns[0].interrupted, false, "the foreign prompt did NOT mark the turn as interrupted");
    const d = await buildTurnDiff(list.turns[0].id);
    assert.equal(d.error, undefined);
    assert.equal(d.turn.prompt, "own turn");
    assert.equal((await buildTurnDiff("latest")).turn.prompt, "own turn", "latest of the session = its last turn");
    assert.equal((await suggestWorkspace()).turnId, list.turns[0].id, "suggest is scoped too");

    // the foreign lane closes on its OWN stop and records — even while this
    // server's sticky sid stays sA. Recording is session-agnostic; only the
    // READ above is scoped (0.10.8).
    sendEvent({ type: "stop", sid: "sF", cwd: B, reply: "ajeno cerrado", at: new Date(T0 + 36_000).toISOString() });
    await processInbox();
    assert.equal((await listTurns()).count, 1, "the recorded foreign turn does NOT enter sA's view");

    // scoped clear: wipes ONLY sA's turns; sF's stay on disk
    const cleared = await clearTurns();
    assert.equal(cleared.scoped, "sA");
    assert.equal((await listTurns()).count, 0);
    process.env.ZCODE_SESSION_ID = "";
    assert.equal((await listTurns()).count, 2, "without filter: BOTH of sF's turns survived the scoped clear");

    // store cache: a NEW turn file is picked up by the next read (invalidation)
    sendEvent({ type: "prompt", sid: "sG", cwd: B, prompt: "another turn", at: new Date(T0 + 40_000).toISOString() });
    await processInbox();
    sendEvent({ type: "stop", sid: "sG", cwd: B, reply: "ok G", at: new Date(T0 + 50_000).toISOString() });
    await processInbox();
    assert.equal((await listTurns()).count, 3, "the store cache is invalidated when the dir changes");

    // whoami reflects the env identity
    process.env.ZCODE_SESSION_ID = "sZ";
    assert.equal(whoAmI().sessionId, "sZ");
    process.env.ZCODE_SESSION_ID = "";
    assert.equal(whoAmI().sessionId, null, "sin env ni request-context → global (sessionId null)");
  } finally {
    process.env.ZCODE_SESSION_ID = "";
  }
});

test("deterministic turn id: re-finalization overwrites; zombie interrupted does NOT clobber completed; legacy dedupe", async () => {
  await clearTurns();
  const D = makeRepo();
  commitAt(D, T0 - 100_000, "d.py", "v1\n", "base D");
  await setActiveWorkspace(D);

  // a window that completes with a reply
  sendEvent({ type: "prompt", sid: "sK", cwd: D, prompt: "ventana que completa", at: new Date(T0).toISOString() });
  await processInbox();
  sendEvent({ type: "stop", sid: "sK", cwd: D, reply: "respuesta real", at: new Date(T0 + 10_000).toISOString() });
  await processInbox();
  let list = (await listTurns());
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
  list = (await listTurns());
  const kept = list.turns.find((t) => t.prompt === "ventana que completa");
  assert.ok(kept, "la ventana completada sigue");
  assert.equal(kept.interrupted, false, "the zombie's interrupted finalize did NOT clobber the completed turn");
  assert.equal(kept.reply, "respuesta real");
  assert.equal(kept.id, doneId, "mismo id determinista (startMs-keyed) tras la re-apertura");

  // the same window re-finalized WITH a real stop overwrites in place (one file)
  sendEvent({ type: "prompt", sid: "sK", cwd: D, prompt: "ventana que completa", at: new Date(T0).toISOString() });
  await processInbox();
  sendEvent({ type: "stop", sid: "sK", cwd: D, reply: "improved reply", at: new Date(T0 + 30_000).toISOString() });
  await processInbox();
  list = (await listTurns());
  const windows = list.turns.filter((t) => t.prompt === "ventana que completa");
  assert.equal(windows.length, 1, "one row per prompt window (deterministic id)");
  assert.equal(windows[0].reply, "improved reply", "the real stop overwrites in the same file");

  // legacy pollution: hand-written stopMs-keyed duplicates collapse at read
  const dupes = [
    { id: "legac0001-sK", sid: "sK", workspace: D, prompt: "legado", reply: "", startedAt: new Date(T0 + 40_000).toISOString(), stoppedAt: new Date(T0 + 50_000).toISOString(), interrupted: true, repos: [], outside: [] },
    { id: "legac0002-sK", sid: "sK", workspace: D, prompt: "legado", reply: "la buena", startedAt: new Date(T0 + 40_000).toISOString(), stoppedAt: new Date(T0 + 60_000).toISOString(), repos: [], outside: [] },
    { id: "legac0003-sK", sid: "sK", workspace: D, prompt: "legado", reply: "", startedAt: new Date(T0 + 40_000).toISOString(), stoppedAt: new Date(T0 + 45_000).toISOString(), interrupted: true, repos: [], outside: [] },
  ];
  for (const d of dupes) fs.writeFileSync(path.join(STATE, "turns2", `${d.id}.json`), JSON.stringify(d));
  list = (await listTurns());
  const legacy = list.turns.filter((t) => t.prompt === "legado");
  assert.equal(legacy.length, 1, "legacy duplicates collapse to one row (sid+startedAt)");
  assert.equal(legacy[0].reply, "la buena", "gana la copia COMPLETADA");
  assert.equal(legacy[0].interrupted, false);
});

test("cross-session attribution: the repo of ANOTHER active task does NOT enter my turn (and symmetrically)", async () => {
  await clearTurns();
  const A = makeRepo(); // this task's cwd
  const B = makeRepo(); // the OTHER task's cwd
  commitAt(A, T0 - 100_000, "a.py", "v1\n", "base A");
  commitAt(B, T0 - 100_000, "b.py", "v1\n", "base B");

  // Phase 1 runs as OUR session. NOTE: the inbox offset starts at EOF on
  // the FIRST processInbox (cold-start rule) — process each event or the
  // server never sees it. Foreign events now open their OWN lanes (0.10.8)
  // — attribution at read time keeps them out of MY turn.
  process.env.ZCODE_SESSION_ID = "sess_mine";
  sendEvent({ type: "prompt", sid: "sess_other-task", cwd: B, prompt: "otra task trabajando", at: new Date(T0 - 10_000).toISOString() });
  await processInbox(); // foreign prompt: its own lane, plus the timeline
  sendEvent({ type: "prompt", sid: "sess_mine", cwd: A, prompt: "my turn", at: new Date(T0).toISOString() });
  await processInbox();
  fs.writeFileSync(path.join(A, "a.py"), "v1\nmia\n");
  noteTapPath(path.join(A, "a.py"));
  fs.writeFileSync(path.join(B, "b.py"), "v1\najena\n");
  noteTapPath(path.join(B, "b.py"));
  sendEvent({ type: "stop", sid: "sess_mine", cwd: A, reply: "ok", at: new Date(T0 + 5_000).toISOString() });
  await processInbox();
  sendEvent({ type: "stop", sid: "sess_other-task", cwd: B, reply: "ok", at: new Date(T0 + 6_000).toISOString() });
  await processInbox(); // foreign stop: closes ITS OWN lane and records (0.10.8)

  try {
    const d = await buildTurnDiff("latest");
    const labels = (d.turn.repos ?? []).map((r) => r.label);
    assert.ok(labels.includes(path.basename(A)), `my repo is there (${JSON.stringify(labels)})`);
    assert.ok(!labels.includes(path.basename(B)), "the OTHER task's repo does NOT enter my turn");
  } finally {
    process.env.ZCODE_SESSION_ID = "";
  }

  // Phase 2 runs as THEIR session (their own turn, after mine closed): they
  // see THEIR repo — and not a trace of mine.
  process.env.ZCODE_SESSION_ID = "sess_other-task";
  sendEvent({ type: "prompt", sid: "sess_other-task", cwd: B, prompt: "their turn now", at: new Date(T0 + 10_000).toISOString() });
  await processInbox();
  fs.writeFileSync(path.join(B, "b.py"), "v1\nsuya\n");
  noteTapPath(path.join(B, "b.py"));
  sendEvent({ type: "stop", sid: "sess_other-task", cwd: B, reply: "ok B", at: new Date(T0 + 12_000).toISOString() });
  await processInbox();
  try {
    const d2 = await buildTurnDiff("latest");
    const labels2 = (d2.turn.repos ?? []).map((r) => r.label);
    assert.ok(labels2.includes(path.basename(B)) && !labels2.includes(path.basename(A)),
      `the other task sees ITS repo and not mine (${JSON.stringify(labels2)})`);
  } finally {
    process.env.ZCODE_SESSION_ID = "";
  }
});

test("0.10.8 regression (live failure): the _meta sticky sid NEVER drops another session's events", async () => {
  // The live 22/11 failure, replayed exactly: ONE server, several tasks.
  // The app stamps _meta["com.zcode/request-context"].session_id on every
  // tools/call — panel AND model — so the sticky sid flips to whoever
  // called LAST. Under the old single-slot gate, every other session's
  // prompt/stop was dropped as "foreign": zero turns recorded for hours,
  // both panel tabs empty. Recording must be session-agnostic.
  await clearTurns();
  const A = makeRepo();
  commitAt(A, T0 - 100_000, "a.py", "v1\n", "base");
  await setActiveWorkspace(A);

  // The sticky sid never self-clears in product code: EVERYTHING after it
  // is set runs inside the try, so a failing assert cannot leak it into the
  // next test.
  try {
    // the PANEL of task sPanel talks to the server (sticky sid ← _meta)
    noteRequestMeta({ "com.zcode/request-context": { session_id: "sPanel" } });
    assert.equal(whoAmI().sessionId, "sPanel", "the sticky sid stayed at sPanel (like the app)");

    // ...while task sWork works: prompt + stop events land in the GLOBAL inbox
    sendEvent({ type: "prompt", sid: "sWork", cwd: A, prompt: "other task's turn", at: new Date(T0).toISOString() });
    await processInbox(); // the OLD gate dropped this prompt (sid ≠ sticky)
    fs.writeFileSync(path.join(A, "a.py"), "v1\nedit\n");
    noteTapPath(path.join(A, "a.py"));
    sendEvent({ type: "stop", sid: "sWork", cwd: A, reply: "trabajo hecho", at: new Date(T0 + 5_000).toISOString() });
    await processInbox(); // ...and dropped this stop: the turn was LOST

    // the store recorded sWork's turn anyway...
    assert.equal((await listTurns()).count, 0, "sPanel's view stays empty (scoped)");
    // the PANEL's explicit-scope read (turn://list?sid=…): even with the
    // server's sticky sid at sPanel, the panel's view pins ITS OWN task.
    const panelView = await listTurns({ sid: "sWork" });
    assert.equal(panelView.count, 1, "the read with an explicit sid sees ITS task");
    assert.equal(panelView.sessionFilter, "sWork");
    process.env.ZCODE_SESSION_ID = "sWork";
    const list = await listTurns();
    assert.equal(list.count, 1, "sWork's turn EXISTS despite the foreign sticky sid");
    assert.equal(list.turns[0].prompt, "other task's turn");
    assert.equal(list.turns[0].interrupted, false);
    const sug = await suggestWorkspace();
    assert.equal(sug.workspace, A, "the repo tab's suggestion works again for sWork");
  } finally {
    process.env.ZCODE_SESSION_ID = "";
    resetRequestMetaForTests();
  }
});

test("0.10.8 regression (restart race): the stop that lands in the NEXT server life completes the turn", async () => {
  // Every deploy restarts the app mid-turn. Life 1 sees the prompt; life 2
  // (a REAL child process, cold inbox offset) only sees the stop — the old
  // life dropped it ("stop without a prompt in this server life") and the
  // turn was lost. Boot heal must reopen the window from the log.
  // Hermetic state (this file's shared inbox carries every earlier test's
  // windows — the heal must be judged on a log with ONLY this turn).
  const RSTATE = fs.mkdtempSync(path.join(os.tmpdir(), "da-rst-"));
  const RINBOX = path.join(RSTATE, "turn-events.jsonl");
  const A = makeRepo();
  commitAt(A, T0 - 100_000, "a.py", "v1\n", "base");
  fs.writeFileSync(path.join(A, "a.py"), "v1\nedit\n");

  // "life 1" is just the LOG it left behind: one prompt, still open
  fs.appendFileSync(RINBOX, `${JSON.stringify({ type: "prompt", sid: "sR", cwd: A, prompt: "turn crosses the restart", at: new Date(T0).toISOString() })}\n`);

  // life 2: a fresh server process over that state — it boots mid-turn
  // (cold offset skips the prompt; boot heal reopens the window), and the
  // stop arrives LIVE, exactly like a deploy restart.
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "..", "diff-ask", "server", "server.mjs")], {
    env: { ...process.env, ZCODE_DIFF_ASK_STATE: RSTATE, ZCODE_SESSION_ID: "", ZCODE_WORKSPACE_ROOT: A },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {}); // keep the pipe drained
  const reply = new Promise((resolve) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 7) resolve(msg.result?.structuredContent ?? null);
        } catch { /* partial line */ }
      }
    });
  });
  await new Promise((r) => setTimeout(r, 300)); // let it boot + heal
  fs.appendFileSync(RINBOX, `${JSON.stringify({ type: "stop", sid: "sR", cwd: A, reply: "cerrado tras el restart", at: new Date(T0 + 8_000).toISOString() })}\n`);
  await new Promise((r) => setTimeout(r, 250)); // the stop travels (watcher/drain)
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_turns", arguments: {} } })}\n`);
  const list2 = await reply;
  child.kill();
  assert.ok(list2, "life 2 answered");
  const done = list2.turns.find((t) => t.prompt === "turn crosses the restart");
  assert.ok(done, "the turn completed across the restart (boot heal + drain)");
  assert.equal(done.reply, "cerrado tras el restart");
  assert.equal(done.interrupted, false);
  assert.equal(done.isLive, false, "really closed — it is not the live window");
  // Byte-offset regression pin: the fresh life must NOT re-drain history —
  // with the old utf8-length offset any multi-byte content reset it to 0
  // and re-finalized the whole log on every restart.
  const files = fs.readdirSync(path.join(RSTATE, "turns2")).filter((n) => n.endsWith(".json"));
  assert.equal(files.length, 1, `the store wrote ONLY the restart's turn (${files.join(", ")})`);
  assert.ok(files[0].endsWith("-sR.json"), files[0]);
});

test("0.10.9 regression (daemon noise): read-time drops the ~/.zcode plumbing of old records", async () => {
  // Records stored BEFORE the allow-list (like the bot-kotlin turns of
  // 23/11: 300 capped outside entries, all daemon plumbing) must render
  // clean at read time — the same isTapNoise predicate, applied to the
  // saved outside list. No store migration.
  await clearTurns();
  const A = makeRepo();
  const id = `${(T0 + 700_000).toString(36)}-sN`;
  const rec = {
    id, sid: "sN", workspace: A, prompt: "old noisy turn", reply: "ok",
    startedAt: new Date(T0 + 700_000).toISOString(),
    stoppedAt: new Date(T0 + 760_000).toISOString(),
    repos: [],
    outside: [
      "~/notrepo/a.txt",                                // plain outside — KEPT
      "~/.zcode/bot-kotlin/state/hb-stream-effects",    // daemon heartbeat — DROPPED
      "~/.zcode/bot-recordings/replay-2026.jsonl",      // recorder — DROPPED
      "~/.zcode/cli/memory-diagnostics/memory-1.jsonl", // diagnostics — DROPPED
      "~/.zcode/cli/artifacts/sess_5b7/call-x.json",    // tool artifacts — DROPPED
      "~/.zcode/plans/plan-sess_x.md",                  // the session speaks — KEPT
      "~/.zcode/cli/memories/projects/x/memory.md",     // the session speaks — KEPT
    ],
  };
  fs.mkdirSync(path.join(STATE, "turns2"), { recursive: true });
  fs.writeFileSync(path.join(STATE, "turns2", `${id}.json`), JSON.stringify(rec));
  const d = await buildTurnDiff(id);
  assert.equal(d.error, undefined);
  const paths = (d.files ?? []).map((f) => f.path);
  for (const kept of ["~/notrepo/a.txt", "~/.zcode/plans/plan-sess_x.md", "~/.zcode/cli/memories/projects/x/memory.md"])
    assert.ok(paths.includes(kept), `kept ${kept} (${JSON.stringify(paths)})`);
  for (const dropped of ["hb-stream-effects", "replay-2026", "memory-1.jsonl", "call-x.json"])
    assert.ok(!paths.some((p) => p.includes(dropped)), `dropped ${dropped} (${JSON.stringify(paths)})`);
});
