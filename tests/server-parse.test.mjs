import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePorcelainZ, splitPatch } from "../diff-ask/server/server.mjs";

test("parsePorcelainZ: M/A/D/?? and renames with NUL origin", () => {
  const out = [
    " M mod.py",
    "A  added.py",
    "D  gone.py",
    "?? new.py",
    "R  renamed.txt",
    "origin.txt",
  ].join("\0") + "\0";
  const files = parsePorcelainZ(out);
  assert.deepEqual(files.map((f) => f.status), ["M", "A", "D", "?", "R"]);
  assert.equal(files[4].oldPath, "origin.txt");
});

test("splitPatch: splits per file and keys by new path (b/)", () => {
  const patch = [
    "diff --git a/one.py b/one.py",
    "--- a/one.py",
    "+++ b/one.py",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/two.py b/two.py",
    "--- a/two.py",
    "+++ b/two.py",
    "@@ -1 +1 @@",
    "-c",
    "+d",
  ].join("\n");
  const map = splitPatch(patch);
  assert.deepEqual([...map.keys()], ["one.py", "two.py"]);
  assert.ok(map.get("two.py").startsWith("diff --git a/two.py"));
  assert.ok(!map.get("one.py").includes("two.py"));
});

test("splitPatch: fallback to the 'diff --git' path with no +++ b/", () => {
  const patch = "diff --git a/x b/no_header\n@@ -1 +1 @@\n-a\n+b";
  const map = splitPatch(patch);
  assert.deepEqual([...map.keys()], ["no_header"]);
});
