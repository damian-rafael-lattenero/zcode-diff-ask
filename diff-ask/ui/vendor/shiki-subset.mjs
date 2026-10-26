// Backend REAL de highlighting con SUBCONJUNTO de lenguajes (0.7.0).
//
// El problema original: @pierre/diffs arrastra shiki con el catálogo
// COMPLETO de lenguajes + el motor oniguruma en WASM (~14 MB) y el host
// limita el panel a 4 MiB — de ahí el stub plano de 0.1.x.
// La combinación que lo hace posible:
//   · shiki/engine/javascript — motor de regex 100% JS, CERO wasm
//   · 11 gramáticas (json/yaml/python/ts/js/md/html/css/bash/kotlin/haskell)
//   · createCssVariablesTheme — los tokens toman color de las VARIABLES CSS
//     del tema del panel: light/dark sale gratis
// Los lenguajes fuera del subconjunto renderizan plano (el fallback de
// siempre). Los imports son por RUTA RELATIVA a node_modules: el build
// stubbea los bare specifiers de shiki (el catálogo dinámico de pierre
// sigue apuntando a un stub vacío) y así esbuild sólo empaqueta esto.

import { createHighlighterCore, createCssVariablesTheme } from "../../../node_modules/shiki/dist/core.mjs";
import { createJavaScriptRegexEngine } from "../../../node_modules/shiki/dist/engine-javascript.mjs";
import json from "../../../node_modules/shiki/dist/langs/json.mjs";
import yaml from "../../../node_modules/shiki/dist/langs/yaml.mjs";
import python from "../../../node_modules/shiki/dist/langs/python.mjs";
import typescript from "../../../node_modules/shiki/dist/langs/typescript.mjs";
import javascript from "../../../node_modules/shiki/dist/langs/javascript.mjs";
import markdown from "../../../node_modules/shiki/dist/langs/markdown.mjs";
import html from "../../../node_modules/shiki/dist/langs/html.mjs";
import css from "../../../node_modules/shiki/dist/langs/css.mjs";
import bash from "../../../node_modules/shiki/dist/langs/bash.mjs";
import kotlin from "../../../node_modules/shiki/dist/langs/kotlin.mjs";
import haskell from "../../../node_modules/shiki/dist/langs/haskell.mjs";

import { DiffsHighlighter } from "../../../node_modules/@pierre/diffs/dist/highlighter/DiffsHighlighter.js";
import { createDiffsThemeResolver } from "../../../node_modules/@pierre/diffs/dist/highlighter/themes/themeResolver.js";
import { ShikiEditorTokenizer } from "../../../node_modules/@pierre/diffs/dist/highlighter/shiki-editor.js";
import { ShikiStreamTokenizer } from "../../../node_modules/@pierre/diffs/dist/highlighter/shiki-stream.js";

const SUBSET = { json, yaml, python, typescript, javascript, markdown, html, css, bash, kotlin, haskell };

// Núcleo SINGLETON arrancado al importar el módulo: las dos clases lo
// comparten. Mientras inicializa (unos ms), hasLoadedLanguages es false y
// el panel pinta plano — cuando aterriza, la librería re-tokeniza.
let coreReady = false;
const CORE = createHighlighterCore({
  themes: [],
  langs: Object.values(SUBSET),
  engine: createJavaScriptRegexEngine(),
}).then((raw) => {
  coreReady = true;
  // API pública para el panel: el renderer de pierre no cablea tokens en
  // nuestro contexto embebido — el panel pinta las filas él mismo con esto.
  globalThis.__DA_HL_READY = {
    langs: () => raw.getLoadedLanguages(),
    has: (l) => raw.getLoadedLanguages().includes(l),
    // themeName: "pierre-dark" | "pierre-light" — los tokens traen .color
    lines: (code, lang, themeName) => {
      try {
        raw.setTheme({ name: themeName, ...raw.getTheme(themeName) });
      } catch { /* el tema ya está seteado */ }
      try {
        return raw.codeToTokens(String(code), { lang, theme: themeName }).tokens;
      } catch {
        return null;
      }
    },
  };
  return raw;
});

const PLAIN = (code) => ({
  tokens: String(code).split("\n").map((l) => (l === "" ? [] : [{ content: l, offset: 0 }])),
});
// Stream tokenizer plano (lang fuera del subset): una token por línea, sin
// color. Interfaz DiffsStreamTokenizer: enqueue async → {stable, unstable,
// recall}, close → {stable}, clear/clone/dispose.
const PLAIN_STREAM_TOKENIZER = () => {
  let buf = "";
  let base = 0; // offset absoluto de buf dentro del stream
  return {
    async enqueue(chunk) {
      buf += String(chunk);
      const stable = [];
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        if (line) stable.push({ content: line, offset: base });
        base += idx + 1;
        buf = buf.slice(idx + 1);
      }
      return { stable, unstable: [], recall: 0 };
    },
    close() {
      const stable = buf ? [{ content: buf, offset: base }] : [];
      buf = "";
      base += stable[0]?.content.length ?? 0;
      return { stable };
    },
    clear() {
      buf = "";
    },
    clone() {
      return PLAIN_STREAM_TOKENIZER();
    },
    dispose() {},
  };
};

