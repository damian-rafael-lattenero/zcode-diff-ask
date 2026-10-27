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

// 0.9.1 — ADICIÓN PURA pintada a medias: antes la cirugía dejaba el resto
// ("abcdef" pintado [0,3) → quedaba "def"); ahora no hay original parcial,
// la pintada se lleva la línea ENTERA.
test("adición pura pintada a medias → la línea se va ENTERA (0.9.1)", () => {
  const before = ["a"];
  const after = ["a", "abcdef"];
  const hunks = [{
    additionStart: 1,
    deletionStart: 1,
    hunkContent: [{ type: "context", lines: 1 }, { type: "change", deletions: 0, additions: 1 }],
  }];
  const r = revertFrags(before, after, hunks, [{ side: "new", line: 2, offA: 0, offB: 3 }]);
  assert.deepEqual(r.lines, ["a"]);
});

// 0.9.1 — el caso exacto de la prueba manual en el fixture server.ts:
// bloque de adición pura multi-línea, pinto UNA palabra de una línea → esa
// línea entera se va, las hermanas del bloque quedan. Antes la cirugía
// hueca dejaba '("GET", "", async () => {' con sintaxis rota en el diff.
test("bloque adición pura: pinto UNA palabra de una línea → esa línea entera se va, las hermanas quedan", () => {
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
    '  return new Response("delta", { status: 200 });',
    "});",
  ]);
});

// 0.9.1 — la verde SIN pareja dentro de un bloque mixto (la "batch_size"
// del fixture config.json): pintada → se va entera; su hermana pareada
// (la roja modificada con su verde) no se toca.
test("bloque mixto: la verde sin pareja pintada → línea entera fuera, la pareada queda", () => {
  const before = ['    "retry_count": 3'];
  const after = ['    "retry_count": 3,', '    "batch_size": 64'];
  const hunks = [{ additionStart: 1, deletionStart: 1, hunkContent: [{ type: "change", deletions: 1, additions: 2 }] }];
  const off = after[1].indexOf("batch_size");
  const r = revertFrags(before, after, hunks, [{ side: "new", line: 2, offA: off, offB: off + 11 }]);
  assert.deepEqual(r.lines, ['    "retry_count": 3,']);
});

// frag degenerado (cero chars) sobre adición pura → NO se lleva la línea.
test("adición pura: pintada de ancho cero → noDiff, no toca nada", () => {
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

// Línea ROJA: before borrado entero; pinto "Cruel" de la línea vieja →
// la línea VUELVE ENTERA (0.9.0: media línea revertida deja el diff a medias).
test("fila roja: pinto 'Cruel' → la línea vieja vuelve entera", () => {
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
  assert.deepEqual(r.lines, ["uno", "Hola Cruel Mundo", "tres"]);
});

// 0.9.0 — la pareja del↔add restaurada COMPLETA: pinto la roja de una
// línea modificada → original vuelve, la verde pareada SE VA.
test("fila roja de línea MODIFICADA → pareja completa (verde fuera)", () => {
  const before = ["alpha beta gamma"];
  const after = ["alpha delta gamma"];
  const hunks = [{ additionStart: 1, deletionStart: 1, hunkContent: [{ type: "change", deletions: 1, additions: 1 }] }];
  const r = revertFrags(before, after, hunks, [{ side: "old", line: 1, offA: 6, offB: 10 }]);
  assert.deepEqual(r.lines, ["alpha beta gamma"]);
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
  // pinto "100" entero de la línea 1 (la palabra cambiada — 0.9.0: la línea
  // vuelve al original, el "1" viejo INCLUÍDO) y "33" de la línea 3 (adición
  // pura, sin pareja → 0.9.1: la línea se va ENTERA)
  const r = revertFrags(before, after, hunks, [
    { side: "new", line: 1, offA: 4, offB: 7 },
    { side: "new", line: 3, offA: 4, offB: 6 },
  ]);
  assert.deepEqual(r.lines, ["x = 1", "y = 2"]);
});

// 0.9.0 — el REBOTA del revert de línea: pintar la línea entera (o la
// palabra cambiada) de una línea MODIFICADA tiene que restaurar el original
// COMPLETO. Antes la cirugía dejaba "alpha  gamma": la palabra borrada se
// perdía y la línea seguía en el diff (el revert "rebotaba").
test("línea MODIFICADA pintada entera → vuelve al original (rebota fix)", () => {
  const before = ["alpha beta gamma", "x"];
  const after = ["alpha delta gamma", "x"];
  const hunks = [{ additionStart: 1, deletionStart: 1, hunkContent: [{ type: "change", deletions: 1, additions: 1 }] }];
  const entera = revertFrags(before, after, hunks, [{ side: "new", line: 1, offA: 0, offB: 18 }]);
  assert.deepEqual(entera.lines, ["alpha beta gamma", "x"]);
  const palabra = revertFrags(before, after, hunks, [{ side: "new", line: 1, offA: 6, offB: 11 }]);
  assert.deepEqual(palabra.lines, ["alpha beta gamma", "x"]);
  // pintar SOLO la línea sin los bordes (recortada) también es línea entera
  const recortada = revertFrags(before, after, hunks, [{ side: "new", line: 1, offA: 6, offB: 11 }]);
  assert.deepEqual(recortada.lines, ["alpha beta gamma", "x"]);
});

test("línea modificada: pinto 3 letras del agregado → parcial quirúrgico", () => {
  const before = ["alpha beta gamma"];
  const after = ["alpha delta gamma"];
  const hunks = [{ additionStart: 1, deletionStart: 1, hunkContent: [{ type: "change", deletions: 1, additions: 1 }] }];
  // "del" de "delta" [6,9): se van esas letras, el resto queda
  const r = revertFrags(before, after, hunks, [{ side: "new", line: 1, offA: 6, offB: 9 }]);
  assert.deepEqual(r.lines, ["alpha ta gamma"]);
});

test("dos palabras agregadas, pinto una → partial SIN doble espacio", () => {
  const before = ["alpha beta gamma"];
  const after = ["alpha delta epsilon gamma"];
  const hunks = [{ additionStart: 1, deletionStart: 1, hunkContent: [{ type: "change", deletions: 1, additions: 1 }] }];
  const una = revertFrags(before, after, hunks, [{ side: "new", line: 1, offA: 6, offB: 11 }]);
  assert.deepEqual(una.lines, ["alpha epsilon gamma"]);
  const dos = revertFrags(before, after, hunks, [{ side: "new", line: 1, offA: 6, offB: 19 }]);
  assert.deepEqual(dos.lines, ["alpha beta gamma"]);
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
