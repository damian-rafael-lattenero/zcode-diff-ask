// lib — capa PURA del panel: parseo de parches, etiquetas de rango, citas,
// totales y ensamblado del mensaje. Sin DOM y sin estado — importable desde
// node:test (tests/lib.test.mjs) y del panel (main.js) por igual.
//
// Convención: todo lo que se puede probar sin navegador vive acá; main.js es
// la capa de presentación (DOM, eventos, MCP App) y se ejercita con el
// harness visual (dist/dev.html).

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Extract the literal text of [start,end] on one side of a unified patch.
export function extractLines(patch, side, start, end) {
  const out = [];
  let oldN = 0;
  let newN = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldN = parseInt(m[1], 10);
        newN = parseInt(m[2], 10);
      }
      continue;
    }
    if (
      raw.startsWith("diff ") || raw.startsWith("index ") ||
      raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("Binary files")
    )
      continue;
    if (raw.startsWith("+")) {
      if (side !== "deletions" && newN >= start && newN <= end) out.push(raw.slice(1));
      newN++;
    } else if (raw.startsWith("-")) {
      if (side === "deletions" && oldN >= start && oldN <= end) out.push(raw.slice(1));
      oldN++;
    } else if (raw.startsWith(" ")) {
      if (side === "deletions" ? oldN >= start && oldN <= end : newN >= start && newN <= end)
        out.push(raw.slice(1));
      oldN++;
      newN++;
    }
  }
  return out;
}

export function rangeLabel(range) {
  const side = range.side ?? "additions";
  const lines = range.end > range.start ? `${range.start}-${range.end}` : `${range.start}`;
  return { side, lines, label: `líneas ${lines} · ${side === "deletions" ? "deletions" : "additions"}` };
}

// Índices de fila seleccionados (SET de cajitas) → corridas contiguas
// [{first,last}] ordenadas — la unidad de pintado y de cita del multi-select.
export function compressRuns(indices) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const runs = [];
  for (const i of sorted) {
    const last = runs[runs.length - 1];
    if (last && i === last.last + 1) last.last = i;
    else runs.push({ first: i, last: i });
  }
  return runs;
}

// Etiqueta de líneas multi-rango: "3-5, 9, 12-14" (para el ancla y el título).
export function linesLabel(ranges) {
  return ranges
    .map((r) => (r.end > r.start ? `${r.start}-${r.end}` : `${r.start}`))
    .join(", ");
}

// Cita de varias corridas: cada rango por su lado, concatenadas en orden
// (los rangos son disjuntos y crecientes — sin duplicados ni saltos de ida).
export function quoteForRanges(entry, ranges, side) {
  const out = [];
  for (const r of ranges) out.push(...quoteFor(entry, { ...r, side }, null));
  return out;
}

// Cita las líneas del rango: desde el contenido completo si lo hay (render
// desde before/after — números de línea directos), sino desde el parche.
// `verbatim` (selección de texto) gana siempre: es lo que el usuario vio.
export function quoteFor(entry, range, verbatim) {
  if (verbatim) return verbatim.split("\n");
  const side = range.side ?? "additions";
  const arr = side === "deletions" ? entry.beforeLines : entry.afterLines;
  if (arr) {
    const out = [];
    for (let n = range.start; n <= range.end; n++) {
      if (arr[n - 1] !== undefined) out.push(arr[n - 1]);
    }
    if (out.length) return out;
  }
  return extractLines(entry.patch, side, range.start, range.end);
}

