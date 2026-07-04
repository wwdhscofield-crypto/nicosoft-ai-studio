# Skills

A skill is a packaged set of instructions an expert loads on demand when a request matches — a reusable "how we do X here": name, a "When to use" hint that helps the model pick it, and step-by-step instructions. Find them under Extensions → Skills.

## Add a skill

"+ Add skill", then choose a Source:

- **Import folder** — point at a folder containing `SKILL.md` (Browse… to pick).
- **Write in studio** — fill Name (e.g. `code-review`), Description, "When to use" (e.g. "When the user asks to review a diff") and Instructions.

Each skill has a Scope (All experts or specific ones), an enable/disable toggle, and an Edit / Remove menu.

## Distilled skills (self-improvement)

After a procedure has actually worked in a conversation, an expert can distill it into a skill draft (the `distill_skill` tool — you'll see the card in chat).

- Drafts land in Extensions → Skills with the source tag "distilled · {expert}", and a note appears: "{n} draft(s) from agents — review and activate below".
- A draft stays inactive until you review and enable it — unless the "Auto-activate distilled skills" toggle is on (off by default).
- You can ask for it explicitly: "distill what we just did into a skill."

## Notes

- Skills add *instructions*, not new tools — new tools come from MCP servers and plugins.
- Source tags tell you where a skill came from: imported / studio / distilled · {expert}.
- Experts only reach for a skill when the request matches its "When to use" — writing that line well is what makes a skill fire.
