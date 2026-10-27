// INTEGRACIÓN (capa media): la lib pura (unit) + el server real (writeFileGuarded)
// + git real, en un repo temporal. El e2e (tests/e2e) cubre lo mismo con el
// panel y el mouse de verdad; esto aísla el circuito write→disk→git→notify
// sin navegador. Si algo de acá falla, no hace falta abrir Chrome.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { revertFrags } from "../diff-ask/ui/src/lib.js";
import { writeFileGuarded } from "../diff-ask/server/server.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (repo, ...args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });

function mkRepo(content) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "da-int-"));
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "doc.md"), content);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  return repo;
}

// @@ -a,b +c,d @@ + cuerpo → hunks con la MISMA forma que el panel le pasa a
// revertFrags ({additionStart, deletionStart, hunkContent})
function hunksFromUnified(diffText) {
  const hunks = [];
  for (const line of diffText.split("\n")) {
    const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) { hunks.push({ deletionStart: +m[1], additionStart: +m[2], hunkContent: [] }); continue; }
    const h = hunks.at(-1);
    if (!h) continue;
    const last = h.hunkContent.at(-1);
    const push = (type, extra) => {
      if (last?.type === type) Object.assign(last, extra);
      else h.hunkContent.push({ type, ...extra });
    };
    if (line.startsWith(" ")) push("context", { lines: (last?.lines ?? 0) + 1 });
    else if (line.startsWith("-")) push("change", { deletions: (last?.deletions ?? 0) + 1, additions: last?.additions ?? 0 });
    else if (line.startsWith("+")) push("change", { deletions: last?.deletions ?? 0, additions: (last?.additions ?? 0) + 1 });
  }
  return hunks;
}

const BASE = [
  "# Title",
  "",
  "alpha beta gamma line",
  "context stays",
  "delta epsilon line",
  "",
].join("\n");
// cambios del "agente": palabra cambiada + palabra borrada + línea borrada
const CHANGED = [
  "# Title",
  "",
  "alpha delta2 gamma line",
  "context stays",
  "delta line",
  "",
].join("\n");

test("revert palabra cambiada: lib + writeFileGuarded + git diff cierran el circuito", async () => {
  const repo = mkRepo(BASE);
  const file = path.join(repo, "doc.md");
  fs.writeFileSync(file, CHANGED);
  const before = git(repo, "show", "HEAD:doc.md").split("\n");
  const after = CHANGED.split("\n");
  const hunks = hunksFromUnified(git(repo, "diff", "-U3", "--", "doc.md"));
  assert.ok(hunks.length > 0, "hay hunks");

  // revert 1: pinto "delta2" (verde, palabra cambiada) → línea 3 al original
  const off = CHANGED.split("\n")[2].indexOf("delta2");
  const res1 = revertFrags(before, after, hunks, [{ side: "new", line: 3, offA: off, offB: off + 6 }]);
  const w1 = await writeFileGuarded({ path: "doc.md", content: res1.lines.join("\n"), base: CHANGED, workspace: repo });
  assert.equal(w1.ok, true, "write 1 ok");
  // el diff YA no tiene la línea 3, pero la 4 sigue cambiada
  assert.ok(!git(repo, "diff", "-U0", "--", "doc.md").includes("gamma line"), "línea 3 fuera del diff");

  // revert 2 (secuencial, con el diff NUEVO como hace el panel): pinto
  // "epsilon" en la fila ROJA de la línea 4 → la pareja vuelve entera
  const after2 = fs.readFileSync(file, "utf8").split("\n");
  const hunks2 = hunksFromUnified(git(repo, "diff", "-U3", "--", "doc.md"));
  const oldOff = BASE.split("\n")[4].indexOf("epsilon");
  const res2 = revertFrags(before, after2, hunks2, [{ side: "old", line: 5, offA: oldOff, offB: oldOff + 7 }]);
  const w2 = await writeFileGuarded({ path: "doc.md", content: res2.lines.join("\n"), base: after2.join("\n"), workspace: repo });
  assert.equal(w2.ok, true, "write 2 ok");
  assert.equal(fs.readFileSync(file, "utf8"), BASE, "disco = original COMPLETO");
  assert.equal(git(repo, "diff", "--numstat"), "", "git diff vacío: los dos reverts fueron exitosos");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("conflicto: base vieja → shelve + disco intacto (gana el agente)", async () => {
  const repo = mkRepo(BASE);
  const file = path.join(repo, "doc.md");
  fs.writeFileSync(file, CHANGED);
  fs.writeFileSync(file, CHANGED + "\nextra del agente"); // el disco avanzó
  const w = await writeFileGuarded({ path: "doc.md", content: BASE, base: CHANGED, workspace: repo });
  assert.equal(w.conflict, true);
  assert.ok(w.shelved?.length >= 1, "quedó el shelve .mine");
  assert.ok(fs.existsSync(w.shelved[0]), "el archivo del shelve existe");
  assert.ok(fs.readFileSync(file, "utf8").includes("extra del agente"), "el disco no se pisó");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("watcher: un write externo → notificación resources/updated", async () => {
  const repo = mkRepo(BASE);
  const server = spawn("node", [path.join(REPO, "diff-ask/server/server.mjs")], {
    env: { ...process.env, ZCODE_WORKSPACE_ROOT: repo },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const send = (o) => server.stdin.write(JSON.stringify(o) + "\n");
  let buf = "";
  const notify = new Promise((resolve) => {
    server.stdout.on("data", (d) => {
      buf += d;
      for (const line of buf.split("\n")) {
        if (line.includes("notifications/resources/updated")) return resolve(true);
      }
    });
  });
  send({ jsonrpc: "2.0", id: 1, method: "resources/subscribe", params: { uri: "diff://workspace" } });
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(path.join(repo, "doc.md"), CHANGED); // cambio externo
  const got = await Promise.race([notify, new Promise((r) => setTimeout(() => r(false), 6000))]);
  server.kill("SIGKILL");
  assert.equal(got, true, "el watcher notificó el cambio de firma git");
  fs.rmSync(repo, { recursive: true, force: true });
});
