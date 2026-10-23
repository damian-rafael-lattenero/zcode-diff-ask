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

// Totales reales del diff para el header: líneas +/- y archivos por status.
// Los counts llegan como STRINGS (git numstat) y pueden faltar (binarios,
// truncados) — NaN no suma.
export function diffTotals(files) {
  const t = { added: 0, deleted: 0, newFiles: 0, delFiles: 0, renamed: 0 };
  for (const f of files) {
    const a = parseInt(f.added, 10);
    const d = parseInt(f.deleted, 10);
    if (!Number.isNaN(a)) t.added += a;
    if (!Number.isNaN(d)) t.deleted += d;
    const s = f.status ?? "M";
    if (s === "A" || s === "?") t.newFiles++;
    else if (s === "D") t.delFiles++;
    else if (s === "R" || s === "C") t.renamed++;
  }
  return t;
}

// Ensambla el mensaje único de "Enviar todo": bloques anclados (línea o
// archivo, con cita) y libres (texto plano), con el encabezado que cuenta.
export function buildAskMessage(asks) {
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
  return { n, label, text: `Diff Ask — ${label} al diff:\n\n${blocks.join("\n\n")}` };
}
