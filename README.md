<div align="center">

# NicoSoft AI Studio

**An open-source desktop AI workshop — a team of named AI experts that collaborate to get your work done.**

Each expert runs on the model best suited to its job, across OpenAI / Anthropic / Google Gemini. Bring your own API key. Everything stays on your machine.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)
![Version](https://img.shields.io/badge/version-1.0.1-success)
![Electron](https://img.shields.io/badge/Electron-42-47848F)
![React](https://img.shields.io/badge/React-19-61DAFB)

</div>

---

## ✨ What it is

A desktop app where **nine named AI experts** work for you — each with its own role, tools, and the model family best suited to its job:

| Expert | Role | Best-fit model |
|---|---|---|
| **Danny** | Coordinator — routes your request to the right expert(s) and merges their answers | anthropic |
| **Amélie** | Generalist — chat, brainstorming, anything not specialized | GPT |
| **Flynn** | Backend engineer — APIs, servers, data | anthropic |
| **Shuri** | Frontend engineer — UI, React, CSS | anthropic |
| **Georgia** | Designer — images & posters | Gemini |
| **Louise** | Translator — any language pair | Gemini |
| **Miranda** | Editor — summarize & condense | Gemini |
| **Turing** | Data analyst — stats & charts | GPT |
| **Joan** | Email & scheduling — drafts, replies, agendas | GPT |

> Model assignments are sensible defaults — every role is freely re-pointable to any provider/model you've configured.

---

## 🧠 Features

- **Multi-model, three protocols.** Connect OpenAI, Anthropic, and Google Gemini natively, or any OpenAI-compatible gateway. Each expert can run on a different provider — bring your own key.
- **Experts that do real work.** Behind each expert is a full agent loop with tools: read/write/edit files, run shell commands, search & fetch the web, execute code in a sandbox, generate images, and produce PDFs.
- **They collaborate.** The coordinator (Danny) can convene the relevant experts, plan a multi-step task, and divide the work across them — or hand off directly to a single specialist.
- **Memory that grows.** A three-layer memory — about you, per-expert, and shared across hand-offs — learns your preferences from conversations and gets better the more you use it. It dedupes, self-corrects, and can be turned off anytime.
- **Projects & history.** Organize work into projects, and keep a tidy conversation history with pin, rename, archive, and grouping by recency.
- **Model Context Protocol.** Attach MCP servers to extend any expert with external tools and resources.
- **Yours, on this device.** Conversations, memory, and projects live in a local SQLite database; API keys sit in your OS keychain. No account, no server, no telemetry.

---

## 📥 Download

Build it yourself today (see [Development](#-development)) — packaged macOS (`.dmg` / Apple Silicon) and Windows (`.exe`) installers are published on the [Releases](https://github.com/nicosoft-dev/nicosoft-ai-studio/releases) page as they're cut. Linux comes later.

---

## 🚀 Quick start

1. Launch the app.
2. On first run, add an API key for one or more providers (OpenAI / Anthropic / Google) under **Settings → Endpoints**. Get keys from each provider's console.
3. Pick an expert from the sidebar — or just type, and Danny routes for you — and start working.

You can run every expert on a single OpenAI-compatible gateway key, or wire each one to the provider that suits it best.

---

## 🛠 Development

```bash
npm install
npm run dev              # electron-vite dev — launches the app with HMR
npm run typecheck        # tsc --noEmit (main + renderer)
npm run build            # production build → out/
npm run dist:mac         # package a macOS app (.dmg) via electron-builder
npm run dist:win         # package a Windows installer (.exe)
```

Requires **Node 22+**.

**Stack:** Electron 42 · electron-vite · React 19 · TypeScript · Vite · Zustand · built-in `node:sqlite` · `@modelcontextprotocol/sdk` · Shiki + react-markdown (rendering) · CSS Modules with design tokens. No heavyweight UI framework — the interface is hand-built.

---

## 📐 Architecture

```
src/
  main/            Electron main process
    agent/         agent loop + tools (read/write/edit, bash, web, images, PDF, code-exec, plan, task…)
    llm/           multi-protocol LLM client (OpenAI / Anthropic / Gemini)
    db/            SQLite schema, migrations, repositories
    keychain/      OS keychain storage for API keys
    mcp/           Model Context Protocol client
    skills/        built-in skills
    ipc/           typed IPC contracts + handlers
  preload/         context-bridge API surface
  renderer/        React 19 UI — views, components, Zustand stores, CSS modules
```

- **Process boundary:** the renderer never touches the network, the disk, or your keys directly — everything goes through typed IPC to the main process.
- **Layering (main):** IPC handler → service → repository → SQLite. Adapters in `agent/` and `llm/` translate to each provider's protocol.
- **Local-first:** all state is on disk (`~/.nsai`); secrets are in the OS keychain.

---

## 🤝 Contributing

Issues and pull requests are welcome. The codebase holds itself to strict standards — strict TypeScript (no `any`), small focused files and functions, no silent error swallowing, and a clean handler → service → repository split. Please match the style of the surrounding code and keep changes scoped.

---

## 📄 License

[Apache License 2.0](LICENSE). Use it, fork it, build on it — keep the NOTICE and patent grant.

---

<div align="center">
<sub>NicoSoft AI Studio is an independent open-source project. It is endpoint-agnostic and not tied to any single LLM provider.</sub>
</div>
