// App-backed turns (0.10.10): when ZCode knows the session, a turn's files
// are the app's own — its workspace checkpoints, the list its end-of-turn
// summary shows. These tests run the REAL edge (node:sqlite + artifact
// reads) against a fake of the app's store; the capture model (sessions the
// app does not know) stays covered by server-turns.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppStore, edited, written } from "./lib/app-store-fixture.mjs";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "da-state-app-"));
process.env.ZCODE_DIFF_ASK_STATE = STATE;
process.env.ZCODE_SESSION_ID = "";
process.env.ZCODE_DIFF_ASK_APP_DB = path.join(STATE, "no-app-db.sqlite"); // until a test installs a store

const server = await import("../diff-ask/server/server.mjs");
const { setActiveWorkspace, processInbox, listTurns, buildTurnDiff, clearTurns, suggestWorkspace } = server;
const { appTurnFiles } = await import("../diff-ask/server/app-store.mjs");

const INBOX = path.join(STATE, "turn-events.jsonl");
const iso = (ms) => new Date(ms).toISOString();
const sendEvent = (ev) => fs.appendFileSync(INBOX, `${JSON.stringify(ev)}\n`);
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-repo-"));
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

function commitAt(dir, ms, file, content, msg) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, "add", "-A");
  const stamp = iso(ms);
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=T", "commit", "-qm", msg], {
    env: { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
  });
}

// Every test gets its own store, session id and time slice (the edge memoizes
// by session and window, and the zombie cap is two hours).
let clock = Date.now() - 60 * 60_000;
function scene() {
  const store = createAppStore(fs.mkdtempSync(path.join(os.tmpdir(), "da-appstore-")));
  Object.assign(process.env, store.env);
  const T = (clock += 120_000);
  const sid = `sess_app_${T.toString(36)}`;
  store.know(sid);
  return { store, T, sid };
}

async function openTurn(sid, cwd, at, prompt) {
  sendEvent({ type: "prompt", sid, cwd, prompt, at: iso(at) });
  await processInbox();
}
async function closeTurn(sid, cwd, at, reply = "listo") {
  sendEvent({ type: "stop", sid, cwd, reply, at: iso(at) });
  await processInbox();
}
const recordOf = async (prompt) => (await listTurns()).turns.find((t) => t.prompt === prompt);

test("a turn shows exactly the files ZCode's end-of-turn summary shows — nothing else", async () => {
  await clearTurns();
  const { store, T, sid } = scene();
  const A = makeRepo();
  commitAt(A, T - 100_000, "src/main.ts", "a\nb\nc\n", "base");
  // Not the turn's writes: a file left dirty BEFORE the turn.
  fs.writeFileSync(path.join(A, "old-dirty.txt"), "dirty since yesterday\n");
  await setActiveWorkspace(A);

  await openTurn(sid, A, T, "cambiá main y creá new");
  // The app checkpoints each tool write as it lands.
  fs.writeFileSync(path.join(A, "src/new.ts"), "export const n = 1;\n");
  store.checkpoint(sid, T + 10_000, "Write", [written(path.join(A, "src/new.ts"), "export const n = 1;\n")]);
  fs.writeFileSync(path.join(A, "src/main.ts"), "a\nB\nc\n");
  store.checkpoint(sid, T + 20_000, "Edit", [edited(path.join(A, "src/main.ts"), "a\nb\nc\n", "a\nB\nc\n")]);
  // Shell side effects the app does not checkpoint: a stray file and a commit.
  fs.writeFileSync(path.join(A, "stray.txt"), "from a shell command\n");
  commitAt(A, T + 30_000, "committed.txt", "by git in a shell\n", "commit made during the turn");
  await closeTurn(sid, A, T + 60_000);

  const row = await recordOf("cambiá main y creá new");
  assert.ok(row, "the turn is listed");
  assert.deepEqual([row.fileCount, row.repoCount], [2, 1], "the row counts what the summary counts");
  const d = await buildTurnDiff(row.id);
  assert.equal(d.error, undefined);
  assert.equal(d.turn.source, "app");
  const label = path.basename(A);
  assert.deepEqual(d.files.map((f) => f.path), [`${label}/src/main.ts`, `${label}/src/new.ts`]);
  assert.deepEqual(
    d.files.map((f) => [f.path, f.status, f.before, f.after, f.added, f.deleted]),
    [
      [`${label}/src/main.ts`, "M", "a\nb\nc\n", "a\nB\nc\n", "1", "1"],
      [`${label}/src/new.ts`, "A", "", "export const n = 1;\n", "1", "0"],
    ],
    "content is the app's first-before → final-after, with its counts",
  );
  assert.deepEqual(d.turn.repos, [{ label, path: A, files: 2 }]);
  assert.equal(d.fileCount, 2);
  const stored = JSON.parse(fs.readFileSync(path.join(STATE, "turns2", `${row.id}.json`), "utf8"));
  assert.deepEqual([stored.source, stored.repos, stored.outside], ["app", [], []], "nothing was captured");
});

