import { test } from "node:test";
import assert from "node:assert/strict";
import { revertFrags, mergeRanges, tokenizeLine, changedWordRanges } from "../diff-ask/ui/src/lib.js";

// Damian's diff: "Hola Mundo" → "Hola Cruel Mundo" (MODIFIED line: hunk with
// 1 deletion + 1 addition paired).
const HELLO = {
  before: ["Hola Mundo"],
  after: ["Hola Cruel Mundo"],
  hunks: [{
    additionStart: 1,
    deletionStart: 1,
    hunkContent: [{ type: "change", deletions: 1, additions: 1 }],
  }],
};
// offsets in "Hola Cruel Mundo": H0 a3 ·sp4· C5 r6 u7 e8 l9 ·sp10· M11..
// paint "Cruel" → [5,10); paint "el" → [8,10); paint "Hola" → [0,4)

test("surgical: paint Cruel → Hola Mundo", () => {
  const r = revertFrags(HELLO.before, HELLO.after, HELLO.hunks, [{ side: "new", line: 1, offA: 5, offB: 10 }]);
  assert.deepEqual(r.lines, ["Hola Mundo"]);
});

test("surgical: paint 'el' → Hola Cru Mundo (added space eaten)", () => {
  const r = revertFrags(HELLO.before, HELLO.after, HELLO.hunks, [{ side: "new", line: 1, offA: 8, offB: 10 }]);
  assert.deepEqual(r.lines, ["Hola Cru Mundo"]);
});

test("surgical: paint ' Cruel' with the leading space → Hola Mundo", () => {
  const r = revertFrags(HELLO.before, HELLO.after, HELLO.hunks, [{ side: "new", line: 1, offA: 4, offB: 10 }]);
  assert.deepEqual(r.lines, ["Hola Mundo"]);
});

test("paint only context ('Hola') → noDiff, touches nothing", () => {
  const r = revertFrags(HELLO.before, HELLO.after, HELLO.hunks, [{ side: "new", line: 1, offA: 0, offB: 4 }]);
  assert.deepEqual(r, { noDiff: true });
});

test("pure addition line painted whole → the line goes away", () => {
  const before = ["a"];
  const after = ["a", "temporada de prueba"];
  const hunks = [{
    additionStart: 1,
    deletionStart: 1,
    hunkContent: [{ type: "context", lines: 1 }, { type: "change", deletions: 0, additions: 1 }],
  }];
  const r = revertFrags(before, after, hunks, [{ side: "new", line: 2, offA: 0, offB: 20 }]);
  assert.deepEqual(r.lines, ["a"]);
});

// 0.9.2 — PURE ADDITION painted halfway: surgical, as Damian asked
// ("it rolls back the 3 lines not the 3 words"): ONLY the painted chars go
// and the line stays (it is removed only if it ends up empty).
test("pure addition painted halfway → the rest stays, surgically (0.9.2)", () => {
  const before = ["a"];
  const after = ["a", "abcdef"];
  const hunks = [{
    additionStart: 1,
    deletionStart: 1,
    hunkContent: [{ type: "context", lines: 1 }, { type: "change", deletions: 0, additions: 1 }],
  }];
  const r = revertFrags(before, after, hunks, [{ side: "new", line: 2, offA: 0, offB: 3 }]);
  assert.deepEqual(r.lines, ["a", "def"]);
});

// 0.9.2 — the exact case of Damian's report on the server.ts fixture:
// multi-line pure addition block, paint ONE word of one line → ONLY that word
// goes, the line stays (0.9.1 removed it whole: the bug "it rolls back the 3
// lines not the 3 words").
test("pure addition block: paint ONE word → ONLY the word goes, the line stays", () => {
  const before = ["reg(charlie);"];
  const after = [
    "reg(charlie);",
    'register("GET", "/delta", async () => {',
    '  return new Response("delta", { status: 200 });',
    "});",
  ];
  const hunks = [{
    additionStart: 1,
    deletionStart: 1,
    hunkContent: [{ type: "context", lines: 1 }, { type: "change", deletions: 0, additions: 3 }],
  }];
  const off = after[1].indexOf("delta");
  const r = revertFrags(before, after, hunks, [{ side: "new", line: 2, offA: off, offB: off + 5 }]);
  assert.deepEqual(r.lines, [
    "reg(charlie);",
    'register("GET", "/", async () => {',
    '  return new Response("delta", { status: 200 });',
    "});",
  ]);
});

