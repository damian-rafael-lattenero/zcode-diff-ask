// Editor save tests (write_file): happy path, AGENT WINS conflict
// (shelve with .patch), drop, deleted file and path escape.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "da-wstate-"));
process.env.ZCODE_DIFF_ASK_STATE = STATE;

const { setActiveWorkspace, writeFileGuarded } = await import("../diff-ask/server/server.mjs");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
// the panel sends the base CONTENT; the server hashes both sides (the
// panel-side hash proved unreliable in the sandbox)

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-w-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "a.py"), "v1\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "b.ts"), "one\ntwo\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

test("write_file: saves with a correct base and rejects paths that escape", async () => {
  const dir = makeRepo();
  await setActiveWorkspace(dir);
  const cur = fs.readFileSync(path.join(dir, "a.py"), "utf8");
  const r = await writeFileGuarded({ path: "a.py", content: "v1\nmine\n", base: cur, workspace: dir });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "a.py"), "utf8"), "v1\nmine\n");

  // subfolder OK
  const b = fs.readFileSync(path.join(dir, "src", "b.ts"), "utf8");
  const r2 = await writeFileGuarded({ path: "src/b.ts", content: "one\n", base: b, workspace: dir });
  assert.equal(r2.ok, true);

  // escape from the workspace → invalid_path, disk untouched
  const esc = await writeFileGuarded({ path: "../outside.txt", content: "x", base: "x", workspace: dir });
  assert.equal(esc.error, "invalid_path");
  assert.ok(!fs.existsSync(path.resolve(dir, "../outside.txt")));
  const abs = await writeFileGuarded({ path: "/etc/passwd", content: "x", base: "x", workspace: dir });
  assert.equal(abs.error, "invalid_path");
});

test("write_file: AGENT WINS conflict — shelve with content + .patch", async () => {
  const dir = makeRepo();
  await setActiveWorkspace(dir);
  const base = fs.readFileSync(path.join(dir, "a.py"), "utf8");
  // the panel edits from base... but the agent overwrites disk before the save
  fs.writeFileSync(path.join(dir, "a.py"), "v1\nAGENT CHANGE\n");
  const r = await writeFileGuarded({ path: "a.py", content: "v1\nmy edit\n", base: base, workspace: dir });
  assert.equal(r.ok, undefined);
  assert.equal(r.conflict, true);
  // the disk keeps the agent's version
  assert.equal(fs.readFileSync(path.join(dir, "a.py"), "utf8"), "v1\nAGENT CHANGE\n");
  // and my version was shelved with its patch
  assert.ok(r.shelved.length >= 1);
  const mine = fs.readFileSync(r.shelved[0], "utf8");
  assert.equal(mine, "v1\nmy edit\n");
  const patch = fs.readFileSync(r.shelved[1], "utf8");
  assert.match(patch, /--- a\/a\.py/);
  assert.match(patch, /\+my edit/);
  assert.match(patch, /-AGENT CHANGE/);
});

test("write_file: drop and deleted file", async () => {
  const dir = makeRepo();
  await setActiveWorkspace(dir);
  const base = fs.readFileSync(path.join(dir, "a.py"), "utf8");
  fs.writeFileSync(path.join(dir, "a.py"), "something else\n");
  const drop = await writeFileGuarded({ path: "a.py", content: "mine", base: base, on_conflict: "drop", workspace: dir });
  assert.equal(drop.conflict, true);
  assert.equal(drop.dropped, true);
  assert.equal(drop.shelved, undefined);
  assert.equal(fs.readFileSync(path.join(dir, "a.py"), "utf8"), "something else\n");

  // file deleted on disk while editing
  fs.rmSync(path.join(dir, "a.py"));
  const gone = await writeFileGuarded({ path: "a.py", content: "x", base: base, workspace: dir });
  assert.equal(gone.conflict, true);
  assert.equal(gone.onConflict, "drop");
});
