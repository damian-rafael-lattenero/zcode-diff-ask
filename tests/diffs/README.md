# Diff Ask Fixture Files

Ten small files in several languages, all English, used as a stable
playground for the Diff Ask panel e2e suite. Each file contains a mix
of prose and code with deliberately unique marker words (alpha, bravo,
charlie, delta, echo, foxtrot) so automated tests can locate exact
lines without ambiguity.

## Layout

- `config.json` — nested settings object
- `server.ts` — tiny HTTP router
- `parser.py` — line-oriented tokenizer
- `styles.css` — theme tokens and rules
- `data.yaml` — fixture records
- `shell.sh` — helper commands
- `notes.md` — long-form markdown prose
- `types.go` — small type declarations
- `Makefile` — build targets

The base revision is intentionally boring: no tricks, no edge cases,
just plain readable text that can be edited freely afterwards.
