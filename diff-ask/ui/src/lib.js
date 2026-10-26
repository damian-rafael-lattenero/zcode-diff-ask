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
        for (let i = 0; i < c.deletions; i++) {
          if (selOld.has(oldN)) out.push(beforeLines[oldN - 1]); // restaurar
          oldN++;
        }
        for (let i = 0; i < c.additions; i++) {
          if (!selNew.has(newN)) out.push(afterLines[newN - 1]); // conservar
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
