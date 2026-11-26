// lib — the panel's PURE layer: patch parsing, range labels, quotes, totals and
// message assembly. No DOM and no state — importable from node:test
// (tests/lib.test.mjs) and from the panel (main.js) alike.
//
// Convention: everything testable without a browser lives here; main.js is the
// presentation layer (DOM, events, MCP App) and is exercised with the visual
// harness (dist/dev.html).

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
  return { side, lines, label: `lines ${lines} · ${side === "deletions" ? "deletions" : "additions"}` };
}

// Selected row indices (the SET of checkboxes) → contiguous runs
// [{first,last}] sorted — the unit of painting and of quoting for multi-select.
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

// Multi-range line label: "3-5, 9, 12-14" (for the anchor and the title).
export function linesLabel(ranges) {
  return ranges
    .map((r) => (r.end > r.start ? `${r.start}-${r.end}` : `${r.start}`))
    .join(", ");
}

// Quote of several runs: each range on its side, concatenated in order
// (the ranges are disjoint and increasing — no duplicates, no round trips).
export function quoteForRanges(entry, ranges, side) {
  const out = [];
  for (const r of ranges) out.push(...quoteFor(entry, { ...r, side }, null));
  return out;
}

// Does a pending line-ask still belong to the CURRENT content? Rule from the
// owner (16/11/2026): once the agent EDITS the anchored line the ask must
// auto-drop — the quote no longer matches and the stale anchor paints the
// wrong row forever. CONTAINS, not equality: for painted fragments the quote
// is just the painted text (a word, a partial line), so the test is "the
// cited text still lives in that row". Whitespace-normalized. `lineText ==
// null` (row gone) is NOT a mismatch signal — the row can be missing because
// its hunk is collapsed, so callers keep those asks.
export function anchorStillValid(quoteLines, lineText) {
  if (!Array.isArray(quoteLines) || !quoteLines.length) return true; // nothing to compare: keep
  if (lineText == null) return false;
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const q = norm(quoteLines[0]);
  if (!q) return true; // empty quote: nothing to verify
  return norm(lineText).includes(q);
}

// Quote the lines of the range: from the full content when available (render
// from before/after — direct line numbers), otherwise from the patch.
// `verbatim` (text selection) always wins: it is what the user saw.
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

// Revert PUNCTUAL LINES to the original (not blocks): walks the exact
// alignment of each hunk (hunkContent: context/change with 1-based indices
// implied by additionStart/deletionStart). selOld = old line numbers to
// RESTORE (deleted lines that come back); selNew = new line numbers to
// REMOVE (added lines that go away). The rest stays as is.
// Returns null if a hunk has no hunkContent or is inconsistent (touches nothing).
export function revertLines(beforeLines, afterLines, hunks, selOld, selNew) {
  const sorted = [...hunks].sort((a, b) => a.additionStart - b.additionStart);
  const out = [];
  let nIdx = 1; // 1-based pointer over afterLines
  for (const h of sorted) {
    if (!Array.isArray(h.hunkContent) || h.hunkContent.length === 0) return null;
    if (h.additionStart - 1 > afterLines.length || h.additionStart < nIdx) return null; // overlapping
    out.push(...afterLines.slice(nIdx - 1, h.additionStart - 1)); // identical stretch
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
        // ATOMIC PAIRS (0.9.0, spec Damian): the checkbox of a MODIFIED line
        // reverts the PAIR — the selected green line restores its paired red
        // line (before, the line DISAPPEARED: the deleted one did not come
        // back alone — "I select a line and the revert does nothing"); the
        // selected red line takes its paired green line with it. Without a
        // pair (pure addition or deletion) the behavior is the usual one.
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
          if (restoreOld.has(dels[i])) out.push(beforeLines[dels[i] - 1]); // restore
          oldN++;
        }
        for (let i = 0; i < c.additions; i++) {
          if (!dropNew.has(adds[i])) out.push(afterLines[adds[i] - 1]); // keep
          newN++;
        }
      }
    }
    nIdx = newN;
  }
  out.push(...afterLines.slice(nIdx - 1));
  return out;
}

// Real diff totals for the header: +/- lines and files by status.
// The counts arrive as STRINGS (git numstat) and may be missing (binaries,
// truncated) — NaN does not add.
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

