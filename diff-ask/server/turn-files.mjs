// turn-files.mjs — the PURE CORE of "what a turn changed" (0.10.10).
//
// Denotation: a turn's changes are what the session's own tool-writes did to
// files during that turn — ZCode's workspace checkpoints, aggregated
// first-before → final-after per file. That is exactly what the app's
// end-of-turn summary shows (ConversationFileSummaryPanel ←
// readConversationFileChangesFromEvents), so the plugin and the app cannot
// disagree about a turn's files: same inputs, same algorithm.
//
// The app's algorithm is ported from the fork's
// cold-file-change-summaries.ts, on top of faithful ports of the two jsdiff
// v9 primitives it leans on: applyPatch (fuzzFactor 0) and diffLines. An
// Edit checkpoint stores no after-content (measured 23/11: 342 of 342) —
// the final content only exists through that applier.
//
// Laws (tests/turn-files.test.mjs):
//   A1 APPLY-FAITHFUL — applyStructuredPatch is jsdiff's applyPatch at fuzz 0:
//                       exact fit or null, EOFNL bookkeeping, hunks applied in
//                       order with their offset carried forward.
//   A2 COUNTS-MINIMAL — lineDiffCounts gives the minimal line edit script's
//                       +/- counts (what diffLines yields); null once the
//                       step budget is spent.
//   F1 FIRST-BEFORE / F2 FINAL-AFTER — a file's before is its FIRST write's
//                       before, its after the LAST write's after.
//   F3 RECONSTRUCT — a write without after-content is rebuilt from its own
//                       structuredPatch.
//   F4 ORDER — items sort by path (localeCompare), like the app.
//   P1 PARSE, DON'T VALIDATE — store rows and artifacts parse ONCE here into
//                       tagged records; nothing downstream re-checks.
//
// Pure: no fs, no clock, no process.

/** @typedef {{oldStart:number, oldLines:number, newStart:number, newLines:number, lines:string[]}} Hunk */
/** @typedef {{path:string, existedBefore:boolean, before:string|null, after:string|undefined, patch:Hunk[]}} CheckpointFile */
/** @typedef {{toolName:string, files:CheckpointFile[]}} Checkpoint */
/** @typedef {{path:string, additions:number, deletions:number, writeCount:number, toolNames:string[], before:string|null, after:string|undefined}} TurnFileChange */

const OK = "ok";
const ERR = "err";

// ---- parse-don't-validate (P1): the app's store enters ONLY here ---------
// One session_entry row of type runtime/workspace_checkpoint.
export function parseCheckpointEvent(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { tag: ERR, reason: "json" };
  }
  const { scope, snapshotRef } = raw?.payload ?? {};
  if (typeof snapshotRef !== "string" || !snapshotRef) return { tag: ERR, reason: "snapshotRef" };
  return {
    tag: OK,
    value: {
      scope: typeof scope === "string" ? scope : "",
      snapshotRef,
      turnId: typeof raw.turnId === "string" ? raw.turnId : "",
    },
  };
}

function parseHunk(h) {
  if (typeof h?.oldStart !== "number" || !Array.isArray(h.lines) || !h.lines.every((l) => typeof l === "string"))
    return null;
  return { oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines };
}

// One workspace_file_before_change artifact. Lenient about unknown keys (the
// app's own zod schema is strict and would fail first if a shape moved).
export function parseCheckpointArtifact(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { tag: ERR, reason: "json" };
  }
  if (raw?.version !== 1 || raw.kind !== "workspace_file_before_change") return { tag: ERR, reason: "kind" };
  if (typeof raw.toolName !== "string" || !Array.isArray(raw.files) || raw.files.length === 0)
    return { tag: ERR, reason: "files" };
  const files = [];
  for (const f of raw.files) {
    const beforeOk = typeof f?.beforeContent === "string" || f?.beforeContent === null;
    const afterOk = f?.afterContent === undefined || typeof f.afterContent === "string";
    if (typeof f?.path !== "string" || !f.path || typeof f.existedBefore !== "boolean" || !beforeOk || !afterOk)
      return { tag: ERR, reason: "file" };
    if (!Array.isArray(f.structuredPatch)) return { tag: ERR, reason: "patch" };
    const patch = f.structuredPatch.map(parseHunk);
    if (patch.some((h) => h === null)) return { tag: ERR, reason: "hunk" };
    files.push({ path: f.path, existedBefore: f.existedBefore, before: f.beforeContent, after: f.afterContent, patch });
  }
  return { tag: OK, value: { toolName: raw.toolName, files } };
}

// ---- jsdiff v9 applyPatch, fuzz 0, line endings untouched (A1) -----------
function* byDistance(start, minLine, maxLine) {
  let wantForward = true;
  let backDone = false;
  let forwardDone = false;
  let offset = 1;
  for (;;) {
    if (wantForward && !forwardDone) {
      if (backDone) offset++;
      else wantForward = false;
      if (start + offset <= maxLine) {
        yield start + offset;
        continue;
      }
      forwardDone = true;
    }
    if (!backDone) {
      if (!forwardDone) wantForward = true;
      if (minLine <= start - offset) {
        yield start - offset++;
        continue;
      }
      backDone = true;
      continue;
    }
    return;
  }
}

