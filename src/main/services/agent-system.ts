// Agent system-prompt building — the role's base prompt + the plan-first doctrine + tool awareness for
// non-dev roles + project convention files + the chat layer's injected context (memories, summary,
// skills). Pure assembly over (roleId, recalled context); no run state.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODING_DISCIPLINE, PANEL_REVIEW_DISCIPLINE, ENGINEER_SYSTEM_PROMPT } from '../agent/system-prompt'
import { buildRolePrompt, displayName } from '../agent/roles/prompts'
import { COMMON_PREAMBLE, SAFETY_PREAMBLE } from '../agent/roles/common-preamble'
import type { AgentContext } from '../agent/context'
import type { MemoryRow } from '../repos/memory.repo'
import { DEV_PROMPT, DEV_ROLES } from './agent-tools'

// Agent system = the role's base prompt (Engineer's coding prompt, or the role section via
// buildRolePrompt for other agent roles) + the chat layer's injected context (memories, summary, skills).
// Plan-first doctrine — the HIGHEST-priority rule every agent role sees, ahead of its own base prompt.
// Big work (new project / large change / major fix) must be planned + documented before any edit; small
// work is exempt so the agent keeps its judgment. Self-contained (no reliance on the base identity that
// follows it) so it reads cleanly when prepended.
const PLAN_FIRST =
  '# Plan before a big build\n' +
  'For a NEW project, a LARGE change (many files or the architecture), or a BIG fix, do not jump straight ' +
  'into edits. Investigate read-only first, then call EnterPlanMode, lay out a concrete step-by-step plan, ' +
  'and call ExitPlanMode to present it before changing anything (in plan mode only read-only tools run). In ' +
  'full-auto/bypass runs ExitPlanMode is confirmed automatically — you do NOT wait on a human, and if you ' +
  'are already executing you may simply proceed.\n' +
  'The approved plan is saved automatically in the app data dir and its path is returned — you do NOT need ' +
  "to write it anywhere yourself, and you must NOT create plan / design / scratch files inside the user's " +
  'repository unless they explicitly ask for a doc. Break large work into ordered steps and verify as you ' +
  'go. For small, well-scoped tasks, plain questions, or chitchat, skip all of this and just do the work — ' +
  'you decide when a task is big enough to warrant a plan; never let planning become busywork.'

// Tool awareness for non-dev agent roles (generalist / analyst / scheduler). Their role prompts are chat-
// style with no mention of tools, so in the agent loop they don't realize they CAN act (the generalist
// fetched an online math API for arithmetic instead of computing it). This is a NEUTRAL capability note
// that names NO specific tool — the roles' toolsets differ (generalist/analyst have code_execution,
// scheduler has none), so it points at the tool schema rather than promising a tool the role lacks. NOT a
// mandate to stay local. Dev roles (engineer / frontend) already carry detailed tool guidance, so skip this.
const TOOL_AWARENESS =
  '# You can act, not just answer — use the tools you have by your own judgment\n' +
  "You're not limited to replying: the tools available to you this turn are in your tool schema — reach " +
  'for them when they help, and do NOT report a result you have not actually produced with one. Rule of ' +
  'thumb: anything you can compute or derive precisely (math, statistics, data wrangling, parsing, ' +
  'formatting) is more reliable run through a code-execution tool — IF you have one — than estimated or ' +
  "fetched from an external service; reach for the web when you genuinely need information you don't " +
  'already have. There is no rule that you must stay local or must go online — the choice is yours.\n\n' +
  '# Iron rule: you are not a software engineer — do NOT write code\n' +
  'Use your tools for YOUR job, but you must NOT write or edit the project source code (application logic, ' +
  'components, types, build or config files) — that work belongs to the engineers. If your task needs a code ' +
  `change, do NOT attempt it yourself: state plainly in your result that it needs ${displayName('frontend')} (frontend) or ${displayName('engineer')} ` +
  '(backend), and exactly what is required, so the coordinator routes it to them. Producing your own ' +
  'deliverable file when that file IS your output (a translation file, a report, notes) is fine; reaching ' +
  'into the existing source code is not.'

// Project-convention files (CLAUDE.md / AGENTS.md) from the agent's working dir — the user's
// project-specific rules. Injected as REFERENCE BELOW the hardcoded system rules (PLAN_FIRST), which
// always win; on conflict the agent follows the system rule and tells the user. Missing dir → null.
const CONVENTION_FILES = ['CLAUDE.md', 'AGENTS.md', join('.claude', 'CLAUDE.md')]
const MAX_CONVENTION_CHARS = 8000
function emitInstructionsLoaded(cwd: string, filePath: string): void {
  void (async () => {
    const { hookRegistry } = await import('../agent/hooks/registry')
    if (!hookRegistry.hasAny('InstructionsLoaded')) return
    const [{ runHooks }, { baseHookPayload, hookContextFromAgent }] = await Promise.all([
      import('../agent/hooks/engine'),
      import('../agent/hooks/adapter'),
    ])
    const signal = new AbortController().signal
    const ctx: AgentContext = {
      cwd,
      signal,
      convId: '',
      permissionMode: 'default',
      sessionDir: cwd,
      readFileState: new Map(),
      requestPermission: async () => ({ allow: false, message: 'InstructionsLoaded hooks cannot request tool permissions.' }),
      todos: [],
    }
    await runHooks('InstructionsLoaded', { ...baseHookPayload('InstructionsLoaded', ctx), file_path: filePath, memory_type: 'project', load_reason: 'agent_system' }, hookContextFromAgent(ctx)).catch(() => undefined)
  })()
}

