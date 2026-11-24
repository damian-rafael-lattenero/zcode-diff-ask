// Language badges (0.12.0): the PURE mapping behind the file-header chips.
// The badge must never be anonymous: known languages get their brand color +
// monogram, unknown extensions still show the extension, no extension shows
// FILE — and the recount aggregates the same function.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extOf, nameLangOf, styleForLang, langCounts } from "../diff-ask/ui/src/lang-icons.js";

test("extOf: last extension, dotfiles, no extension", () => {
  assert.equal(extOf("src/a.ts"), "ts");
  assert.equal(extOf("src/a.test.ts"), "ts");
  assert.equal(extOf("A/B/C.JSON"), "json");
  assert.equal(extOf("Makefile"), "");
  assert.equal(extOf("src/.env"), "env");
  assert.equal(extOf(".gitignore"), "gitignore");
  assert.equal(extOf(""), "");
  assert.equal(extOf(undefined), "");
});

test("nameLangOf: file names that carry their language", () => {
  assert.equal(nameLangOf("Dockerfile"), "dockerfile");
  assert.equal(nameLangOf("CMakeLists.txt"), "cmake");
  assert.equal(nameLangOf("package.json"), "json");
  assert.equal(nameLangOf(".env"), "dotenv");
  assert.equal(nameLangOf(".gitignore"), "text");
  assert.equal(nameLangOf("index.ts"), "");
});

test("styleForLang: brand monogram + color for the languages the owner named", () => {
  const ts = styleForLang("typescript", "ts");
  assert.deepEqual([ts.mono, ts.color, ts.label], ["TS", "#3178c6", "TypeScript"]);
  assert.deepEqual(styleForLang("nushell", "nu").mono, "NU");
  assert.deepEqual(styleForLang("haskell", "hs").mono, "HS");
  assert.deepEqual(styleForLang("kotlin", "kt").mono, "KT");
  assert.deepEqual(styleForLang("javascript", "js").mono, "JS");
  assert.deepEqual(styleForLang("markdown", "md").mono, "MD");
  assert.deepEqual(styleForLang("json", "json").mono, "{ }");
  assert.deepEqual(styleForLang("yaml", "yml").mono, "YML");
  assert.deepEqual(styleForLang("sql", "sql").mono, "SQL");
  // aliases share the family badge
  assert.deepEqual(styleForLang("zsh", "sh").mono, "SH");
  assert.deepEqual(styleForLang("shellscript", "sh").mono, "SH");
});

test("styleForLang: unknown languages still get a readable badge (extension, else FILE)", () => {
  const bf = styleForLang("brainfuck", "bf");
  assert.deepEqual([bf.mono, bf.label], ["BF", ".bf"]);
  assert.match(bf.color, /^#[0-9a-f]{6}$/i);
  const none = styleForLang("", "");
  assert.equal(none.mono, "FILE");
  const nullId = styleForLang(null, "xyz");
  assert.equal(nullId.mono, "XYZ");
});

test("langCounts: aggregates by badge, most common first, ties by monogram", () => {
  const counts = langCounts([
    { lang: "typescript", ext: "ts" },
    { lang: "typescript", ext: "tsx" },
    { lang: "markdown", ext: "md" },
    { lang: "json", ext: "json" },
    { lang: "typescript", ext: "ts" },
  ]);
  assert.deepEqual(counts.map((c) => [c.mono, c.n]), [["TS", 3], ["{ }", 1], ["MD", 1]]);
  assert.equal(counts[0].label, "TypeScript");
  assert.deepEqual(langCounts([]), []);
});
