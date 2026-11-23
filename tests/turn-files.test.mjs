// Laws of the pure core of "what a turn changed" (0.10.10) — the port of the
// app's end-of-turn aggregation. Pure: pinned inputs, no fs. One law per
// test, named after the law it pins (see turn-files.mjs's header). The
// ports were also checked DIFFERENTIALLY against the real jsdiff v9 and the
// app's own function over 18 real turns (211 patch applications, 104 files:
// zero mismatches) — these tests pin the behavior without that dependency.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateTurnFiles,
  applyStructuredPatch,
  lineDiffCounts,
  parseCheckpointArtifact,
  parseCheckpointEvent,
} from "../diff-ask/server/turn-files.mjs";

const hunk = (oldStart, oldLines, newStart, newLines, lines) => ({ oldStart, oldLines, newStart, newLines, lines });
// "a\nb\nc\n" → "a\nB\nc\n" with one line of context, as structuredPatch emits it.
const REPLACE_B = hunk(1, 2, 1, 2, [" a", "-b", "+B", " c"]);

test("A1 apply: replaces through exact context", () => {
  assert.equal(applyStructuredPatch("a\nb\nc\n", [REPLACE_B]), "a\nB\nc\n");
});

test("A1 apply: no hunks leaves the source untouched", () => {
  assert.equal(applyStructuredPatch("x", []), "x");
});

test("A1 apply: fuzz 0 — a context mismatch is null, never a guess", () => {
  assert.equal(applyStructuredPatch("a\nX\nc\n", [REPLACE_B]), null);
});

test("A1 apply: hunks apply in order on the original line numbers", () => {
  const insert = hunk(1, 3, 1, 4, [" 1", " 2", "+x", " 3"]);
  const replace = hunk(5, 3, 6, 3, [" 5", "-6", "+SIX", " 7"]);
  assert.equal(applyStructuredPatch("1\n2\n3\n4\n5\n6\n7\n", [insert, replace]), "1\n2\nx\n3\n4\n5\nSIX\n7\n");
});

test("A1 apply: a hunk whose oldStart is off fits at the nearest exact spot", () => {
  assert.equal(applyStructuredPatch("a\nb\nc\n", [hunk(2, 2, 2, 2, REPLACE_B.lines)]), "a\nB\nc\n");
});

test("A1 apply: removing the final newline", () => {
  const h = hunk(1, 2, 1, 2, [" a", "-b", "+B", "\\ No newline at end of file"]);
  assert.equal(applyStructuredPatch("a\nb\n", [h]), "a\nB");
});

test("A1 apply: adding the final newline", () => {
  const h = hunk(1, 2, 1, 2, [" a", "-b", "\\ No newline at end of file", "+B"]);
  assert.equal(applyStructuredPatch("a\nb", [h]), "a\nB\n");
});

test("A1 apply: a pure insertion at the top", () => {
  assert.equal(applyStructuredPatch("a\nb\n", [hunk(1, 1, 1, 2, ["+X", " a"])]), "X\na\nb\n");
});

test("A2 counts: identical texts are 0/0, even with no budget", () => {
  assert.deepEqual(lineDiffCounts("a\nb\n", "a\nb\n", 0), { additions: 0, deletions: 0 });
});

test("A2 counts: a replaced line is +1 −1, an insertion +n −0, a deletion +0 −n", () => {
  assert.deepEqual(lineDiffCounts("a\nb\nc", "a\nB\nc"), { additions: 1, deletions: 1 });
  assert.deepEqual(lineDiffCounts("a\nc", "a\nb\nc"), { additions: 1, deletions: 0 });
  assert.deepEqual(lineDiffCounts("a\nb\nc", "a\nc"), { additions: 0, deletions: 1 });
});

test("A2 counts: trimming a common head/tail of REPEATED lines stays exact", () => {
  assert.deepEqual(lineDiffCounts("x\nx\nx", "x\nx"), { additions: 0, deletions: 1 });
  assert.deepEqual(lineDiffCounts("x\nx", "x\nx\nx"), { additions: 1, deletions: 0 });
  // "" is one empty line for a line differ, as for jsdiff
  assert.deepEqual(lineDiffCounts("a\nb", ""), { additions: 1, deletions: 2 });
});

test("A2 counts: null once the step budget is spent", () => {
  assert.equal(lineDiffCounts("a", "b", 0), null);
});

const write = (p, before, after) => ({ path: p, existedBefore: before !== null, before, after, patch: [] });
const edit = (p, before, patch) => ({ path: p, existedBefore: true, before, after: undefined, patch });
const ONLY_LINE = (from, to) => [hunk(1, 1, 1, 1, [`-${from}`, `+${to}`])];

