// A fake of ZCode's own session store (0.10.10): the two tables and the
// artifact layout the plugin's edge reads. It lets tests and the e2e rig
// play the app — the sessions it knows and the workspace checkpoints it
// persists as its tools write files.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// What the Write tool stores: the whole new content, no patch.
export const written = (p, after, existedBefore = false) => ({
  path: p,
  existedBefore,
  beforeContent: existedBefore ? "THE OLD CONTENT\n" : null,
  afterContent: after,
  structuredPatch: [],
});

// The single hunk an Edit checkpoint carries: the common head and tail stay
// untouched, the middle is replaced.
function patchBetween(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail])
    tail++;
  return [
    {
      oldStart: head + 1,
      oldLines: a.length - head - tail,
      newStart: head + 1,
      newLines: b.length - head - tail,
      lines: [...a.slice(head, a.length - tail).map((l) => `-${l}`), ...b.slice(head, b.length - tail).map((l) => `+${l}`)],
    },
  ];
}

// What the Edit tool stores: the content before, the patch, no content after.
export const edited = (p, before, after) => ({
  path: p,
  existedBefore: true,
  beforeContent: before,
  afterContentLength: after.length,
  structuredPatch: patchBetween(before, after),
});

/** @param {string} dir a fresh tmp dir for this store */
export function createAppStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "app.sqlite");
  const artifacts = path.join(dir, "artifacts");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table session (id text primary key);
    create table session_entry (
      id text primary key, session_id text not null, type text not null,
      time_created integer not null, data text not null
    );
    create index session_entry_session_type_idx on session_entry(session_id, type);
  `);
  let calls = 0;
  return {
    // Env for a server that must read THIS store.
    env: { ZCODE_DIFF_ASK_APP_DB: dbPath, ZCODE_DIFF_ASK_APP_ARTIFACTS: artifacts },
    dbPath,
    artifacts,
    know(sid) {
      db.prepare("insert or ignore into session (id) values (?)").run(sid);
    },
    // One workspace checkpoint exactly as the app persists it: a
    // tool-result artifact plus its session_entry row.
    checkpoint(sid, atMs, toolName, files) {
      const id = `tool-result-${randomUUID()}`;
      const call = `call_${++calls}`;
      fs.mkdirSync(path.join(artifacts, sid), { recursive: true });
      fs.writeFileSync(
        path.join(artifacts, sid, `${call}-${id}.json`),
        JSON.stringify({
          version: 1,
          kind: "workspace_file_before_change",
          createdAt: new Date(atMs).toISOString(),
          toolCallId: call,
          toolName,
          files,
        }),
      );
      db.prepare("insert into session_entry (id, session_id, type, time_created, data) values (?, ?, ?, ?, ?)").run(
        `wc:${id}`,
        sid,
        "runtime/workspace_checkpoint",
        atMs,
        JSON.stringify({
          eventId: id,
          payload: { scope: "workspace", snapshotRef: `zcode-artifact://${sid}/${id}` },
          turnId: `turn_${sid}_${Math.floor(atMs / 60_000)}`,
        }),
      );
      return path.join(artifacts, sid, `${call}-${id}.json`);
    },
    close() {
      db.close();
    },
  };
}