test("a turn that wrote nothing shows nothing — commits and dirty files do not count", async () => {
  await clearTurns();
  const { T, sid } = scene();
  const A = makeRepo();
  commitAt(A, T - 100_000, "a.txt", "base\n", "base");
  await setActiveWorkspace(A);
  await openTurn(sid, A, T, "solo commiteá");
  commitAt(A, T + 10_000, "b.txt", "x\n", "a commit made by a shell command");
  fs.writeFileSync(path.join(A, "c.txt"), "dirty\n");
  await closeTurn(sid, A, T + 30_000);

  const row = await recordOf("solo commiteá");
  assert.deepEqual([row.fileCount, row.repoCount], [0, 0], "ZCode's summary lists no file for this turn");
  const d = await buildTurnDiff(row.id);
  assert.equal(d.turn.source, "app");
  assert.equal(d.files.length, 0);
  assert.deepEqual(d.turn.repos, []);
  assert.deepEqual(await suggestWorkspace(), { ok: true, turnId: row.id, workspace: null, reason: "no_repos" });
});

test("records stored before 0.10.10 (captured repos) render from the app's truth too", async () => {
  await clearTurns();
  const { store, T, sid } = scene();
  const A = makeRepo();
  commitAt(A, T - 100_000, "a.txt", "base\n", "base");
  store.checkpoint(sid, T + 10_000, "Write", [written(path.join(A, "real.ts"), "real\n")]);
  // What the old model stored for the same window: noise and all.
  const id = `${T.toString(36)}-${sid.slice(0, 8)}`;
  fs.mkdirSync(path.join(STATE, "turns2"), { recursive: true });
  fs.writeFileSync(
    path.join(STATE, "turns2", `${id}.json`),
    JSON.stringify({
      id,
      sid,
      workspace: A,
      prompt: "turno viejo",
      reply: "",
      startedAt: iso(T),
      stoppedAt: iso(T + 60_000),
      repos: [{ path: A, label: path.basename(A), commits: [], dirty: [{ path: "unrelated.txt", status: "M" }] }],
      outside: ["~/.zcode/bot-kotlin/state/hb-stream-effects"],
    }),
  );
  const d = await buildTurnDiff(id);
  assert.equal(d.error, undefined);
  assert.equal(d.turn.source, "app", "the app's truth wins over what was captured");
  assert.deepEqual(d.files.map((f) => f.path), [`${path.basename(A)}/real.ts`]);
  assert.equal((await recordOf("turno viejo")).fileCount, 1);
});

test("the live turn is what the agent has written so far", async () => {
  await clearTurns();
  const { store, T, sid } = scene();
  const A = makeRepo();
  await setActiveWorkspace(A);
  await openTurn(sid, A, T, "en vivo");
  assert.deepEqual((await buildTurnDiff("latest")).files.map((f) => f.path), [], "nothing written yet");

  store.checkpoint(sid, T + 10_000, "Write", [written(path.join(A, "one.ts"), "1\n")]);
  store.checkpoint(sid, T + 20_000, "Write", [written(path.join(A, "two.ts"), "2\n")]);
  const live = await buildTurnDiff("latest");
  assert.equal(live.turn.isLive, true);
  assert.equal(live.turn.source, "app");
  assert.deepEqual(live.files.map((f) => f.path), [`${path.basename(A)}/one.ts`, `${path.basename(A)}/two.ts`]);

  await closeTurn(sid, A, T + 60_000);
  assert.deepEqual((await buildTurnDiff("latest")).files.map((f) => f.path), live.files.map((f) => f.path));
});

test("only the turn's own checkpoints count — and a window that grew is re-read, never served stale", async () => {
  await clearTurns();
  const { store, T, sid } = scene();
  const A = makeRepo();
  const file = (n) => path.join(A, `${n}.ts`);
  // A previous turn's write, this turn's, and the next turn's.
  store.checkpoint(sid, T - 60_000, "Write", [written(file("previous"), "p\n")]);
  store.checkpoint(sid, T + 10_000, "Write", [written(file("a"), "a\n")]);
  const window = { sid, fromMs: T - 2000, toMs: T + 60_000 + 2000 };
  assert.deepEqual((await appTurnFiles(window)).map((i) => path.basename(i.path)), ["a.ts"]);
  // The app flushes a late row after the turn closed: the memo must not pin the old answer.
  store.checkpoint(sid, T + 20_000, "Write", [written(file("b"), "b\n")]);
  const grown = await appTurnFiles(window);
  assert.deepEqual(grown.map((i) => path.basename(i.path)), ["a.ts", "b.ts"]);
  assert.equal(await appTurnFiles(window), grown, "an unchanged window answers the parsed items");
  store.checkpoint(sid, T + 120_000, "Write", [written(file("next"), "n\n")]);

  await setActiveWorkspace(A);
  await openTurn(sid, A, T, "ventana justa");
  await closeTurn(sid, A, T + 60_000);
  const d = await buildTurnDiff((await recordOf("ventana justa")).id);
  assert.deepEqual(d.files.map((f) => path.basename(f.path)), ["a.ts", "b.ts"], "the neighbours' files stay out");
});

