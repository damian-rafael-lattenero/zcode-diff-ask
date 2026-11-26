import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeWords, mergedOffToNew, newRangeToMergedSegs, revertFrags, restoreOldWords, wordRanges,
} from "../diff-ask/ui/src/lib.js";

// mergeWords: the interleaved sequence that feeds the inline strikethroughs of
// the green row (spec 0.9.8: "I also want to read what was there before").

test("mergeWords: changed word — del BEFORE the add that replaces it", () => {
  // "alpha beta gamma" → "alpha delta gamma": reads alpha ~~beta~~ delta gamma
  const seq = mergeWords("alpha beta gamma", "alpha delta gamma");
  assert.deepEqual(seq, [
    { k: "same", text: "alpha " },
    { k: "del", text: "beta" },
    { k: "add", text: "delta" },
    { k: "same", text: " gamma" },
  ]);
});

test("mergeWords: identical lines → all same; contiguous runs merged", () => {
  assert.deepEqual(mergeWords("x y", "x y"), [{ k: "same", text: "x y" }]);
  // two removed words in a row = ONE del run
  assert.deepEqual(
    mergeWords("a b c", "a c").filter((it) => it.k === "del"),
    [{ k: "del", text: "b " }],
  );
});

test("mergeWords: pure addition (new line) → all add; null with null", () => {
  assert.deepEqual(mergeWords("", "new"), [{ k: "add", text: "new" }]);
  assert.deepEqual(mergeWords("old", ""), [{ k: "del", text: "old" }]);
  assert.equal(mergeWords(null, "x"), null);
  assert.equal(mergeWords("x", null), null);
});

test("mergeWords: del at the END of the line (no add follows it)", () => {
  // "alpha beta" → "alpha": the strikethrough stays at the end of the green row
  assert.deepEqual(mergeWords("alpha beta", "alpha"), [
    { k: "same", text: "alpha" },
    { k: "del", text: " beta" },
  ]);
});

test("mergeWords: change at the START — the strikethrough anchors at new offset 0", () => {
  // del runs carry their implicit new anchor: everything same/add before them
  const seq = mergeWords("uno dos", "tres dos");
  assert.deepEqual(seq, [
    { k: "del", text: "uno" },
    { k: "add", text: "tres" },
    { k: "same", text: " dos" },
  ]);
});

// ---- merged↔new space cuts ----
// row "alpha ~~beta~~ delta gamma" (del run merged [6,10)):
const DELS = [{ mStart: 6, mEnd: 10, text: "beta" }]; // merged len 22

test("mergedOffToNew: offsets cross the strikethrough subtracting its chars", () => {
  assert.equal(mergedOffToNew(DELS, 3), 3); // before the run: same
  assert.equal(mergedOffToNew(DELS, 6), 6); // left border: same
  assert.equal(mergedOffToNew(DELS, 10), 6); // right border: 10-4
  assert.equal(mergedOffToNew(DELS, 22), 18); // end of row: 22-4
  assert.equal(mergedOffToNew([], 7), 7); // no strikethroughs: identity
});

test("newRangeToMergedSegs: a range crossing the strikethrough splits in two", () => {
  // new "alpha  delta gamma": painting [0,12) (up to the space after "delta")
  // is TWO segments in merged: "alpha " [0,6) and " delta" [10,16)
  assert.deepEqual(newRangeToMergedSegs(DELS, 22, 0, 12), [[0, 6], [10, 16]]);
  // range on the new side further right: simple shift
  assert.deepEqual(newRangeToMergedSegs(DELS, 22, 7, 12), [[11, 16]]);
  // range before the run: untouched
  assert.deepEqual(newRangeToMergedSegs(DELS, 22, 0, 4), [[0, 4]]);
  // two strikethroughs: each piece of new text in between is its own segment
  // (merged: [0,2) new, [2,4) del, [4,6) new, [6,8) del, [8,9) new)
  assert.deepEqual(
    newRangeToMergedSegs(
      [{ mStart: 2, mEnd: 4 }, { mStart: 6, mEnd: 8 }], 9, 0, 5,
    ),
    [[0, 2], [4, 6], [8, 9]],
  );
});

// ---- old-side revert: painting the STRUCK run restores the original line ----
const CHANGE = {
  before: ["alpha beta gamma"],
  after: ["alpha delta gamma"],
  hunks: [{
    additionStart: 1,
    deletionStart: 1,
    hunkContent: [{ type: "change", deletions: 1, additions: 1 }],
  }],
};

