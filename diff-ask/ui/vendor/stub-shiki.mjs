// Stub for the whole `shiki` package (and @shikijs/*) in the panel build.
// Only two named static imports exist outside the stubbed backends
// (INITIAL, EncodedTokenMetadata in shiki/textmate); everything else is
// reached through dynamic imports that never run without a real highlighter.
export const INITIAL = -1;
export const EncodedTokenMetadata = class {};
export const createHighlighterCore = async () => {
  throw new Error("panel build: shiki disabled");
};
export const createJavaScriptRegexEngine = async () => {
  throw new Error("panel build: shiki disabled");
};
export const createOnigurumaEngine = async () => {
  throw new Error("panel build: shiki disabled");
};
export default {};
