import { test } from "node:test";
import assert from "node:assert/strict";
import {
  esc, extractLines, rangeLabel, quoteFor, diffTotals, buildAskMessage,
  compressRuns, linesLabel, quoteForRanges, revertLines,
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

test("extractLines: lado additions ignora los borrados y numeración nueva", () => {
  assert.deepEqual(extractLines(PATCH, "additions", 3, 5), ["ctx3", "new4", "new5"]);
});

test("extractLines: lado deletions numeración vieja", () => {
  assert.deepEqual(extractLines(PATCH, "deletions", 3, 4), ["ctx3", "old4"]);
});

test("extractLines: contexto cuenta en ambos lados (número propio de cada lado)", () => {
  assert.deepEqual(extractLines(PATCH, "additions", 6, 6), ["ctx6"]);  // new 6
  assert.deepEqual(extractLines(PATCH, "deletions", 5, 5), ["ctx6"]);  // old 5
});

test("rangeLabel: single y multi línea, ambos lados", () => {
  assert.equal(rangeLabel({ start: 7, end: 7, side: "additions" }).label, "líneas 7 · additions");
  assert.equal(rangeLabel({ start: 4, end: 6, side: "deletions" }).label, "líneas 4-6 · deletions");
  assert.equal(rangeLabel({ start: 4, end: 6 }).lines, "4-6"); // side default
});

test("quoteFor: verbatim gana sobre todo lo demás", () => {
  assert.deepEqual(
    quoteFor({ afterLines: ["a"], patch: "" }, { start: 1, end: 1 }, "lo que\nvi"),
    ["lo que", "vi"],
  );
});

test("quoteFor: contenido completo por número de línea directo", () => {
  const entry = { afterLines: ["l1", "l2", "l3"], beforeLines: ["v1", "v2"], patch: PATCH };
  assert.deepEqual(quoteFor(entry, { start: 2, end: 3, side: "additions" }), ["l2", "l3"]);
  assert.deepEqual(quoteFor(entry, { start: 2, end: 2, side: "deletions" }), ["v2"]);
});

test("quoteFor: fallback al parche cuando no hay contenido", () => {
  assert.deepEqual(quoteFor({ patch: PATCH }, { start: 4, end: 4, side: "additions" }), ["new4"]);
});

test("diffTotals: strings de numstat, untracked como nuevo, sin counts no suma", () => {
  const t = diffTotals([
    { status: "M", added: "11", deleted: "6" },
    { status: "?", added: "2", deleted: "0" },
    { status: "D", added: "0", deleted: "219" },
    { status: "R" },           // sin counts (numstat de rename no matchea)
    { added: "-" },            // binario SIN status → default M cuenta como modificado
  ]);
  assert.deepEqual(t, { added: 13, deleted: 225, newFiles: 1, delFiles: 1, modFiles: 2, renamed: 1 });
});

test("buildAskMessage: bloques línea + archivo + libre, cita y encabezado", () => {
  const { n, label, text } = buildAskMessage([
    { kind: "line", path: "a.py", start: 3, label: "líneas 3-4 · additions", quoteLines: ["x = 1"], question: "q1" },
    { kind: "file", path: "b.py", label: "archivo", quoteLines: ["M · +2 −0"], question: "q2" },
    { kind: "free", question: "libre" },
  ]);
  assert.equal(n, 3);
  assert.equal(label, "2 ancladas + 1 libre");
  assert.ok(text.startsWith("Diff Ask — 2 ancladas + 1 libre al diff:\n\n"));
  assert.ok(text.includes("- `a.py:3` (Diff Ask · diff, líneas 3-4 · additions):\n> x = 1\n\nq1"));
  assert.ok(text.includes("- `b.py` (Diff Ask · diff, archivo):\n> M · +2 −0\n\nq2"));
  assert.ok(text.includes("\n\nlibre"));
});

test("buildAskMessage: solo libres, plural/singular", () => {
  assert.equal(buildAskMessage([{ kind: "free", question: "x" }]).label, "1 pregunta anclada");
  assert.equal(
    buildAskMessage([{ kind: "free", question: "x" }, { kind: "free", question: "y" }]).label,
    "2 preguntas ancladas",
  );
});

test("buildAskMessage: scope del modo en el encabezado (sin pushear / commit)", () => {
  const asks = [{ kind: "free", question: "x" }];
  assert.ok(
    buildAskMessage(asks, "sin pushear, vs origin/damian").text.startsWith(
      "Diff Ask — 1 pregunta anclada al diff (sin pushear, vs origin/damian):",
    ),
  );
  assert.ok(
    buildAskMessage(asks, "commit abc1234 fix: algo").text.includes("(commit abc1234 fix: algo):"),
  );
  // Sin scope: encabezado idéntico al de siempre.
  assert.ok(buildAskMessage(asks).text.startsWith("Diff Ask — 1 pregunta anclada al diff:"));
});

test("esc: caracteres HTML", () => {
  assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("compressRuns: set de cajitas → corridas contiguas, dedup y orden", () => {
  assert.deepEqual(compressRuns([3, 4, 5, 9, 12, 13, 1]), [
    { first: 1, last: 1 },
    { first: 3, last: 5 },
    { first: 9, last: 9 },
    { first: 12, last: 13 },
  ]);
  assert.deepEqual(compressRuns([]), []);
  assert.deepEqual(compressRuns([7, 7]), [{ first: 7, last: 7 }]);
});

test("linesLabel: multi-rango con singletones", () => {
  assert.equal(
    linesLabel([{ start: 3, end: 5 }, { start: 9, end: 9 }, { start: 12, end: 14 }]),
    "3-5, 9, 12-14",
  );
  assert.equal(linesLabel([{ start: 7, end: 7 }]), "7");
});

test("quoteForRanges: concatena por rango en orden (contenido y fallback parche)", () => {
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

test("buildAskMessage: pregunta multi-rango cita las líneas de todas las corridas", () => {
  const { text } = buildAskMessage([
    {
      kind: "line", path: "a.py", start: 3,
      lines: "3-5, 9", label: "líneas 3-5, 9 · additions",
      quoteLines: ["x3", "x4", "x5", "x9"], question: "por qué estas?",
    },
  ]);
  assert.ok(text.includes("- `a.py:3` (Diff Ask · diff, líneas 3-5, 9 · additions):"));
  assert.ok(text.includes("> x3\n> x4\n> x5\n> x9"));
});

test("esc: caracteres HTML", () => {
  assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("compressRuns: set de cajitas → corridas contiguas, dedup y orden", () => {
  assert.deepEqual(compressRuns([3, 4, 5, 9, 12, 13, 1]), [
    { first: 1, last: 1 },
    { first: 3, last: 5 },
    { first: 9, last: 9 },
    { first: 12, last: 13 },
  ]);
  assert.deepEqual(compressRuns([]), []);
  assert.deepEqual(compressRuns([7, 7]), [{ first: 7, last: 7 }]);
});

test("linesLabel: multi-rango con singletones", () => {
  assert.equal(
    linesLabel([{ start: 3, end: 5 }, { start: 9, end: 9 }, { start: 12, end: 14 }]),
    "3-5, 9, 12-14",
  );
  assert.equal(linesLabel([{ start: 7, end: 7 }]), "7");
});

test("quoteForRanges: concatena por rango en orden (contenido y fallback parche)", () => {
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

test("revertLines: por LÍNEA — una de un bloque de 3, borrada que vuelve, mezcla", () => {
  // hunk real: contexto a | cambio b,c,d→X,Y,Z | contexto e (el contexto de
  // adentro del hunk CUENTA en additionCount/deletionCount de pierre)
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
  // revertir SOLO la Y (nueva 3): X y Z quedan, b/c/d no vuelven
  assert.deepEqual(revertLines(before, after, [hunk], new Set(), new Set([3])), ["a", "X", "Z", "e"]);
  // restaurar SOLO la c vieja (borrada): vuelve a su lugar del bloque, X/Y/Z quedan
  assert.deepEqual(revertLines(before, after, [hunk], new Set([3]), new Set()), ["a", "c", "X", "Y", "Z", "e"]);
  // mezcla: Y fuera + c vuelve
  assert.deepEqual(revertLines(before, after, [hunk], new Set([3]), new Set([3])), ["a", "c", "X", "Z", "e"]);
  // todo el bloque = revert de bloque clásico
  assert.deepEqual(
    revertLines(before, after, [hunk], new Set([2, 3, 4]), new Set([2, 3, 4])),
    ["a", "b", "c", "d", "e"],
  );
  // nada seleccionado → igual; sin hunkContent → null
  assert.deepEqual(revertLines(before, after, [hunk], new Set(), new Set()), after);
  assert.equal(revertLines(before, after, [{ ...hunk, hunkContent: [] }], new Set(), new Set([3])), null);
});