test("old-side: paint the struck run 'beta' → the ORIGINAL line comes back", () => {
  // offA/offB on the old line: "beta" is at [6,10) of "alpha beta gamma"
  const r = revertFrags(CHANGE.before, CHANGE.after, CHANGE.hunks, [
    { side: "old", line: 1, offA: 6, offB: 10 },
  ]);
  assert.deepEqual(r.lines, ["alpha beta gamma"]);
});

test("old + new together: the mixed drag (struck + new word) restores and deletes", () => {
  // paint the struck "beta" AND the new word "gamma": the pair goes back to
  // the original and the surgery of the paired line is canceled (dropNew)
  const r = revertFrags(CHANGE.before, CHANGE.after, CHANGE.hunks, [
    { side: "old", line: 1, offA: 6, offB: 10 },
    { side: "new", line: 1, offA: 12, offB: 17 },
  ]);
  assert.deepEqual(r.lines, ["alpha beta gamma"]);
});

// ---- SURGICAL restoration of the old side (spec 28/10: "painting a word of
// the red one restores ONLY that word in place") ----

// "the quick brown fox" → "the slow fox": old offsets of quick [4,9),
// brown [10,15), "quick brown" [4,15)
const FOX = {
  before: ["the quick brown fox"],
  after: ["the slow fox"],
  hunks: [{ additionStart: 1, deletionStart: 1, hunkContent: [{ type: "change", deletions: 1, additions: 1 }] }],
};

test("old surgical: paint ONE of two removed words → it comes back and the replacement stays", () => {
  const r = revertFrags(FOX.before, FOX.after, FOX.hunks, [
    { side: "old", line: 1, offA: 4, offB: 9 },
  ]);
  assert.deepEqual(r.lines, ["the quick slow fox"]);
});

test("old surgical: paint ALL the removed ones → the line goes back to the original (full swap)", () => {
  const r = revertFrags(FOX.before, FOX.after, FOX.hunks, [
    { side: "old", line: 1, offA: 4, offB: 15 },
  ]);
  assert.deepEqual(r.lines, ["the quick brown fox"]);
});

test("old surgical: half a word painted restores nothing (the whole word must be painted)", () => {
  const r = revertFrags(FOX.before, FOX.after, FOX.hunks, [
    { side: "old", line: 1, offA: 4, offB: 7 },
  ]);
  assert.equal(r.noDiff, true); // nothing changed: the green line stays as is
});

test("old surgical: separate paints of quick and brown (no spaces) restore both", () => {
  const r = revertFrags(FOX.before, FOX.after, FOX.hunks, [
    { side: "old", line: 1, offA: 4, offB: 9 },
    { side: "old", line: 1, offA: 10, offB: 15 },
  ]);
  // full swap: every old word of the region comes back, slow goes away
  assert.deepEqual(r.lines, ["the quick brown fox"]);
});

test("old surgical: painting the WHOLE red = the old atomic pair (original line)", () => {
  const r = revertFrags(FOX.before, FOX.after, FOX.hunks, [
    { side: "old", line: 1, offA: 0, offB: 19 },
  ]);
  assert.deepEqual(r.lines, ["the quick brown fox"]);
});

test("old surgical: the restored word stays glued to the new text with its space", () => {
  // "alpha beta" → "alpha": region of " beta" at the end. Painting "beta"
  // (without the space) restores it with the glue space: "alpha beta"
  const r = revertFrags(
    ["alpha beta"],
    ["alpha"],
    [{ additionStart: 1, deletionStart: 1, hunkContent: [{ type: "change", deletions: 1, additions: 1 }] }],
    [{ side: "old", line: 1, offA: 6, offB: 10 }],
  );
  assert.deepEqual(r.lines, ["alpha beta"]);
});

test("restoreOldWords pure: an unpainted region changes nothing; an identical line changes nothing", () => {
  assert.equal(restoreOldWords("b", "a", [[0, 0]]).noChange, true); // nothing painted
  assert.equal(restoreOldWords("x", "x", [[0, 1]]).noChange, true); // equal
});

// ---- ONE BOX PER WORD (spec 28/10: "many words → overlapping boxes and hard
// to read"; the merged range covers everything together) ----

test("wordRanges: splits the range into words, spaces outside", () => {
  // "uno dos tres" changed whole: the merged range [0,12) → 3 boxes
  assert.deepEqual(wordRanges("uno dos tres", 0, 12), [[0, 3], [4, 7], [8, 12]]);
});

test("wordRanges: trims to the range edges and tolerates spaces only", () => {
  assert.deepEqual(wordRanges("hola que tal", 2, 9), [[2, 4], [5, 8]]); // partial edges
  assert.deepEqual(wordRanges("a  b", 1, 3), []); // all-space range → no boxes
  assert.deepEqual(wordRanges("solo", 0, 4), [[0, 4]]); // a whole word
});
