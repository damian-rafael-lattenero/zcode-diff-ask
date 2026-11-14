// Tests del walker de repos del chip 📁 (list_git_projects, 0.9.18): árbol
// tmp real con repos anidados, skips de pesadas y tope de profundidad.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listGitProjects } from "../diff-ask/server/server.mjs";

const mkTree = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "da-list-"));
  const mkRepo = (p) => { fs.mkdirSync(path.join(p, ".git"), { recursive: true }); };
  // real worktree layout: .git is a FILE pointing back at the main repo
  const mkWorktree = (p) => {
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, ".git"), "gitdir: /elsewhere/main/.git/worktrees/x\n");
  };
  // primer nivel: dos repos y una carpeta contenedora
  mkRepo(path.join(root, "alpha"));
  mkRepo(path.join(root, "beta"));
  fs.mkdirSync(path.join(root, "container"));
  // anidado profundo (depth 2 y 3): visible con maxDepth 4
  mkRepo(path.join(root, "container", "deep"));
  mkRepo(path.join(root, "container", "deeper", "deepest"));
  // pesadas: ni listar ni bajar
  mkRepo(path.join(root, "node_modules", "hidden-pkg"));
  mkRepo(path.join(root, ".secret"));
  // hidden worktree container: the ALLOWED exception (0.9.22) — .worktrees/<repo>-<slug>
  fs.mkdirSync(path.join(root, ".worktrees"));
  mkWorktree(path.join(root, ".worktrees", "gamma-wt"));
  // carpeta normal SIN git (ni ella ni nada debajo)
  fs.mkdirSync(path.join(root, "plain"));
  return root;
};

test("list_git_projects: lista los repos (anidados incluidos), orden por profundidad", () => {
  const root = mkTree();
  const r = listGitProjects(root);
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.repos.map((x) => x.path.slice(root.length + 1)),
    // localeCompare (ICU) sorts leading dots after letters: container/deep first
    ["alpha", "beta", "container/deep", ".worktrees/gamma-wt", "container/deeper/deepest"],
  );
  assert.deepEqual(r.repos.map((x) => x.depth), [0, 0, 1, 1, 2]);
});

test("list_git_projects: maxDepth acota la profundidad del walk", () => {
  const root = mkTree();
  const r = listGitProjects(root, 2); // hasta hijos de hijos (depth 1)
  assert.deepEqual(r.repos.map((x) => x.path.slice(root.length + 1)), ["alpha", "beta", "container/deep", ".worktrees/gamma-wt"]);
});

test("list_git_projects: skips reales — node_modules y ocultas no aparecen NI se bajan", () => {
  const root = mkTree();
  const names = listGitProjects(root).repos.map((x) => x.name);
  assert.ok(!names.includes("hidden-pkg"), "el repo dentro de node_modules no se lista");
  assert.ok(!names.includes(".secret"), "las carpetas ocultas no se listan");
  assert.ok(names.includes("gamma-wt"), "el worktree dentro de la oculta .worktrees SÍ se lista");
});

test("list_git_projects: repos dentro de la oculta .worktrees salen flag worktree=container (el panel los sube)", () => {
  const root = mkTree();
  const r = listGitProjects(root);
  const flags = Object.fromEntries(r.repos.map((x) => [x.path.slice(root.length + 1), x.worktree ?? false]));
  assert.equal(flags[".worktrees/gamma-wt"], ".worktrees", "el worktree va flaggeado con el NOMBRE del contenedor");
  assert.equal(flags["alpha"], false, "los repos normales NO van flaggeados");
  assert.equal(flags["container/deep"], false, "los anidados en carpetas visibles NO van flaggeados");
  // el flag es de la ruta ABSOLUTA: no depende de la carpeta donde se para el picker
  const r2 = listGitProjects(path.join(root, ".worktrees"));
  const names2 = r2.repos.map((x) => x.name);
  assert.ok(names2.includes("gamma-wt"), "parado DENTRO de .worktrees el worktree se lista");
  assert.equal(r2.repos.find((x) => x.name === "gamma-wt")?.worktree, ".worktrees", "y sigue flaggeado aunque el root SEA el contenedor");
});

test("list_git_projects: carpeta inexistente → error amigable; ~ expandido", () => {
  const r = listGitProjects(path.join(os.tmpdir(), "da-no-existe-XYZ"));
  assert.equal(r.error, "invalid_path");
  assert.ok(Array.isArray(r.repos) && r.repos.length === 0);
  // depth 1: sólo para verificar la expansión de ~ sin caminar todo el home
  const home = listGitProjects("~", 1);
  assert.equal(home.ok, true); // el home siempre existe; puede tener 0+ repos
});