// Assemble the single "Send all" message: anchored blocks (line or file, with a
// quote) and free ones (plain text), with a header that counts them.
// scope (optional) states WHICH diff is being asked about — "unpushed",
// "commit a1b2c3d", "last turn 📸" — so the agent knows what to look at.
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
      ? `${anchored} anchored + ${libres} free`
      : `${n} anchored question${n === 1 ? "" : "s"}`;
  const scopeTxt = scope ? ` (${scope})` : "";
  return { n, label, text: `Diff Ask — ${label} on the diff${scopeTxt}:\n\n${blocks.join("\n\n")}` };
}

// ------------------------------------------- surgical revert (0.8.0)
// Fragments PAINTED with the mouse (exact chars, not whole lines).
// frags: [{side:"new"|"old", line, offA, offB}] — flat offsets [A,B) over
//   the line: side new = AFTER line number (green/context row, visible text);
//   side old = BEFORE line number (red row).
// Semantics (Damian; 0.9.0 — char surgery CANNOT resurrect what was deleted,
// so COMPLETE coverage of the change restores the line):
//   - new, PARTIAL paint: the chars the change ADDED inside the painted span
//     are removed; the ones that already existed stay. "Hello World"→"Hello
//     Cruel World": paint "el" → "Hello Cru World". Added spaces glued to the
//     deletion are eaten (no double space left).
//   - new, paint that covers the WHOLE line or ALL the added ranges
//     (= you painted the changed word(s)): the line goes back to the
//     ORIGINAL from before — including the words the change deleted.
//     Before this it left a hybrid ("alpha  gamma") that kept showing up in
//     the diff: the "bounce" of the line revert.
//   - old (red row) painted: the pair flips WHOLE — the original line is
//     restored and its green counterpart goes away (half a reverted line is
//     worse than a line that was never reverted). If the red one has no pair
//     (purely deleted line), it is restored as is.
//   - new, PURE ADDITION line (no paired before): surgical too — only the
//     painted chars are deleted and the line stays, even if the result is
//     broken syntax: it is Damian's brush (spec confirmed 27/10: "I pick 3
//     words from 3 rows → it rolls back the 3 lines, NOT the 3 words"). The
//     line is only removed if it ends up empty (0.9.1 removed it whole:
//     wrong).
//   - A line left empty after the surgery → removed whole.
// Returns {lines} | {noDiff:true} | null (inconsistent alignment).
export function tokenizeLine(s) {
  const out = [];
  const re = /\s+|\w+|[^\s\w]+/g;
  let m;
  while ((m = re.exec(s))) out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  return out;
}

