// Static seed data for the studio UI — NOT a mock backend. These are real defaults / config:
//   - EXPERTS / EXPERT_BY_ID: the built-in expert roster (names, colors, specialties, default models)
//   - USER_PROFILE: the display name shown on the user avatar; hydrated from real storage at runtime
//   - GREETINGS: the per-expert greeting + starter chips on a fresh chat
//   - EXTENSIONS: still-mock per-expert MCP/skills shown on the expert PROFILE page (the Extensions
//     settings screen itself uses real window.api.mcp/skills/plugins)
//   - PHASES / PHASE_INDEX: collaboration-project phase labels
// The prototype's mock projects / conversations / analytics / memory / endpoint fixtures were removed —
// those screens read real IPC-backed data now.
import type { Expert, StudioData, ExtensionsData, Greeting } from '@/types'
import { ROLE_DISPLAY_NAMES as N } from '@shared/roles'

// Display names come from @shared/roles (single source with main's router/dispatch prompts); everything
// else here (color, specialty, personality, default model, family) is renderer-only UI metadata.
const EXPERTS: Expert[] = [
  { id: 'coordinator', name: N.coordinator, color: 'var(--exp-coordinator)', specialty: 'Coordinator — routes & merges', personality: 'Calm air-traffic-controller', model: 'nicosoft/claude-opus-4-8', family: 'anthropic', coordinator: true },
  { id: 'generalist', name: N.generalist, color: 'var(--exp-generalist)', specialty: 'Generalist — chat & brainstorming', personality: 'Warm, curious front door', model: 'nicosoft/gpt-5.5', family: 'openai' },
  { id: 'engineer', name: N.engineer, color: 'var(--exp-engineer)', specialty: 'Backend engineer — APIs, server, data', personality: 'Precise, direct, no pleasantries', model: 'nicosoft/claude-opus-4-8', family: 'anthropic' },
  { id: 'shuri', name: N.shuri, color: 'var(--exp-shuri)', specialty: 'Frontend engineer — UI, React, CSS', personality: 'Inventive, detail-driven, craft-proud', model: 'nicosoft/claude-opus-4-8', family: 'anthropic' },
  { id: 'designer', name: N.designer, color: 'var(--exp-designer)', specialty: 'Designer — images & posters', personality: 'Creative, opinionated', model: 'gemini-pro-latest', family: 'gemini' },
  { id: 'translator', name: N.translator, color: 'var(--exp-translator)', specialty: 'Translator — any language pair', personality: 'Precise, culturally aware', model: 'nicosoft/gemini-3-flash-agent', family: 'gemini' },
  { id: 'editor', name: N.editor, color: 'var(--exp-editor)', specialty: 'Editor — summarize & condense', personality: 'Structured, no padding', model: 'gemini-pro-latest', family: 'gemini' },
  { id: 'analyst', name: N.analyst, color: 'var(--exp-analyst)', specialty: 'Data analyst — stats & charts', personality: 'Rigorous, honest about uncertainty', model: 'nicosoft/gpt-5.5', family: 'openai' },
  { id: 'scheduler', name: N.scheduler, color: 'var(--exp-scheduler)', specialty: 'Email & scheduling', personality: 'Efficient, situationally appropriate', model: 'nicosoft/gpt-5.4-mini', family: 'openai' }
]

const EXPERT_BY_ID: Record<string, Expert> = Object.fromEntries(EXPERTS.map((e) => [e.id, e]))

const USER_PROFILE = { name: 'Nico' }

