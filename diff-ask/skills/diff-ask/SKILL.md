---
name: diff-ask
description: Use when the user asks about workspace changes, or when a message arrives anchored to an exact diff line (a "Diff Ask" block with `path:line` and quoted lines). Covers reading the live diff with get_diff, answering line-anchored questions, and pinning answers back onto the file with "# Code comments:" blocks.
---

# Diff Ask — preguntas ancladas a líneas del diff

The user has a **Diff Ask** side panel showing the live workspace diff (git diff HEAD + untracked). Hovering any diff line shows a **+** gutter button; clicking it opens a composer, and submitting sends a user message anchored to that exact line.

## How anchored questions arrive

A Diff Ask message contains a block like:

```markdown
- `src/bot/poller.py:412` (Diff Ask · diff, líneas 412-414 · additions):
> def _nuclear_body(ctx):
>     caffeinate = subprocess.Popen(...)

¿por qué lanzás caffeinate antes del ciclo?
```

- The `path:line` is a real file location — treat it as clickable context and answer ABOUT THOSE EXACT LINES, not about the file in general.
- The quoted lines (`> ...`) are the diff content at question time; line numbers may have drifted if more edits happened since. When in doubt, re-read the file around that line before answering.
- `· additions`/`· deletions` tells the diff side: additions = new-file line numbers; deletions = old-file line numbers (the line no longer exists in the working tree — discuss why it was removed/changed).

## Getting the diff yourself

Call the `get_diff` tool (from this plugin) for structured JSON: branch, head, and per-file path/status/added-deleted counts/unified patch. It also opens the Diff Ask panel for the user. The working payload also carries `upstream`/`ahead`/`behind` when the branch has one.

Turns (what each user prompt achieved — commits made in the window plus files left dirty, across every repo the turn touched):

- `list_turns` — recorded turns, newest first, paginated (use `skip`): id, timestamps, prompt/reply previews, repo and file counts. The first entry may be the OPEN turn (`isLive`).
- `get_turn_diff` — diff of one turn (`latest` = the open turn live, or the last saved one): every file namespaced by repo label, commit files and dirty files, plus the "Fuera de git" group for files outside any repo. Opens the panel on that turn.

Commits:

- `list_commits` — latest commits (title/author/date, paginate with `skip`) or search by hash/prefix/title (`query`).
- `get_commit_diff` — full diff of one commit vs its first parent (root commits diff against the empty tree); opens the panel on that commit.

Panel tabs (0.10.0): **Turnos** (the last executed turn, grouped by repo and folder) and **Trabajo por repositorio** (its 📁 picker defaults to the repo the last turn changed the most — `suggest_workspace`; its Commits button opens that repo's history).

The panel's question header names its scope, e.g. `Diff Ask — 2 preguntas al diff (turno 10:03 — repos: …):` or `(commit a1b2c3d fix: algo)`. Answer about THAT diff: for turn/commit questions the quoted lines may differ from the current working tree — re-read the file at the right revision/line before concluding.

## Pinning an answer onto the file (optional, high value)

If the answer is about a specific line and the user is looking at the file, END your message with a code-comments section and ZCode renders it as native cards pinned to those lines:

```markdown
# Code comments:

## Comment
File: src/bot/poller.py
Lines: 412-414
Selected text:
```
def _nuclear_body(ctx):
    caffeinate = subprocess.Popen(...)
```
Comment: caffeinate va primero porque el ciclo completo depende de que la Mac no se duerma.
```

Rules for that section: it must be the LAST thing in the message; each `## Comment` block has `File:`, `Lines:` (new-file line numbers), `Selected text:` as a fenced code block copied verbatim from the file, and `Comment:`. Use it when it genuinely helps (review-style remarks); skip it for general discussion.
