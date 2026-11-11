// Integration tests for the mega-commit bounds (0.9.21). Damian's report:
// picking a commit from ~/Projects/ZCode — an upstream-sync merge with 5103
// files — hung the server for minutes (2 git-shows per file, SERIALLY, ~10k
// spawns) and the panel froze for good. These tests pin the three guards:
// bounded concurrency + content cap in enrichFiles, capped git stdout, and
// the pruned file list — all against REAL git repos in tmp (same pattern as
// the rest of the suite: no git mocks).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCommitDiff, enrichFiles, runGit, mapPool,
  MAX_CONTENT_FILES, MAX_LIST_FILES, ENRICH_CONCURRENCY,
} from "../diff-ask/server/server.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-mega-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  return dir;
}

test("mapPool: bounded in-flight and every item processed", async () => {
  let inFlight = 0;
  let max = 0;
  let done = 0;
  const items = Array.from({ length: 50 }, (_, i) => i);
  await mapPool(items, 7, async () => {
    inFlight++;
    max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    done++;
  });
  assert.equal(done, 50);
  assert.ok(max <= 7, `max in-flight ${max} must be <= 7`);
  assert.ok(max > 1, `actually ran concurrently (max ${max})`);
});

test("mapPool: empty list resolves without workers", async () => {
  let called = 0;
  await mapPool([], 4, async () => { called++; });
  assert.equal(called, 0);
});

test("enrichFiles: content only for the first N files, the rest ride patches", async () => {
  const entries = Array.from(
    { length: MAX_CONTENT_FILES + 40 },
    (_, i) => ({ status: "M", path: `f${i}.txt` }),
  );
  const numstat = new Map(entries.map((f) => [f.path, { added: "1", deleted: "1" }]));
  const { files, truncated } = await enrichFiles({
    entries,
    numstat,
    getBefore: async () => "old\n",
    getAfter: async () => "new\n",
    buildPatches: async () => new Map(entries.map((f) => [f.path, `patch ${f.path}\n`])),
    cwd: os.tmpdir(),
  });
  const withContent = files.filter((f) => f.before !== undefined);
  assert.equal(withContent.length, MAX_CONTENT_FILES);
  assert.equal(withContent[0].before, "old\n");
  assert.equal(withContent[0].after, "new\n");
  // Beyond the cap: no content, but the patch fallback still carries it.
  const rest = files[MAX_CONTENT_FILES + 10];
  assert.equal(rest.before, undefined);
  assert.equal(rest.patch, `patch ${rest.path}\n`);
  assert.equal(rest.added, "1"); // numstat counts cover every entry
  assert.equal(truncated, false);
});

test("enrichFiles: enrichment runs with bounded concurrency", async () => {
  let inFlight = 0;
  let max = 0;
  const entries = Array.from({ length: 60 }, (_, i) => ({ status: "M", path: `c${i}.txt` }));
  const tick = async () => {
    inFlight++;
    max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, 4));
    inFlight--;
    return "x\n";
  };
  await enrichFiles({
    entries,
    numstat: new Map(),
    getBefore: tick,
    getAfter: tick,
    buildPatches: async () => new Map(),
    cwd: os.tmpdir(),
  });
  assert.ok(max <= ENRICH_CONCURRENCY, `max in-flight ${max} must be <= ${ENRICH_CONCURRENCY}`);
});

test("enrichFiles: oversized content skips the budget and marks truncated", async () => {
  const entries = [{ status: "M", path: "huge.txt" }];
  const { files, truncated } = await enrichFiles({
    entries,
    numstat: new Map(),
    getBefore: async () => "o".repeat(2_000_000),
    getAfter: async () => "n".repeat(2_000_000),
    buildPatches: async () => new Map(),
    cwd: os.tmpdir(),
  });
  assert.equal(files[0].before, undefined);
  assert.equal(truncated, true);
});

test("runGit: maxOut caps captured stdout and still resolves ok", async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "big.txt"), "x".repeat(200_000));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "big file");
  const r = await runGit(["show", "HEAD"], { cwd: dir, maxOut: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.capped, true);
  assert.ok(r.out.length > 1000 && r.out.length < 200_000, `out length ${r.out.length} sits around the cap, not the full blob`);
});

test("buildCommitDiff: a 400-file commit stays bounded and complete", async () => {
  const dir = makeRepo();
  for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `v1 file ${i}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "mega commit 400");
  const sha = git(dir, "rev-parse", "HEAD").trim();

  const d = await buildCommitDiff(sha, { workspace: dir });
  assert.equal(d.error, undefined);
  assert.equal(d.fileCount, 400);
  assert.equal(d.files.length, 400); // below MAX_LIST_FILES: no list pruning
  const withAfter = d.files.filter((f) => f.after !== undefined);
  assert.equal(withAfter.length, MAX_CONTENT_FILES);
  assert.equal(d.files[0].after, "v1 file 0\n");
  // Beyond the content cap the single git diff patch map still covers it.
  // (git sorts paths lexically: index 399 is f99.txt — look f399 up by path.)
  const late = d.files.find((f) => f.path === "f399.txt");
  assert.ok(late, "f399.txt is in the payload");
  assert.ok(late.patch.includes("+v1 file 399"), "beyond-cap file rides the patch map");
  assert.equal(d.truncated, false);
});

test("buildCommitDiff: beyond MAX_LIST_FILES the list prunes and marks truncated", async () => {
  const dir = makeRepo();
  for (let i = 0; i < 700; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), `v1 file ${i}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "mega commit 700");
  const sha = git(dir, "rev-parse", "HEAD").trim();

  const d = await buildCommitDiff(sha, { workspace: dir });
  assert.equal(d.error, undefined);
  assert.equal(d.fileCount, 700);
  assert.equal(d.files.length, MAX_LIST_FILES);
  assert.equal(d.truncated, true);
  assert.equal(d.files[0].after, "v1 file 0\n");
});

test("buildCommitDiff: merge commit diffs vs first parent, isMerge tagged", async () => {
  const dir = makeRepo();
  git(dir, "commit", "-q", "--allow-empty", "-m", "root");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "side a");
  const first = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "checkout", "-q", "-b", "side", "HEAD~1");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "side b");
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "-q", "--no-ff", "side", "-m", "merge two sides");
  const merge = git(dir, "rev-parse", "HEAD").trim();

  const d = await buildCommitDiff(merge, { workspace: dir });
  assert.equal(d.error, undefined);
  assert.equal(d.isMerge, true);
  assert.equal(d.commit.parents.length, 2);
  assert.deepEqual(d.files.map((f) => f.path), ["b.txt"]); // vs FIRST parent (side a): only b.txt
  assert.equal(d.files[0].after, "b\n");
});
