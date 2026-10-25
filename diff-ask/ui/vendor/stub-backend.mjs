// Highlighter backends stubbed out for the panel build.
//
// @pierre/diffs pulls the entire shiki language catalog plus the oniguruma and
// highlights WASM engines through dynamic imports (~14 MB — the host caps an
// HTML resource at 4 MiB). This stub keeps the module contract AND implements
// the exact interface the renderer consumes (name, getTheme, codeToTokens,
// hasLoadedLanguages, themeResolver) so every file renders SYNCHRONOUSLY as a
// plain diff: line numbers, +/- colors from the theme, no syntax tokens — the
// same look the host shows for unknown languages.

const GIT = (green, red, blue) => ({
  "gitDecoration.addedResourceForeground": green,
  "gitDecoration.deletedResourceForeground": red,
  "gitDecoration.modifiedResourceForeground": blue,
  "terminal.ansiGreen": green,
  "terminal.ansiRed": red,
  "terminal.ansiBlue": blue,
});

const LIGHT = Object.freeze({
  name: "da-light",
  type: "light",
  fg: "#1f2328",
  bg: "#ffffff",
  colors: GIT("#1a7f37", "#cf222e", "#0969da"),
});
const DARK = Object.freeze({
  name: "da-dark",
  type: "dark",
  fg: "#e6e8eb",
  bg: "#1b1e24",
  colors: GIT("#3fb950", "#f85149", "#4493f8"),
});

class PlainHighlighter {
  constructor(name) {
    this.name = name;
    this.disposed = false;
    this.themeResolver = {
      resolveThemes: async () => {},
      hasResolvedThemes: () => true,
      getResolvedTheme: (themeName) =>
        String(themeName).includes("dark") ? DARK : LIGHT,
    };
  }
  static async create(name) {
    return new this(name);
  }
  getTheme(themeName) {
    return String(themeName).includes("dark") ? DARK : LIGHT;
  }
  async loadLanguages() {}
  hasLoadedLanguages() {
    return true;
  }
  codeToTokens(code) {
    // Shiki shape: one entry per line, each a list of {content, offset}.
    // A single uncolored token per line renders as plain inherited-fg text.
    const lines = String(code).split("\n");
    return { tokens: lines.map((l) => (l === "" ? [] : [{ content: l, offset: 0 }])) };
  }
  get isDisposed() {
    return this.disposed;
  }
  dispose() {
    this.disposed = true;
  }

  // Editor en vivo (✏️): el editor de pierre le pide al highlighter un
  // tokenizer POR TECLA. Sin shiki no hay syntax highlight — devolvemos el
  // tokenizer PLANO: Map vacío = el renderer dibuja cada línea como texto
  // heredado (exactamente el look que ya tiene el diff no-editado acá).
  // Sin este método el editor explota al ATACHARSE:
  // "TypeError: t.createEditorTokenizer is not a function" (visto en la app
  // 0.5.0; el harness de Chrome caía por otro camino y no lo delató).
  createEditorTokenizer(_options) {
    return {
      tokenize() {
        return new Map();
      },
      prebuildStateStack() {},
      getStringCommentRegexpRangesInLine() {
        return null;
      },
      setTheme() {},
      stopBackgroundTokenize() {},
      pauseBackgroundTokenize() {},
      resumeBackgroundTokenize() {},
      dispose() {},
    };
  }
}

export const ShikiHighlighter = PlainHighlighter;
export const HighlightsHighlighter = PlainHighlighter;