// Per-expert extensions shown on the expert PROFILE page. Still mock (the real per-installation MCP /
// skills live behind window.api on the Extensions settings screen); kept until the profile page reads
// the real catalog filtered by role scope.
const EXTENSIONS: ExtensionsData = {
  mcp: [
    { name: 'GitHub', transport: 'http', endpoint: 'https://mcp.github.com/sse', status: 'connected', tools: 8, scope: 'all' },
    { name: 'Filesystem', transport: 'stdio', endpoint: 'npx @modelcontextprotocol/server-filesystem ~/projects', status: 'connected', tools: 5, scope: ['engineer'] },
    { name: 'Postgres', transport: 'stdio', endpoint: 'npx mcp-server-postgres', status: 'error', tools: 0, scope: ['analyst'], error: 'bad credentials' }
  ],
  skills: [
    { name: 'code-review', desc: 'Structured PR review with inline suggestions', source: 'built-in', enabled: true, scope: ['engineer'] },
    { name: 'pdf', desc: 'Read & extract text and tables from PDF files', source: 'built-in', enabled: true, scope: 'all' },
    { name: 'xlsx', desc: 'Read & write spreadsheets, build formulas', source: 'built-in', enabled: true, scope: ['analyst'] },
    { name: 'deep-research', desc: 'Multi-step web research with cited sources', source: 'community', enabled: false, scope: 'all' }
  ],
  plugins: [
    {
      name: 'Dev Pack',
      desc: 'Everything an engineer needs, wired up',
      source: 'community',
      enabled: true,
      bundles: [
        { type: 'skill', name: 'code-review' },
        { type: 'mcp', name: 'GitHub' }
      ],
      summary: '1 skill · 1 MCP'
    }
  ]
}

const GREETINGS: Record<string, Greeting> = {
  generalist: { greeting: "Hi, I'm Amélie. I handle the everyday stuff — ask me anything, or I'll point you to the right expert.", chips: ['Explain this error message', 'Brainstorm names for my app', 'Plan a 3-day trip'] },
  engineer: { greeting: 'I build the backend — APIs, databases, services, business logic. Paste code or describe what the server should do.', chips: ['Design a REST API', 'Why is this query slow?', 'Add auth to this endpoint'] },
  shuri: { greeting: 'I build the frontend — UI, components, styling, interactions. Tell me what to build, or paste a component.', chips: ['Build a login form', 'Make this responsive', 'Why is this layout broken?'] },
  coordinator: { greeting: "I coordinate the team. Tell me what you need and I'll route it to the right expert — or convene several and merge their work.", chips: ['Translate and debug this error', 'Research, then summarize', 'Draft and schedule an email'] },
  designer: { greeting: 'I make posters, illustrations, and avatars. Describe the vibe, the text, and the format.', chips: ['Poster for our game night', 'App icon, flat & minimal', 'Hero illustration, isometric'] },
  translator: { greeting: 'I translate any language pair and localize copy — paste text, or point me at files (i18n / md / txt) in a folder.', chips: ['Translate landing page to German', 'Localize a locale file', 'Is this idiomatic?'] },
  editor: { greeting: 'I summarize, condense, and take notes. Drop in a long doc or transcript.', chips: ['Summarize this thread', 'Turn notes into action items', 'Condense to 100 words'] },
  analyst: { greeting: 'I run the numbers — stats, math, and chart recommendations. Bring your data.', chips: ['Analyze Q1 churn', 'Is this difference significant?', 'Recommend a chart'] },
  scheduler: { greeting: 'I draft emails, replies, and agendas. Tell me the recipient and the gist.', chips: ['Reply to this investor', 'Draft a meeting agenda', 'Polish this cold email'] }
}

export const PHASES = ['Plan', 'Execute', 'Test', 'Done']
export const PHASE_INDEX: Record<string, number> = { Planning: 0, Executing: 1, Testing: 2, Done: 3 }

export const STUDIO_DATA: StudioData = {
  EXPERTS,
  EXPERT_BY_ID,
  USER_PROFILE,
  GREETINGS,
  EXTENSIONS
}

// expert id → display name + color (built-ins; unknown/custom ids fall back to the raw id). Shared by
// the Overview timeline and the Stats page.
export function expertMeta(id: string): { name: string; color: string } {
  const e = EXPERT_BY_ID[id]
  return e ? { name: e.name, color: e.color } : { name: id || '\u2014', color: 'var(--text-3)' }
}
