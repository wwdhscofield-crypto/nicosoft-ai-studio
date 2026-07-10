# Projects

A project is a multi-expert collaboration with a goal, an optional working folder, phases and visible progress. Phases run Planning → Executing → Testing → Done. Find them under sidebar → Projects.

## Start one

- "+ New Project": Title (optional — generated from the goal if left blank), Goal, Folder path (optional).
- Or just ask the team in chat — when Danny routes a build request into a collaboration, it lands here automatically.

## While it runs

- The project card shows the phase chip, a progress bar and the avatars of the experts involved.
- Inside a project, the Orchestration timeline shows one swimlane per expert (custom roles by name) with their tool calls as cards. Every teammate exchange — an assignment, a hand-off message, a reply — draws its own dashed arrow from the sender's card to where the receiver picked it up, arrowhead on the receiving end; the small label reads `assign → Name` / `send → Name` and hovering it shows the message.
- The dock at the bottom of a project sends the team a new instruction; while a run is in flight the send button becomes **Stop** — one click aborts the run.
- Plans can pause for your decision: "Plan ready for review" → **Approve & run** or **Revise**; approve/reject actions are also available from the project surface.
- The Overview page's Activity tab shows live, currently-streaming work including collaborations.

## Edit, archive & delete

- **Edit** (header button inside a project): change the title, goal or working folder. Changing the folder only affects future instructions — files the team already created stay where they are.
- **Archive** (card "…" menu, or the header button): moves the project under a collapsed "Archived (n)" section at the bottom of the list. Nothing is lost — phase, plan, history and conversation links stay; Unarchive restores it exactly. A scheduled Advance step skips an archived project (recorded as skipped, not failed).
- **Delete**: hover a project card → "…" menu → Delete, or the Delete button in the header. A confirm dialog explains what goes: the plan, tests and timeline are removed permanently, and an in-flight collaboration is stopped first. Linked conversations are kept — they only lose their project link.

## Automation

A Scheduled task can include a **Project** step with action Create or Advance — useful for "kick off the weekly cleanup project every Monday". An Advance step pointing at a deleted project fails with a clear reason (it never fakes success).

## Notes

- A project's working folder gives its experts the same Workspace surface as a normal conversation (Files / Diff / Terminal / Preview).
