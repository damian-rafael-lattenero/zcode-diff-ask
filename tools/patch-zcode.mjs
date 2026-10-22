#!/usr/bin/env node
// patch-zcode.mjs — enciende el "+" en el diff nativo (B) y redirige el botón
// "Changes" de Git tools al panel Diff Ask (A). Todo por anchors de texto con
// capturas de nombres minificados: si un anchor no matchea EXACTAMENTE una
// vez, aborta sin tocar nada de la app.
//
//   node tools/patch-zcode.mjs --dry-run   # extrae + parchea en /tmp y valida
//   node tools/patch-zcode.mjs             # aplica (backup + asar + plist + codesign)
//   node tools/patch-zcode.mjs --unpatch   # restaura el último backup
//
// Tras cada update de ZCode hay que re-ejecutarlo (el update pisa todo).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const APP = "/Applications/ZCode.app";
const ASAR = path.join(APP, "Contents/Resources/app.asar");
const PLIST = path.join(APP, "Contents/Info.plist");
const BACKUP_DIR = path.join(ROOT, "tools", "backup");

const argv = new Set(process.argv.slice(2));
const DRY = argv.has("--dry-run");
const UNPATCH = argv.has("--unpatch");

const log = (m) => console.log(m);
const die = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

// ------------------------------------------------------------------ unpatch

if (UNPATCH) {
  const b = fs.readdirSync(BACKUP_DIR).sort().at(-1);
  if (!b) die("no hay backup para restaurar");
  const dir = path.join(BACKUP_DIR, b);
  log(`restaurando backup ${b}…`);
  execFileSync("cp", [path.join(dir, "app.asar"), ASAR], { stdio: "inherit" });
  execFileSync("cp", [path.join(dir, "Info.plist"), PLIST], { stdio: "inherit" });
  const ent = path.join(dir, "entitlements.plist");
  const signArgs = fs.existsSync(ent)
    ? ["--force", "--deep", "--sign", "-", "--options", "runtime", "--entitlements", ent, APP]
    : ["--force", "--deep", "--sign", "-", APP];
  execFileSync("codesign", signArgs, { stdio: "inherit" });
  log("✓ restaurado y re-firmado. Reiniciá ZCode.");
  process.exit(0);
}

// ------------------------------------------------------------------ extract

const WORK = "/tmp/da-asar-work";
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
log(`extrayendo app.asar → ${WORK} (~341MB, unos segundos)…`);
execFileSync("npx", ["-y", "@electron/asar", "extract", ASAR, WORK], {
  stdio: "inherit",
  cwd: ROOT,
});

// Bundle principal del renderer: el .js más grande de out/renderer/assets.
const assetsDir = path.join(WORK, "out", "renderer", "assets");
const bundle = fs
  .readdirSync(assetsDir)
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ f, size: fs.statSync(path.join(assetsDir, f)).size }))
  .sort((a, b) => b.size - a.size)[0];
if (!bundle || bundle.size < 4_000_000) die("no encontré el bundle principal del renderer");
const BUNDLE_PATH = path.join(assetsDir, bundle.f);
let src = fs.readFileSync(BUNDLE_PATH, "utf8");
log(`bundle: ${bundle.f} (${(bundle.size / 1e6).toFixed(1)} MB)`);

// ------------------------------------------------------------------ patches

let applied = 0;
function patchOnce(name, regex, build) {
  const m = src.match(regex);
  if (!m) die(`anchor NO ENCONTRADO (aborto sin tocar la app): ${name}`);
  const count = src.split(m[0]).length - 1;
  if (count !== 1) die(`anchor ${name} matchea ${count} veces (esperaba 1) — aborto`);
  src = src.replace(m[0], build(...m));
  applied++;
  log(`✓ ${name}`);
}

// ---- resolvemos el nombre minificado de onSubmitCodeComment dentro de QOn
const qon = src.match(
  /codeComments:(\w+),enableCodeLineSelection:(\w+)=!1,enableCodeGutterUtility:(\w+)=!1,codeCommentLabels:(\w+),onSubmitCodeComment:(\w+),/,
);
if (!qon) die("anchor NO ENCONTRADO: destructure de QOn");
const SUBMIT = qon[5]; // onSubmitCodeComment prop en el scope de QOn
log(`  QOn: comments=${qon[1]} submit=${SUBMIT}`);