function lcsMatch(aT, bT) {
  // token match of AFTER against BEFORE (classic LCS); returns, for each aT
  // index, the bT index it matches (or -1 = added)
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

// Apply the surgery to ONE after line with selections (list of MERGED [a,b)
// ranges). beforeLine null = pure addition. Returns {line} (even if identical)
// or {noChange:true} if the paint touched no added char.
function surgeryLine(afterLine, beforeLine, sels) {
  if (beforeLine === afterLine) return { noChange: true };
  const aT = tokenizeLine(afterLine);
  const bT = beforeLine != null ? tokenizeLine(beforeLine) : [];
  const match = lcsMatch(aT, bT);
  const added = aT.map((_, k) => match[k] === -1);
  // chars to delete: sel ∩ added tokens
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
  // ADDED spaces that after the deletions would sit ADJACENT to another
  // surviving space: they are eaten (without this, painting "Cruel" leaves
  // "Hello  World"). With "el" painted they are NOT adjacent ("Cru" in the
  // middle) and the space stays ("Hello Cru World").
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
  // added NON-blank token deleted WHOLE with surviving spaces on BOTH sides:
  // one of the two is eaten (matched, not added — the block above left them
  // alone). "alpha delta epsilon" with "delta" painted (partial change of a
  // line with more changes) → "alpha epsilon", no double space. If only ONE
  // side has a space, it stays (there is no double).
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

// Does the paint cover the WHOLE change of the line? Two equivalent ways of
// saying "I want this line as the original": the full line (trimmed) or all
// the ranges the change added (= the changed words painted).
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
  // group new frags by after line (merging ranges) and old frags by before line
  const newSels = new Map(); // afterLine → [[a,b),...]
  let oldSels = []; // {line, a, b} in order
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

  // walk the hunks like revertLines; restore old frags at their deletion point
  // and apply surgery/restoration to the marked after lines
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
      // RED frags of the block: the pair is restored SURGICALLY (spec Damian
      // 28/10: "painting a word of the red one restores ONLY that word in
      // place"); the red one WITHOUT a pair (whole line deleted) still comes
      // back as is — there is nowhere to splice it partially. If the
      // restoration changes nothing (half a word painted), the green one goes
      // its normal way, green paints included.
      const dropNew = new Set();
      const swapped = new Map(); // new line N → text restored surgically
      for (let i = 0; i < dels.length; i++) {
        const L = dels[i];
        const selsL = oldSels.filter((f) => f.line === L);
        if (!selsL.length) continue;
        oldSels = oldSels.filter((f) => f.line !== L);
        const beforeLine = beforeLines[L - 1];
        if (beforeLine === undefined) return null;
        if (i < c.additions) {
          const N = addStart + i;
          const r = restoreOldWords(afterLines[N - 1], beforeLine, selsL.map((f) => [f.offA, f.offB]));
          if (!r.noChange) {
            dropNew.add(N); // its green paints are ignored: the old side wins
            swapped.set(N, r.line);
            changed = true;
          }
          continue;
        }
        if (beforeLine !== "") out.push(beforeLine);
        changed = true;
      }
      for (let i = 0; i < c.additions; i++) {
        const N = addStart + i;
        newN = N + 1;
        if (dropNew.has(N)) {
          if (swapped.has(N)) out.push(swapped.get(N));
          continue;
        }
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
        if (r.line !== "") out.push(r.line); // empty → line removed
      }
    }
    // careful: do NOT call flushOld(Infinity) here — it ate red frags of LATER
    // hunks (m6 in hunk 2 was inserted by hunk 1 as a slice). The in-block
    // consumption above already restores this hunk's reds; whatever is left
    // unconsumed at the end is an inconsistency → null.
    nIdx = newN;
  }
  if (oldSels.length) return null; // red frag outside every hunk: inconsistent
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

// Inline word-level diff: in a pair of old/new lines, the word ranges that
// really changed (no LCS match) as [a,b). Used by the UI to box a change of a
// few words in a more visible red/green shim (spec: a whole new line keeps the
// full-row red/green background — that case never pairs, so it never gets
// here). The matching unit is the tokenizeLine token (whitespace tokens
// included; whitespace itself takes no mark).
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
  // ws: little circles (spec Damian — a change of SPACES only is marked too)
  if (!del.length && !add.length && !delWs.length && !addWs.length) return null;
  return { del: mergeRanges(del), add: mergeRanges(add), delWs: mergeRanges(delWs), addWs: mergeRanges(addWs) };
}

// INTERLEAVED sequence of an old/new pair — the base of the single row with
// the removals visible: items {k:"same"|"del"|"add", text} in reading order,
// with contiguous runs merged and "del" BEFORE "add" when they are neighbors
// (reads "was ~~alpha~~, is beta"). changedWordRanges gives the ranges of EACH
// side separately; this one says where they go relative to each other (spec
// Damian 27/10: "I also want to read what was there before").
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

// Split a range [a,b) of a line into per-WORD ranges (whitespace runs stay
// out). changedWordRanges returns MERGED ranges that cover "word1 word2
// word3" whole — one giant box; with one box per word and clean space
// between them, a many-word change is still readable (spec Damian 28/10:
// "many words → overlapping boxes and hard to read").
export function wordRanges(text, a, b) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) {
    const s = Math.max(a, m.index);
    const e = Math.min(b, m.index + m[0].length);
    if (e > s) out.push([s, e]);
  }
  return out;
}

// ---- merged↔new space cuts (green row with struck runs) ----
// Pure and DOM-free so it can be tested: `dels` is the list of struck runs with
// their merged range [mStart,mEnd) (rowSpaces in main.js builds it from the
// real DOM).

// merged offset → new offset (the language of the surgery): subtract the
// struck chars that come before mOff
export function mergedOffToNew(dels, mOff) {
  let cut = 0;
  for (const d of dels) {
    if (mOff <= d.mStart) break;
    cut += Math.min(mOff, d.mEnd) - d.mStart;
  }
  return mOff - cut;
}

