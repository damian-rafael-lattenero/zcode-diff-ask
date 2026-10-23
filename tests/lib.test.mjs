import { test } from "node:test";
import assert from "node:assert/strict";
import { esc, extractLines, rangeLabel, quoteFor, diffTotals, buildAskMessage } from "../diff-ask/ui/src/lib.js";

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
    { added: "-" },            // binario
  ]);
  assert.deepEqual(t, { added: 13, deleted: 225, newFiles: 1, delFiles: 1, renamed: 1 });
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

test("esc: caracteres HTML", () => {
  assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});
