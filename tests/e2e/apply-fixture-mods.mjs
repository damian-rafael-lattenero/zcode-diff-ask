// Applies the playground modifications to the tests/diffs fixture: resets
// each file to its HEAD version and applies deterministic edits (adds,
// dels and changed words) so the panel has a rich diff and the e2e
// tests know exactly what to expect. Re-runnable: it always starts from
// HEAD, so the final state does not depend on earlier runs.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// [find, replace] · ["+after", lines] inserts after the line that
// contains the anchor · ["-line"] deletes the exact line.
const MODS = {
  "tests/diffs/notes.md": [
    // m1 — changed word (double-click + revert → back to "individual")
    ["highlight individual words inside", "highlight singular words inside"],
    // m2 — ADDED word "painted" (3-letter drag "pai" left→right)
    ["visible as amber stripes until the user clears them.",
     "visible as amber painted stripes until the user clears them."],
    // m3 — ADDED word "explicitly" (3-letter drag "cit" right→left)
    ["The bravo section talks about revert.",
     "The bravo section explicitly talks about revert."],
    // m4 — ADDED word "simple" (ONE-letter drag "m")
    ["Delta adds bullet lists:", "Delta adds simple bullet lists:"],
    // m5 — one changed word in a table row (triple-click = whole line)
    ["| alpha  | select   |", "| alpha  | chosen   |"],
    // m6 — DELETED line (red row: painting a word restores it)
    ["- second bullet with the word bravo inside"],
    // m7 — new lines at the end (addition side of the diff)
    ["+End of notes.",
     ["## Section Six: foxtrot", "",
      "Foxtrot appends fresh closing lines for the addition side of the diff.", ""]],
  ],
  "tests/diffs/server.ts": [
    ['const payload = { status: "running", uptime: 12345 };',
     'const payload = { status: "ready", uptime: 12345 };'],
    ["// Marker words: alpha (routes), bravo (middleware), charlie (errors)."],
    ['+register("GET", "/charlie", async () => {',
     ['register("GET", "/delta", async () => {',
      '  return new Response("delta", { status: 200 });', '});', ""]],
  ],
  "tests/diffs/config.json": [
    ['"retry_count": 3\n  }', '"retry_count": 3,\n    "batch_size": 64\n  }'],
    ['"port": 8080', '"port": 9090'],
  ],
  "tests/diffs/parser.py": [
    ["Marker words: alpha (words), bravo (numbers), charlie (symbols).",
     "Marker words: alpha (tokens), bravo (numbers), charlie (symbols)."],
    ["+def classify(token: Token) -> str:",
     ["", "def render(tokens):", '    return " ".join(t.text for t in tokens)']],
  ],
  "tests/diffs/types.go": [
    ["\tTitle string", "\tHeading string"],
    ["+func NewCollector(max int) *Collector {",
     ["// Render formats the record as one line.", "func (r Record) Render() string {",
      "\treturn r.Title", "}", ""]],
  ],
  "tests/diffs/styles.css": [
    ["--accent: #3fb950;", "--accent: #58a6ff;"],
    ["+.button:hover {",
     ["", ".panel-footer {", "  border-top: 1px solid var(--danger);", "  padding: 8px 16px;", "}"]],
  ],
  "tests/diffs/data.yaml": [
    ["  labels:\n    - alpha", "  labels:\n    - foxtrot"],
    ["+  - id: 3", ["  - id: 4", "    kind: note", '    title: "Fourth record"', "    tags: [charlie, delta]"]],
  ],
  "tests/diffs/shell.sh": [
    ['echo "alpha: listing fixture files"', 'echo "alpha: listing all fixture files"'],
  ],
  "tests/diffs/Makefile": [
    ['@echo "nothing to clean"', '@echo "nothing to clean today"'],
  ],
  "tests/diffs/runner.nu": [
    // nu1 — changed word in the echo (double-click + revert)
    ['echo $"alpha total: ($total)"', 'echo $"alpha grand total: ($total)"'],
    // nu2 — ADDED word in the where (3-letter drag)
    ["$rows | where kind == one", "$rows | where kind != one"],
  ],
};

let n = 0;
for (const [rel, ops] of Object.entries(MODS)) {
  let content = execFileSync("git", ["-C", REPO, "show", `HEAD:${rel}`], { encoding: "utf8" });
  for (const op of ops) {
    if (op.length === 1) {
      // ["exact line"] → delete
      const line = op[0];
      if (!content.split("\n").includes(line))
        throw new Error(`${rel}: line to delete does not exist: ${JSON.stringify(line)}`);
      content = content.split("\n").filter((l) => l !== line).join("\n");
    } else if (op[0].startsWith("+")) {
      // ["+anchor", [lines]] → insert after the line holding the anchor
      const anchor = op[0].slice(1);
      const i = content.split("\n").findIndex((l) => l.includes(anchor));
      if (i < 0) throw new Error(`${rel}: cannot find the anchor ${JSON.stringify(anchor)}`);
      const lines = content.split("\n");
      lines.splice(i + 1, 0, ...op[1]);
      content = lines.join("\n");
    } else {
      // [find, replace]
      if (!content.includes(op[0]))
        throw new Error(`${rel}: cannot find ${JSON.stringify(op[0])}`);
      content = content.replace(op[0], op[1]);
    }
    n++;
  }
  fs.writeFileSync(path.join(REPO, rel), content);
}
console.log(`fixture mods: ${n} edits in ${Object.keys(MODS).length} files`);