test("the window is exact at both ends: a write 1 s before the prompt is the previous turn's, one 1 s after the stop still belongs to this turn", async () => {
  await clearTurns();
  const { store, T, sid } = scene();
  const A = makeRepo();
  const file = (n) => path.join(A, `${n}.ts`);
  store.checkpoint(sid, T - 1000, "Write", [written(file("previous"), "p\n")]);
  store.checkpoint(sid, T + 10_000, "Write", [written(file("mine"), "m\n")]);
  store.checkpoint(sid, T + 61_000, "Write", [written(file("late"), "l\n")]); // flushed after the stop
  store.checkpoint(sid, T + 65_000, "Write", [written(file("next"), "n\n")]);
  await setActiveWorkspace(A);
  await openTurn(sid, A, T, "borde justo");
  await closeTurn(sid, A, T + 60_000);
  const d = await buildTurnDiff((await recordOf("borde justo")).id);
  assert.deepEqual(d.files.map((f) => path.basename(f.path)), ["late.ts", "mine.ts"]);
});

test("other repos group under their own repo, files outside any repo close the list, a vanished artifact is skipped", async () => {
  await clearTurns();
  const { store, T, sid } = scene();
  const A = makeRepo();
  const B = makeRepo();
  const loose = path.join(os.tmpdir(), `da-loose-${T}`, "notes.md");
  await setActiveWorkspace(A);
  await openTurn(sid, A, T, "tres lugares");
  store.checkpoint(sid, T + 10_000, "Edit", [edited(path.join(A, "a.ts"), "1\n2\n", "1\nTWO\n")]);
  store.checkpoint(sid, T + 20_000, "Write", [written(path.join(B, "b.ts"), "b\n")]);
  const vanished = store.checkpoint(sid, T + 30_000, "Write", [written(path.join(B, "gone.ts"), "g\n")]);
  fs.rmSync(vanished); // pruned by the app
  store.checkpoint(sid, T + 40_000, "Write", [written(loose, "# notes\n")]);
  await closeTurn(sid, A, T + 60_000);

  // Repos keep the order of their first file's path; the "~" group closes.
  const [first, second] = [A, B].sort((x, y) => x.localeCompare(y));
  const d = await buildTurnDiff((await recordOf("tres lugares")).id);
  assert.deepEqual(
    d.files.map((f) => f.path),
    [`${path.basename(first)}/${first === A ? "a.ts" : "b.ts"}`, `${path.basename(second)}/${second === A ? "a.ts" : "b.ts"}`, loose],
  );
  assert.deepEqual(d.turn.repos, [
    { label: path.basename(first), path: first, files: 1 },
    { label: path.basename(second), path: second, files: 1 },
    { label: "~", path: os.homedir(), files: 1 },
  ]);
  assert.equal(d.files.at(-1).repoLabel, "~");
  assert.equal(d.files.at(-1).status, "A");
  assert.equal(d.files.at(-1).after, "# notes\n");
});

test("the repo tab suggests the repo where the newest turn that WROTE files worked", async () => {
  await clearTurns();
  const { store, T, sid } = scene();
  const A = makeRepo();
  const B = makeRepo();
  await setActiveWorkspace(A);
  await openTurn(sid, A, T, "trabajo real");
  store.checkpoint(sid, T + 10_000, "Write", [written(path.join(A, "one.ts"), "1\n")]);
  store.checkpoint(sid, T + 20_000, "Write", [written(path.join(B, "one.ts"), "1\n")]);
  store.checkpoint(sid, T + 30_000, "Write", [written(path.join(B, "two.ts"), "2\n")]);
  store.checkpoint(sid, T + 40_000, "Write", [written(path.join(B, "three.ts"), "3\n")]);
  await closeTurn(sid, A, T + 60_000);
  // The newest turn wrote nothing (it only ran commands).
  await openTurn(sid, A, T + 90_000, "solo comandos");
  await closeTurn(sid, A, T + 100_000);

  const work = await recordOf("trabajo real");
  assert.deepEqual(await suggestWorkspace(), { ok: true, turnId: work.id, workspace: B, label: path.basename(B), files: 3 });
});

test("no truth: a session the app does not know, or a store that cannot be read, answers null", async () => {
  const { store, T } = scene();
  const window = { sid: "sess_nobody", fromMs: T, toMs: T + 1000 };
  assert.equal(await appTurnFiles(window), null, "not an app session");
  store.close();
  fs.writeFileSync(path.join(STATE, "garbage.sqlite"), "this is not a database");
  Object.assign(process.env, { ZCODE_DIFF_ASK_APP_DB: path.join(STATE, "garbage.sqlite") });
  assert.equal(await appTurnFiles({ ...window, sid: "sess_anyone" }), null, "unreadable store");
});
