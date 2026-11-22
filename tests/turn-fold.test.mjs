// Unit laws of the turn fold (0.10.8) — tests/turn-fold.test.mjs.
// The fold is pure: pinned clocks, no fs. One law per test, named after the
// law it pins (see turn-fold.mjs's header).
import { test } from "node:test";
import assert from "node:assert/strict";
import { foldTurnEvent, reopenWindows, sliceByWindow, TURN_LANES_CAP } from "../diff-ask/server/turn-fold.mjs";

const T0 = Date.parse("2026-11-22T20:00:00.000Z");
const ev = (type, sid, atMs, extra = {}) => ({ type, sid, cwd: `/tmp/${sid}`, atMs, ...extra });

function foldAll(states, events, opts = {}) {
  let s = states ?? new Map();
  for (const e of events) s = foldTurnEvent(s, e, opts).states;
  return s;
}

test("L1 own-supersede: a prompt supersedes only ITS OWN lane's open window", () => {
  let { states } = foldTurnEvent(new Map(), ev("prompt", "sA", T0, { prompt: "a1" }));
  const r = foldTurnEvent(states, ev("prompt", "sA", T0 + 60_000, { prompt: "a2" }));
  assert.equal(r.superseded.prompt, "a1", "the previous sA window comes back as interrupted");
  assert.equal(r.states.get("sA").prompt, "a2");
  assert.equal(r.finalized, null);
});

test("L2 no cross-talk: an event for sid A never mutates or drops lane B", () => {
  let states = foldAll(null, [
    ev("prompt", "sA", T0, { prompt: "mine" }),
    ev("prompt", "sB", T0 + 30_000, { prompt: "foreign" }),
  ]);
  // The old single-slot bug: a foreign prompt (with the sticky sid at sA)
  // interrupted sA's window. Per-lane state makes that impossible.
  assert.equal(states.get("sA").prompt, "mine", "sA's lane untouched by sB's prompt");
  const r = foldTurnEvent(states, ev("stop", "sB", T0 + 60_000, { reply: "done" }));
  assert.equal(r.states.get("sA").prompt, "mine", "sA's lane untouched by sB's stop");
  assert.equal(r.finalized.sid, "sB", "sB's stop finalizes sB's window");
});

test("L3 zombie cap: a stale open window never persists as interrupted", () => {
  const states = foldAll(null, [ev("prompt", "sA", T0, { prompt: "old" })]);
  // next prompt arrives beyond the cap — measured against the EVENT clock,
  // not the wall clock, so the fold stays deterministic
  const r = foldTurnEvent(states, ev("prompt", "sA", T0 + 3 * 60 * 60 * 1000, { prompt: "new" }));
  assert.equal(r.superseded, null, "the zombie window is dropped silently");
  assert.equal(r.states.get("sA").prompt, "new");
});

test("stop without a live lane is a no-op (its window, if any, is history)", () => {
  const r = foldTurnEvent(new Map(), ev("stop", "sX", T0, { reply: "late" }));
  assert.equal(r.finalized, null);
  assert.equal(r.states.size, 0);
});

test("stop completes its lane with reply clamped and stopMs >= startMs+1", () => {
  let states = foldAll(null, [ev("prompt", "sA", T0, { prompt: "p" })]);
  const r = foldTurnEvent(states, ev("stop", "sA", T0, { reply: "r".repeat(9_000) }));
  assert.equal(r.finalized.stopMs, T0 + 1, "same-ms stop is bumped past the start");
  assert.equal(r.finalized.reply.length, 8_000, "REPLY_MAX clamp");
  assert.equal(r.states.size, 0);
});

test("L6 lanes cap: bounded map, evict-oldest", () => {
  const cap = 3;
  const events = [];
  for (let i = 0; i < 5; i++) events.push(ev("prompt", `s${i}`, T0 + i * 1_000, { prompt: `p${i}` }));
  const states = foldAll(null, events, { lanesCap: cap });
  assert.equal(states.size, cap, "the map stays bounded");
  assert.equal(states.has("s0"), false, "the OLDEST lane was evicted");
  assert.equal(states.has("s4"), true, "the newest lane survives");
  assert.ok(TURN_LANES_CAP > 0);
});

test("L4 boot heal: reopenWindows rebuilds the still-open lanes from the log", () => {
  const lines = [
    JSON.stringify({ type: "prompt", sid: "sA", cwd: "/tmp/sA", prompt: "kept-open", at: new Date(T0 + 60_000).toISOString() }),
    JSON.stringify({ type: "stop", sid: "sA", cwd: "/tmp/sA", reply: "closed", at: new Date(T0 + 90_000).toISOString() }),
    JSON.stringify({ type: "prompt", sid: "sB", cwd: "/tmp/sB", prompt: "still-open", at: new Date(Date.now() - 5 * 60_000).toISOString() }),
    "{ not json",
    "",
  ];
  const lanes = reopenWindows(lines);
  assert.equal(lanes.size, 1, "only the never-closed fresh window reopens");
  assert.equal(lanes.get("sB").prompt, "still-open");
});

test("L4 boot heal: zombies never reopen", () => {
  const lines = [
    JSON.stringify({ type: "prompt", sid: "sOld", cwd: "/tmp/x", prompt: "ancient", at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }),
  ];
  assert.equal(reopenWindows(lines).size, 0);
});

test("L4 boot heal: a re-prompt supersedes its own lane inside the scan (no double lane)", () => {
  const lines = [
    JSON.stringify({ type: "prompt", sid: "sA", cwd: "/tmp/sA", prompt: "first", at: new Date(Date.now() - 10 * 60_000).toISOString() }),
    JSON.stringify({ type: "prompt", sid: "sA", cwd: "/tmp/sA", prompt: "second", at: new Date(Date.now() - 5 * 60_000).toISOString() }),
  ];
  const lanes = reopenWindows(lines);
  assert.equal(lanes.size, 1);
  assert.equal(lanes.get("sA").prompt, "second", "the last prompt owns the lane");
});

test("L5 window slice: shared tap sets are sliced per lane by fromMs", () => {
  const touched = [
    ["/a", T0],
    ["/b", T0 + 10],
    ["/c", T0 + 20],
  ];
  assert.deepEqual(sliceByWindow(touched, T0 + 10), [["/b", T0 + 10], ["/c", T0 + 20]]);
  assert.deepEqual(sliceByWindow([], T0), []);
  assert.deepEqual(sliceByWindow([["/x", NaN]], T0), [], "NaN stamps never pass");
});