// ---- B1: rama patch de QOn — options con gutter + y composer
patchOnce(
  "B1 patch-branch options",
  /if\(e\.type===`patch`\)return\(0,\$\.jsx\)\(YOn,\{patch:e\.patch,codePreviewSettings:\w+,resolvedTheme:\w+,sourcePath:e\.path,sourceTitle:e\.title\}\);/,
  (whole) =>
    whole.replace(
      /sourceTitle:e\.title\}\);/,
      `sourceTitle:e.title,options:{enableGutterUtility:!0,onGutterUtilityClick:function(__r){window.__daComposer(__r,e.path,${SUBMIT},e.patch)}}});`,
    ),
);

// ---- B2: YOn acepta y forwadea options → $6 (DiffViewer/pierre)
const yon = src.match(
  /function YOn\(\{patch:(\w+),codePreviewSettings:(\w+),resolvedTheme:(\w+),sourcePath:(\w+),sourceTitle:(\w+)\}\)\{/,
);
if (!yon) die("anchor NO ENCONTRADO: firma de YOn");
const [YP, YC, YR] = [yon[1], yon[2], yon[3]];
patchOnce(
  "B2 YOn options forward",
  new RegExp(`function YOn\\(\\{patch:${YP},codePreviewSettings:${YC},resolvedTheme:${YR},sourcePath:\\w+,sourceTitle:\\w+\\}\\)\\{`),
  (whole) => whole.replace(/sourceTitle:\w+\}\)/, "sourceTitle:x0,options:x})"),
);
patchOnce(
  "B2b YOn → $6 options",
  new RegExp(
    `\\(0,\\$\\.jsx\\)\\(\\$6,\\{patch:${YP},diffClassName:\\x60block\\x60,fontSizePx:${YC}\\.fontSizePx,lightTheme:${YC}\\.lightTheme,darkTheme:${YC}\\.darkTheme,themeType:${YR}\\}\\)`,
  ),
  (whole) => whole.replace(new RegExp(`themeType:${YR}\\}`), `themeType:${YR},options:x}`),
);

// ---- B3: rama multi-file-diff — mismo options en $6 directo (cita del contenido nuevo)
patchOnce(
  "B3 multi-file-diff options",
  /if\(e\.type===`multi-file-diff`&&(\w+)\)return\(0,\$\.jsx\)\(\$6,\{oldFile:\1\.oldFile,newFile:\1\.newFile,diffClassName:`block`,fontSizePx:(\w+)\.fontSizePx,lightTheme:\2\.lightTheme,darkTheme:\2\.darkTheme,themeType:(\w+)\}\);/,
  (whole, AE, E, O) =>
    whole.replace(
      new RegExp(`themeType:${O}\\}\\);`),
      `themeType:${O},options:{enableGutterUtility:!0,onGutterUtilityClick:function(__r){window.__daComposer(__r,e.path??e.title,${SUBMIT},e.afterContent??\`\`)}}});`,
    ),
);

