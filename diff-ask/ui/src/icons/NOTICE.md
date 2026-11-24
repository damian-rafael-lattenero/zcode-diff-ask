# Vendored language icons

Small, self-contained subset used by the Diff Ask file headers. Only the icons
the panel references are vendored (the search-first rule: ship what you use).

Sources:
- **devicon** 2.18.0 (`<lang>-original.svg`) — MIT, see `LICENSE.devicon.txt`.
- **simple-icons** (`nushell`, `graphql`, `toml`, `svg`, `make`) — CC0 1.0,
  fetched from `https://cdn.simpleicons.org/<slug>`.

The marks are trademarks of their respective owners; they are used here only
to identify a file's language (the same purpose VS Code and devicon serve).

Do not edit the SVGs by hand: `npm run icons` regenerates
`src/lang-svgs.generated.js` from this folder, and the panel reads from that
module.
