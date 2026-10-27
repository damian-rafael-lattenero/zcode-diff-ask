// POPURRÍ RICO para prueba MANUAL del panel (pedido de Damian 27/10):
// resetea tests/diffs a HEAD y aplica edits mucho más diversos que el
// fixture del e2e — varias palabras AGREGADAS por línea, varias BORRADAS,
// líneas mixtas (add+del), cambios intra-palabra, palabras GEMELAS
// repetidas en la misma línea, bloques multilínea, en los 9 lenguajes.
// El e2e NO usa esto: usa apply-fixture-mods.mjs (determinista, sus tests
// dependen de ese contenido exacto). Re-ejecutable: siempre parte de HEAD.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// [find, replace] · ["+after", lines] inserta después de la línea que
// contiene el anchor · ["-line"] borra la línea exacta.
const MODS = {
  "tests/diffs/notes.md": [
    // dos palabras AGREGADAS en una línea
    ["highlight individual words inside", "highlight two individual words carefully inside"],
    // dos palabras BORRADAS ("about selection")
    ["The alpha section talks about selection.", "The alpha section talks."],
    // línea MIXTA: agrega y borra a la vez
    ["another word much further down", "another marker much further below"],
    // INTRA-palabra
    ["works for single words,", "works for singular wordings,"],
    // GEMELAS: "bravo" agregada DOS veces en la misma línea
    ["Persistence is the", "bravo Persistence bravo is the"],
    // línea BORRADA
    ["- second bullet with the word bravo inside"],
    // bloque AGREGADO de 3 líneas + vacía
    ["+Echo closes the notes with a small table:",
     ["", "Extra echo block added to test multi-line paints,", "with two full lines plus a trailing empty one.", ""]],
  ],
  "tests/diffs/server.ts": [
    // DOS palabras cambiadas en la MISMA línea
    ['const payload = { status: "running", uptime: 12345 };',
     'const payload = { status: "ready", uptime: 99999 };'],
    // palabra al PRINCIPIO + palabra al FINAL de la misma línea
    ['function register(method: string, path: string, handler: Route["handler"]): void {',
     'async function register(method: string, path: string, handler: Route["handler"]): Promise<void> {'],
    // bloque handler NUEVO de 4 líneas + vacía
    ['+register("GET", "/charlie", async () => {',
     ['register("GET", "/delta", async () => {', '  const extra = true;',
      '  return new Response("delta", { status: 200 });', '});', ""]],
    // línea BORRADA
    ["  const body = await req.json();"],
    // DOS palabras agregadas dentro de una línea
    ['return Response.json({ received: body }, { status: 201 });',
     'return Response.json({ received: body, ok: true, cached: false }, { status: 201 });'],
    // INTRA-palabra
    ["url.pathname", "url.pathName"],
  ],
  "tests/diffs/parser.py": [
    // DOS reemplazos en la misma línea (mixta add+del x2)
    ["Marker words: alpha (words), bravo (numbers), charlie (symbols).",
     "Marker words: alpha (tokens), bravo (digits), charlie (symbols)."],
    // función NUEVA de 3 líneas + vacía
    ["+def classify(token: Token) -> str:",
     ["", "def render(tokens):", '    return " ".join(t.text for t in tokens)', "    # extra line bravo"]],
    // línea BORRADA
    ['    if re.match(r"^\\w+$", token.text):'],
    // DOS tokens agregados en la firma
    ["def summarize(line: str) -> dict:", "def summarize(line: str, keep_all: bool = True) -> dict:"],
    // frase BORRADA del medio de una línea
    ["kinds = [classify(t) for t in tokens if t.text.strip()]",
     "kinds = [classify(t) for t in tokens]"],
  ],
  "tests/diffs/types.go": [
    // clásico: palabra cambiada en struct
    ["\tTitle string", "\tHeading string"],
    // campo NUEVO insertado
    ["+\tKind  string", ["\tExtra string"]],
    // método NUEVO de 3 líneas + vacía
    ["+func NewCollector(max int) *Collector {",
     ["// Render formats the record as one line.", "func (r Record) Render() string {",
      "\treturn r.Title", "}", ""]],
    // DOS palabras cambiadas en la misma línea de comentario
    ["// Record is the base unit stored by the fixture collector.",
     "// Record is the main unit kept by the fixture collector."],
    // línea BORRADA
    ["// Collector gathers records with a bounded buffer."],
    // INTRA-palabra
    ["records []Record", "records []RecordX"],
  ],
  "tests/diffs/styles.css": [
    // clásico: color
    ["--accent: #3fb950;", "--accent: #58a6ff;"],
    // DOS propiedades AGREGADAS dentro de :root
    ["+  --radius: 6px;", ["  --spacing: 4px,", "  --shadow: 0 1px 2px black;"]],
    // bloque NUEVO de 4 líneas + vacía
    ["+.button:hover {",
     ["", ".panel-footer {", "  border-top: 1px solid var(--danger);", "  padding: 8px 16px;", "}"]],
    // línea BORRADA dentro de una regla existente
    ["  border-color: var(--accent);"],
  ],
  "tests/diffs/config.json": [
    // DOS claves AGREGADAS
    ['"retry_count": 3\n  }', '"retry_count": 3,\n    "batch_size": 64,\n    "timeout_ms": 5000\n  }'],
    // valor cambiado
    ['"port": 8080', '"port": 9090'],
    // clave INTRA-palabra
    ['"max_requests": 1000', '"max_request_limit": 1000'],
    // línea BORRADA
    ['    "max_payload_kb": 512,'],
  ],
  "tests/diffs/data.yaml": [
    // clásico: item de lista cambiado
    ["    - alpha", "    - foxtrot"],
    // registro NUEVO de 4 líneas insertado
    ["+  - id: 3", ["  - id: 4", "    kind: note", '    title: "Fourth record"', "    tags: [charlie, delta]"]],
    // DOS campos cambiados (uno agrega, otro cambia texto)
    ['    title: "Second record"', '    title: "Second record (edited)"'],
    ["    tags: [bravo, echo]", "    tags: [bravo, echo, extra]"],
    // línea BORRADA
    ["    tags: [charlie, foxtrot]"],
  ],
  "tests/diffs/shell.sh": [
    // DOS palabras agregadas en un echo
    ['echo "alpha: listing fixture files"', 'echo "alpha: listing all fixture files carefully"'],
    // línea NUEVA en un case
    ["+      ls -1 tests/diffs", ["      wc -l tests/diffs/*"]],
    // línea BORRADA
    ["    bravo)"],
  ],
  "tests/diffs/Makefile": [
    // clásico
    ['@echo "nothing to clean"', '@echo "nothing to clean today"'],
    // línea NUEVA en el target
    ["+clean:", ['\t@echo "rich fixture variant"']],
  ],
};

let n = 0;
for (const [rel, ops] of Object.entries(MODS)) {
  let content = execFileSync("git", ["-C", REPO, "show", `HEAD:${rel}`], { encoding: "utf8" });
  for (const op of ops) {
    if (op.length === 1) {
      const line = op[0];
      if (!content.split("\n").includes(line))
        throw new Error(`${rel}: no existe la línea a borrar: ${JSON.stringify(line)}`);
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
console.log(`fixture RICH (popurrí): ${n} edits en ${Object.keys(MODS).length} archivos`);