// ---- B4: composer overlay inyectado (vanilla, fuera de React)
// quoteLines soporta unified diff Y contenido plano (multi-file-diff pasa el
// contenido nuevo; las líneas sin prefijo se toman como contexto).
const COMPOSER = `
;(function(){
  if (window.__daComposer) return;
  window.__daLastPointer = {x: innerWidth - 380, y: 120};
  window.addEventListener('pointerdown', function(e){ window.__daLastPointer = {x: e.clientX, y: e.clientY}; }, true);
  function quoteLines(text, start, end, side) {
    var out = [], oldN = 0, newN = 0;
    var lines = String(text || '').split('\\n');
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      var m = l.match(/^@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/);
      if (m) { oldN = +m[1]; newN = +m[2]; continue; }
      if (l.indexOf('diff ') === 0 || l.indexOf('index ') === 0 || l.indexOf('--- ') === 0 || l.indexOf('+++ ') === 0 || l.indexOf('Binary files') === 0) continue;
      var c = l[0];
      if (c === '+') { if (side !== 'deletions' && newN >= start && newN <= end) out.push(l.slice(1)); newN++; }
      else if (c === '-') { if (side === 'deletions' && oldN >= start && oldN <= end) out.push(l.slice(1)); oldN++; }
      else {
        var ln = c === ' ' ? l.slice(1) : l;
        if ((side === 'deletions' ? oldN : newN) >= start && (side === 'deletions' ? oldN : newN) <= end) out.push(ln);
        oldN++; newN++;
      }
    }
    return out.join('\\n');
  }
  window.__daComposer = function(range, filePath, submit, text) {
    document.querySelectorAll('.da-composer').forEach(function(n){ n.remove(); });
    var p = window.__daLastPointer;
    var lines = range.start === range.end ? String(range.start) : range.start + '-' + range.end;
    var side = range.side || 'additions';
    var quote = quoteLines(text, range.start, range.end, side);
    var card = document.createElement('div');
    card.className = 'da-composer';
    card.style.cssText = 'position:fixed;z-index:2147483647;left:' + Math.max(8, Math.min(p.x + 12, innerWidth - 350)) + 'px;top:' + Math.max(8, Math.min(p.y - 20, innerHeight - 200)) + 'px;width:330px;background:var(--color-popover,#23262b);color:var(--color-foreground,#e6e8eb);border:1px solid var(--color-border,#3a3f47);border-radius:10px;padding:10px;box-shadow:0 12px 32px rgba(0,0,0,.45);font:12px/1.4 system-ui,sans-serif';
    card.innerHTML = '<div style="font:600 11px ui-monospace,Menlo,monospace;margin-bottom:6px;color:var(--color-accent,#6f8dff)"></div>' +
      '<textarea rows="3" style="width:100%;box-sizing:border-box;background:var(--color-input,#16181c);color:inherit;border:1px solid var(--color-border,#3a3f47);border-radius:6px;padding:6px;font:inherit;resize:vertical"></textarea>' +
      '<div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px">' +
      '<button data-a="c" style="font:inherit;padding:3px 12px;background:transparent;color:inherit;border:1px solid var(--color-border,#3a3f47);border-radius:6px;cursor:pointer">Cancelar</button>' +
      '<button data-a="s" style="font:inherit;padding:3px 12px;background:var(--color-accent,#4268d8);color:#fff;border:0;border-radius:6px;cursor:pointer">Preguntar</button></div>';
    card.firstChild.textContent = (filePath || '') + ':' + lines + (side === 'deletions' ? ' · deletions' : '') + ' — ⌘↵ envía';
    var ta = card.querySelector('textarea'); ta.focus();
    var close = function(){ card.remove(); };
    card.querySelector('[data-a=c]').onclick = close;
    card.querySelector('[data-a=s]').onclick = function(){
      var t = ta.value.trim(); if (!t) { ta.focus(); return; }
      submit({ range: { startLine: range.start, endLine: range.end }, selectedText: quote, comment: t });
      close();
    };
    ta.addEventListener('keydown', function(e){
      if (e.key === 'Escape') close();
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); card.querySelector('[data-a=s]').click(); }
    });
    document.body.appendChild(card);
  };
})();
`;
src += COMPOSER;
applied++;
log("✓ B4 composer overlay inyectado");

// ---- A1: hook de apertura de plugin-UI (nombre minificado → dinámico)
const hookMatch = src.match(/function (\w+)\(e\)\{let \w+=Ea\(\),\w+=Nl\(\)\?\.pluginUiBridgeService/);
if (!hookMatch) die("anchor NO ENCONTRADO: hook open-plugin-UI (A1)");
const HOOK = hookMatch[1];
log(`✓ A1 hook resuelto: ${HOOK}()`);

// pluginId de diff-ask desde el registry instalado
let PLUGIN_ID = "diff-ask";
try {
  const reg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".zcode/cli/plugins/installed_plugins.json"), "utf8"));
  const items = Array.isArray(reg) ? reg : Object.values(reg.plugins ?? reg);
  const da = items.find((p) => p?.id?.startsWith("diff-ask"));
  if (da) PLUGIN_ID = da.id;
} catch {}
log(`  pluginId: ${PLUGIN_ID}`);

