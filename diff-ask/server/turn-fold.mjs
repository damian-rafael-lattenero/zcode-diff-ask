// turn-fold — the PURE CORE of turn recording (0.10.8).
//
// Denotation: the inbox is an append-only log of prompt/stop events per
// session; the open state is the FOLD of that log into one window PER
// SESSION (a "lane"), keyed by sid. Recording is session-agnostic — the
// identity of whoever happens to be reading (the sticky request-context sid
// in the app, where one server serves every task and the panel) scopes
// READS, never the fold. The live 22/11 failure — both panel tabs empty,
// zero turns recorded for hours while several tasks were open — was exactly
// this coupling: the old single openTurn was gated by the LAST caller's
// sid, so every other session's prompt/stop was dropped as "foreign".
//
// Laws (each one a test in tests/turn-fold.test.mjs):
//   L1 OWN-SUPERSEDE — a prompt supersedes only ITS OWN lane's open window.
//   L2 NO CROSS-TALK — an event for sid A never mutates or drops lane B.
//   L3 ZOMBIE CAP    — an open window older than TURN_OPEN_MAX_MS never
//                      persists as interrupted (a dead server's stale
//                      window is dropped silently, not re-finalized).
//   L4 BOOT HEAL     — reopenWindows recovers still-fresh lanes from the
//                      log, healing the restart race (a stop that lands on
//                      the NEXT server life still completes its window).
//   L5 WINDOW SLICE  — shared tap sets are sliced per lane by startMs, so
//                      concurrent windows never leak writes to each other.
//   L6 LANES CAP     — the lane map is bounded; eviction takes the oldest.
//
// This module is pure: no fs, no clock, no process — time and limits arrive
// as options so tests can pin them. The server wires the effects (persist,
// notify, scan git) around it at the edges.

/** A prompt window opened at startMs, closed by a stop (or superseded). */
/** @typedef {{sid:string, cwd:string, prompt:string, startMs:number, reply?:string, stopMs?:number}} TurnWindow */
/** @typedef {{type:"prompt", sid:string, cwd:string, prompt:string, atMs:number}|{type:"stop", sid:string, cwd:string, reply:string, atMs:number}} TurnEvent */

// A window older than this without a stop is a ZOMBIE: a server that died
// mid-turn. Persisting it as "interrupted" spammed the store with October
// windows re-finalized in chains (measured 22/11) — it is dropped instead.
export const TURN_OPEN_MAX_MS = 2 * 60 * 60 * 1000;

// Paranoia clamps: prompts gigantes se recortan (kept identical to the old
// inline server constants — one source of truth now).
export const PROMPT_MAX = 100_000;
export const REPLY_MAX = 8_000;

// The lane map's ceiling — a machine with more CONCURRENT open windows than
// this is beyond any real workload; the bound keeps memory finite. Eviction
// takes the OLDEST lane (its stop becomes a no-op, documented behavior).
export const TURN_LANES_CAP = 32;

const promptMaxOf = (o) => Number(o?.promptMax) > 0 ? Number(o.promptMax) : PROMPT_MAX;
const replyMaxOf = (o) => Number(o?.replyMax) > 0 ? Number(o.replyMax) : REPLY_MAX;
const lanesCapOf = (o) => Number(o?.lanesCap) > 0 ? Number(o.lanesCap) : TURN_LANES_CAP;

/** Evict-oldest insertion into a bounded lane map (L6). Mutates `next`. */
function putLane(next, win, lanesCap) {
  while (next.size >= lanesCap) {
    let oldest = null;
    for (const t of next.values()) if (!oldest || t.startMs < oldest.startMs) oldest = t;
    next.delete(oldest.sid || "");
  }
  next.set(win.sid || "", win);
}

