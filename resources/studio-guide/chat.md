# Chat & Conversations

The main surface: talk to one expert (solo) or to Danny (the coordinator, who routes). Replies stream live with reasoning, tool activity and results.

## Starting and managing conversations

- Sidebar → "New Conversation" → pick a role.
- History groups conversations under Pinned, Today, Yesterday, Earlier and a collapsible Archived section. Each row's ⋯ menu: Pin/Unpin, Rename, Archive/Unarchive, Delete.
- Topbar → Actions: Rename, Export Markdown, Export JSON, Delete. Deleting is permanent.

## The composer

- Enter sends, Shift+Enter inserts a newline. "Stop" cancels the current turn.
- **Images**: paste, drag-and-drop, or the "Attach image" button (images only — other file types go through the working folder instead).
- **Folder**: the path bar picks a working directory, enabling Files / Diff / Terminal / Preview for this conversation (see Workspace).
- **Pickers** under the input: model, thinking depth (when the model supports it), permission Mode (Ask / Plan / Auto), and — for Georgia — an image model picker.
- **Token meter**: "used / context limit" (e.g. `45.2K / 200K`); it turns amber above 85%. Use `/compact` when it gets tight.

## Slash commands

Type `/` in the composer:

| Command | What it does |
|---|---|
| `/new`, `/clear` | Start a new conversation |
| `/compact` | Summarize older history to free context — a visible receipt shows what was folded, and it can be stopped |
| `/plan` | Switch to Plan mode (read-only investigation) |
| `/default` | Back to the default acting mode |
| `/mode <Ask\|Plan\|Auto>` | Set the permission mode |
| `/memory` | Open Memory Live (the 3D memory cloud) |
| `/workflow <name> [key=value …]` | Launch an enabled workflow; Tab fills the defaults for inline editing (see Workflows) |

## Reading a reply

- Each expert's contribution is a segment with its avatar and name chip. Coordinator turns start with a **dispatch badge** showing the routing chain; **Synthesis** and **Verifier** tags mark the merge and final-review parts.
- Consecutive tool calls fold into a one-line activity summary ("Reading …, running a command") — click to expand the individual tool cards. Some tools render inline cards (widgets, images, plans).
- While streaming, a live readout at the bottom shows elapsed time, tokens in/out and the current activity; "Stop" is available the whole time.

## Approvals and questions

- In Ask mode, actions pause with "wants to run" → **Allow** / **Deny**.
- Plan mode ends with "Plan ready for review" → **Approve & run** or **Revise**.
- An expert may ask you a question with clickable options — pick one or type another answer.
