# Workspace

The right-hand drawer that attaches a conversation to a real folder: files, git, terminal, preview. First pick the working directory in the composer's path bar — the panels operate on that folder.

## Panels

Toggle from the topbar Workspace button or with shortcuts (press again to close, VS Code-style):

| Panel | Shortcut | What you get |
|---|---|---|
| Tasks | ⌘J | Live to-dos, workflow runs, review findings, services, history (see Tasks Panel) |
| Files | ⌘P | File tree with filter; row menu: Reveal in Finder, Copy path, Insert path to agent, Open with default app; click a text file to preview and copy |
| Diff | ⌘⇧D | Current branch, +added −deleted, per-file patches, and "Unpushed commits (n)" with their subjects; "No code changes" when clean |
| Terminal | Ctrl+` | Real shell sessions in the working directory; multiple tabs via "New terminal" |
| Preview | ⌘⇧V | Built-in browser for the app you're building (see Preview & Visuals) |

The drawer is resizable (drag the edge) and remembers its width and active panel.

## The git chip

In an expert conversation whose folder is a git repository, the composer shows a live git chip: `+A −D` counted since the branch's merge base — uncommitted and unpushed work together. Its action button sends a visible, plain-language instruction to the expert:

- **Commit changes** — when there are uncommitted edits.
- **Push / PR** — when the tree is clean but commits are unpushed.

Danny's direct chat is read-only, so the action button doesn't appear there.

## Permission modes

The composer's Mode picker governs what an expert may do in this folder:

- **Ask** — approve edits & commands before they run (default).
- **Plan** — read-only: investigate and plan first, then hand you a plan to approve.
- **Auto** — run everything without asking.

Switch any time with the picker or `/mode`, `/plan`, `/default`.

## Isolation

Experts can run sub-tasks in temporary git worktrees so parallel edits don't collide; the sub-task card shows when this is used. Unchanged worktrees clean themselves up.

## Notes

- Panels need a working directory ("This conversation has no working directory." otherwise); Diff additionally needs the folder to be a git repository ("This folder isn't a git repository.").
- Very large diffs may be truncated in the panel: "Largest diffs omitted — open the terminal for the full view."
