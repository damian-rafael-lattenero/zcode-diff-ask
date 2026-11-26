import { test } from "node:test";
import assert from "node:assert/strict";
import {
  esc, extractLines, rangeLabel, quoteFor, diffTotals, buildAskMessage,
  compressRuns, linesLabel, quoteForRanges, revertLines, anchorStillValid,
} from "../diff-ask/ui/src/lib.js";

const PATCH = [
  "diff --git a/x.py b/x.py",
  "index 111..222 100644",
  "--- a/x.py",
  "+++ b/x.py",
  "@@ -3,3 +3,4 @@",
  " ctx3",
  "-old4",
  "+new4",
  "+new5",
  " ctx6",
].join("\n");

test("extractLines: additions side ignores deletions and uses new numbering", () => {
  assert.deepEqual(extractLines(PATCH, "additions", 3, 5), ["ctx3", "new4", "new5"]);
});

test("extractLines: deletions side uses old numbering", () => {
  assert.deepEqual(extractLines(PATCH, "deletions", 3, 4), ["ctx3", "old4"]);
});

test("extractLines: context counts on both sides (number of each side)", () => {
  assert.deepEqual(extractLines(PATCH, "additions", 6, 6), ["ctx6"]);  // new 6
  assert.deepEqual(extractLines(PATCH, "deletions", 5, 5), ["ctx6"]);  // old 5
});

test("rangeLabel: single and multi line, both sides", () => {
  assert.equal(rangeLabel({ start: 7, end: 7, side: "additions" }).label, "lines 7 · additions");
  assert.equal(rangeLabel({ start: 4, end: 6, side: "deletions" }).label, "lines 4-6 · deletions");
  assert.equal(rangeLabel({ start: 4, end: 6 }).lines, "4-6"); // side default
});

test("quoteFor: verbatim wins over everything else", () => {
  assert.deepEqual(
    quoteFor({ afterLines: ["a"], patch: "" }, { start: 1, end: 1 }, "what\nI saw"),
    ["what", "I saw"],
  );
});

test("quoteFor: full content by direct line number", () => {
  const entry = { afterLines: ["l1", "l2", "l3"], beforeLines: ["v1", "v2"], patch: PATCH };
  assert.deepEqual(quoteFor(entry, { start: 2, end: 3, side: "additions" }), ["l2", "l3"]);
  assert.deepEqual(quoteFor(entry, { start: 2, end: 2, side: "deletions" }), ["v2"]);
});

test("quoteFor: fallback to the patch when there is no content", () => {
  assert.deepEqual(quoteFor({ patch: PATCH }, { start: 4, end: 4, side: "additions" }), ["new4"]);
});

test("diffTotals: numstat strings, untracked as new, missing counts do not add", () => {
  const t = diffTotals([
    { status: "M", added: "11", deleted: "6" },
    { status: "?", added: "2", deleted: "0" },
    { status: "D", added: "0", deleted: "219" },
    { status: "R" },           // no counts (rename numstat does not match)
    { added: "-" },            // binary WITHOUT status → default M counts as modified
  ]);
  assert.deepEqual(t, { added: 13, deleted: 225, newFiles: 1, delFiles: 1, modFiles: 2, renamed: 1 });
});

test("buildAskMessage: line + file + free blocks, quote and header", () => {
  const { n, label, text } = buildAskMessage([
    { kind: "line", path: "a.py", start: 3, label: "lines 3-4 · additions", quoteLines: ["x = 1"], question: "q1" },
    { kind: "file", path: "b.py", label: "file", quoteLines: ["M · +2 −0"], question: "q2" },
    { kind: "free", question: "free" },
  ]);
  assert.equal(n, 3);
  assert.equal(label, "2 anchored + 1 free");
  assert.ok(text.startsWith("Diff Ask — 2 anchored + 1 free on the diff:\n\n"));
  assert.ok(text.includes("- `a.py:3` (Diff Ask · diff, lines 3-4 · additions):\n> x = 1\n\nq1"));
  assert.ok(text.includes("- `b.py` (Diff Ask · diff, file):\n> M · +2 −0\n\nq2"));
  assert.ok(text.includes("\n\nfree"));
});

