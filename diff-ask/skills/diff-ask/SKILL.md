---
name: diff-ask
description: Use when the user asks about workspace changes, or when a message arrives anchored to an exact diff line (a "Diff Ask" block with `path:line` and quoted lines). Covers reading the live diff with get_diff, answering line-anchored questions, and pinning answers back onto the file with "# Code comments:" blocks.
---

# Diff Ask — questions anchored to diff lines

The user has a **Diff Ask** side panel showing the live workspace diff (git diff HEAD + untracked). Hovering any diff line shows a **+** gutter button; clicking it opens a composer, and submitting sends a user message anchored to that exact line.

## How anchored questions arrive

A Diff Ask message contains a block like:

```markdown
- `src/bot/poller.py:412` (Diff Ask · diff, lines 412-414 · additions):
> def _nuclear_body(ctx):
>     caffeinate = subprocess.Popen(...)

why do you launch caffeinate before the cycle?
```

- The `path:line` is a real file location — treat it as clickable context and answer ABOUT THOSE EXACT LINES, not about the file in general.
- The quoted lines (`> ...`) are the diff content at question time; line numbers may have drifted if more edits happened since. When in doubt, re-read the file around that line before answering.
- `· additions`/`· deletions` tells the diff side: additions = new-file line numbers; deletions = old-file line numbers (the line no longer exists in the working tree — discuss why it was removed/changed).

## Getting the diff yourself

Call the `get_diff` tool (from this plugin) for structured JSON: branch, head, and per-file path/status/added-deleted counts/unified patch. It also opens the Diff Ask panel for the user. The working payload also carries `upstream`/`ahead`/`behind` when the branch has one.

Turns (what each user prompt achieved — the files its tools wrote, which is the same list ZCode's end-of-turn summary shows; sessions the app does not know fall back to commits made in the window plus files left dirty):

- `list_turns` — recorded turns, newest first, paginated (use `skip`): id, timestamps, prompt/reply previews, repo and file counts. The first entry may be the OPEN turn (`isLive`). Turns are scoped to the calling session when it is known (panel/model request context); otherwise they span all sessions.
- `get_turn_diff` — diff of one turn (`latest` = the open turn live, or the last saved one): every file namespaced by repo label, with its first-before → final-after content, plus the "Outside git" group for files outside any repo. Opens the panel on that turn. A turn that wrote nothing lists nothing — commands, commits and pre-existing dirty files are not "files written".

Commits:

- `list_commits` — latest commits (title/author/date, paginate with `skip`) or search by hash/prefix/title (`query`).
- `get_commit_diff` — full diff of one commit vs its first parent (root commits diff against the empty tree); opens the panel on that commit.

Panel tabs (0.10.0): **Turns** (each turn's written files — the same list the app's end-of-turn summary shows — grouped by repo and folder) and **Work per repository** (its 📁 picker defaults to the repo the last turn that wrote files worked in — `suggest_workspace`; its Commits button opens that repo's history).

The panel's question header names its scope, e.g. `Diff Ask — 2 questions on the diff (turn 10:03 — repos: …):` or `(commit a1b2c3d fix: algo)`. Answer about THAT diff: for turn/commit questions the quoted lines may differ from the current working tree — re-read the file at the right revision/line before concluding.

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
Comment: caffeinate comes first because the whole cycle depends on the Mac not sleeping.
```

Rules for that section: it must be the LAST thing in the message; each `## Comment` block has `File:`, `Lines:` (new-file line numbers), `Selected text:` as a fenced code block copied verbatim from the file, and `Comment:`. Use it when it genuinely helps (review-style remarks); skip it for general discussion.