test("F1/F2/F3: created then edited — first before (null → empty), final after rebuilt from the Edit's patch", () => {
  const items = aggregateTurnFiles([
    { toolName: "Write", files: [write("/f", null, "v1\n")] },
    { toolName: "Edit", files: [edit("/f", "v1\n", ONLY_LINE("v1", "v2"))] },
  ]);
  // relative to the turn's start the file is brand new: everything is added
  assert.deepEqual(items, [
    { path: "/f", additions: 1, deletions: 0, writeCount: 2, toolNames: ["Edit", "Write"], before: null, after: "v2\n" },
  ]);
});

test("F1/F2: two edits keep the FIRST before and end at the LAST after", () => {
  const items = aggregateTurnFiles([
    { toolName: "Edit", files: [edit("/f", "a\nb\nc\n", [REPLACE_B])] },
    { toolName: "Edit", files: [edit("/f", "a\nB\nc\n", [hunk(2, 2, 2, 2, [" B", "-c", "+C"])])] },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].before, "a\nb\nc\n");
  assert.equal(items[0].after, "a\nB\nC\n");
  assert.deepEqual([items[0].additions, items[0].deletions, items[0].writeCount], [2, 2, 2]);
});

test("F3: a patch that does not apply leaves no after — the counts fall back to the per-write sums", () => {
  const items = aggregateTurnFiles([{ toolName: "Edit", files: [edit("/f", "a\n", ONLY_LINE("zzz", "q"))] }]);
  assert.deepEqual(items, [
    { path: "/f", additions: 1, deletions: 1, writeCount: 1, toolNames: ["Edit"], before: "a\n", after: undefined },
  ]);
});

test("F3: a file that never existed and carries nothing has no after and no counts", () => {
  const items = aggregateTurnFiles([{ toolName: "Write", files: [{ path: "/f", existedBefore: false, before: null, after: undefined, patch: [] }] }]);
  assert.deepEqual(items, [
    { path: "/f", additions: 0, deletions: 0, writeCount: 1, toolNames: ["Write"], before: null, after: undefined },
  ]);
});

test("F4 order: items sort by path the way the app sorts them", () => {
  const files = [write("/b", null, "1"), write("/c/a", null, "1"), write("/a", null, "1")];
  assert.deepEqual(aggregateTurnFiles([{ toolName: "Write", files }]).map((i) => i.path), ["/a", "/b", "/c/a"]);
});

test("P1 parse: a checkpoint row parses once into its tagged record", () => {
  const ok = parseCheckpointEvent(JSON.stringify({ payload: { scope: "workspace", snapshotRef: "zcode-artifact://s1/tool-result-x" }, turnId: "turn_1" }));
  assert.deepEqual(ok, { tag: "ok", value: { scope: "workspace", snapshotRef: "zcode-artifact://s1/tool-result-x", turnId: "turn_1" } });
  assert.equal(parseCheckpointEvent("{").tag, "err");
  assert.equal(parseCheckpointEvent(JSON.stringify({ payload: { scope: "workspace" } })).tag, "err");
});

test("P1 parse: an artifact parses its files, rejects moved shapes, ignores unknown keys", () => {
  const artifact = {
    version: 1,
    kind: "workspace_file_before_change",
    createdAt: "2026-11-23T00:00:00.000Z",
    futureField: "ignored",
    toolCallId: "call_1",
    toolName: "Edit",
    files: [{ path: "/f", existedBefore: true, beforeContent: "a\n", afterContentLength: 2, structuredPatch: [ONLY_LINE("a", "b")[0]] }],
  };
  const ok = parseCheckpointArtifact(JSON.stringify(artifact));
  assert.equal(ok.tag, "ok");
  assert.deepEqual(ok.value, { toolName: "Edit", files: [{ path: "/f", existedBefore: true, before: "a\n", after: undefined, patch: ONLY_LINE("a", "b") }] });
  assert.equal(parseCheckpointArtifact(JSON.stringify({ ...artifact, kind: "other" })).tag, "err");
  assert.equal(parseCheckpointArtifact(JSON.stringify({ ...artifact, version: 2 })).tag, "err");
  const badHunk = { ...artifact, files: [{ ...artifact.files[0], structuredPatch: [{ oldStart: "1", lines: [] }] }] };
  assert.equal(parseCheckpointArtifact(JSON.stringify(badHunk)).tag, "err");
});
