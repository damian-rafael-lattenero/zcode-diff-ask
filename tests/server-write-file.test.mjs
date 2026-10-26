// Tests del guardado del editor (write_file): happy path, conflicto AGENTE
// GANA (shelve con .patch), drop, archivo borrado y escape de rutas.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

const STATE = fs.mkdtempSync(path.join(os.tmpdir(), "da-wstate-"));
process.env.ZCODE_DIFF_ASK_STATE = STATE;

const { setActiveWorkspace, writeFileGuarded } = await import("../diff-ask/server/server.mjs");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}
// el panel manda el CONTENIDO base; el server hashea ambos lados (el hash
// del lado del panel demostró no ser confiable en el sandbox)

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "da-w-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  fs.writeFileSync(path.join(dir, "a.py"), "v1\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "b.ts"), "uno\ndos\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

test("write_file: guarda con base correcta y rechaza rutas que escapan", async () => {
  const dir = makeRepo();
  await setActiveWorkspace(dir);
  const cur = fs.readFileSync(path.join(dir, "a.py"), "utf8");
  const r = await writeFileGuarded({ path: "a.py", content: "v1\nmia\n", base: cur, workspace: dir });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "a.py"), "utf8"), "v1\nmia\n");

  // subcarpeta OK
  const b = fs.readFileSync(path.join(dir, "src", "b.ts"), "utf8");
  const r2 = await writeFileGuarded({ path: "src/b.ts", content: "uno\n", base: b, workspace: dir });
  assert.equal(r2.ok, true);

  // escape del workspace → invalid_path, sin tocar disco
  const esc = await writeFileGuarded({ path: "../fuera.txt", content: "x", base: "x", workspace: dir });
  assert.equal(esc.error, "invalid_path");
  assert.ok(!fs.existsSync(path.resolve(dir, "../fuera.txt")));
  const abs = await writeFileGuarded({ path: "/etc/passwd", content: "x", base: "x", workspace: dir });
  assert.equal(abs.error, "invalid_path");
});

test("write_file: conflicto GANA EL AGENTE — shelve con contenido + .patch", async () => {
  const dir = makeRepo();
  await setActiveWorkspace(dir);
  const base = fs.readFileSync(path.join(dir, "a.py"), "utf8");
  // el panel edita desde base... pero el agente pisa el disco antes del save
  fs.writeFileSync(path.join(dir, "a.py"), "v1\nCAMBIO DEL AGENTE\n");
  const r = await writeFileGuarded({ path: "a.py", content: "v1\nmi edición\n", base: base, workspace: dir });
  assert.equal(r.ok, undefined);
  assert.equal(r.conflict, true);
  // el disco conserva la versión del agente
  assert.equal(fs.readFileSync(path.join(dir, "a.py"), "utf8"), "v1\nCAMBIO DEL AGENTE\n");
  // y mi versión quedó shelfada con su patch
  assert.ok(r.shelved.length >= 1);
  const mine = fs.readFileSync(r.shelved[0], "utf8");
  assert.equal(mine, "v1\nmi edición\n");
  const patch = fs.readFileSync(r.shelved[1], "utf8");
  assert.match(patch, /--- a\/a\.py/);
  assert.match(patch, /\+mi edición/);
  assert.match(patch, /-CAMBIO DEL AGENTE/);
});

test("write_file: drop y archivo borrado", async () => {
  const dir = makeRepo();
  await setActiveWorkspace(dir);
  const base = fs.readFileSync(path.join(dir, "a.py"), "utf8");
  fs.writeFileSync(path.join(dir, "a.py"), "otra cosa\n");
  const drop = await writeFileGuarded({ path: "a.py", content: "mía", base: base, on_conflict: "drop", workspace: dir });
  assert.equal(drop.conflict, true);
  assert.equal(drop.dropped, true);
  assert.equal(drop.shelved, undefined);
  assert.equal(fs.readFileSync(path.join(dir, "a.py"), "utf8"), "otra cosa\n");

  // archivo borrado en disco mientras editaba
  fs.rmSync(path.join(dir, "a.py"));
  const gone = await writeFileGuarded({ path: "a.py", content: "x", base: base, workspace: dir });
  assert.equal(gone.conflict, true);
  assert.equal(gone.onConflict, "drop");
});
