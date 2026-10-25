// Tests de integración de los modos del server: unpushed, último turno 📸,
// lista/búsqueda de commits y diff por commit — contra repos git reales en
// tmp (mismo patrón que el harness visual: nada de mocks de git).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDiff, recordTurn, buildTurnDiff, listTurns, deleteTurn, clearTurns,
  listCommits, buildCommitDiff, parseNameStatusZ, parseLogLine, setActiveWorkspace,
} from "../diff-ask/server/server.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-modes-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  return dir;
}

function commitFile(dir, file, content, msg) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD").trim();
}

function fileOf(data, p) {
  return data.files.find((f) => f.path === p);
}

test("parseNameStatusZ: letras, score de renames y origen NUL", () => {
  const out = ["M", "a.py", "R100", "new.ts", "old.ts", "D", "x.py"].join("\0") + "\0";
  assert.deepEqual(parseNameStatusZ(out), [
    { status: "M", path: "a.py" },
    { status: "R", path: "new.ts", oldPath: "old.ts" },
    { status: "D", path: "x.py" },
  ]);
});

test("parseLogLine: campos separados por 0x1f", () => {
  const c = parseLogLine(["abc", "abc12", "súper título", "Damian", "2 hours ago"].join("\x1f"));
  assert.deepEqual(c, { hash: "abc", short: "abc12", subject: "súper título", author: "Damian", date: "2 hours ago" });
  assert.equal(parseLogLine(""), null);
});

test("unpushed: commits adelante + working + untracked, con ahead/behind", async () => {
  const dir = makeRepo();
  const base = commitFile(dir, "a.py", "v1\n", "base");
  // upstream simulado: remote-tracking ref + config completa de branch y
  // remote (rev-parse @{upstream} exige el refspec del remote, no alcanza
  // con update-ref + branch.*.merge).
  git(dir, "update-ref", `refs/remotes/origin/main`, base);
  git(dir, "config", "remote.origin.url", "/tmp/da-fake-remote");
  git(dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git(dir, "config", "branch.main.remote", "origin");
  git(dir, "config", "branch.main.merge", "refs/heads/main");

  commitFile(dir, "b.py", "nuevo en commit\n", "feat: b");
  fs.writeFileSync(path.join(dir, "a.py"), "v2\n"); // sin commitear
  fs.writeFileSync(path.join(dir, "c.py"), "untracked\n"); // sin trackear

  const d = await buildDiff({ mode: "unpushed", workspace: dir });
  assert.equal(d.error, undefined);
  assert.equal(d.upstream, "origin/main");
  assert.equal(d.ahead, 1);
  assert.equal(d.behind, 0);
  // a.py: committed nada, pero working cambió vs origin → M con before v1
  assert.equal(fileOf(d, "a.py").before, "v1\n");
  assert.equal(fileOf(d, "a.py").after, "v2\n");
  assert.equal(fileOf(d, "b.py").status, "A");
  assert.equal(fileOf(d, "b.py").before, "");
  assert.equal(fileOf(d, "c.py").status, "?");
  assert.equal(d.fileCount, 3);

  // El modo working sólo ve lo no commiteado (a.py + c.py), no el commit de b.
  const w = await buildDiff({ mode: "working", workspace: dir });
  assert.deepEqual(w.files.map((f) => f.path).sort(), ["a.py", "c.py"]);
});

test("unpushed sin upstream: error explícito con cómo salir", async () => {
  const dir = makeRepo();
  commitFile(dir, "a.py", "v1\n", "base");
  const d = await buildDiff({ mode: "unpushed", workspace: dir });
  assert.equal(d.error, "no_upstream");
  assert.match(d.message, /git push -u/);
});

test("turnos: cada prompt fotografía el estado; el diff N es foto N vs foto N+1", async () => {
  const dir = makeRepo();
  commitFile(dir, "a.py", "línea 1\n", "base a");

  // Turno 1: el agente edita a.py y crea b.py (sin commitear nada)
  await recordTurn("arreglá el bug de a", "2026-10-24T10:00:00.000Z", dir);
  fs.writeFileSync(path.join(dir, "a.py"), "línea 1\nlínea 2\n");
  fs.writeFileSync(path.join(dir, "b.py"), "nuevo\n");

  // Turno 2: el usuario pide otra cosa; el agente commitea TODO (efecto neto)
  await recordTurn("commiteá y seguí con c", "2026-10-24T10:05:00.000Z", dir);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "turno 2 commitea");
  fs.writeFileSync(path.join(dir, "c.py"), "tercer turno\n");

  const list = listTurns({ workspace: dir });
  assert.equal(list.count, 2);
  assert.equal(list.turns[0].prompt, "commiteá y seguí con c"); // newest first
  assert.equal(list.turns[0].isLatest, true);

  // Turno 1: a.py M (1 línea nueva) + b.py A — TODO sin commit en su momento
  const t1 = await buildTurnDiff(list.turns[1].id, { workspace: dir });
  assert.equal(t1.mode, "turn");
  assert.equal(t1.turn.prompt, "arreglá el bug de a");
  assert.deepEqual(t1.files.map((f) => f.path).sort(), ["a.py", "b.py"]);
  const a1 = t1.files.find((f) => f.path === "a.py");
  assert.equal(a1.before, "línea 1\n");
  assert.equal(a1.after, "línea 1\nlínea 2\n");
  assert.equal(a1.status, "M");
  assert.equal(t1.files.find((f) => f.path === "b.py").status, "A");

  // Turno 2 (latest, VIVO): el commit de a/b NO aparece (mismo contenido que
  // la foto 2) — sólo c.py nuevo sin commitear.
  const t2 = await buildTurnDiff("latest", { workspace: dir });
  assert.deepEqual(t2.files.map((f) => f.path), ["c.py"]);
  assert.equal(t2.turn.isLatest, true);

  // Los blobs persisten en el repo: el diff del turno 1 sobrevive sin estado
  // en memoria (recordTurn no guarda nada en el server).
  const t1b = await buildTurnDiff(list.turns[1].id, { workspace: dir });
  assert.equal(t1b.files.length, 2);
});

