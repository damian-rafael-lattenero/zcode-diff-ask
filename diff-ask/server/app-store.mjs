// app-store.mjs — the EDGE that reads ZCode's own session store (0.10.10).
//
// Denotation: "the app's truth for one turn" — the workspace checkpoints the
// app persisted for a session inside the turn's prompt→stop window, turned
// into the same items its end-of-turn summary shows.
//
// Read-only and best-effort (degradation is an honest null, never an error):
// a missing database, a runtime without node:sqlite, a session the app does
// not know — each answers null and the caller keeps its own fallback. The
// store is the app's private shape: everything crossing this edge parses
// once in turn-files.mjs, and a shape the app moves degrades to null.
//
// Layout (the fork's NodeToolArtifactStore + sqlite session store):
//   ~/.zcode/cli/db/db.sqlite            session(id) · session_entry(session_id, type, time_created, data)
//   ~/.zcode/cli/artifacts/<sid>/<toolCallId>-tool-result-<uuid>.json   workspace_file_before_change
// Test seams: ZCODE_DIFF_ASK_APP_DB and ZCODE_DIFF_ASK_APP_ARTIFACTS.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aggregateTurnFiles, parseCheckpointArtifact, parseCheckpointEvent } from "./turn-files.mjs";

const CHECKPOINT_TYPE = "runtime/workspace_checkpoint";
const MEMO_MAX = 64; // turns whose artifacts stay parsed

const dbPath = () =>
  process.env.ZCODE_DIFF_ASK_APP_DB || path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const artifactsRoot = () =>
  process.env.ZCODE_DIFF_ASK_APP_ARTIFACTS || path.join(os.homedir(), ".zcode", "cli", "artifacts");
// The app's own folder name for a session.
const sanitizeSegment = (value) => value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";

let sqliteLoader = null;
// Resolved once per server life; null = this runtime cannot read the store.
const loadSqlite = () =>
  (sqliteLoader ??= import("node:sqlite")
    .then((m) => m.DatabaseSync)
    .catch(() => null));

const memo = new Map(); // key → TurnFileChange[]

// "zcode-artifact://<sid>/<artifactId>" → the one file of the session folder carrying that id.
function artifactName(names, snapshotRef) {
  let id;
  try {
    id = decodeURIComponent(new URL(snapshotRef).pathname.split("/").pop());
  } catch {
    return null;
  }
  return id ? names.find((name) => name.includes(id)) ?? null : null;
}

// Checkpoint rows of the window → parsed artifacts, in write order. A row
// whose artifact is gone or unreadable is skipped: the turn shows what the
// app still has.
function readCheckpoints(sid, rows) {
  const dir = path.join(artifactsRoot(), sanitizeSegment(sid));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const checkpoints = [];
  for (const row of rows) {
    const event = parseCheckpointEvent(row.data);
    if (event.tag !== "ok" || (event.value.scope !== "workspace" && event.value.scope !== "both")) continue;
    const name = artifactName(names, event.value.snapshotRef);
    if (!name) continue;
    const artifact = parseCheckpointArtifact(fs.readFileSync(path.join(dir, name), "utf8"));
    if (artifact.tag === "ok") checkpoints.push(artifact.value);
  }
  return checkpoints;
}

/**
 * The app's file changes of one turn window (prompt→stop of session `sid`),
 * or null when the app has no truth for it.
 * @param {{sid: string, fromMs: number, toMs: number}} window
 * @returns {Promise<import("./turn-files.mjs").TurnFileChange[] | null>}
 */
export async function appTurnFiles({ sid, fromMs, toMs }) {
  if (!sid) return null;
  const DatabaseSync = await loadSqlite();
  if (!DatabaseSync) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath(), { readOnly: true });
  } catch {
    return null;
  }
  try {
    if (!db.prepare("select 1 from session where id = ?").get(sid)) return null; // not an app session
    const rows = db
      .prepare(
        `select time_created, data from session_entry
         where session_id = ? and type = ? and time_created >= ? and time_created <= ?
         order by time_created`,
      )
      .all(sid, CHECKPOINT_TYPE, fromMs, toMs);
    // Rows come ordered from a fixed start, so their count and last stamp
    // identify the whole set: a closed window parses its artifacts once, a
    // live one only again once it has grown.
    const key = `${sid}\0${fromMs}\0${rows.length}\0${rows.at(-1)?.time_created ?? 0}`;
    if (!memo.has(key)) {
      memo.set(key, aggregateTurnFiles(readCheckpoints(sid, rows)));
      if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value);
    }
    return memo.get(key);
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
}
