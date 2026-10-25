// Tests del flujo COMPLETO de turnos: inbox de eventos (como lo escribe el
// hook user-scope del bot) → processInbox → fotos con blobs → lista/diff/
// delete/clear. El estado vive en un tmp (ZCODE_DIFF_ASK_STATE) para no tocar
// el ~/.zcode real. Import dinámico DESPUÉS de setear el env.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "da-state-"));
process.env.ZCODE_DIFF_ASK_STATE = STATE;

const server = await import("../diff-ask/server/server.mjs");
const { setActiveWorkspace, processInbox, listTurns, buildTurnDiff, deleteTurn, clearTurns } = server;

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-turns-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  return dir;
}
const INBOX = path.join(STATE, "turn-events.jsonl");
function sendEvent(ws, prompt, at) {
  fs.appendFileSync(INBOX, `${JSON.stringify({ workspace: ws, prompt, at, source: "test" })}\n`);
}

test("flujo inbox→turno: foto con blobs, diff entre turnos, en vivo, dedupe", async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "a.py"), "v1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  await setActiveWorkspace(dir);

  // prompt 1 (hora local estilo bot, sin zona)
  sendEvent(dir, "turno uno: editá a", "2026-10-24T10:00:01");
  await processInbox();
  assert.equal(listTurns({ workspace: dir }).count, 1);

  // el agente trabaja: edita a.py y crea b.py
  fs.writeFileSync(path.join(dir, "a.py"), "v1\nv2\n");
  fs.writeFileSync(path.join(dir, "b.py"), "nuevo\n");

  // prompt 2
  sendEvent(dir, "turno dos: seguí", "2026-10-24T10:05:00");
  await processInbox();
  assert.equal(listTurns({ workspace: dir }).count, 2);

  // dedupe: la MISMA línea reprocesada (evento sintético inmediato) no crea turno
  sendEvent(dir, "turno dos: seguí", "2026-10-24T10:05:01");
  await processInbox();
  assert.equal(listTurns({ workspace: dir }).count, 2);

  // turno 1 = foto1 vs foto2: a.py M + b.py A, con contenidos de blob
  const list = listTurns({ workspace: dir });
  const t1 = await buildTurnDiff(list.turns[1].id, { workspace: dir });
  assert.deepEqual(t1.files.map((f) => f.path).sort(), ["a.py", "b.py"]);
  assert.equal(t1.files.find((f) => f.path === "a.py").before, "v1\n");
  assert.equal(t1.files.find((f) => f.path === "a.py").after, "v1\nv2\n");
  assert.equal(t1.files.find((f) => f.path === "b.py").status, "A");
  assert.equal(t1.turn.prompt, "turno uno: editá a");

  // evento de OTRA carpeta: no toca este índice
  sendEvent("/no/existe", "otra carpeta", "2026-10-24T10:06:00");
  await processInbox();
  assert.equal(listTurns({ workspace: dir }).count, 2);

  // turno 2 (latest, VIVO): commitea el trabajo → el diff en vivo sólo ve lo
  // nuevo sin commitear
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "trabajo del turno 2");
  fs.writeFileSync(path.join(dir, "c.py"), "vivo\n");
  const t2 = await buildTurnDiff("latest", { workspace: dir });
  assert.deepEqual(t2.files.map((f) => f.path), ["c.py"]);
  assert.equal(t2.turn.isLatest, true);

  // borrar el turno 2: el 1 pasa a ser latest y diffea contra el worktree
  const id2 = listTurns({ workspace: dir }).turns[0].id;
  assert.equal(deleteTurn(id2, { workspace: dir }).ok, true);
  const t1live = await buildTurnDiff("latest", { workspace: dir });
  assert.equal(t1live.turn.prompt, "turno uno: editá a");
  assert.equal(t1live.turn.isLatest, true);

  clearTurns({ workspace: dir });
  assert.equal(listTurns({ workspace: dir }).count, 0);
});