test("turnos: delete y clear; sin turnos → error amigable", async () => {
  const dir = makeRepo();
  commitFile(dir, "a.py", "v1\n", "base");
  const empty = await buildTurnDiff("latest", { workspace: dir });
  assert.equal(empty.error, "no_turns");

  await recordTurn("turno uno", "2026-10-24T11:00:00.000Z", dir);
  fs.writeFileSync(path.join(dir, "a.py"), "v2\n");
  await recordTurn("turno dos", "2026-10-24T11:05:00.000Z", dir);
  fs.writeFileSync(path.join(dir, "a.py"), "v3\n");
  assert.equal(listTurns({ workspace: dir }).count, 2);

  // borrar el turno 1: queda 1; el que queda pasa a ser latest (vivo)
  const id1 = listTurns({ workspace: dir }).turns[1].id;
  const del = deleteTurn(id1, { workspace: dir });
  assert.equal(del.ok, true);
  assert.equal(del.remaining, 1);
  assert.equal(listTurns({ workspace: dir }).turns[0].isLatest, true);
  assert.equal(deleteTurn("no-existe", { workspace: dir }).error, "unknown_turn");

  clearTurns({ workspace: dir });
  assert.equal(listTurns({ workspace: dir }).count, 0);
  assert.equal((await buildTurnDiff("latest", { workspace: dir })).error, "no_turns");
});

