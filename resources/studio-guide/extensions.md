# Extensions

Everything you plug into the team lives under sidebar → Extensions, in four tabs: MCP, Skills, Plugins, Tools.

Scoping applies across all of them: extensions run inside an expert's agent loop — every built-in expert has one, Danny included — and the **Scope** (All experts / specific ones) only controls *which* experts are offered the capability.

## MCP servers

External tools & data sources your experts can call (Model Context Protocol).

1. "+ Add MCP server".
2. Either fill the fields — Name; Transport **stdio (local)** (Command such as `npx`, Arguments space-separated, Environment as `KEY=value` per line) or **HTTP** (URL, Headers) — or use "Paste config JSON" with a standard `mcpServers` snippet to fill them automatically.
3. Save, then **Test connection**. A healthy server shows Connected and "{n} tools".

Secrets entered under Environment/Headers are kept in the OS keychain. Each row has an enable/disable toggle, a Scope, and an Edit / Test connection / Remove menu. Once connected, the server's tools are available to in-scope experts automatically — calls show up as tool cards in chat.

## Skills

Packaged instructions experts load on demand — see the Skills guide for details, including distilled-skill drafts.

## Plugins

Bundles that install a whole set at once — skills, MCP servers and roles.

- "+ Install plugin" from a folder containing `plugin.json`. The row lists what came with it (chips per skill / MCP / role) and a summary like "2 skills · 1 MCP · 1 role".
- Bundled items are marked "via {plugin}" and are managed by the plugin; Uninstall removes the set.

## Tools (built-ins)

- **Generate Image** (`ns_generate_image`) — posters, illustrations, avatars and thumbnails; pick its default model; scoped to the Designer by default. The `ns_` prefix marks reusable built-ins any agent can be granted.
- **Playwright** — a read-only status card for Tier 2 browser automation (package + Chromium browser state). Your engineering expert installs it on request; the Tier 1 preview tools work without it.
- **Computer use** (`ns_computer_use`, macOS and Windows) — lets any expert see and control your computer: screenshot the screen (or stream it live to watch something change), read on-screen elements, click, type (any language), scroll, and drag across native apps, not just the browser. A global switch turns it on for every expert. It runs through a small native helper ("NicoSoft Computer Use"). On macOS it needs two permissions — Accessibility and Screen Recording — shown on the card (installed/running plus each permission's state) with an "Open settings" shortcut to grant them; Windows needs no per-app permission. While an expert is in control a banner shows on screen; press Esc to stop at any time.

## Agent-assisted installs

Experts can help you install extensions — but only with your hand on the gate.

- Turn it on under Tools → **Agent extension installs** (a global switch, off by default). When on, every expert gains `install_skill`, `install_mcp` and `install_plugin`.
- Agents **never download anything**. The extension must already be on your disk; the expert can tell you what to download and where to put it, then you point it at the folder.
- The install source is **the conversation's working folder** — the same folder you set for the chat — or a path you give the expert in a message (a relative path resolves inside the working folder). There's no separate "source folder" setting to configure.
- **Every install pops a confirmation** showing exactly what would happen: a skill's name and instructions, a plugin's full component list (skills / MCP servers / roles), or the exact command an MCP server would run. You can swap the folder with the native picker right there; a folder outside the conversation's working folder has to be picked by hand (that click is your authorization). `npx`-style and remote HTTP MCP servers add a red warning that connecting fetches code from the network. Nothing installs until you press Install — pressing Enter never approves one.
- MCP secrets are entered in that confirmation and go straight to the OS keychain; the expert only ever sees the key names, never the values.
- What lands where: installs are copied into `~/.nsai/extensions/` (skills, plugins, and each MCP server's manifest), so the install keeps working even if you delete the original download. Removing the extension removes its copy.
- Installs never run unattended: scheduled tasks and pipeline-dispatched experts get denied with guidance to ask you in a live chat.
