// lang-icons.js — the PURE mapping "file → language badge" (0.12.0).
//
// Denotation: a file's badge is its language's official mark (vendored SVG)
// and, for languages we have no mark for, a brand-colored monogram; anything
// unknown keeps its own extension — no file is ever anonymous.
//
// The language ID comes from the lib's own extension catalogue
// (getFiletypeFromFileName, hundreds of extensions) in the shell; this module
// is pure: `styleForLang(langId, ext)` answers { mono, color, label, svg }.
// Icons: a vendored subset (src/icons, devicon + simple-icons — see NOTICE)
// is generated into lang-svgs.generated.js by `npm run icons`; the panel
// inlines it, so the bundle stays a single self-contained HTML.

import { LANG_SVGS } from "./lang-svgs.generated.js";

/** Language id → vendored icon key. Languages without a mark fall back to
 *  the monogram; the id→key split keeps aliases (zsh/shellscript → bash). */
export const ICON_BY_LANG = {
  typescript: "typescript",
  tsx: "typescript",
  javascript: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json",
  yaml: "yaml",
  toml: "toml",
  markdown: "markdown",
  mdx: "markdown",
  python: "python",
  rust: "rust",
  go: "go",
  java: "java",
  kotlin: "kotlin",
  haskell: "haskell",
  nushell: "nushell",
  bash: "bash",
  zsh: "bash",
  shellscript: "bash",
  fish: "bash",
  powershell: "powershell",
  html: "html",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
  graphql: "graphql",
  svg: "svg",
  dockerfile: "dockerfile",
  cmake: "cmake",
  makefile: "makefile",
  c: "c",
  cpp: "cpp",
  csharp: "csharp",
  ruby: "ruby",
  php: "php",
  swift: "swift",
  dart: "dart",
  lua: "lua",
  r: "r",
  perl: "perl",
  elixir: "elixir",
  erlang: "erlang",
  clojure: "clojure",
  scala: "scala",
  zig: "zig",
  nim: "nim",
  terraform: "terraform",
  hcl: "terraform",
  prisma: "prisma",
  groovy: "gradle",
  gradle: "gradle",
  solidity: "solidity",
  fsharp: "fsharp",
  ocaml: "ocaml",
  sqlite: "sqlite",
  vim: "vim",
};

/** Brand color + monogram per language id (pierre/shiki ids and aliases). */
const LANGS = {
  typescript: { mono: "TS", color: "#3178c6" },
  tsx: { mono: "TS", color: "#3178c6" },
  javascript: { mono: "JS", color: "#e8b400" },
  jsx: { mono: "JS", color: "#e8b400" },
  json: { mono: "{ }", color: "#9a7b00" },
  jsonc: { mono: "{ }", color: "#9a7b00" },
  json5: { mono: "{ }", color: "#9a7b00" },
  yaml: { mono: "YML", color: "#cb171e" },
  toml: { mono: "TML", color: "#9c4221" },
  markdown: { mono: "MD", color: "#57606a" },
  mdx: { mono: "MDX", color: "#57606a" },
  python: { mono: "PY", color: "#3776ab" },
  rust: { mono: "RS", color: "#b7410e" },
  go: { mono: "GO", color: "#00add8" },
  java: { mono: "JV", color: "#b07219" },
  kotlin: { mono: "KT", color: "#7f52ff" },
  haskell: { mono: "HS", color: "#5d4f85" },
  nushell: { mono: "NU", color: "#4e9a06" },
  bash: { mono: "SH", color: "#4eaa25" },
  zsh: { mono: "SH", color: "#4eaa25" },
  shellscript: { mono: "SH", color: "#4eaa25" },
  fish: { mono: "SH", color: "#4eaa25" },
  powershell: { mono: "PS", color: "#012456" },
  batch: { mono: "BAT", color: "#4d4d4d" },
  cmd: { mono: "BAT", color: "#4d4d4d" },
  html: { mono: "<>", color: "#e34f26" },
  css: { mono: "CSS", color: "#1572b6" },
  scss: { mono: "CSS", color: "#cd6799" },
  sass: { mono: "CSS", color: "#cd6799" },
  less: { mono: "CSS", color: "#1d365d" },
  vue: { mono: "VUE", color: "#41b883" },
  svelte: { mono: "SV", color: "#ff3e00" },
  astro: { mono: "AS", color: "#bc52ee" },
  sql: { mono: "SQL", color: "#b37000" },
  graphql: { mono: "GQL", color: "#e10098" },
  xml: { mono: "<>", color: "#b5651d" },
  svg: { mono: "<>", color: "#b5651d" },
  csv: { mono: "CSV", color: "#217346" },
  diff: { mono: "±", color: "#6b7280" },
  dockerfile: { mono: "DK", color: "#2496ed" },
  makefile: { mono: "MK", color: "#6d8086" },
  cmake: { mono: "CM", color: "#064f8c" },
  ini: { mono: "INI", color: "#6b7280" },
  dotenv: { mono: "ENV", color: "#6b7280" },
  c: { mono: "C", color: "#555555" },
  cpp: { mono: "C++", color: "#00599c" },
  csharp: { mono: "C#", color: "#239120" },
  objectivec: { mono: "C", color: "#438eff" },
  ruby: { mono: "RB", color: "#cc342d" },
  php: { mono: "PHP", color: "#777bb4" },
  swift: { mono: "SW", color: "#f05138" },
  dart: { mono: "DA", color: "#0175c2" },
  lua: { mono: "LUA", color: "#4b4b80" },
  r: { mono: "R", color: "#276dc3" },
  perl: { mono: "PL", color: "#39457e" },
  elixir: { mono: "EX", color: "#4b275f" },
  erlang: { mono: "ER", color: "#a90533" },
  clojure: { mono: "CLJ", color: "#5881d8" },
  fsharp: { mono: "F#", color: "#378bba" },
  ocaml: { mono: "ML", color: "#ec6e19" },
  scala: { mono: "SC", color: "#c22d40" },
  zig: { mono: "ZIG", color: "#b7760b" },
  nim: { mono: "NIM", color: "#b58500" },
  terraform: { mono: "TF", color: "#7b42bc" },
  hcl: { mono: "TF", color: "#7b42bc" },
  prisma: { mono: "PRI", color: "#2d3748" },
  protobuf: { mono: "PB", color: "#4285f4" },
  groovy: { mono: "GR", color: "#4298b8" },
  gradle: { mono: "GR", color: "#02303a" },
  solidity: { mono: "SOL", color: "#4a4a4a" },
  powershell_es: { mono: "PS", color: "#012456" },
  text: { mono: "TXT", color: "#6b7280" },
  plaintext: { mono: "TXT", color: "#6b7280" },
  plain: { mono: "TXT", color: "#6b7280" },
  ansi: { mono: "TXT", color: "#6b7280" },
  sqlite: { mono: "DB", color: "#6b7280" },
  binary: { mono: "BIN", color: "#6b7280" },
};

