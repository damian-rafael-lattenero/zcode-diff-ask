import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeWords, mergedOffToNew, newRangeToMergedSegs, revertFrags,
} from "../diff-ask/ui/src/lib.js";

// mergeWords: la secuencia intercalada que alimenta los tachados inline de
// la fila verde (spec 0.9.8: "quiero leer también lo que había antes").

test("mergeWords: palabra cambiada — del ANTES del add que la reemplaza", () => {
  // "alpha beta gamma" → "alpha delta gamma": se lee alpha ~~beta~~ delta gamma
  const seq = mergeWords("alpha beta gamma", "alpha delta gamma");
  assert.deepEqual(seq, [
    { k: "same", text: "alpha " },
    { k: "del", text: "beta" },
    { k: "add", text: "delta" },
    { k: "same", text: " gamma" },
  ]);
});

test("mergeWords: líneas idénticas → todo same; runs contiguos fusionados", () => {
  assert.deepEqual(mergeWords("x y", "x y"), [{ k: "same", text: "x y" }]);
  // dos palabras removidas seguidas = UN run del
  assert.deepEqual(
    mergeWords("a b c", "a c").filter((it) => it.k === "del"),
    [{ k: "del", text: "b " }],
  );
});

test("mergeWords: adición pura (línea nueva) → todo add; null con null", () => {
  assert.deepEqual(mergeWords("", "nueva"), [{ k: "add", text: "nueva" }]);
  assert.deepEqual(mergeWords("vieja", ""), [{ k: "del", text: "vieja" }]);
  assert.equal(mergeWords(null, "x"), null);
  assert.equal(mergeWords("x", null), null);
});

test("mergeWords: del al FINAL de la línea (no hay add que lo siga)", () => {
  // "alpha beta" → "alpha": el tachado queda al final de la fila verde
  assert.deepEqual(mergeWords("alpha beta", "alpha"), [
    { k: "same", text: "alpha" },
    { k: "del", text: " beta" },
  ]);
});

test("mergeWords: cambio al PRINCIPIO — el tachado ancla en offset new 0", () => {
  // los runs del llevan su ancla new implícita: todo lo same/add previo
  const seq = mergeWords("uno dos", "tres dos");
  assert.deepEqual(seq, [
    { k: "del", text: "uno" },
    { k: "add", text: "tres" },
    { k: "same", text: " dos" },
  ]);
});

// ---- cortes de espacio merged↔new ----
// fila "alpha ~~beta~~ delta gamma" (del run merged [6,10)):
const DELS = [{ mStart: 6, mEnd: 10, text: "beta" }]; // merged len 22

test("mergedOffToNew: offsets cruzan el tachado restando sus chars", () => {
  assert.equal(mergedOffToNew(DELS, 3), 3); // antes del run: igual
  assert.equal(mergedOffToNew(DELS, 6), 6); // borde izquierdo: igual
  assert.equal(mergedOffToNew(DELS, 10), 6); // borde derecho: 10-4
  assert.equal(mergedOffToNew(DELS, 22), 18); // fin de fila: 22-4
  assert.equal(mergedOffToNew([], 7), 7); // sin tachados: identidad
});

test("newRangeToMergedSegs: rango cruzando el tachado se parte en dos", () => {
  // new "alpha  delta gamma": pintar [0,12) (hasta el espacio tras "delta")
  // en merged son DOS segmentos: "alpha " [0,6) y " delta" [10,16)
  assert.deepEqual(newRangeToMergedSegs(DELS, 22, 0, 12), [[0, 6], [10, 16]]);
  // rango del lado nuevo posterior: corrimiento simple
  assert.deepEqual(newRangeToMergedSegs(DELS, 22, 7, 12), [[11, 16]]);
  // rango anterior al run: intacto
  assert.deepEqual(newRangeToMergedSegs(DELS, 22, 0, 4), [[0, 4]]);
  // dos tachados: cada tramo de texto nuevo del medio es su propio segmento
  // (merged: [0,2) nuevo, [2,4) del, [4,6) nuevo, [6,8) del, [8,9) nuevo)
  assert.deepEqual(
    newRangeToMergedSegs(
      [{ mStart: 2, mEnd: 4 }, { mStart: 6, mEnd: 8 }], 9, 0, 5,
    ),
    [[0, 2], [4, 6], [8, 9]],
  );
});

// ---- revert lado old: pintar el TACHADO restaura la línea original ----
const CAMBIO = {
  before: ["alpha beta gamma"],
  after: ["alpha delta gamma"],
  hunks: [{
    additionStart: 1,
    deletionStart: 1,
    hunkContent: [{ type: "change", deletions: 1, additions: 1 }],
  }],
};

test("old-side: pinto el run tachado 'beta' → vuelve la línea ORIGINAL", () => {
  // offA/offB en la línea vieja: "beta" está en [6,10) de "alpha beta gamma"
  const r = revertFrags(CAMBIO.before, CAMBIO.after, CAMBIO.hunks, [
    { side: "old", line: 1, offA: 6, offB: 10 },
  ]);
  assert.deepEqual(r.lines, ["alpha beta gamma"]);
});

test("old + new juntos: el drag mixto (tachado + palabra nueva) restaura y borra", () => {
  // pinto el tachado "beta" Y la palabra nueva "gamma": la pareja vuelve al
  // original y la cirugía de la línea pareada se cancela (dropNew)
  const r = revertFrags(CAMBIO.before, CAMBIO.after, CAMBIO.hunks, [
    { side: "old", line: 1, offA: 6, offB: 10 },
    { side: "new", line: 1, offA: 12, offB: 17 },
  ]);
  assert.deepEqual(r.lines, ["alpha beta gamma"]);
});