// 0.9.2 — the green WITHOUT a pair inside a mixed block (the "batch_size" of
// the config.json fixture): surgical too — only the painted chars go; its
// paired sister (the modified red with its green) is left alone.
test("mixed block: unpaired green painted → only the word, the paired one stays", () => {
  const before = ['    "retry_count": 3'];
  const after = ['    "retry_count": 3,', '    "batch_size": 64'];
  const hunks = [{ additionStart: 1, deletionStart: 1, hunkContent: [{ type: "change", deletions: 1, additions: 2 }] }];
  const off = after[1].indexOf("batch_size");
  const r = revertFrags(before, after, hunks, [{ side: "new", line: 2, offA: off, offB: off + 11 }]);
  assert.deepEqual(r.lines, ['    "retry_count": 3,', '    ": 64']);
});

// degenerate frag (zero chars) over a pure addition → does NOT take the line.
test("pure addition: zero-width paint → noDiff, touches nothing", () => {
  const before = ["a"];
  const after = ["a", "abcdef"];
  const hunks = [{
    additionStart: 1,
    deletionStart: 1,
    hunkContent: [{ type: "context", lines: 1 }, { type: "change", deletions: 0, additions: 1 }],
  }];
  const r = revertFrags(before, after, hunks, [{ side: "new", line: 2, offA: 2, offB: 2 }]);
  assert.deepEqual(r, { noDiff: true });
});

// RED line: whole before deleted; paint "Cruel" of the old line → the line
// COMES BACK WHOLE (0.9.0: half a reverted line leaves the diff half-done).
test("red row: paint 'Cruel' → the old line comes back whole", () => {
  const before = ["uno", "Hola Cruel Mundo", "tres"];
  const after = ["uno", "tres"];
  const hunks = [{
    additionStart: 1,
    deletionStart: 1,
    hunkContent: [
      { type: "context", lines: 1 }, // uno
      { type: "change", deletions: 1, additions: 0 }, // Hola Cruel Mundo
      { type: "context", lines: 1 }, // tres
    ],
  }];
  // offsets in "Hola Cruel Mundo": Cruel = [5,10)
  const r = revertFrags(before, after, hunks, [{ side: "old", line: 2, offA: 5, offB: 10 }]);
  assert.deepEqual(r.lines, ["uno", "Hola Cruel Mundo", "tres"]);
});

// 0.9.0 — the del↔add pair restored WHOLE: paint the red of a modified line →
// the original comes back, the paired green GOES AWAY.
test("red row of a MODIFIED line → full pair (green out)", () => {
  const before = ["alpha beta gamma"];
  const after = ["alpha delta gamma"];
  const hunks = [{ additionStart: 1, deletionStart: 1, hunkContent: [{ type: "change", deletions: 1, additions: 1 }] }];
  const r = revertFrags(before, after, hunks, [{ side: "old", line: 1, offA: 6, offB: 10 }]);
  assert.deepEqual(r.lines, ["alpha beta gamma"]);
});

test("multiple frags: green in a file with two separate changes", () => {
  const before = ["x = 1", "y = 2"];
  const after = ["x = 100", "y = 2", "z = 33"];
  const hunks = [
    {
      additionStart: 1,
      deletionStart: 1,
      hunkContent: [{ type: "change", deletions: 1, additions: 1 }],
    },
    {
      additionStart: 3,
      deletionStart: 2,
      hunkContent: [{ type: "change", deletions: 0, additions: 1 }],
    },
  ];
  // paint the whole "100" of line 1 (the changed word — 0.9.0: the line goes
  // back to the original, the old "1" INCLUDED) and "33" of line 3 (pure
  // addition, no pair → 0.9.2: surgical, leaves "z = ")
  const r = revertFrags(before, after, hunks, [
    { side: "new", line: 1, offA: 4, offB: 7 },
    { side: "new", line: 3, offA: 4, offB: 6 },
  ]);
  assert.deepEqual(r.lines, ["x = 1", "y = 2", "z = "]);
});