/**
 * Fold ONE event into the lane map (L1, L2, L3).
 *
 * @param {Map<string, TurnWindow>} states the open lanes (not mutated — a
 *   fresh Map is returned; the caller owns the swap).
 * @param {TurnEvent} ev a parsed inbox event.
 * @param {{promptMax?:number, replyMax?:number, lanesCap?:number}} [opts]
 * @returns {{states:Map<string,TurnWindow>, superseded:TurnWindow|null, finalized:TurnWindow|null}}
 *   superseded = the lane's previous window, interrupted by its own next
 *   prompt (null when fresh, absent, or a zombie); finalized = a window
 *   completed by its own stop. Effects (persist/notify) belong to the
 *   caller — the fold only computes them.
 */
export function foldTurnEvent(states, ev, opts = {}) {
  const next = new Map(states);
  const key = ev.sid || "";
  if (ev.type === "prompt") {
    const prev = next.get(key) ?? null;
    let superseded = null;
    // L3: only a FRESH window is a real interruption; a zombie dies silently.
    if (prev && ev.atMs - prev.startMs <= TURN_OPEN_MAX_MS) superseded = prev;
    putLane(next, { sid: ev.sid, cwd: ev.cwd, prompt: ev.prompt.slice(0, promptMaxOf(opts)), startMs: ev.atMs }, lanesCapOf(opts));
    return { states: next, superseded, finalized: null };
  }
  const prev = next.get(key) ?? null;
  if (!prev) return { states: next, superseded: null, finalized: null }; // stop without a live lane: nothing to bound here
  next.delete(key);
  return {
    states: next,
    superseded: null,
    finalized: { ...prev, reply: String(ev.reply ?? "").slice(0, replyMaxOf(opts)), stopMs: Math.max(ev.atMs, prev.startMs + 1) },
  };
}

/**
 * BOOT HEAL (L4): the windows still open at the END of the log, rebuilt by
 * folding it whole. A restart race (prompt on server life 1, stop on life
 * 2 — every deploy does this) used to lose the turn: the stop found no
 * lane. The recovered lanes carry prompt/cwd/startMs from the log; only the
 * pre-boot loose-write tap is unrecoverable (git scans at finalize still
 * recover commits and dirty state). Zombies and cap eviction apply.
 *
 * @param {string[]} lines raw inbox lines (unparsed ones are skipped).
 * @param {{promptMax?:number, lanesCap?:number}} [opts]
 * @returns {Map<string, TurnWindow>} the fresh open lanes.
 */
export function reopenWindows(lines, opts = {}) {
  let states = new Map();
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    const atMs = Date.parse(String(e.at ?? "").trim());
    if (!Number.isFinite(atMs)) continue;
    const sid = String(e.sid ?? e.session_id ?? "").trim();
    const cwd = String(e.cwd ?? e.workspace ?? "").trim();
    if (e.type === "stop") {
      states = foldTurnEvent(states, { type: "stop", sid, cwd, reply: String(e.reply ?? ""), atMs }, opts).states;
      continue;
    }
    const prompt = String(e.prompt ?? "");
    if (!prompt) continue;
    states = foldTurnEvent(states, { type: "prompt", sid, cwd, prompt, atMs }, opts).states;
  }
  // L3 once more at read time: a window whose start is beyond the cap is a
  // zombie even if the log never closed it.
  const cap = TURN_OPEN_MAX_MS;
  const now = Date.now();
  for (const [k, t] of states) if (now - t.startMs > cap) states.delete(k);
  return states;
}

/**
 * WINDOW SLICE (L5): the tap sets are shared machine-wide; a lane's turn
 * only takes the entries touched inside its window (fromMs = startMs minus
 * the same 2s guard band the git scans use).
 *
 * @param {Iterable<[string, number]>} entries path-or-root → last touch ms.
 * @param {number} fromMs inclusive lower bound.
 * @returns {[string, number][]}
 */
export function sliceByWindow(entries, fromMs) {
  const out = [];
  for (const [k, ts] of entries) if (Number.isFinite(ts) && ts >= fromMs) out.push([k, ts]);
  return out;
}