/** `source` with `hunks` applied exactly, or null when any hunk does not fit. */
export function applyStructuredPatch(source, hunks) {
  const lines = source.split("\n");
  if (!hunks.length) return source;
  // End-of-file newline: only the FINAL hunk may carry the marker, right
  // after a '+' (the newline goes away) or a '-' (it appears).
  let prev = "";
  let removeEOFNL = false;
  let addEOFNL = false;
  for (const line of hunks[hunks.length - 1].lines) {
    if (line[0] === "\\") {
      if (prev[0] === "+") removeEOFNL = true;
      else if (prev[0] === "-") addEOFNL = true;
    }
    prev = line;
  }
  if (removeEOFNL) {
    if (addEOFNL) {
      if (lines[lines.length - 1] === "") return null;
    } else if (lines[lines.length - 1] === "") lines.pop();
    else return null;
  } else if (addEOFNL) {
    if (lines[lines.length - 1] !== "") lines.push("");
    else return null;
  }
  // One hunk at `toPos`: `lines[toPos]` must match its first line.
  const fit = (hunkLines, toPos) => {
    const patched = [];
    let trailingContext = 0;
    let nextContextMustMatch = false;
    let lastContextMatched = true;
    for (const hunkLine of hunkLines) {
      const op = hunkLine.length > 0 ? hunkLine[0] : " ";
      const content = hunkLine.length > 0 ? hunkLine.slice(1) : hunkLine;
      if (op === "-") {
        if (lines[toPos] !== content) return null;
        toPos++;
        trailingContext = 0;
      }
      if (op === "+") {
        if (!lastContextMatched) return null;
        patched.push(content);
        trailingContext = 0;
        nextContextMustMatch = true;
      }
      if (op === " ") {
        trailingContext++;
        patched.push(lines[toPos]);
        if (lines[toPos] !== content) return null;
        lastContextMatched = true;
        nextContextMustMatch = false;
        toPos++;
      }
    }
    patched.length -= trailingContext;
    return { patched, lastOld: toPos - trailingContext - 1 };
  };
  const result = [];
  let minLine = 0;
  let offsetCarry = 0;
  for (const hunk of hunks) {
    const start = hunk.oldStart + offsetCarry - 1;
    let toPos = start;
    let fitted = fit(hunk.lines, toPos);
    const candidates = byDistance(start, minLine, lines.length - hunk.oldLines);
    while (!fitted) {
      const next = candidates.next();
      if (next.done) return null;
      toPos = next.value;
      fitted = fit(hunk.lines, toPos);
    }
    for (let i = minLine; i < toPos; i++) result.push(lines[i]);
    result.push(...fitted.patched);
    minLine = fitted.lastOld + 1;
    offsetCarry = toPos + 1 - hunk.oldStart;
  }
  for (let i = minLine; i < lines.length; i++) result.push(lines[i]);
  return result.join("\n");
}

// ---- minimal line edit counts, what jsdiff's diffLines adds up to (A2) ---
const LINE_DIFF_BUDGET = 200_000_000; // inner steps (≈ half a second); past it the caller keeps the app's fallback sums

// Myers O(ND): the edit distance alone (no script needed for the counts).
function editDistance(n, m, lineA, lineB, budget) {
  if (n === 0 && m === 0) return 0;
  const max = n + m;
  const v = new Int32Array(2 * max + 1);
  let steps = 0;
  for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && lineA(x) === lineB(y)) {
        x++;
        y++;
        steps++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) return d;
    }
    steps += d;
    if (steps > budget) return -1;
  }
  return -1;
}

/**
 * {additions, deletions} of the minimal line diff, or null past the budget.
 * `budget` is injectable so the exhausted path is testable.
 */
export function lineDiffCounts(oldText, newText, budget = LINE_DIFF_BUDGET) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  // A common head and tail never take part in an edit script.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail])
    tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  const d = editDistance(n, m, (i) => a[head + i], (j) => b[head + j], budget);
  if (d < 0) return null;
  const common = (n + m - d) / 2;
  return { additions: m - common, deletions: n - common };
}

// ---- the app's aggregation, first-before → final-after (F1–F4) -----------
function countPatchLines(hunks) {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks)
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions++;
      if (line.startsWith("-")) deletions++;
    }
  return { additions, deletions };
}

// A write that stored no after-content is replayed from its own patch; a
// file that never existed and carries no patch has no after at all.
function resolveAfter(file) {
  if (!file.existedBefore && file.before === null && file.patch.length === 0) return undefined;
  const patched = applyStructuredPatch(file.before ?? "", file.patch);
  return typeof patched === "string" ? patched : undefined;
}

/**
 * Checkpoints of ONE turn, in write order → one item per path, sorted by
 * path like the app. `after` stays undefined when no write could supply or
 * rebuild it (the counts then fall back to the app's per-write sums).
 * @param {Checkpoint[]} checkpoints
 * @returns {TurnFileChange[]}
 */
export function aggregateTurnFiles(checkpoints) {
  const byPath = new Map();
  for (const { toolName, files } of checkpoints) {
    for (const file of files) {
      const base = countPatchLines(file.patch);
      const after = typeof file.after === "string" ? file.after : resolveAfter(file);
      const existing = byPath.get(file.path);
      if (!existing) {
        byPath.set(file.path, {
          after,
          before: file.before,
          fallbackAdditions: base.additions,
          fallbackDeletions: base.deletions,
          path: file.path,
          toolNames: new Set([toolName]),
          writeCount: 1,
        });
        continue;
      }
      existing.after = after ?? existing.after;
      existing.fallbackAdditions += base.additions;
      existing.fallbackDeletions += base.deletions;
      existing.toolNames.add(toolName);
      existing.writeCount += 1;
    }
  }
  return [...byPath.values()]
    .map((entry) => {
      const counts = entry.after === undefined ? null : lineDiffCounts(entry.before ?? "", entry.after);
      return {
        path: entry.path,
        additions: counts?.additions ?? entry.fallbackAdditions,
        deletions: counts?.deletions ?? entry.fallbackDeletions,
        writeCount: entry.writeCount,
        toolNames: [...entry.toolNames].sort(),
        before: entry.before,
        after: entry.after,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}
