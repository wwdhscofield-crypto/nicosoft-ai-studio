# Tasks Panel

The live-work drawer for the current conversation. Open it with ⌘J, or topbar → Workspace → Tasks.

## Sections

- **Live** — each working expert's to-do list with statuses To do / In progress / Done and a "{done}/{total} done" summary. In coordinator or group conversations the items group per expert; in a solo chat they list flat.
- **Workflows** — workflow runs launched *from this conversation*: status at a glance, click to open the full run panel.
- **Studio Lens** — findings when an expert runs a code review: each finding carries a verdict — Pass, Flagged or False positive.
- **Services** — dev servers the experts started: Starting / Running / Exited, with **Stop** and **Logs** ("waiting for port" while booting).
- **History** — settled workflow runs persist here; entries reopen as full replays. **Clear** empties the list.

## Notes

- "No task list for this chat." simply means no expert has planned steps yet.
- Ownership is per conversation: a run launched from another conversation shows in *that* conversation's panel. The Workflows view in the sidebar always shows everything.