// Revertir LÍNEAS puntuales al original (no bloques): camina el
// alineamiento exacto de cada hunk (hunkContent: context/change con índices
// 1-based implícitos desde additionStart/deletionStart). selOld = números de
// líneas viejas a RESTAURAR (borradas que vuelven); selNew = números de
// líneas nuevas a QUITAR (agregadas que se van). El resto queda tal cual.
// Devuelve null si un hunk no trae hunkContent o es inconsistente (no toca nada).
export function revertLines(beforeLines, afterLines, hunks, selOld, selNew) {
  const sorted = [...hunks].sort((a, b) => a.additionStart - b.additionStart);
  const out = [];
  let nIdx = 1; // puntero 1-based sobre afterLines
  for (const h of sorted) {
    if (!Array.isArray(h.hunkContent) || h.hunkContent.length === 0) return null;
    if (h.additionStart - 1 > afterLines.length || h.additionStart < nIdx) return null; // solapado
    out.push(...afterLines.slice(nIdx - 1, h.additionStart - 1)); // tramo idéntico
    let oldN = h.deletionStart;
    let newN = h.additionStart;
    for (const c of h.hunkContent) {
      if (c.type === "context") {
        for (let i = 0; i < c.lines; i++) {
          out.push(afterLines[newN - 1]);
          oldN++;
          newN++;
        }
      } else {
        // PARES atómicos (0.9.0, spec Damian): la cajita de una línea
        // MODIFICADA revierte la PAREJA — la verde seleccionada restaura su
        // roja pareada (antes la línea DESAPARECÍA: el del no volvía solo —
        // "selecciono una línea y el revert no funciona"); la roja
        // seleccionada se lleva su verde pareada puesta. Sin pareja (adición
        // o borrada pura) el comportamiento es el de siempre.
        const dels = [];
        for (let i = 0; i < c.deletions; i++) dels.push(oldN + i);
        const adds = [];
        for (let i = 0; i < c.additions; i++) adds.push(newN + i);
        const restoreOld = new Set();
        const dropNew = new Set();
        for (let i = 0; i < dels.length; i++) {
          if (selOld.has(dels[i])) {
            restoreOld.add(dels[i]);
            if (i < adds.length) dropNew.add(adds[i]);
          }
        }
        for (let i = 0; i < adds.length; i++) {
          if (selNew.has(adds[i])) {
            dropNew.add(adds[i]);
            if (i < dels.length) restoreOld.add(dels[i]);
          }
        }
        for (let i = 0; i < c.deletions; i++) {
          if (restoreOld.has(dels[i])) out.push(beforeLines[dels[i] - 1]); // restaurar
          oldN++;
        }
        for (let i = 0; i < c.additions; i++) {
          if (!dropNew.has(adds[i])) out.push(afterLines[adds[i] - 1]); // conservar
          newN++;
        }
      }
    }
    nIdx = newN;
  }
  out.push(...afterLines.slice(nIdx - 1));
  return out;
}

// Totales reales del diff para el header: líneas +/- y archivos por status.
// Los counts llegan como STRINGS (git numstat) y pueden faltar (binarios,
// truncados) — NaN no suma.
export function diffTotals(files) {
  const t = { added: 0, deleted: 0, newFiles: 0, delFiles: 0, modFiles: 0, renamed: 0 };
  for (const f of files) {
    const a = parseInt(f.added, 10);
    const d = parseInt(f.deleted, 10);
    if (!Number.isNaN(a)) t.added += a;
    if (!Number.isNaN(d)) t.deleted += d;
    const s = f.status ?? "M";
    if (s === "A" || s === "?") t.newFiles++;
    else if (s === "D") t.delFiles++;
    else if (s === "M" || s === "T") t.modFiles++;
    else if (s === "R" || s === "C") t.renamed++;
  }
  return t;
}

