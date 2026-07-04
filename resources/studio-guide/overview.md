# Studio Overview

NicoSoft AI Studio is a local-first desktop workspace where a team of named AI experts works for you, running on the model providers you configure. Everything — conversations, memories, projects, settings — stays on this device: no accounts, no cloud sync, no telemetry.

## The team

Nine built-in experts. Every one of them is a full agent: it works in turns, calls tools (files, terminal, web, extensions), and streams its reasoning and results into chat.

| Name | Role | Specialty |
|---|---|---|
| Danny | Coordinator | Routes requests to the right experts and merges their results. Primary role · Always on. |
| Amélie | Generalist | General chat & brainstorming |
| Flynn | Engineer | Backend — APIs, server, data |
| Shuri | Frontend engineer | UI, React, CSS |
| Georgia | Designer | Images & posters |
| Louise | Translator | Any language pair |
| Miranda | Editor | Summarize & condense |
| Turing | Analyst | Data analysis — stats & charts |
| Joan | Scheduler | Email & scheduling |

You can add custom roles ("New Role" in the sidebar) with their own system prompt, model and tools.

## Ways to work

- **Solo chat** — "New Conversation" → pick one expert → talk to it directly.
- **Coordinator** — pick Danny. He answers simple things himself, or routes your request: a single specialist, a **pipeline** (sequential hand-off), **parallel** takes (independent perspectives, then a synthesis), a **council** (experts debate a high-stakes call), or a **collaboration** (2–3 builders constructing something together). Type `@Flynn` (any expert name) to route instantly.
- **Workflows** — save a multi-expert procedure and run it by hand, with `/workflow`, or on a schedule.
- **Scheduled** — timed tasks and monitors that run in the background and report back.

## Finding your way around

- **Sidebar**: Overview (live activity + stats), Projects, Scheduled, Extensions, Workflows, Roles (the team), and conversation History (Pinned / Today / Yesterday / Earlier / Archived).
- **Topbar**: the Workspace button opens the right-hand drawer (Tasks / Files / Diff / Terminal / Preview); the gear opens Settings.
- **⌘K** opens a global palette to search conversations, roles and actions.

## Quick start

1. Settings → Endpoints → "Add endpoint" — your provider's Base URL, API key and models.
2. Settings → Roles — bind each expert to an endpoint & model (a "Best fit" chip suggests a family).
3. Sidebar → "New Conversation" — pick an expert and start.

## Limits

- Studio needs at least one enabled endpoint with an API key and a model; an unbound role can't chat (the conversation shows a notice with an "Open settings" shortcut).
- Studio brings no models of its own — capability and cost follow the providers you connect.
