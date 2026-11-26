// Tests for the 📁 chip's repo walker (list_git_projects, 0.9.18): a real
// tmp tree with nested repos, heavy skips and a depth cap.

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
  // first level: two repos and a container folder
  mkRepo(path.join(root, "alpha"));
  mkRepo(path.join(root, "beta"));
  fs.mkdirSync(path.join(root, "container"));
  // deeply nested (depth 2 and 3): visible with maxDepth 4
  mkRepo(path.join(root, "container", "deep"));
  mkRepo(path.join(root, "container", "deeper", "deepest"));
  // heavy ones: neither listed nor walked into
  mkRepo(path.join(root, "node_modules", "hidden-pkg"));
  mkRepo(path.join(root, ".secret"));
  // hidden worktree container: the ALLOWED exception (0.9.22) — .worktrees/<repo>-<slug>
  fs.mkdirSync(path.join(root, ".worktrees"));
  mkWorktree(path.join(root, ".worktrees", "gamma-wt"));
  // normal folder WITHOUT git (neither it nor anything below)
  fs.mkdirSync(path.join(root, "plain"));
  return root;
};

test("list_git_projects: lists the repos (nested included), ordered by depth", () => {
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

test("list_git_projects: maxDepth caps the walk depth", () => {
  const root = mkTree();
  const r = listGitProjects(root, 2); // up to children of children (depth 1)
  assert.deepEqual(r.repos.map((x) => x.path.slice(root.length + 1)), ["alpha", "beta", "container/deep", ".worktrees/gamma-wt"]);
});

test("list_git_projects: real skips — node_modules and hidden folders are neither listed NOR walked into", () => {
  const root = mkTree();
  const names = listGitProjects(root).repos.map((x) => x.name);
  assert.ok(!names.includes("hidden-pkg"), "the repo inside node_modules is not listed");
  assert.ok(!names.includes(".secret"), "hidden folders are not listed");
  assert.ok(names.includes("gamma-wt"), "the worktree inside the hidden .worktrees IS listed");
});

test("list_git_projects: repos inside the hidden .worktrees come out with worktree=container (the panel lifts them up)", () => {
  const root = mkTree();
  const r = listGitProjects(root);
  const flags = Object.fromEntries(r.repos.map((x) => [x.path.slice(root.length + 1), x.worktree ?? false]));
  assert.equal(flags[".worktrees/gamma-wt"], ".worktrees", "the worktree is flagged with the CONTAINER NAME");
  assert.equal(flags["alpha"], false, "normal repos are NOT flagged");
  assert.equal(flags["container/deep"], false, "the ones nested in visible folders are NOT flagged");
  // the flag comes from the ABSOLUTE path: it does not depend on the folder the picker stands in
  const r2 = listGitProjects(path.join(root, ".worktrees"));
  const names2 = r2.repos.map((x) => x.name);
  assert.ok(names2.includes("gamma-wt"), "standing INSIDE .worktrees the worktree is listed");
  assert.equal(r2.repos.find((x) => x.name === "gamma-wt")?.worktree, ".worktrees", "and it is still flagged even when the root IS the container");
});

test("list_git_projects: missing folder → friendly error; ~ expanded", () => {
  const r = listGitProjects(path.join(os.tmpdir(), "da-no-existe-XYZ"));
  assert.equal(r.error, "invalid_path");
  assert.ok(Array.isArray(r.repos) && r.repos.length === 0);
  // depth 1: only to verify ~ expansion without walking the whole home
  const home = listGitProjects("~", 1);
  assert.equal(home.ok, true); // home always exists; it may hold 0+ repos
});
