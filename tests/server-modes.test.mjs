// Integration tests of the server modes: working (with upstream info),
// commit list/search and per-commit diff — against real git repos
// in tmp (same pattern as the visual harness: no git mocks).
// Turns live in tests/server-turns.test.mjs (prompt→stop window model).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDiff,
  listCommits, buildCommitDiff, parseNameStatusZ, parseLogLine, setActiveWorkspace,
} from "../diff-ask/server/server.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-modes-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  return dir;
}

function commitFile(dir, file, content, msg) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD").trim();
}

function fileOf(data, p) {
  return data.files.find((f) => f.path === p);
}

test("parseNameStatusZ: letters, rename score and NUL origin", () => {
  const out = ["M", "a.py", "R100", "new.ts", "old.ts", "D", "x.py"].join("\0") + "\0";
  assert.deepEqual(parseNameStatusZ(out), [
    { status: "M", path: "a.py" },
    { status: "R", path: "new.ts", oldPath: "old.ts" },
    { status: "D", path: "x.py" },
  ]);
});

test("parseLogLine: fields separated by 0x1f", () => {
  const c = parseLogLine(["abc", "abc12", "super title", "Damian", "2 hours ago"].join("\x1f"));
  assert.deepEqual(c, { hash: "abc", short: "abc12", subject: "super title", author: "Damian", date: "2 hours ago" });
  assert.equal(parseLogLine(""), null);
});

test("working: only the uncommitted tree, but upstream/ahead/behind still ride", async () => {
  const dir = makeRepo();
  const base = commitFile(dir, "a.py", "v1\n", "base");
  // simulated upstream: remote-tracking ref + full branch and remote config
  // (rev-parse @{upstream} needs the remote refspec, update-ref + branch.*.merge
  // are not enough).
  git(dir, "update-ref", `refs/remotes/origin/main`, base);
  git(dir, "config", "remote.origin.url", "/tmp/da-fake-remote");
  git(dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(dir, "config", "branch.main.remote", "origin");
  git(dir, "config", "branch.main.merge", "refs/heads/main");

  commitFile(dir, "b.py", "new in commit\n", "feat: b"); // committed: does NOT ride
  fs.writeFileSync(path.join(dir, "a.py"), "v2\n"); // not committed
  fs.writeFileSync(path.join(dir, "c.py"), "untracked\n"); // not tracked

  const d = await buildDiff({ workspace: dir });
  assert.equal(d.error, undefined);
  assert.equal(d.mode, "working");
  // 0.10.0: the unpushed MODE is gone, but the upstream info rides every
  // payload (the panel's working header shows the ↑/↓ chips).
  assert.equal(d.upstream, "origin/main");
  assert.equal(d.ahead, 1);
  assert.equal(d.behind, 0);
  // working only sees the uncommitted tree: a.py + c.py, not b.py's commit.
  assert.deepEqual(d.files.map((f) => f.path).sort(), ["a.py", "c.py"]);
  assert.equal(fileOf(d, "a.py").before, "v1\n");
  assert.equal(fileOf(d, "a.py").after, "v2\n");
  assert.equal(fileOf(d, "c.py").status, "?");

  // no upstream: no error (working does not need it), just no chips.
  const solo = makeRepo();
  commitFile(solo, "a.py", "v1\n", "base");
  fs.writeFileSync(path.join(solo, "a.py"), "v2\n");
  const d2 = await buildDiff({ workspace: solo });
  assert.equal(d2.error, undefined);
  assert.equal(d2.upstream, null);
  assert.equal(d2.ahead, undefined);
});

test("listCommits: page of 10 with hasMore, skip, hash and subject", async () => {
  const dir = makeRepo();
  const first = commitFile(dir, "f.py", "1\n", "first");
  for (let i = 2; i <= 12; i++) commitFile(dir, "f.py", `${i}\n`, `commit ${i}`);

  const page1 = await listCommits({ workspace: dir });
  assert.equal(page1.commits.length, 10);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.commits[0].subject, "commit 12");
  assert.equal(page1.commits[9].subject, "commit 3");

  const page2 = await listCommits({ skip: 10, workspace: dir });
  assert.equal(page2.commits.length, 2);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.commits[1].subject, "first");

  const short = first.slice(0, 6);
  const byHash = await listCommits({ query: short, workspace: dir });
  assert.equal(byHash.exactMatch, true);
  assert.equal(byHash.commits[0].hash, first);

  const byTitle = await listCommits({ query: "commit 7", workspace: dir });
  assert.equal(byTitle.commits.length, 1);
  assert.equal(byTitle.commits[0].subject, "commit 7");
});

