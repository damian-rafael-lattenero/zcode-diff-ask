// Light turns (0.11.0): the panel's turn switch must move headers, not
// megabytes. `buildTurnDiff(..., {withContent:false})` carries the file list,
// statuses and counts with NO before/after/patch; `buildTurnFile` answers one
// file on demand, byte-identical to what the full payload carries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAppStore, edited, written } from "./lib/app-store-fixture.mjs";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "da-state-light-"));
process.env.ZCODE_DIFF_ASK_STATE = STATE;
process.env.ZCODE_SESSION_ID = "";
process.env.ZCODE_DIFF_ASK_APP_DB = path.join(STATE, "no-app-db.sqlite");

const server = await import("../diff-ask/server/server.mjs");
const { setActiveWorkspace, processInbox, listTurns, buildTurnDiff, buildTurnFile, clearTurns } = server;

const INBOX = path.join(STATE, "turn-events.jsonl");
const iso = (ms) => new Date(ms).toISOString();
const sendEvent = (ev) => fs.appendFileSync(INBOX, `${JSON.stringify(ev)}\n`);
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-repo-light-"));
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

let clock = Date.now() - 60 * 60_000;
function scene() {
  const store = createAppStore(fs.mkdtempSync(path.join(os.tmpdir(), "da-appstore-light-")));
  Object.assign(process.env, store.env);
  const T = (clock += 120_000);
  const sid = `sess_light_${T.toString(36)}`;
  store.know(sid);
  return { store, T, sid };
}

const recordOf = async (prompt) => (await listTurns()).turns.find((t) => t.prompt === prompt);

test("light turn: headers + counts, no content, no internal _src — the per-file read brings the content", async () => {
  await clearTurns();
  const { store, T, sid } = scene();
  const A = makeRepo();
  commitAt(A, T - 100_000, "src/main.ts", "a\nb\nc\n", "base");
  await setActiveWorkspace(A);
  sendEvent({ type: "prompt", sid, cwd: A, prompt: "liviano", at: iso(T) });
  await processInbox();
  fs.writeFileSync(path.join(A, "src/new.ts"), "export const n = 1;\n");
  store.checkpoint(sid, T + 10_000, "Write", [written(path.join(A, "src/new.ts"), "export const n = 1;\n")]);
  fs.writeFileSync(path.join(A, "src/main.ts"), "a\nB\nc\n");
  store.checkpoint(sid, T + 20_000, "Edit", [edited(path.join(A, "src/main.ts"), "a\nb\nc\n", "a\nB\nc\n")]);
  sendEvent({ type: "stop", sid, cwd: A, reply: "ok", at: iso(T + 60_000) });
  await processInbox();

  const row = await recordOf("liviano");
  const light = await buildTurnDiff(row.id, { withContent: false });
  assert.equal(light.light, true, "the panel knows content is deferred");
  assert.equal(light.fileCount, 2);
  const label = path.basename(A);
  assert.deepEqual(light.files.map((f) => f.path), [`${label}/src/main.ts`, `${label}/src/new.ts`]);
  assert.deepEqual(light.files.map((f) => [f.added, f.deleted]), [["1", "1"], ["1", "0"]], "counts ride the light payload");
  for (const f of light.files) {
    assert.equal(f.before, undefined, "no before in the light payload");
    assert.equal(f.after, undefined, "no after in the light payload");
    assert.equal(f.patch, undefined, "no patch in the light payload");
    assert.equal(f._src, undefined, "_src (the app item, content twice) never rides the wire");
    assert.equal(f.deferred, true, "each file is deferred");
  }
  assert.ok(JSON.stringify(light).length < 2000, "a light payload is tiny even with real content behind it");

  const full = await buildTurnDiff(row.id);
  for (const f of full.files) {
    const c = await buildTurnFile(row.id, f.path);
    assert.equal(c.error, undefined);
    assert.equal(c.before, f.status === "A" ? null : f.before);
    assert.equal(c.after, f.after);
  }
  const cached = await buildTurnFile(row.id, `${label}/src/main.ts`);
  assert.equal(cached.after, "a\nB\nc\n", "the second read answers from the cache");
  const missing = await buildTurnFile(row.id, `${label}/nope.ts`);
  assert.equal(missing.error, "unknown_file");
});