// new [a,b) → merged segments, SPLIT by the struck runs in between
// (strips and boxes paint the new text without invading the struck runs)
export function newRangeToMergedSegs(dels, mergedLen, a, b) {
  if (!dels.length) return [[a, b]];
  const segs = [];
  let n = 0; // new chars counted up to the left border of the current run
  let cur = 0; // merged position of the new text that follows
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

// SURGICAL restoration of the old side (spec Damian 28/10: painting a word of
// the RED line restores ONLY that word in place). The pair is walked by
// REGIONS of change (contiguous unmatched tokens between LCS matches), at
// TOKEN level — mergeWords merges the runs and would lose the per-word
// granularity. Rule per region:
//   - ALL the old tokens of the region painted (whole) → the region goes back
//     to the old text: the new run goes away (full swap — painting the whole
//     red side reproduces the old atomic pair).
//   - SOME painted → the painted ones go back to their place and the new run
//     STAYS ("the quick brown fox"→"the slow fox" with "quick" painted →
//     "the quick slow fox": you accept the deletion little by little).
//   - PARTIAL paint of a token (half a word) restores nothing: the whole word
//     must be painted (the double-click paints it whole) — a predictable
//     mirror of the green-side surgery, which is char-based.
// The spaces: INTERIOR whitespace tokens between painted tokens are kept; the
// seams with the new text are filled with one space so words do not stick
// together.
// Returns {line} | {noChange:true}.
export function restoreOldWords(afterLine, beforeLine, sels) {
  if (beforeLine == null || beforeLine === afterLine) return { noChange: true };
  const oT = tokenizeLine(beforeLine);
  const nT = tokenizeLine(afterLine);
  const n = oT.length;
  const m = nT.length;
  if (!n && !m) return { noChange: true };
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = oT[i].text === nT[j].text ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  // items token by token (del carries its EXACT offsets in the old line)
  const items = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oT[i].text === nT[j].text) { items.push({ k: "same", text: oT[i].text }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { items.push({ k: "del", text: oT[i].text, a: oT[i].start, b: oT[i].end }); i++; }
    else { items.push({ k: "add", text: nT[j].text }); j++; }
  }
  while (i < n) { items.push({ k: "del", text: oT[i].text, a: oT[i].start, b: oT[i].end }); i++; }
  while (j < m) { items.push({ k: "add", text: nT[j].text }); j++; }
  const sel = mergeRanges(sels);
  const full = (a, b) => sel.some(([s, e]) => s <= a && b <= e);
  let out = "";
  let changed = false;
  let k = 0;
  while (k < items.length) {
    if (items[k].k === "same") { out += items[k].text; k++; continue; }
    // region of change: contiguous del/add items
    const dels = [];
    let addText = "";
    while (k < items.length && items[k].k !== "same") {
      if (items[k].k === "del") dels.push(items[k]);
      else addText += items[k].text;
      k++;
    }
    const inc = dels.map((d) => full(d.a, d.b));
    // full swap when EVERY CONTENT old word is painted: unpainted whitespace
    // tokens do not count (two double-clicks on quick and brown paint the
    // words, not the space in between — and the swap has to come out the same
    // as painting "quick brown" at once)
    const content = dels.filter((d) => !/^\s+$/.test(d.text));
    if (content.length && content.every((d) => full(d.a, d.b))) {
      out += dels.map((d) => d.text).join(""); // full swap
      changed = true;
    } else if (inc.some(Boolean)) {
      // partial: the painted ones + interior spaces; the new run stays
      let back = "";
      dels.forEach((d, x) => {
        if (inc[x]) back += d.text;
        else if (/^\s+$/.test(d.text) && inc.slice(0, x).some(Boolean) && inc.slice(x + 1).some(Boolean)) back += d.text;
      });
      if (back && !/^\s/.test(back) && out && !/\s$/.test(out)) back = " " + back;
      if (addText && !/^\s/.test(addText) && !/\s$/.test(back)) back += " ";
      out += back + addText;
      changed = true;
    } else out += addText;
  }
  return changed ? { line: out } : { noChange: true };
}