const PLAIN_EDITOR_TOKENIZER = () => ({
  tokenize: () => new Map(),
  prebuildStateStack() {},
  getStringCommentRegexpRangesInLine: () => null,
  setTheme() {},
  stopBackgroundTokenize() {},
  pauseBackgroundTokenize() {},
  resumeBackgroundTokenize() {},
  dispose() {},
});

class SubsetShikiHighlighter extends DiffsHighlighter {
  loadedThemes = new Map();

  static async create(name) {
    const raw = await CORE;
    return new SubsetShikiHighlighter(name, raw);
  }

  constructor(name, raw) {
    super(name, createDiffsThemeResolver(name));
    this.raw = raw;
  }

  getTheme(themeName) {
    this.assertNotDisposed();
    const loaded = this.loadedThemes.get(themeName);
    const theme = this.themeResolver.getResolvedTheme(themeName) ?? loaded;
    if (theme == null) throw new Error(`Theme "${themeName}" has not been resolved`);
    if (loaded !== theme) {
      const textmate =
        theme.textmate ?? (theme.cssVariables != null ? createCssVariablesTheme(theme.cssVariables) : void 0);
      if (textmate == null) throw new Error(`Theme "${themeName}" does not support Shiki`);
      this.raw?.setTheme({ ...textmate, name: themeName });
      this.loadedThemes.set(themeName, theme);
    }
    return theme;
  }

  codeToTokens(code, options) {
    if (!this.raw) return PLAIN(code);
    try {
      return this.raw.codeToTokens(code, this.resolveOptions(options));
    } catch {
      // lang fuera del subset (p.ej. .sql/.sqlite): tokens planos. JAMÁS
      // propagar — el pipeline de pierre renderiza CON esto y un throw
      // tumbaba el render entero del panel (bug 0.8.0 con data.sql).
      return PLAIN(code);
    }
  }

  // lang del request: null si no viene (que el camino real decida)
  langLoaded(options) {
    const lang = options?.lang ?? options?.language;
    if (!lang) return true;
    try {
      return this.raw.getLoadedLanguages().includes(lang);
    } catch {
      return false;
    }
  }

  createEditorTokenizer(options) {
    if (!this.raw || !this.langLoaded(options)) return PLAIN_EDITOR_TOKENIZER();
    return new ShikiEditorTokenizer(this.raw, options, this);
  }

  createStreamTokenizer(options) {
    // lang fuera del subset (p.ej. .sql/.sqlite): tokenizer plano. El real
    // explota ASYNC dentro del pipeline worker de pierre → 8× ONERROR
    // 'reading length' (bug 0.8.1 en la app, invisible en jsdom sin workers).
    if (!this.raw || !this.langLoaded(options)) return PLAIN_STREAM_TOKENIZER();
    try {
      return new ShikiStreamTokenizer(this.raw, this.resolveOptions(options), this);
    } catch {
      return PLAIN_STREAM_TOKENIZER();
    }
  }

  // El subconjunto viene cargado de fábrica. loadLanguages ADEMÁS espera el
  // núcleo: getSharedHighlighter no resuelve hasta que el subset está listo.
  async loadLanguages(_languages) {
    this.assertNotDisposed();
    if (!this.raw) await CORE.then((raw) => (this.raw = raw));
  }
  hasLoadedLanguages(languages) {
    if (this.disposed || !this.raw) return false;
    const loaded = this.raw.getLoadedLanguages();
    return languages.every((lang) => loaded.includes(lang));
  }
  attachLanguages(_languages) {
    this.assertNotDisposed();
  }

  resolveOptions({ theme, themes, ...options }) {
    this.assertNotDisposed();
    if (theme != null) {
      this.getTheme(theme);
      return { ...options, theme };
    }
    if (themes == null) throw new Error("A theme or themes option is required");
    for (const name of Object.values(themes)) this.getTheme(name);
    return { ...options, themes };
  }

  releaseResources() {
    this.loadedThemes.clear();
    this.raw?.dispose?.();
  }
}

// Fachada del slot "highlights": el worker manager de pierre PREFIERE este
// backend, así que también tiene que ser el subset real. Se construye SIN
// await (new HighlightsHighlighter()) — el núcleo se engancha cuando llega;
// hasta entonces pinta plano (hasLoadedLanguages false).
class SubsetHighlightsHighlighter extends SubsetShikiHighlighter {
  constructor() {
    super("highlights", null);
    CORE.then((raw) => {
      if (!this.disposed) this.raw = raw;
    });
  }
}

export const ShikiHighlighter = SubsetShikiHighlighter;
export const HighlightsHighlighter = SubsetHighlightsHighlighter;
