// Resilience against a DEAD workspace (0.9.24): a repo that gets deleted or
// stops being a git repo must degrade into an explicit error — never throw,
// never wedge — and switching to a valid repo afterwards must keep working.
// Damian's report: deleting the project folder left the panel stuck.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDiff, buildCommitDiff, listGitProjects, setActiveWorkspace,
} from "../diff-ask/server/server.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-res-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "a.txt"), "v1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

test("buildDiff: a deleted workspace returns not_a_repo, never throws", async () => {
  const dir = makeRepo();
  fs.rmSync(dir, { recursive: true, force: true });
  const d = await buildDiff({ mode: "working", workspace: dir });
  assert.equal(d.error, "not_a_repo");
  assert.equal(d.workspace, dir);
  assert.match(d.message, /no es un repositorio git/);
});

test("buildDiff: a folder that stopped being a repo also returns not_a_repo", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-res-nogit-"));
  fs.writeFileSync(path.join(dir, "x.txt"), "x\n");
  const d = await buildDiff({ mode: "working", workspace: dir });
  assert.equal(d.error, "not_a_repo");
});

test("buildCommitDiff: deleted workspace → not_a_repo, never throws", async () => {
  const dir = makeRepo();
  fs.rmSync(dir, { recursive: true, force: true });
  const d = await buildCommitDiff("HEAD", { workspace: dir });
  assert.equal(d.error, "not_a_repo");
});

test("listGitProjects: deleted folder → invalid_path with an empty list", () => {
  const gone = path.join(os.tmpdir(), `da-res-gone-${Date.now()}`);
  const r = listGitProjects(gone);
  assert.equal(r.error, "invalid_path");
  assert.deepEqual(r.repos, []);
});

test("the active workspace can be re-pointed after it dies", async () => {
  const a = makeRepo();
  const b = makeRepo();
  const okA = await setActiveWorkspace(a);
  assert.equal(okA.ok, true);
  // A dies under the server's feet
  fs.rmSync(a, { recursive: true, force: true });
  assert.equal((await buildDiff({ mode: "working" })).error, "not_a_repo");
  // the escape hatch: switching to a valid repo restores normal operation
  const okB = await setActiveWorkspace(b);
  assert.equal(okB.ok, true);
  const d = await buildDiff({ mode: "working" });
  assert.equal(d.error, undefined);
  assert.equal(d.workspace, b);
  await setActiveWorkspace(a); // restore default for other tests (path is gone → harmless)
});
