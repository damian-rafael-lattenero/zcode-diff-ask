import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePorcelainZ, splitPatch } from "../diff-ask/server/server.mjs";

test("parsePorcelainZ: M/A/D/?? y renames con origen NUL", () => {
  const out = [
    " M mod.py",
    "A  added.py",
    "D  gone.py",
    "?? nuevo.py",
    "R  renamed.txt",
    "origen.txt",
  ].join("\0") + "\0";
  const files = parsePorcelainZ(out);
  assert.deepEqual(files.map((f) => f.status), ["M", "A", "D", "?", "R"]);
  assert.equal(files[4].oldPath, "origen.txt");
});

test("splitPatch: separa por archivo y keyea por path nuevo (b/)", () => {
  const patch = [
    "diff --git a/uno.py b/uno.py",
    "--- a/uno.py",
    "+++ b/uno.py",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/dos.py b/dos.py",
    "--- a/dos.py",
    "+++ b/dos.py",
    "@@ -1 +1 @@",
    "-c",
    "+d",
  ].join("\n");
  const map = splitPatch(patch);
  assert.deepEqual([...map.keys()], ["uno.py", "dos.py"]);
  assert.ok(map.get("dos.py").startsWith("diff --git a/dos.py"));
  assert.ok(!map.get("uno.py").includes("dos.py"));
});

test("splitPatch: fallback al path de 'diff --git' sin +++ b/", () => {
  const patch = "diff --git a/x b/sin_header\n@@ -1 +1 @@\n-a\n+b";
  const map = splitPatch(patch);
  assert.deepEqual([...map.keys()], ["sin_header"]);
});