test("buildAskMessage: free only, plural/singular", () => {
  assert.equal(buildAskMessage([{ kind: "free", question: "x" }]).label, "1 anchored question");
  assert.equal(
    buildAskMessage([{ kind: "free", question: "x" }, { kind: "free", question: "y" }]).label,
    "2 anchored questions",
  );
});

test("buildAskMessage: mode scope in the header (unpushed / commit)", () => {
  const asks = [{ kind: "free", question: "x" }];
  assert.ok(
    buildAskMessage(asks, "unpushed, vs origin/damian").text.startsWith(
      "Diff Ask — 1 anchored question on the diff (unpushed, vs origin/damian):",
    ),
  );
  assert.ok(
    buildAskMessage(asks, "commit abc1234 fix: something").text.includes("(commit abc1234 fix: something):"),
  );
  // Without scope: the same header as always.
  assert.ok(buildAskMessage(asks).text.startsWith("Diff Ask — 1 anchored question on the diff:"));
});

test("esc: HTML characters", () => {
  assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("compressRuns: set of checkboxes → contiguous runs, dedup and order", () => {
  assert.deepEqual(compressRuns([3, 4, 5, 9, 12, 13, 1]), [
    { first: 1, last: 1 },
    { first: 3, last: 5 },
    { first: 9, last: 9 },
    { first: 12, last: 13 },
  ]);
  assert.deepEqual(compressRuns([]), []);
  assert.deepEqual(compressRuns([7, 7]), [{ first: 7, last: 7 }]);
});

test("linesLabel: multi-range with singletons", () => {
  assert.equal(
    linesLabel([{ start: 3, end: 5 }, { start: 9, end: 9 }, { start: 12, end: 14 }]),
    "3-5, 9, 12-14",
  );
  assert.equal(linesLabel([{ start: 7, end: 7 }]), "7");
});

test("quoteForRanges: concatenates per range in order (content and patch fallback)", () => {
  const entry = { afterLines: ["l1", "l2", "l3", "l4", "l5"], patch: PATCH };
  assert.deepEqual(
    quoteForRanges(entry, [{ start: 1, end: 2 }, { start: 5, end: 5 }], "additions"),
    ["l1", "l2", "l5"],
  );
  assert.deepEqual(
    quoteForRanges({ patch: PATCH }, [{ start: 3, end: 4 }], "additions"),
    ["ctx3", "new4"],
  );
  assert.deepEqual(
    quoteForRanges({ patch: PATCH }, [{ start: 3, end: 3 }, { start: 4, end: 4 }], "deletions"),
    ["ctx3", "old4"],
  );
});

test("buildAskMessage: multi-range ask quotes the lines of every run", () => {
  const { text } = buildAskMessage([
    {
      kind: "line", path: "a.py", start: 3,
      lines: "3-5, 9", label: "lines 3-5, 9 · additions",
      quoteLines: ["x3", "x4", "x5", "x9"], question: "why these?",
    },
  ]);
  assert.ok(text.includes("- `a.py:3` (Diff Ask · diff, lines 3-5, 9 · additions):"));
  assert.ok(text.includes("> x3\n> x4\n> x5\n> x9"));
});

test("esc: HTML characters", () => {
  assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("compressRuns: set of checkboxes → contiguous runs, dedup and order", () => {
  assert.deepEqual(compressRuns([3, 4, 5, 9, 12, 13, 1]), [
    { first: 1, last: 1 },
    { first: 3, last: 5 },
    { first: 9, last: 9 },
    { first: 12, last: 13 },
  ]);
  assert.deepEqual(compressRuns([]), []);
  assert.deepEqual(compressRuns([7, 7]), [{ first: 7, last: 7 }]);
});

test("linesLabel: multi-range with singletons", () => {
  assert.equal(
    linesLabel([{ start: 3, end: 5 }, { start: 9, end: 9 }, { start: 12, end: 14 }]),
    "3-5, 9, 12-14",
  );
  assert.equal(linesLabel([{ start: 7, end: 7 }]), "7");
});

test("quoteForRanges: concatenates per range in order (content and patch fallback)", () => {
  const entry = { afterLines: ["l1", "l2", "l3", "l4", "l5"], patch: PATCH };
  assert.deepEqual(
    quoteForRanges(entry, [{ start: 1, end: 2 }, { start: 5, end: 5 }], "additions"),
    ["l1", "l2", "l5"],
  );
  assert.deepEqual(
    quoteForRanges({ patch: PATCH }, [{ start: 3, end: 4 }], "additions"),
    ["ctx3", "new4"],
  );
  assert.deepEqual(
    quoteForRanges({ patch: PATCH }, [{ start: 3, end: 3 }, { start: 4, end: 4 }], "deletions"),
    ["ctx3", "old4"],
  );
});

test("revertLines: per LINE — one out of a block of 3, a deleted one coming back, a mix", () => {
  // real hunk: context a | change b,c,d→X,Y,Z | context e (the context INSIDE
  // the hunk COUNTS in pierre's additionCount/deletionCount)
  const before = ["a", "b", "c", "d", "e"];
  const after = ["a", "X", "Y", "Z", "e"];
  const hunk = {
    additionStart: 1, additionCount: 5, deletionStart: 1, deletionCount: 5,
    hunkContent: [
      { type: "context", lines: 1 },
      { type: "change", deletions: 3, additions: 3 },
      { type: "context", lines: 1 },
    ],
  };
  // revert ONLY Y (new 3): X and Z stay, b/c/d do not come back
  // 0.9.0 atomic pairs: the selected green restores ITS paired RED one
  // (before, the line disappeared: the deleted one did not come back)
  assert.deepEqual(revertLines(before, after, [hunk], new Set(), new Set([3])), ["a", "c", "X", "Z", "e"]);
  // restore ONLY the old c (deleted): it comes back to its place in the block, X/Y/Z stay
  // ...and the selected red takes its paired green with it (line back to the original)
  assert.deepEqual(revertLines(before, after, [hunk], new Set([3]), new Set()), ["a", "c", "X", "Z", "e"]);
  // mix: Y out + c back
  assert.deepEqual(revertLines(before, after, [hunk], new Set([3]), new Set([3])), ["a", "c", "X", "Z", "e"]);
  // the whole block = classic block revert
  assert.deepEqual(
    revertLines(before, after, [hunk], new Set([2, 3, 4]), new Set([2, 3, 4])),
    ["a", "b", "c", "d", "e"],
  );
  // nothing selected → unchanged; no hunkContent → null
  assert.deepEqual(revertLines(before, after, [hunk], new Set(), new Set()), after);
  assert.equal(revertLines(before, after, [{ ...hunk, hunkContent: [] }], new Set(), new Set([3])), null);
});

test("anchorStillValid: an edited line invalidates the ask (16/11 rule)", () => {
  // exact match survives
  assert.equal(anchorStillValid(["const x = 1;"], "const x = 1;"), true);
  // whitespace normalizes (rendered rows carry their own spacing)
  assert.equal(anchorStillValid(["  const   x = 1;  "], "const x = 1;"), true);
  // the line was EDITED → drop
  assert.equal(anchorStillValid(["const x = 1;"], "const x = 2;"), false);
  // painted-fragment asks carry just the painted text: contained = still there
  assert.equal(anchorStillValid(["render"], "def render(tokens):"), true);
  assert.equal(anchorStillValid(["render"], "def paint(tokens):"), false);
  // multi-range asks compare against the FIRST quoted line
  assert.equal(anchorStillValid(["a();", "b();"], "a();"), true);
  assert.equal(anchorStillValid(["a();", "b();"], "z();"), false);
  // nothing to compare / no row text → keep-or-drop contract
  assert.equal(anchorStillValid([], "anything"), true);
  assert.equal(anchorStillValid(null, "anything"), true);
  assert.equal(anchorStillValid(["a"], null), false);
});