// Ensambla el mensaje único de "Enviar todo": bloques anclados (línea o
// archivo, con cita) y libres (texto plano), con el encabezado que cuenta.
// scope (opcional) aclara QUÉ diff se está preguntando — "Sin pushear",
// "commit a1b2c3d", "último turno 📸" — para que el agente sepa qué mirar.
export function buildAskMessage(asks, scope = "") {
  const n = asks.length;
  const blocks = asks.map((a) => {
    if (a.kind === "free") return a.question;
    const quoted = a.quoteLines?.length ? a.quoteLines.map((l) => `> ${l}`).join("\n") : "";
    const head =
      a.kind === "file"
        ? `- \`${a.path}\` (Diff Ask · diff, ${a.label}):`
        : `- \`${a.path}:${a.start}\` (Diff Ask · diff, ${a.label}):`;
    return quoted ? `${head}\n${quoted}\n\n${a.question}` : `${head}\n\n${a.question}`;
  });
  const anchored = asks.filter((a) => a.kind !== "free").length;
  const libres = n - anchored;
  const label =
    anchored && libres
      ? `${anchored} anclada${anchored === 1 ? "" : "s"} + ${libres} libre${libres === 1 ? "" : "s"}`
      : `${n} pregunta${n === 1 ? "" : "s"} anclada${n === 1 ? "" : "s"}`;
  const scopeTxt = scope ? ` (${scope})` : "";
  return { n, label, text: `Diff Ask — ${label} al diff${scopeTxt}:\n\n${blocks.join("\n\n")}` };
}