// ---- A2: inyectar el hook en Q2t (padre de la tarjeta Git tools) y publicarlo
const q2t = src.match(
  /function \w+\(\{workspacePath:(\w+),workspaceIdentity:(\w+),gitSummary:\w+,gitDirtyFileCount:\w+=0,gitWorktreeReviewSourceId:/,
);
if (!q2t) die("anchor NO ENCONTRADO: firma de Q2t (A2)");
const q2tBlock = src.slice(q2t.index, q2t.index + 4000);
const sess = q2tBlock.match(/rootSessionId:(\w+),parentSessionId:(\w+)/);
if (!sess) die("anchor NO ENCONTRADO: sessionIds de Q2t (A2)");
const INJECT = `let __da=${HOOK}({workspacePath:${q2t[1]},workspaceIdentity:${q2t[2]}??void 0,sessionId:${sess[2]}??${sess[1]}??void 0}),__dao=window.__daOpen=__da.open;`;
patchOnce(
  "A2 hook en Q2t",
  /onOpenWorkflowRunDirectory:(\w+),className:(\w+)\}\)\{let (\w+)=zO\(\),/,
  (whole, R, Z, B) => `onOpenWorkflowRunDirectory:${R},className:${Z}}){${INJECT}let ${B}=zO(),`,
);

// ---- A3: onClick del botón Changes → Diff Ask (con fallback nativo)
patchOnce(
  "A3 Changes → Diff Ask",
  /onClick:\(\)=>\{(\w+)\?\.\((\w+)\?\?void 0\)\}(,children:\[\(0,\$\.jsx\)\(\w+,\{className:`size-4 shrink-0)/,
  (whole, I, N, rest) =>
    `onClick:()=>{if(window.__daOpen){window.__daOpen('${PLUGIN_ID}')}else{${I}?.(${N}??void 0)}}${rest}`,
);

// ------------------------------------------------------------- validate JS

// El bundle es ESM: validamos sintaxis sobre una copia .mjs
fs.writeFileSync(BUNDLE_PATH, src);
const tmpCheck = "/tmp/da-bundle-check.mjs";
fs.copyFileSync(BUNDLE_PATH, tmpCheck);
execFileSync("node", ["--check", tmpCheck]);
log(`✓ sintaxis OK (${applied} parches aplicados)`);

// ------------------------------------------------------------------ dry run

if (DRY) {
  log(`\nDRY-RUN OK — ${applied} parches + composer validados en ${BUNDLE_PATH}`);
  log("Nada de la app se tocó. El extraído queda en /tmp/da-asar-work para inspección.");
  process.exit(0);
}

// ------------------------------------------------------------ backup + apply

fs.mkdirSync(BACKUP_DIR, { recursive: true });
const version = (execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", PLIST], { encoding: "utf8" }) || "").trim();
const bdir = path.join(BACKUP_DIR, `${version}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(bdir, { recursive: true });
fs.copyFileSync(ASAR, path.join(bdir, "app.asar"));
fs.copyFileSync(PLIST, path.join(bdir, "Info.plist"));
// Entitlements actuales: la app corre con hardened runtime; re-firmar sin
// ellos rompería el JIT del renderer. Los guardamos y los re-usamos.
const entPath = path.join(bdir, "entitlements.plist");
execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", APP], {
  stdio: ["ignore", fs.openSync(entPath, "w"), "inherit"],
});
log(`✓ backup en ${bdir}`);

log("re-empaquetando app.asar…");
execFileSync("npx", ["-y", "@electron/asar", "pack", WORK, ASAR, "--unpack", "**/*.node", "--unpack-dir", "**/prebuilds"], {
  stdio: "inherit",
  cwd: ROOT,
});
// El ejecutable spawn-helper de node-pty pierde el bit +x al extraer/empaquetar.
const spawnHelper = path.join(APP, "Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
if (fs.existsSync(spawnHelper)) fs.chmodSync(spawnHelper, 0o755);

const hash = createHash("sha256").update(fs.readFileSync(ASAR)).digest("hex");
log(`nuevo hash asar: ${hash}`);
// macOS guarda el digest directo bajo ElectronAsarIntegrity → "Resources/app.asar"
// (la clave contiene puntos/barras → PlistBuddy, no plutil keypath).
const integKey = "/usr/libexec/PlistBuddy";
execFileSync(integKey, ["-c", `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`, PLIST], {
  stdio: "inherit",
});
log("✓ Info.plist ElectronAsarIntegrity actualizado");

log("re-firmando ad-hoc con entitlements originales (puede tardar)…");
execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--options", "runtime", "--entitlements", entPath, APP], {
  stdio: "inherit",
});
execFileSync("codesign", ["--verify", APP]);
log("✓ codesign verify OK");

log(`
LISTO. Cerrá y reabrí ZCode:
  • El botón "Changes" de Git tools abre Diff Ask (fallback: diff nativo si el plugin no está disponible).
  • El diff nativo (pestaña Review) tiene "+" por línea → composer → la pregunta entra al chat anclada a path:línea.
Para deshacer: node tools/patch-zcode.mjs --unpatch
Tras cada update de ZCode: re-ejecutar este script (avisa si algún anchor cambió).`);
