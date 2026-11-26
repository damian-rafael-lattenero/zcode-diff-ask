// RICH MIX for MANUAL panel testing (Damian's request 27/10):
// resets tests/diffs to HEAD and applies edits far more diverse than the
// e2e fixture — several ADDED words per line, several DELETED ones,
// mixed lines (add+del), intra-word changes, TWIN words
// repeated on the same line, multi-line blocks, across the 9 languages.
// The e2e does NOT use this: it uses apply-fixture-mods.mjs (deterministic, its tests
// depend on that exact content). Re-runnable: it always starts from HEAD.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// [find, replace] · ["+after", lines] inserts after the line that
// contains the anchor · ["-line"] deletes the exact line.
const MODS = {
  "tests/diffs/notes.md": [
    // two ADDED words on one line
    ["highlight individual words inside", "highlight two individual words carefully inside"],
    // two DELETED words ("about selection")
    ["The alpha section talks about selection.", "The alpha section talks."],
    // MIXED line: adds and deletes at once
    ["another word much further down", "another marker much further below"],
    // INTRA-palabra
    ["works for single words,", "works for singular wordings,"],
    // TWINS: "bravo" added TWICE on the same line
    ["Persistence is the", "bravo Persistence bravo is the"],
    // DELETED line
    ["- second bullet with the word bravo inside"],
    // ADDED block of 3 lines + an empty one
    ["+Echo closes the notes with a small table:",
     ["", "Extra echo block added to test multi-line paints,", "with two full lines plus a trailing empty one.", ""]],
  ],
  "tests/diffs/server.ts": [
    // TWO changed words on the SAME line
    ['const payload = { status: "running", uptime: 12345 };',
     'const payload = { status: "ready", uptime: 99999 };'],
    // word at the START + word at the END of the same line
    ['function register(method: string, path: string, handler: Route["handler"]): void {',
     'async function register(method: string, path: string, handler: Route["handler"]): Promise<void> {'],
    // NEW handler block of 4 lines + an empty one
    ['+register("GET", "/charlie", async () => {',
     ['register("GET", "/delta", async () => {', '  const extra = true;',
      '  return new Response("delta", { status: 200 });', '});', ""]],
    // DELETED line
    ["  const body = await req.json();"],
    // TWO words added inside a line
    ['return Response.json({ received: body }, { status: 201 });',
     'return Response.json({ received: body, ok: true, cached: false }, { status: 201 });'],
    // INTRA-palabra
    ["url.pathname", "url.pathName"],
  ],
  "tests/diffs/parser.py": [
    // TWO replacements on the same line (mixed add+del x2)
    ["Marker words: alpha (words), bravo (numbers), charlie (symbols).",
     "Marker words: alpha (tokens), bravo (digits), charlie (symbols)."],
    // NEW function of 3 lines + an empty one
    ["+def classify(token: Token) -> str:",
     ["", "def render(tokens):", '    return " ".join(t.text for t in tokens)', "    # extra line bravo"]],
    // DELETED line
    ['    if re.match(r"^\\w+$", token.text):'],
    // DOS tokens agregados en la firma
    ["def summarize(line: str) -> dict:", "def summarize(line: str, keep_all: bool = True) -> dict:"],
    // DELETED phrase from the middle of a line
    ["kinds = [classify(t) for t in tokens if t.text.strip()]",
     "kinds = [classify(t) for t in tokens]"],
  ],
  "tests/diffs/types.go": [
    // classic: changed word in a struct
    ["\tTitle string", "\tHeading string"],
    // campo NUEVO insertado
    ["+\tKind  string", ["\tExtra string"]],
    // NEW method of 3 lines + an empty one
    ["+func NewCollector(max int) *Collector {",
     ["// Render formats the record as one line.", "func (r Record) Render() string {",
      "\treturn r.Title", "}", ""]],
    // TWO changed words on the same comment line
    ["// Record is the base unit stored by the fixture collector.",
     "// Record is the main unit kept by the fixture collector."],
    // DELETED line
    ["// Collector gathers records with a bounded buffer."],
    // INTRA-palabra
    ["records []Record", "records []RecordX"],
  ],
  "tests/diffs/styles.css": [
    // classic: color
    ["--accent: #3fb950;", "--accent: #58a6ff;"],
    // DOS propiedades AGREGADAS dentro de :root
    ["+  --radius: 6px;", ["  --spacing: 4px,", "  --shadow: 0 1px 2px black;"]],
    // NEW block of 4 lines + an empty one
    ["+.button:hover {",
     ["", ".panel-footer {", "  border-top: 1px solid var(--danger);", "  padding: 8px 16px;", "}"]],
    // DELETED line inside an existing rule
    ["  border-color: var(--accent);"],
  ],
  "tests/diffs/config.json": [
    // DOS claves AGREGADAS
    ['"retry_count": 3\n  }', '"retry_count": 3,\n    "batch_size": 64,\n    "timeout_ms": 5000\n  }'],
    // valor cambiado
    ['"port": 8080', '"port": 9090'],
    // clave INTRA-palabra
    ['"max_requests": 1000', '"max_request_limit": 1000'],
    // DELETED line
    ['    "max_payload_kb": 512,'],
  ],
  "tests/diffs/data.yaml": [
    // classic: changed list item
    ["    - alpha", "    - foxtrot"],
    // NEW record of 4 lines inserted
    ["+  - id: 3", ["  - id: 4", "    kind: note", '    title: "Fourth record"', "    tags: [charlie, delta]"]],
    // DOS campos cambiados (uno agrega, otro cambia texto)
    ['    title: "Second record"', '    title: "Second record (edited)"'],
    ["    tags: [bravo, echo]", "    tags: [bravo, echo, extra]"],
    // DELETED line
    ["    tags: [charlie, foxtrot]"],
  ],
  "tests/diffs/shell.sh": [
    // DOS palabras agregadas en un echo
    ['echo "alpha: listing fixture files"', 'echo "alpha: listing all fixture files carefully"'],
    // NEW line in a case
    ["+      ls -1 tests/diffs", ["      wc -l tests/diffs/*"]],
    // DELETED line
    ["    bravo)"],
  ],
  "tests/diffs/Makefile": [
    // classic
    ['@echo "nothing to clean"', '@echo "nothing to clean today"'],
    // NEW line in the target
    ["+clean:", ['\t@echo "rich fixture variant"']],
  ],
  "tests/diffs/runner.nu": [
    // nushell: palabra cambiada + una agregada + comentario nuevo
    ['echo $"alpha total: ($total)"', 'echo $"alpha grand total: ($total)"'],
    ["$rows | where kind == one", "$rows | where kind != one"],
    ["+def \"main alpha\" [] {", ["  # rich nushell variant"]],
  ],
};

let n = 0;
for (const [rel, ops] of Object.entries(MODS)) {
  let content = execFileSync("git", ["-C", REPO, "show", `HEAD:${rel}`], { encoding: "utf8" });
  for (const op of ops) {
    if (op.length === 1) {
      const line = op[0];
      if (!content.split("\n").includes(line))
        throw new Error(`${rel}: line to delete does not exist: ${JSON.stringify(line)}`);
      content = content.split("\n").filter((l) => l !== line).join("\n");
    } else if (op[0].startsWith("+")) {
      const anchor = op[0].slice(1);
      const i = content.split("\n").findIndex((l) => l.includes(anchor));
      if (i < 0) throw new Error(`${rel}: no encuentro el anchor ${JSON.stringify(anchor)}`);
      const lines = content.split("\n");
      lines.splice(i + 1, 0, ...op[1]);
      content = lines.join("\n");
    } else {
      if (!content.includes(op[0]))
        throw new Error(`${rel}: no encuentro ${JSON.stringify(op[0])}`);
      content = content.replace(op[0], op[1]);
    }
    n++;
  }
  fs.writeFileSync(path.join(REPO, rel), content);
}
console.log(`fixture RICH (mixed bag): ${n} edits in ${Object.keys(MODS).length} files`);
