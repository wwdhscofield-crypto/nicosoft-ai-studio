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

Tasks can be enabled/disabled, edited and deleted from their row. When a task fires, the work lands as conversation turns from the expert that ran it.

## Monitors

The "Running monitors" section lists active watchers: what they watch, "every {interval} · {n} changes", whether they are persistent or will stop after a time limit ("stops in {timeout}"), and a Stop button.

## Or just ask an expert

Experts can manage all of this themselves — ask in plain language:

- `schedule_create` / `schedule_list` / `schedule_delete` — recurring tasks ("every weekday at 9:00 run my report workflow and email me the summary" — Joan is the natural pick).
- `schedule_wakeup` — a one-off self wake-up ("check the build again in 20 minutes").
- `monitor_start` / `monitor_stop` — watchers ("watch this file and tell me when it changes").

You'll see these as tool cards in the conversation, and the created items appear in the Scheduled view.

## Notes

- Practical minimum cadence is about one minute.
- To react to *changes*, prefer a monitor over a tight schedule: the monitor polls cheaply and only involves the expert when something actually changed.
