import { test } from "node:test";
import assert from "node:assert/strict";
import { revertFrags, mergeRanges, tokenizeLine, changedWordRanges } from "../diff-ask/ui/src/lib.js";

// El diff de Damian: "Hola Mundo" → "Hola Cruel Mundo" (línea MODIFICADA:
// hunk con 1 deletion + 1 addition pareados).
const HOLA = {
  before: ["Hola Mundo"],
  after: ["Hola Cruel Mundo"],
  hunks: [{
    additionStart: 1,
    deletionStart: 1,
    hunkContent: [{ type: "change", deletions: 1, additions: 1 }],
  }],
};
// offsets en "Hola Cruel Mundo": H0 a3 ·sp4· C5 r6 u7 e8 l9 ·sp10· M11..
// pinto "Cruel" → [5,10); pinto "el" → [8,10); pinto "Hola" → [0,4)

test("quirúrgico: pinto Cruel → Hola Mundo", () => {
  const r = revertFrags(HOLA.before, HOLA.after, HOLA.hunks, [{ side: "new", line: 1, offA: 5, offB: 10 }]);
  assert.deepEqual(r.lines, ["Hola Mundo"]);
});

test("quirúrgico: pinto 'el' → Hola Cru Mundo (espacio agregado comido)", () => {
  const r = revertFrags(HOLA.before, HOLA.after, HOLA.hunks, [{ side: "new", line: 1, offA: 8, offB: 10 }]);
  assert.deepEqual(r.lines, ["Hola Cru Mundo"]);
});

test("quirúrgico: pinto ' Cruel' con el espacio adelante → Hola Mundo", () => {
  const r = revertFrags(HOLA.before, HOLA.after, HOLA.hunks, [{ side: "new", line: 1, offA: 4, offB: 10 }]);
  assert.deepEqual(r.lines, ["Hola Mundo"]);
});

test("pinto sólo contexto ('Hola') → noDiff, no toca nada", () => {
  const r = revertFrags(HOLA.before, HOLA.after, HOLA.hunks, [{ side: "new", line: 1, offA: 0, offB: 4 }]);
  assert.deepEqual(r, { noDiff: true });
});

test("línea pura adición pintada entera → la línea desaparece", () => {
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

test("adición pura pintada a medias → queda el resto quirúrgico", () => {
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

// Línea ROJA: before borrado entero; pinto "Cruel" de la línea vieja →
// VUELVE como línea insertada en la posición del hunk.
test("fila roja: pinto 'Cruel' → la palabra reaparece como línea", () => {
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
  // offsets en "Hola Cruel Mundo": Cruel = [5,10)
  const r = revertFrags(before, after, hunks, [{ side: "old", line: 2, offA: 5, offB: 10 }]);
  assert.deepEqual(r.lines, ["uno", "Cruel", "tres"]);
});

test("múltiples frags: verde en un archivo con dos cambios separados", () => {
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
  // pinto "100" entero de la línea 1 y "33" de la línea 3 — quirúrgico:
  // se van los chars pintados (el "1" viejo NO vuelve solo)
  const r = revertFrags(before, after, hunks, [
    { side: "new", line: 1, offA: 4, offB: 7 },
    { side: "new", line: 3, offA: 4, offB: 6 },
  ]);
  assert.deepEqual(r.lines, ["x = ", "y = 2", "z = "]);
});

test("mergeRanges solapa y ordena", () => {
  assert.deepEqual(mergeRanges([[8, 10], [0, 4], [4, 5]]), [[0, 5], [8, 10]]);
  assert.deepEqual(mergeRanges([[2, 4], [3, 9]]), [[2, 9]]);
});

test("tokenizeLine separa palabras/espacios/símbolos con offsets", () => {
  const t = tokenizeLine("Hola Cruel Mundo");
  assert.deepEqual(t.map((x) => x.text), ["Hola", " ", "Cruel", " ", "Mundo"]);
  assert.equal(t[2].start, 5);
  assert.equal(t[2].end, 10);
});

test("changedWordRanges: palabra suelta cambiada (spec de la almohadilla)", () => {
  // "Hola Mundo" → "Hola Cruel Mundo": del no marca nada, add marca "Cruel"
  const r = changedWordRanges("Hola Mundo", "Hola Cruel Mundo");
  assert.deepEqual(r.add, [[5, 10]]);
  assert.deepEqual(r.del, []);
});

test("changedWordRanges: intra-palabra (version → versionNew)", () => {
  const r = changedWordRanges("return config.version", "return config.versionNew");
  assert.deepEqual(r.del, [[14, 21]]);
  assert.deepEqual(r.add, [[14, 24]]);
});

test("changedWordRanges: líneas idénticas → null (sin almohadilla)", () => {
  assert.equal(changedWordRanges("línea igual", "línea igual"), null);
});

test("changedWordRanges: varias palabras sueltas por ambos lados", () => {
  const r = changedWordRanges("el gato come pescado", "el perro come sopa");
  assert.deepEqual(r.del, [[3, 7], [13, 20]]);
  assert.deepEqual(r.add, [[3, 8], [14, 18]]);
});
