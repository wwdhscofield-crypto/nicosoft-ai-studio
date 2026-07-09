# Scheduled Tasks & Monitors

Background automation. A **scheduled task** fires on a trigger and runs a chain of steps. A **monitor** watches something at a fixed interval and only wakes an expert when it detects a change. Find both under sidebar → Scheduled.

## Create a scheduled task

1. Name the task.
2. Pick a **Trigger**: Once (date & time), Interval (`5m` / `2h` / `1d`), Daily (time), Weekly (day + time) or Cron (5-field expression, e.g. `0 9 * * 1`).
3. Add **steps**, executed in order:

| Step | What it does |
|---|---|
| Expert | Send an instruction to a specific expert |
| Tool / MCP | Call a tool directly |
| Send email | Compose Recipient (to), Subject and body — email always routes through your email MCP; Studio never sends mail itself |
| Project | Create or Advance a project |
| Workflow | Run an enabled workflow (with parameter values) |
| Command | Run a shell command or a program directly — no expert, no model, no tokens |

Tasks can be enabled/disabled, edited and deleted from their row. When a task fires, the work lands as conversation turns from the expert that ran it.

### Command steps

A **Command** step runs something on your machine directly, with no expert in the loop — ideal for a backup script, a sync, or any tool you'd normally run in a terminal. Two modes:

- **Shell** — a command line handed to a shell (your login shell by default, so it resolves your `PATH`; pick zsh/bash/sh, or PowerShell/cmd on Windows). Multi-line is fine.
- **Program** — an executable plus arguments, run *without* a shell. Choose the file with the picker; arguments are passed exactly as typed, so spaces and quotes are safe.

Each command step also has a **Working directory** (defaults to the task's), a **Timeout** (default 10 minutes — the whole process tree is killed if it runs over), and an **On failure** choice (Stop the remaining steps, the default, or Continue anyway). The command's output is captured and piped into the next step, and a non-zero exit code marks the step failed.

> ⚠️ A command runs unattended with your full user permissions and is **not** confined to the working directory (unlike an expert step's tools). Only schedule commands you'd run yourself.

### Running & history in the Tasks panel

While a task is running, it appears in the workspace **Tasks** panel (right drawer) under "Scheduled runs" with its current step and a **Stop** button. After it settles, the run drops into the panel's History — click a run to expand its per-step trail (each step's kind, exit code, duration and a snippet of output). The Scheduled page's own row also shows the last run's result.

## Monitors

The "Running monitors" section lists active watchers: what they watch, "every {interval} · {n} changes", whether they are persistent or will stop after a time limit ("stops in {timeout}"), and a Stop button.

## Or just ask an expert

Experts can manage all of this themselves — ask in plain language:

- `schedule_create` / `schedule_list` / `schedule_delete` — recurring tasks ("every weekday at 9:00 run my report workflow and email me the summary" — Joan is the natural pick). This can include a **Command** step, so an expert can schedule a script or program for you ("back up my project folder every night at 2am").
- `schedule_wakeup` — a one-off self wake-up ("check the build again in 20 minutes").
- `monitor_start` / `monitor_stop` — watchers ("watch this file and tell me when it changes").

You'll see these as tool cards in the conversation, and the created items appear in the Scheduled view. When an expert schedules a **command**, its exact command line is echoed back in the tool card (so you can see precisely what will run unattended), and the task's row in the Scheduled view is tagged "by \<expert\>" — a command runs with your full permissions and isn't confined to the working directory, so review it. You can also run any task on demand from the composer with `/schedule <id|name>`.

## Notes

- Practical minimum cadence is about one minute.
- To react to *changes*, prefer a monitor over a tight schedule: the monitor polls cheaply and only involves the expert when something actually changed.
