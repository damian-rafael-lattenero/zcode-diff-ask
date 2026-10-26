import { test } from "node:test";
import assert from "node:assert/strict";
import {
  esc, extractLines, rangeLabel, quoteFor, diffTotals, buildAskMessage,
  compressRuns, linesLabel, quoteForRanges, revertHunks,
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

test("revertHunks: reemplaza el rango nuevo por el original, hunks múltiples y solapados", () => {
  const before = ["a", "b", "c", "d", "e", "f"].map((x) => x);
  const after = ["a", "B", "c", "D", "e", "f"];
  // hunk 1: línea 2 (B↔b), hunk 2: línea 4 (D↔d)
  const h = (as, ac, ds, dc) => ({ additionStart: as, additionCount: ac, deletionStart: ds, deletionCount: dc });
  // un hunk (línea 2: contexto+1 cambio con contexto → cubre 1..3? simplificado: exacto)
  assert.deepEqual(
    revertHunks(before, after, [h(2, 1, 2, 1)]),
    ["a", "b", "c", "D", "e", "f"],
  );
  assert.deepEqual(
    revertHunks(before, after, [h(2, 1, 2, 1), h(4, 1, 4, 1)]),
    ["a", "b", "c", "d", "e", "f"],
  );
  // bloque con más líneas nuevas que viejas (el revert achica)
  const after2 = ["a", "X", "Y", "Z", "c", "d"];
  assert.deepEqual(revertHunks(before, after2, [h(2, 3, 2, 1)]), ["a", "b", "c", "d"]);
  // solapados → null (no se toca nada)
  assert.equal(revertHunks(before, after, [h(2, 2, 2, 1), h(3, 1, 3, 1)]), null);
  // sin hunks → igual
  assert.deepEqual(revertHunks(before, after, []), after);
});