function readProjectConventions(cwd: string | undefined): string | null {
  if (!cwd) return null
  const parts: string[] = []
  for (const rel of CONVENTION_FILES) {
    const p = join(cwd, rel)
    if (!existsSync(p)) continue
    try {
      const body = readFileSync(p, 'utf8').trim()
      if (body) {
        emitInstructionsLoaded(cwd, p)
        parts.push(`--- ${rel} ---\n${body}`)
      }
    } catch {
      /* unreadable → skip */
    }
  }
  if (!parts.length) return null
  const joined = parts.join('\n\n')
  return joined.length > MAX_CONVENTION_CHARS ? joined.slice(0, MAX_CONVENTION_CHARS) + '\n…(truncated)' : joined
}

export function buildAgentSystem(
  roleId: string,
  memories: MemoryRow[],
  summary: string | null,
  skillListing: string,
  cwd?: string,
  collab = false,
  projectMap?: string,
  memoryIndex?: string,
): string {
  // toolless:false — this is the agent-loop path (the role really has a tool kit), so buildRolePrompt must
  // NOT prepend the "no tools to call" chat-mode note. TOOL_AWARENESS below tells non-dev roles they can act.
  // DEV roles (engineer/frontend) use ENGINEER/FRONTEND_SYSTEM_PROMPT which — unlike buildRolePrompt — does NOT
  // carry COMMON_PREAMBLE, so they were missing the "reply in the user's language / no filler / own mistakes"
  // baseline on the agent + collab paths (the dogfood Flynn-in-English-filler bug). Prepend it for DEV roles;
  // the buildRolePrompt branch already includes it.
  const base = DEV_ROLES.has(roleId) ? `${COMMON_PREAMBLE}\n\n${DEV_PROMPT[roleId]}` : (buildRolePrompt(roleId, { toolless: false }) ?? ENGINEER_SYSTEM_PROMPT)
  // Verify-before-done + stay-in-scope discipline applies to EVERY tool-wielding expert, not just the dev
  // roles — a non-dev expert (e.g. the translator editing source files) must verify + stay in scope too.
  // SAFETY_PREAMBLE rides at the very front of every user-facing agent (all roles, incl. collab via
  // buildCollabSystem which calls this) — the release red lines for a general-audience open-source product.
  const parts = [SAFETY_PREAMBLE, PLAN_FIRST, base, CODING_DISCIPLINE]
  // Panel self-review + orient discipline is SOLO-only: those steps drive the studio_lens tool, which solo runs
  // carry but collab implementers do NOT (批3 filters it + nulls ctx.panel). For collab, buildCollabSystem adds
  // its own review note (one consolidated post-completion review by an independent reviewer) instead.
  if (!collab) parts.push(PANEL_REVIEW_DISCIPLINE)
  // Non-dev agent roles use a chat-style role prompt with no tool awareness — give them the capability note
  // so they know they can act (dev roles already have detailed tool guidance baked into DEV_PROMPT).
  if (!DEV_ROLES.has(roleId)) parts.push(TOOL_AWARENESS)
  const conventions = readProjectConventions(cwd)
  if (conventions) {
    parts.push(
      '# PROJECT CONVENTIONS (reference)\n' +
        "The user's project ships these convention files. Follow them for project-specific choices " +
        '(naming, layout, stack, style). The system rules at the very top take precedence: if a project ' +
        'convention conflicts with them, follow the system rule and tell the user about the conflict.\n\n' +
        conventions,
    )
  }
  // PROJECT MAP (§4): the remembered shape of this project — a SYSTEM-WIDE memory every executing agent reads
  // (solo + dispatched + collab), not just Danny's router. Danny's routeAsAgent is the single writer; here it's
  // read-only orientation so an implementer doesn't re-scan a known project. Absent → nothing injected.
  if (projectMap) parts.push(projectMap)
  // # Memory (auto-memory): the agent-authored memory section — CC template adaptation + the index
  // snapshot, built per run by agent-memory.service.indexText (undefined for folder-free runs). The
  // MemoryRow block below is the separate passive-extraction layer; both coexist by design.
  if (memoryIndex) parts.push(memoryIndex)
  if (memories.length) {
    parts.push(
      "What you've learned about this user (engineering preferences, project conventions):\n" +
        memories.map((m) => `- ${m.content}`).join('\n'),
    )
  }
  if (summary) parts.push('Summary of earlier in this conversation:\n' + summary)
  if (skillListing) parts.push(skillListing)
  return parts.join('\n\n')
}
