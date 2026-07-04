// Studio guide — the read side of the built-in product manual (resources/studio-guide/<topic>.md, 12
// sections of user-visible behavior only). Consumed two ways, from one source of truth here:
//   1) studio_guide tool (agent/tools/studio-guide.ts) reads a section on demand;
//   2) STUDIO_GUIDE_INDEX is the standing one-line-per-section directory + anti-hallucination rule,
//      injected into every agent system prompt (buildAgentSystem) and Danny's DIRECT override.
// Directory resolution is electron-free on purpose (e2e imports this under plain node): the packaged app
// ships the folder via electron-builder extraResources → <process.resourcesPath>/studio-guide; when that
// doesn't exist (dev / e2e) we read the repo's resources/studio-guide relative to cwd (electron-vite dev
// and the e2e harness both run from the project root).
// Discipline (studio-guide-product-manual): any user-visible feature change updates its section in the
// SAME commit — the e2e pin (e2e/studio-guide.mts) holds enum ⇄ files ⇄ index three-way consistent.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Topic ids = file basenames = index lines (three-way, pinned in e2e). Order is the index display order.
export const STUDIO_GUIDE_TOPICS = [
  'overview',
  'chat',
  'workflows',
  'scheduled',
  'tasks-panel',
  'memory',
  'skills',
  'projects',
  'workspace',
  'preview-visuals',
  'extensions',
  'settings',
] as const
export type StudioGuideTopic = (typeof STUDIO_GUIDE_TOPICS)[number]

// One line per section — just enough for an agent to pick the right section to pull. Keep each hint a
// tight keyword phrase: the how-to lives in the md, and this index is STANDING prompt weight on every
// run (the e2e pin caps the built index at 1,600 chars ≈ the ratified ~200-token budget).
const TOPIC_HINTS: Record<StudioGuideTopic, string> = {
  overview: 'what Studio is, the nine experts, ways of working, quick start',
  chat: 'conversations, composer, slash commands, image attachments, token meter, approvals',
  workflows: 'saved multi-expert procedures: create/edit, drafts vs enabled, /workflow, runs & replay',
  scheduled: 'timed tasks (triggers + step chains), monitors, expert-managed schedules',
  'tasks-panel': 'the ⌘J drawer: to-dos, workflow runs, review findings, services, history',
  memory: 'memory layers, Self-learning, Memory Live, expert notes & project maps, Profile',
  skills: 'packaged instructions: import or write skills, distilled drafts, scoping',
  projects: 'multi-expert collaborations: phases, plan approval, automation',
  workspace: 'Files/Diff/Terminal panels, git chip, permission modes Ask/Plan/Auto, worktrees',
  'preview-visuals': 'Preview panel, dev-server attach, inline widgets & charts, image generation',
  extensions: 'MCP servers, plugins, built-in tools, expert scoping',
  settings: 'Profile, endpoints & keys, role↔model bindings, appearance, privacy, updates',
}

// The standing system-prompt section (~200 tokens): directory + the anti-hallucination red line.
export const STUDIO_GUIDE_INDEX =
  '# Studio product guide\n' +
  'You work inside NicoSoft AI Studio. For ANY question about Studio itself — what it can do, how a ' +
  'feature works, where a control lives — call the studio_guide tool with the matching topic FIRST and ' +
  "answer from what it returns, in the user's language. If the guide doesn't cover it, say you don't " +
  'know rather than guessing — NEVER invent Studio features, buttons, or behavior. Topics:\n' +
  STUDIO_GUIDE_TOPICS.map((t) => `- ${t} — ${TOPIC_HINTS[t]}`).join('\n')

// Packaged first (extraResources lands next to the asar), else the repo folder (dev / e2e run from root).
function guideDir(): string {
  const packaged = join(process.resourcesPath ?? '', 'studio-guide')
  if (process.resourcesPath && existsSync(packaged)) return packaged
  return join(process.cwd(), 'resources', 'studio-guide')
}

const cache = new Map<StudioGuideTopic, string>()

// Returns the section's markdown, or undefined when the file is unreadable (the tool surfaces a clear
// error instead of throwing — a missing manual must never break an agent turn).
export function loadGuideSection(topic: StudioGuideTopic): string | undefined {
  const hit = cache.get(topic)
  if (hit) return hit
  try {
    const text = readFileSync(join(guideDir(), `${topic}.md`), 'utf8').trim()
    if (!text) return undefined
    cache.set(topic, text)
    return text
  } catch {
    return undefined
  }
}