const NEUTRAL = "#6b7280";
const GENERIC = { mono: "FILE", color: NEUTRAL };

/** Human label of a language id ("typescript" → "TypeScript"). */
const LABELS = {
  typescript: "TypeScript", tsx: "TypeScript (TSX)", javascript: "JavaScript", jsx: "JavaScript (JSX)",
  json: "JSON", jsonc: "JSON with comments", json5: "JSON5", yaml: "YAML", toml: "TOML",
  markdown: "Markdown", mdx: "MDX", python: "Python", rust: "Rust", go: "Go", java: "Java",
  kotlin: "Kotlin", haskell: "Haskell", nushell: "Nushell", bash: "Bash", zsh: "Zsh",
  shellscript: "Shell", fish: "Fish", powershell: "PowerShell", batch: "Batch", cmd: "Batch",
  html: "HTML", css: "CSS", scss: "SCSS", sass: "Sass", less: "Less", vue: "Vue",
  svelte: "Svelte", astro: "Astro", sql: "SQL", graphql: "GraphQL", xml: "XML", svg: "SVG",
  csv: "CSV", diff: "Diff", dockerfile: "Dockerfile", makefile: "Makefile", cmake: "CMake",
  ini: "INI", dotenv: "dotenv", c: "C", cpp: "C++", csharp: "C#", objectivec: "Objective-C",
  ruby: "Ruby", php: "PHP", swift: "Swift", dart: "Dart", lua: "Lua", r: "R", perl: "Perl",
  elixir: "Elixir", erlang: "Erlang", clojure: "Clojure", fsharp: "F#", ocaml: "OCaml",
  scala: "Scala", zig: "Zig", nim: "Nim", terraform: "Terraform", hcl: "HCL", prisma: "Prisma",
  protobuf: "Protocol Buffers", groovy: "Groovy", gradle: "Gradle", solidity: "Solidity",
  text: "Text", plaintext: "Text", plain: "Text", ansi: "Text",
};

/** Lowercase extension of a path ("a/b/File.TS" → "ts"), or "" for none. */
export function extOf(path) {
  const base = String(path ?? "").split("/").pop() ?? "";
  if (!base) return "";
  if (base.startsWith(".") && !base.slice(1).includes(".")) return base.slice(1).toLowerCase(); // .gitignore
  const i = base.lastIndexOf(".");
  return i <= 0 ? "" : base.slice(i + 1).toLowerCase();
}

/** File NAMES whose language is not in the extension ("Dockerfile"). */
const NAME_LANGS = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".gitignore": "text",
  ".gitattributes": "text",
  ".env": "dotenv",
  "cmakelists.txt": "cmake",
  "package.json": "json",
  "tsconfig.json": "jsonc",
};

/**
 * Badge for one file: the language id (from the lib's extension catalogue)
 * picks the vendored icon when we have one; otherwise the brand monogram
 * keeps it distinguishable — and an empty extension gets the generic FILE
 * mark.
 * @param {string} langId
 * @param {string} ext
 * @returns {{ mono: string, color: string, label: string, lang: string, svg?: string }}
 */
export function styleForLang(langId, ext = "") {
  const id = String(langId ?? "").toLowerCase();
  const style = LANGS[id];
  const e = String(ext ?? "").toLowerCase();
  const fallbackMono = e ? e.toUpperCase().slice(0, 3) : GENERIC.mono;
  const label = LABELS[id] ?? (e ? `.${e}` : "File");
  const iconKey = ICON_BY_LANG[id];
  const svg = iconKey ? LANG_SVGS[iconKey] : undefined;
  return {
    mono: style?.mono ?? fallbackMono,
    color: style?.color ?? NEUTRAL,
    label,
    lang: id || (e ? `ext:${e}` : "file"),
    ...(svg ? { svg } : {}),
  };
}

/** Language id for a file name (special names first), or "" when unknown. */
export function nameLangOf(base) {
  return NAME_LANGS[String(base ?? "").toLowerCase()] ?? "";
}

/**
 * Counts of a file list by badge: [{ lang, mono, color, label, n }], most
 * common first (ties by monogram) — the "recuento" line of a view header.
 * @param {{path:string, lang?:string, ext?:string}[]} files
 */
export function langCounts(files) {
  const by = new Map();
  for (const f of files ?? []) {
    const s = styleForLang(f.lang, f.ext);
    const cur = by.get(s.lang) ?? { ...s, n: 0 };
    cur.n++;
    by.set(s.lang, cur);
  }
  return [...by.values()].sort((a, b) => b.n - a.n || a.mono.localeCompare(b.mono));
}