// 0.9.0 — the BOUNCE of line revert: painting the whole line (or the changed
// word) of a MODIFIED line has to restore the COMPLETE original. Before this,
// the surgery left "alpha  gamma": the deleted word was lost and the line kept
// showing in the diff (the revert "bounced").
test("MODIFIED line painted whole → back to the original (bounce fix)", () => {
  const before = ["alpha beta gamma", "x"];
  const after = ["alpha delta gamma", "x"];
  const hunks = [{ additionStart: 1, deletionStart: 1, hunkContent: [{ type: "change", deletions: 1, additions: 1 }] }];
  const entera = revertFrags(before, after, hunks, [{ side: "new", line: 1, offA: 0, offB: 18 }]);
  assert.deepEqual(entera.lines, ["alpha beta gamma", "x"]);
  const palabra = revertFrags(before, after, hunks, [{ side: "new", line: 1, offA: 6, offB: 11 }]);
  assert.deepEqual(palabra.lines, ["alpha beta gamma", "x"]);
  // painting ONLY the line without the edges (trimmed) is the whole line too
  const recortada = revertFrags(before, after, hunks, [{ side: "new", line: 1, offA: 6, offB: 11 }]);
  assert.deepEqual(recortada.lines, ["alpha beta gamma", "x"]);
});

test("modified line: paint 3 letters of the addition → surgical partial", () => {
  const before = ["alpha beta gamma"];
  const after = ["alpha delta gamma"];
  const hunks = [{ additionStart: 1, deletionStart: 1, hunkContent: [{ type: "change", deletions: 1, additions: 1 }] }];
  // "del" of "delta" [6,9): those letters go, the rest stays
  const r = revertFrags(before, after, hunks, [{ side: "new", line: 1, offA: 6, offB: 9 }]);
  assert.deepEqual(r.lines, ["alpha ta gamma"]);
});

test("two added words, paint one → partial with NO double space", () => {
  const before = ["alpha beta gamma"];
  const after = ["alpha delta epsilon gamma"];
  const hunks = [{ additionStart: 1, deletionStart: 1, hunkContent: [{ type: "change", deletions: 1, additions: 1 }] }];
  const una = revertFrags(before, after, hunks, [{ side: "new", line: 1, offA: 6, offB: 11 }]);
  assert.deepEqual(una.lines, ["alpha epsilon gamma"]);
  const dos = revertFrags(before, after, hunks, [{ side: "new", line: 1, offA: 6, offB: 19 }]);
  assert.deepEqual(dos.lines, ["alpha beta gamma"]);
});

test("mergeRanges overlaps and sorts", () => {
  assert.deepEqual(mergeRanges([[8, 10], [0, 4], [4, 5]]), [[0, 5], [8, 10]]);
  assert.deepEqual(mergeRanges([[2, 4], [3, 9]]), [[2, 9]]);
});

test("tokenizeLine splits words/spaces/symbols with offsets", () => {
  const t = tokenizeLine("Hola Cruel Mundo");
  assert.deepEqual(t.map((x) => x.text), ["Hola", " ", "Cruel", " ", "Mundo"]);
  assert.equal(t[2].start, 5);
  assert.equal(t[2].end, 10);
});

test("changedWordRanges: single word changed (shim spec)", () => {
  // "Hola Mundo" → "Hola Cruel Mundo": del marks nothing, add marks "Cruel"
  const r = changedWordRanges("Hola Mundo", "Hola Cruel Mundo");
  assert.deepEqual(r.add, [[5, 10]]);
  assert.deepEqual(r.del, []);
});

test("changedWordRanges: intra-word (version → versionNew)", () => {
  const r = changedWordRanges("return config.version", "return config.versionNew");
  assert.deepEqual(r.del, [[14, 21]]);
  assert.deepEqual(r.add, [[14, 24]]);
});

test("changedWordRanges: identical lines → null (no shim)", () => {
  assert.equal(changedWordRanges("línea igual", "línea igual"), null);
});

test("changedWordRanges: several single words on both sides", () => {
  const r = changedWordRanges("el gato come pescado", "el perro come sopa");
  assert.deepEqual(r.del, [[3, 7], [13, 20]]);
  assert.deepEqual(r.add, [[3, 8], [14, 18]]);
});