test("capture turn: light headers, per-file content from the work tree/git", async () => {
  await clearTurns();
  // No app store for this session: the capture model owns the turn.
  process.env.ZCODE_DIFF_ASK_APP_DB = path.join(STATE, "no-app-db.sqlite");
  const T = (clock += 120_000);
  const sid = `sess_capture_${T.toString(36)}`;
  const A = makeRepo();
  commitAt(A, T - 100_000, "one.txt", "v1\n", "base");
  await setActiveWorkspace(A);
  sendEvent({ type: "prompt", sid, cwd: A, prompt: "captura", at: iso(T) });
  await processInbox();
  fs.writeFileSync(path.join(A, "one.txt"), "v2\n");
  sendEvent({ type: "stop", sid, cwd: A, reply: "ok", at: iso(T + 30_000) });
  await processInbox();

  const row = await recordOf("captura");
  const light = await buildTurnDiff(row.id, { withContent: false });
  assert.equal(light.light, true);
  const f = light.files.find((x) => x.path.endsWith("/one.txt"));
  assert.ok(f, "the dirty file is listed");
  assert.equal(f.deferred, true);
  assert.equal(f.before, undefined);
  assert.equal(f.added, "1");
  assert.equal(f.deleted, "1");
  const c = await buildTurnFile(row.id, f.path);
  assert.equal(c.before, "v1\n");
  assert.equal(c.after, "v2\n");
});

test("turn store: a new turn re-reads only ITS file — the rest stay parsed", async () => {
  await clearTurns();
  const { T, sid } = scene();
  const A = makeRepo();
  commitAt(A, T - 100_000, "a.txt", "a\n", "base");
  await setActiveWorkspace(A);
  sendEvent({ type: "prompt", sid, cwd: A, prompt: "cache uno", at: iso(T) });
  sendEvent({ type: "stop", sid, cwd: A, reply: "primero", at: iso(T + 10_000) });
  await processInbox();
  sendEvent({ type: "prompt", sid, cwd: A, prompt: "cache dos", at: iso(T + 20_000) });
  sendEvent({ type: "stop", sid, cwd: A, reply: "segundo", at: iso(T + 30_000) });
  await processInbox();

  const first = await listTurns();
  const one = first.turns.find((t) => t.prompt === "cache uno");
  assert.ok(one);

  // Count how many turn-store files the next scan actually PARSES.
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === "string" && p.includes(`${path.sep}turns2${path.sep}`)) reads++;
    return realRead.call(this, p, ...rest);
  };
  try {
    sendEvent({ type: "prompt", sid, cwd: A, prompt: "cache tres", at: iso(T + 40_000) });
    sendEvent({ type: "stop", sid, cwd: A, reply: "tercero", at: iso(T + 50_000) });
    await processInbox();
    reads = 0; // the stop notification's own list read doesn't matter
    const second = await listTurns();
    assert.ok(second.turns.some((t) => t.prompt === "cache tres"));
    assert.ok(second.turns.some((t) => t.prompt === "cache uno"));
    assert.ok(reads <= 2, `only the new/changed record is parsed again (parsed ${reads})`);
  } finally {
    fs.readFileSync = realRead;
  }

  // A file whose bytes changed is re-parsed at the next scan (the scan runs
  // when the directory changes: a new record, a delete; the server's own
  // writes invalidate the cache outright). The probe file forces that scan.
  const file = path.join(STATE, "turns2", `${one.id}.json`);
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...rec, reply: "reescrito de otra forma" }));
  const probe = path.join(STATE, "turns2", "zzz-probe.json");
  fs.writeFileSync(probe, "{not a record}");
  try {
    const third = await listTurns();
    assert.equal(third.turns.find((t) => t.id === one.id)?.reply, "reescrito de otra forma");
    assert.ok(third.turns.some((t) => t.prompt === "cache dos"), "the other records survived the rescan");
  } finally {
    fs.rmSync(probe, { force: true });
  }
});
