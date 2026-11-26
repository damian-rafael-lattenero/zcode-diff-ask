// INTEGRATION (middle layer): the pure lib (unit) + the real server (writeFileGuarded)
// + real git, in a temporary repo. The e2e (tests/e2e) covers the same with the
// real panel and mouse; this isolates the write→disk→git→notify circuit
// without a browser. If something here fails, there is no need to open Chrome.

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

// @@ -a,b +c,d @@ + body → hunks with the SAME shape the panel passes to
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
// "agent" changes: changed word + deleted word + deleted line
const CHANGED = [
  "# Title",
  "",
  "alpha delta2 gamma line",
  "context stays",
  "delta line",
  "",
].join("\n");

test("revert changed word: lib + writeFileGuarded + git diff close the circuit", async () => {
  const repo = mkRepo(BASE);
  const file = path.join(repo, "doc.md");
  fs.writeFileSync(file, CHANGED);
  const before = git(repo, "show", "HEAD:doc.md").split("\n");
  const after = CHANGED.split("\n");
  // --no-color: the app environment injects GIT_CONFIG color.ui=always, and
  // the ANSI escapes break hunksFromUnified's ^@@ regex.
  const diffText = git(repo, "diff", "--no-color", "-U3", "--", "doc.md");
  const hunks = hunksFromUnified(diffText);
  assert.ok(hunks.length > 0, "there are hunks");

  // revert 1: paint "delta2" (green, changed word) → line 3 back to the original
  const off = CHANGED.split("\n")[2].indexOf("delta2");
  const res1 = revertFrags(before, after, hunks, [{ side: "new", line: 3, offA: off, offB: off + 6 }]);
  const w1 = await writeFileGuarded({ path: "doc.md", content: res1.lines.join("\n"), base: CHANGED, workspace: repo });
  assert.equal(w1.ok, true, "write 1 ok");
  // the diff no longer has line 3, but line 4 is still changed
  assert.ok(!git(repo, "diff", "-U0", "--", "doc.md").includes("gamma line"), "line 3 out of the diff");

  // revert 2 (sequential, with the NEW diff as the panel does): paint
  // "epsilon" on the RED row of line 4 → the pair comes back whole
  const after2 = fs.readFileSync(file, "utf8").split("\n");
  const hunks2 = hunksFromUnified(git(repo, "diff", "--no-color", "-U3", "--", "doc.md"));
  const oldOff = BASE.split("\n")[4].indexOf("epsilon");
  const res2 = revertFrags(before, after2, hunks2, [{ side: "old", line: 5, offA: oldOff, offB: oldOff + 7 }]);
  const w2 = await writeFileGuarded({ path: "doc.md", content: res2.lines.join("\n"), base: after2.join("\n"), workspace: repo });
  assert.equal(w2.ok, true, "write 2 ok");
  assert.equal(fs.readFileSync(file, "utf8"), BASE, "disk = COMPLETE original");
  assert.equal(git(repo, "diff", "--numstat"), "", "empty git diff: both reverts succeeded");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("conflict: stale base → shelve + disk untouched (the agent wins)", async () => {
  const repo = mkRepo(BASE);
  const file = path.join(repo, "doc.md");
  fs.writeFileSync(file, CHANGED);
  fs.writeFileSync(file, CHANGED + "\nextra from the agent"); // the disk moved on
  const w = await writeFileGuarded({ path: "doc.md", content: BASE, base: CHANGED, workspace: repo });
  assert.equal(w.conflict, true);
  assert.ok(w.shelved?.length >= 1, "the .mine shelve was kept");
  assert.ok(fs.existsSync(w.shelved[0]), "the shelve file exists");
  assert.ok(fs.readFileSync(file, "utf8").includes("extra from the agent"), "the disk was not overwritten");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("watcher: an external write → resources/updated notification", async () => {
  const repo = mkRepo(BASE);
  const server = spawn("node", [path.join(REPO, "diff-ask/server/server.mjs")], {
    env: { ...process.env, ZCODE_WORKSPACE_ROOT: repo },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const send = (o) => server.stdin.write(JSON.stringify(o) + "\n");
  // ONE stdout listener feeds BOTH promises — the subscribe's ANSWER
  // ("id":1) arms the gate, the notification fires it. A fixed 300 ms boot
  // guess flakes on a cold runner (the subscribe would land after the
  // write and the notification would never come — measured on CI).
  let buf = "";
  let wakeAnswer = () => {};
  let wakeNotify = () => {};
  const answer = new Promise((r) => { wakeAnswer = r; });
  const notify = new Promise((r) => { wakeNotify = r; });
  server.stdout.on("data", (d) => {
    buf += d;
    for (const line of buf.split("\n")) {
      if (line.includes('"id":1')) wakeAnswer(true);
      if (line.includes("notifications/resources/updated")) wakeNotify(true);
    }
  });
  send({ jsonrpc: "2.0", id: 1, method: "resources/subscribe", params: { uri: "diff://workspace" } });
  await answer; // the watcher is ARMED — no boot guess
  fs.writeFileSync(path.join(repo, "doc.md"), CHANGED); // external change
  const got = await Promise.race([notify, new Promise((r) => setTimeout(() => r(false), 6000))]);
  server.kill("SIGKILL");
  assert.equal(got, true, "the watcher notified the git signature change");
  fs.rmSync(repo, { recursive: true, force: true });
});
