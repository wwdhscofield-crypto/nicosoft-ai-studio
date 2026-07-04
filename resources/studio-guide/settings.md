# Settings

Open Settings from the topbar gear; "Back to Studio" returns. Sections in the left nav: Profile, Memory, Endpoints, Roles, General, Privacy, About.

## Profile

Who you are — appended to every request so every expert knows who they're working with: Display Name, Role / Occupation, Primary Stack / Domain, Preferred Tone (Formal / Friendly / Direct), Preferred Reply Language, Timezone, About Me. "Save Profile" / "Reset".

## Memory

Browse, edit and delete what experts remember, filter by Expert and Layer (Shared / Role / Collab), and control the Self-learning toggle. See the Memory guide.

## Endpoints

Your model providers. "+ Add endpoint" → Name, Protocol (Anthropic / OpenAI / Gemini / Custom), Base URL, API key, and one or more Models (Model slug + Context tokens; a Prompt caching toggle where the provider supports it). Save first, then **Test connection**. Rows show enabled/disabled, "{n} models" and the key state ("key set" / "no key" / "key unreadable — re-enter"). API keys are stored in the OS keychain.

## Roles

Bind each expert to the Endpoint & model best suited to its job. A "Best fit · {family}" chip marks the recommended family — Anthropic (reasoning & code), OpenAI (general & analysis), Gemini (translation & images) — as a starting point you can always override. Where the model supports it, pick a thinking depth per role: "Default thinking", Adaptive, or a fixed tier.

## General

- **Theme**: Auto (System) / Light / Dark.
- **Language**: Auto (System), English, 简体中文, 繁體中文, 한국어, 日本語.
- **Appearance**: UI zoom, Chat text size, Body font and Code font (Default, any installed font, or Custom…), with a live Preview row.
- **Reset to defaults** restores all appearance settings at once.

## Privacy

Studio is local-first: conversations, memories, projects and settings persist solely on this device — no accounts, no servers, no cloud sync, zero analytics or telemetry. This page shows live counts ("{n} conversations · {n} memories") and the Data folder, with Reveal in Finder.

## About

Version, Updates ("Check for updates"; updates download in the background, then "Restart to install"), License (Apache-2.0 · Open Source), Engine, Author.

## Custom roles

Sidebar → "New Role": Name, Color, System prompt, Endpoint, Model, Tools (Web search, Code execution, Image generation, File reading) and an optional Greeting. Roles can be disabled from the sidebar; Danny is "Primary role · Always on" and can't be disabled. Deleting a role removes its conversations and its role-layer memory — the Shared layer remains.