test("buildCommitDiff: statuses, before/after and root commit (empty tree)", async () => {
  const dir = makeRepo();
  commitFile(dir, "a.py", "v1\nold line\n", "root");
  const sha = commitFile(dir, "a.py", "v1\nnew line\n", "second");
  fs.writeFileSync(path.join(dir, "b.py"), "added\n");
  git(dir, "add", "b.py");
  git(dir, "commit", "-q", "-m", "third"); // modifies a.py? no — only adds b.py
  const shaTercero = git(dir, "rev-parse", "HEAD").trim();

  const d = await buildCommitDiff(sha.slice(0, 7), { workspace: dir });
  assert.equal(d.mode, "commit");
  assert.match(d.baseLabel, /^commit /);
  assert.equal(d.commit.isMerge, false);
  const a = fileOf(d, "a.py");
  assert.equal(a.status, "M");
  assert.equal(a.before, "v1\nold line\n");
  assert.equal(a.after, "v1\nnew line\n");
  assert.equal(a.added, "1");
  assert.equal(a.deleted, "1");

  const t = await buildCommitDiff(shaTercero, { workspace: dir });
  assert.equal(fileOf(t, "b.py").status, "A");
  assert.equal(fileOf(t, "b.py").before, "");
  assert.equal(fileOf(t, "b.py").after, "added\n");

  // Root commit: diff against the empty tree → everything "A".
  const root = await buildCommitDiff("HEAD~2", { workspace: dir });
  assert.equal(fileOf(root, "a.py").status, "A");
  assert.equal(fileOf(root, "a.py").before, "");

  const bad = await buildCommitDiff("missing", { workspace: dir });
  assert.equal(bad.error, "unknown_commit");
});

test("setActiveWorkspace: changes the server's default workspace and validates", async () => {
  const a = makeRepo();
  const b = makeRepo();
  commitFile(a, "a.py", "from A\n", "repo a");
  commitFile(b, "b.py", "from B\n", "repo b");

  // invalid paths first
  assert.equal((await setActiveWorkspace("/no/existe")).error, "invalid_path");
  const filePath = path.join(b, "b.py");
  assert.equal((await setActiveWorkspace(filePath)).error, "invalid_path"); // a file, not a folder
  const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), "da-nogit-"));
  assert.equal((await setActiveWorkspace(noRepo)).error, "not_a_repo");

  // valid change: builds WITHOUT an explicit workspace now diff B —
  // I edit AFTER the switch to prove it reads the active one live.
  const ok = await setActiveWorkspace(b);
  assert.equal(ok.ok, true);
  // the server reports the CANONICAL path (realpath: symlinks resolved — on
  // macOS /var is a link to /private/var, so the assertion canonicalizes too)
  assert.equal(ok.workspace, fs.realpathSync(b));
  fs.writeFileSync(path.join(b, "b.py"), "from B edited\n");
  const d = await buildDiff({ mode: "working" });
  assert.equal(d.workspace, fs.realpathSync(b));
  assert.deepEqual(d.files.map((f) => f.path), ["b.py"]);

  // back to A so other tests are not contaminated (the others pass an explicit
  // workspace, but for hygiene)
  await setActiveWorkspace(a);
});

test("NEW folders expand file by file (-uall), subfolders included", async () => {
  const dir = makeRepo();
  commitFile(dir, "a.py", "v1\n", "base");
  fs.mkdirSync(path.join(dir, "newdir", "sub"), { recursive: true });
  fs.writeFileSync(path.join(dir, "newdir", "one.ts"), "export const X = 1;\n");
  fs.writeFileSync(path.join(dir, "newdir", "sub", "two.json"), "{}\n");
  const d = await buildDiff({ mode: "working", workspace: dir });
  const paths = d.files.map((f) => f.path).sort();
  // BEFORE the fix: a single "newdir/" entry impossible to open.
  assert.ok(paths.includes("newdir/one.ts"));
  assert.ok(paths.includes("newdir/sub/two.json"));
  assert.ok(!paths.some((p) => p === "newdir/" || p.endsWith("/")));
  const one = d.files.find((f) => f.path === "newdir/one.ts");
  assert.equal(one.status, "?");
  assert.equal(one.after, "export const X = 1;\n");
});