test("listCommits: página de 10 con hasMore, skip, hash y título", async () => {
  const dir = makeRepo();
  const first = commitFile(dir, "f.py", "1\n", "primero");
  for (let i = 2; i <= 12; i++) commitFile(dir, "f.py", `${i}\n`, `commit ${i}`);

  const page1 = await listCommits({ workspace: dir });
  assert.equal(page1.commits.length, 10);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.commits[0].subject, "commit 12");
  assert.equal(page1.commits[9].subject, "commit 3");

  const page2 = await listCommits({ skip: 10, workspace: dir });
  assert.equal(page2.commits.length, 2);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.commits[1].subject, "primero");

  const short = first.slice(0, 6);
  const byHash = await listCommits({ query: short, workspace: dir });
  assert.equal(byHash.exactMatch, true);
  assert.equal(byHash.commits[0].hash, first);

  const byTitle = await listCommits({ query: "commit 7", workspace: dir });
  assert.equal(byTitle.commits.length, 1);
  assert.equal(byTitle.commits[0].subject, "commit 7");
});

test("buildCommitDiff: statuses, before/after y commit raíz (árbol vacío)", async () => {
  const dir = makeRepo();
  commitFile(dir, "a.py", "v1\nlínea vieja\n", "raíz");
  const sha = commitFile(dir, "a.py", "v1\nlínea nueva\n", "segundo");
  fs.writeFileSync(path.join(dir, "b.py"), "agregado\n");
  git(dir, "add", "b.py");
  git(dir, "commit", "-q", "-m", "tercero"); // modifica a.py? no — sólo agrega b.py
  const shaTercero = git(dir, "rev-parse", "HEAD").trim();

  const d = await buildCommitDiff(sha.slice(0, 7), { workspace: dir });
  assert.equal(d.mode, "commit");
  assert.match(d.baseLabel, /^commit /);
  assert.equal(d.commit.isMerge, false);
  const a = fileOf(d, "a.py");
  assert.equal(a.status, "M");
  assert.equal(a.before, "v1\nlínea vieja\n");
  assert.equal(a.after, "v1\nlínea nueva\n");
  assert.equal(a.added, "1");
  assert.equal(a.deleted, "1");

  const t = await buildCommitDiff(shaTercero, { workspace: dir });
  assert.equal(fileOf(t, "b.py").status, "A");
  assert.equal(fileOf(t, "b.py").before, "");
  assert.equal(fileOf(t, "b.py").after, "agregado\n");

  // Commit raíz: diff contra el árbol vacío → todo "A".
  const root = await buildCommitDiff("HEAD~2", { workspace: dir });
  assert.equal(fileOf(root, "a.py").status, "A");
  assert.equal(fileOf(root, "a.py").before, "");

  const bad = await buildCommitDiff("noexiste", { workspace: dir });
  assert.equal(bad.error, "unknown_commit");
});

test("setActiveWorkspace: cambia el workspace por defecto del server y valida", async () => {
  const a = makeRepo();
  const b = makeRepo();
  commitFile(a, "a.py", "de A\n", "repo a");
  commitFile(b, "b.py", "de B\n", "repo b");

  // rutas inválidas primero
  assert.equal((await setActiveWorkspace("/no/existe")).error, "invalid_path");
  const archivo = path.join(b, "b.py");
  assert.equal((await setActiveWorkspace(archivo)).error, "invalid_path"); // archivo, no carpeta
  const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), "da-nogit-"));
  assert.equal((await setActiveWorkspace(noRepo)).error, "not_a_repo");

  // cambio válido: los builds SIN workspace explícito ahora diffean B —
  // edito DESPUÉS del switch para probar que lee el activo en vivo.
  const ok = await setActiveWorkspace(b);
  assert.equal(ok.ok, true);
  assert.equal(ok.workspace, b);
  fs.writeFileSync(path.join(b, "b.py"), "de B editado\n");
  const d = await buildDiff({ mode: "working" });
  assert.equal(d.workspace, b);
  assert.deepEqual(d.files.map((f) => f.path), ["b.py"]);

  // vuelvo a A para no contaminar otros tests (los demás pasan workspace
  // explícito, pero por higiene)
  await setActiveWorkspace(a);
});