// ------------------------------------------- revert quirúrgico (0.8.0)
// Fragmentos PINTADOS con el mouse (chars exactos, no líneas enteras).
// frags: [{side:"new"|"old", line, offA, offB}] — offsets planos [A,B) sobre
//   la línea: side new = número de línea del AFTER (fila verde/contexto,
//   texto visible); side old = número de línea del BEFORE (fila roja).
// Semántica (Damian; 0.9.0 — la cirugía de chars NO puede resucitar lo
// borrado, así que la cobertura COMPLETA del cambio restaura la línea):
//   - new, pintado PARCIAL: los chars que el cambio AGREGÓ dentro de lo
//     pintado se eliminan; los que ya existían quedan. "Hola Mundo"→"Hola
//     Cruel Mundo": pinto "el" → "Hola Cru Mundo". Espacios agregados
//     pegados a la eliminación se comen (no queda doble espacio).
//   - new, pintado que cubre la LÍNEA entera o TODOS los rangos agregados
//     (= pintaste la palabra/las palabras cambiadas): la línea vuelve AL
//     ORIGINAL del before — incluidas las palabras que el cambio borró.
//     Antes quedaba un híbrido ("alpha  gamma") que seguía apareciendo en
//     el diff: el "rebota" del revert de línea.
//   - old (fila roja) pintada: la pareja DEL VUELTA ENTERA — la línea
//     original se restaura y su contraparte verde se va (media línea
//     revertida es peor que la línea sin revertir). Si la roja no tiene
//     pareja (línea puramente borrada), se restaura tal cual.
//   - new, línea de ADICIÓN PURA (sin before pareado): quirúrgico también
//     — se borran SÓLO los chars pintados y la línea queda, aunque el
//     resultado sea sintaxis rota: es el pincel de Damian (spec confirmada
//     27/10: "elijo 3 palabras de 3 filas → me rollbackea las 3 líneas NO
//     las 3 palabras"). La línea sólo se elimina si queda vacía (0.9.1 la
//     sacaba entera: mal).
//   - Línea que queda vacía tras la cirugía → se elimina entera.
// Devuelve {lines} | {noDiff:true} | null (alineamiento inconsistente).
export function tokenizeLine(s) {
  const out = [];
  const re = /\s+|\w+|[^\s\w]+/g;
  let m;
  while ((m = re.exec(s))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

function lcsMatch(aT, bT) {
  // match de tokens AFTER contra BEFORE (LCS clásico); devuelve para cada
  // índice de aT el índice de bT con el que matchea (o -1 = agregado)
  const n = aT.length;
  const m = bT.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = aT[i].text === bT[j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const match = new Int32Array(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aT[i].text === bT[j].text) { match[i] = j; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return match;
}

// Aplica la cirugía a UNA línea after con selecciones (lista de [a,b)
// MERGEADAS). beforeLine null = adición pura. Devuelve {line} (aunque idéntica)
// o {noChange:true} si lo pintado no tocó ningún char agregado.
function surgeryLine(afterLine, beforeLine, sels) {
  if (beforeLine === afterLine) return { noChange: true };
  const aT = tokenizeLine(afterLine);
  const bT = beforeLine != null ? tokenizeLine(beforeLine) : [];
  const match = lcsMatch(aT, bT);
  const added = aT.map((_, k) => match[k] === -1);
  // chars a borrar: intersección sel ∩ tokens agregados
  const del = new Array(afterLine.length).fill(false);
  let touched = false;
  for (let k = 0; k < aT.length; k++) {
    if (!added[k]) continue;
    const t = aT[k];
    for (const [a, b] of sels) {
      const lo = Math.max(a, t.start);
      const hi = Math.min(b, t.end);
      if (lo < hi) {
        for (let x = lo; x < hi; x++) del[x] = true;
        touched = true;
      }
    }
  }
  if (!touched) return { noChange: true };
  // espacios AGREGADOS que tras las eliminaciones quedarían ADYACENTES a
  // otro espacio sobreviviente: se comen (sin esto "Cruel" pintado deja
  // "Hola  Mundo"). Con "el" pintado NO quedan adyacentes ("Cru" en el
  // medio) y el espacio queda ("Hola Cru Mundo").
  for (let k = 0; k < aT.length; k++) {
    const t = aT[k];
    if (!added[k] || !/^\s+$/.test(t.text)) continue;
    let left = -1;
    for (let x = t.start - 1; x >= 0; x--) if (!del[x]) { left = x; break; }
    let right = -1;
    for (let x = t.end; x < afterLine.length; x++) if (!del[x]) { right = x; break; }
    const near = (c) => c >= 0 && /\s/.test(afterLine[c]);
    if (near(left) || near(right)) for (let x = t.start; x < t.end; x++) del[x] = true;
  }
  // token agregado NO-blanco borrado ENTERO con espacios SOBREVIVIENTES a
  //AMBOS lados: uno de los dos se come (matched, no agregado — el bloque de
  // arriba no los tocó). "alpha delta epsilon" con "delta" pintado (cambio
  // parcial de una línea con más cambios) → "alpha epsilon", sin doble
  // espacio. Si sólo UN lado tiene espacio, queda (no hay doble).
  for (let k = 0; k < aT.length; k++) {
    const t = aT[k];
    if (!added[k] || /^\s+$/.test(t.text)) continue;
    let fullyDel = true;
    for (let x = t.start; x < t.end; x++) if (!del[x]) { fullyDel = false; break; }
    if (!fullyDel) continue;
    let right = -1;
    for (let x = t.end; x < afterLine.length; x++) if (!del[x]) { right = x; break; }
    if (right < 0 || !/\s/.test(afterLine[right])) continue;
    let left = -1;
    for (let x = t.start - 1; x >= 0; x--) if (!del[x]) { left = x; break; }
    if (left >= 0 && /\s/.test(afterLine[left])) del[right] = true;
  }
  let out = "";
  for (let x = 0; x < afterLine.length; x++) if (!del[x]) out += afterLine[x];
  return { line: out };
}

// ¿la pintada cubre el cambio ENTERO de la línea? Dos formas equivalentes
// de "quiero esta línea como el original": la línea completa (recortada) o
// todos los rangos que el cambio agregó (= las palabras cambiadas pintadas).
function coversFullChange(sels, beforeLine, afterLine) {
  let first = 0;
  while (first < afterLine.length && /\s/.test(afterLine[first])) first++;
  let lastEnd = afterLine.length;
  while (lastEnd > first && /\s/.test(afterLine[lastEnd - 1])) lastEnd--;
  if (sels.some(([a, b]) => a <= first && b >= lastEnd)) return true;
  const add = changedWordRanges(beforeLine, afterLine)?.add ?? [];
  return add.length > 0 && add.every(([a, b]) => sels.some(([s, e]) => s <= a && e >= b));
}

export function revertFrags(beforeLines, afterLines, hunks, frags) {
  if (!Array.isArray(hunks) || !frags.length) return { noDiff: true };
  const sorted = [...hunks].sort((a, b) => a.additionStart - b.additionStart);
  // agrupar frags new por línea after (merge de rangos) y old por línea before
  const newSels = new Map(); // afterLine → [[a,b),...]
  let oldSels = []; // {line, a, b} en orden
  for (const f of frags) {
    if (f.side === "old") oldSels.push(f);
    else {
      const arr = newSels.get(f.line) ?? [];
      arr.push([f.offA, f.offB]);
      newSels.set(f.line, arr);
    }
  }
  oldSels.sort((x, y) => x.line - y.line || x.offA - y.offA);
  let changed = false;

  // caminar los hunks como revertLines; restaurar frags old en su punto de
  // borrado y aplicar cirugía/restauración a las líneas after marcadas
  const out = [];
  let nIdx = 1;
  for (const h of sorted) {
    if (!Array.isArray(h.hunkContent) || h.hunkContent.length === 0) return null;
    if (h.additionStart - 1 > afterLines.length || h.additionStart < nIdx) return null;
    out.push(...afterLines.slice(nIdx - 1, h.additionStart - 1));
    let oldN = h.deletionStart;
    let newN = h.additionStart;
    const flushOld = (upToOld) => {
      while (oldSels.length && oldSels[0].line < upToOld) {
        const f = oldSels.shift();
        const text = beforeLines[f.line - 1]?.slice(f.offA, f.offB);
        if (text) { out.push(text); changed = true; }
      }
    };
    for (const c of h.hunkContent) {
      if (c.type === "context") {
        flushOld(oldN);
        for (let i = 0; i < c.lines; i++) { out.push(afterLines[newN - 1]); oldN++; newN++; }
        continue;
      }
      flushOld(oldN);
      const addStart = newN;
      const dels = [];
      for (let i = 0; i < c.deletions; i++) dels.push(oldN + i);
      oldN += c.deletions;
      // frags ROJAS del bloque: la línea vieja vuelve ENTERA y su pareja
      // verde se va (dropNew) — medio revertir deja la línea en el diff.
      const dropNew = new Set();
      for (let i = 0; i < dels.length; i++) {
        const L = dels[i];
        if (!oldSels.some((f) => f.line === L)) continue;
        oldSels = oldSels.filter((f) => f.line !== L);
        const beforeLine = beforeLines[L - 1];
        if (beforeLine === undefined) return null;
        if (i < c.additions) dropNew.add(addStart + i);
        if (beforeLine !== "") out.push(beforeLine);
        changed = true;
      }
      for (let i = 0; i < c.additions; i++) {
        const N = addStart + i;
        newN = N + 1;
        if (dropNew.has(N)) continue;
        if (!newSels.has(N)) { out.push(afterLines[N - 1]); continue; }
        const sels = mergeRanges(newSels.get(N));
        const beforeLine = dels[i] !== undefined ? beforeLines[dels[i] - 1] : null;
        const afterLine = afterLines[N - 1];
        if (beforeLine !== null && beforeLine !== afterLine && coversFullChange(sels, beforeLine, afterLine)) {
          changed = true;
          if (beforeLine !== "") out.push(beforeLine);
          continue;
        }
        const r = surgeryLine(afterLine, beforeLine, sels);
        if (r.noChange) { out.push(afterLine); continue; }
        changed = true;
        if (r.line !== "") out.push(r.line); // vacía → línea eliminada
      }
    }
    // ojo: NO hacer flushOld(Infinity) acá — se comía frags rojas de hunks
    // POSTERIORES (m6 en el hunk 2 lo insertaba el hunk 1 como slice). El
    // consumo in-block de arriba ya restaura las rojas de este hunk; lo que
    // quede sin consumir al final es inconsistencia → null.
    nIdx = newN;
  }
  if (oldSels.length) return null; // frag roja fuera de todo hunk: inconsistente
  if (!changed) return { noDiff: true };
  out.push(...afterLines.slice(nIdx - 1));
  return { lines: out };
}

export function mergeRanges(ranges) {
  const rs = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of rs) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

// 行内词级 diff：一对 old/new 行中真正变化（无 LCS 匹配）的词区间 [a,b)。
// 中文注释：给 UI 的"只改了几个词就用更醒目的红绿垫片方框标出"用
// （spec：整行全新时保持整行红绿底色——那种情况调用方根本不配对，不会走到这）。
// 匹配单位是 tokenizeLine 的 token（含空白 token；空白自身不参与标记）。
export function changedWordRanges(oldLine, newLine) {
  if (oldLine == null || newLine == null || oldLine === newLine) return null;
  const oT = tokenizeLine(oldLine);
  const nT = tokenizeLine(newLine);
  const n = oT.length;
  const m = nT.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = oT[i].text === nT[j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const matchO = new Int32Array(n).fill(-1);
  const matchN = new Int32Array(m).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oT[i].text === nT[j].text) { matchO[i] = j; matchN[j] = i; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  const del = [];
  const delWs = [];
  oT.forEach((t, k) => {
    if (matchO[k] !== -1) return;
    (/\S/.test(t.text) ? del : delWs).push([t.start, t.end]);
  });
  const add = [];
  const addWs = [];
  nT.forEach((t, k) => {
    if (matchN[k] !== -1) return;
    (/\S/.test(t.text) ? add : addWs).push([t.start, t.end]);
  });
  // ws: circulitos (spec Damian — cambio SOLO de espacios también se señala)
  if (!del.length && !add.length && !delWs.length && !addWs.length) return null;
  return { del: mergeRanges(del), add: mergeRanges(add), delWs: mergeRanges(delWs), addWs: mergeRanges(addWs) };
}

// Secuencia INTERCALADA de una pareja old/new — la base de la fila única con
// los removidos visibles: items {k:"same"|"del"|"add", text} en orden de
// lectura, con los runs contiguos fusionados y "del" ANTES de "add" cuando
// son vecinos (se lee "era ~~alpha~~, es beta"). changedWordRanges da los
// rangos de CADA lado por separado; esto dice dónde van unos respecto a
// otros (spec Damian 27/10: "quiero leer también lo que había antes").
export function mergeWords(oldLine, newLine) {
  if (oldLine == null || newLine == null) return null;
  const oT = tokenizeLine(oldLine);
  const nT = tokenizeLine(newLine);
  const n = oT.length;
  const m = nT.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = oT[i].text === nT[j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  const push = (k, text) => {
    const last = out[out.length - 1];
    if (last && last.k === k) last.text += text;
    else out.push({ k, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oT[i].text === nT[j].text) { push("same", oT[i].text); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push("del", oT[i].text); i++; }
    else { push("add", nT[j].text); j++; }
  }
  while (i < n) push("del", oT[i++].text);
  while (j < m) push("add", nT[j++].text);
  return out;
}

// ---- cortes de espacio merged↔new (fila verde con runs tachados) ----
// Puro y sin DOM para poder testear: `dels` es la lista de runs tachados con
// su rango merged [mStart,mEnd) (rowSpaces en main.js la arma del DOM real).

// offset merged → offset new (el idioma de la cirugía): restar los chars
// tachados que quedan antes de mOff
export function mergedOffToNew(dels, mOff) {
  let cut = 0;
  for (const d of dels) {
    if (mOff <= d.mStart) break;
    cut += Math.min(mOff, d.mEnd) - d.mStart;
  }
  return mOff - cut;
}

// new [a,b) → segmentos merged, PARTIDOS por los runs tachados intermedios
// (franjitas y cajas pintan el texto nuevo sin invadir los tachados)
export function newRangeToMergedSegs(dels, mergedLen, a, b) {
  if (!dels.length) return [[a, b]];
  const segs = [];
  let n = 0; // chars nuevos contados hasta el borde izquierdo del run actual
  let cur = 0; // posición merged del texto nuevo que sigue
  const piece = (txtLen) => {
    const lo = Math.max(0, a - n);
    const hi = Math.min(txtLen, b - n);
    if (hi > lo) segs.push([cur + lo, cur + hi]);
    n += txtLen;
  };
  for (const d of dels) {
    piece(d.mStart - cur);
    cur = d.mEnd;
  }
  piece(mergedLen - cur);
  return segs;
}
