// Agent system-prompt building — the role's base prompt + the plan-first doctrine + tool awareness for
// non-dev roles + project convention files + the chat layer's injected context (memories, summary,
// skills). Pure assembly over (roleId, recalled context); no run state.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODING_DISCIPLINE, ENGINEER_SYSTEM_PROMPT } from '../agent/system-prompt'
import { buildRolePrompt } from '../agent/roles/prompts'
import type { MemoryRow } from '../repos/memory.repo'
import { DEV_PROMPT, DEV_ROLES } from './agent-tools'

// Agent system = the role's base prompt (Engineer's coding prompt, or the role section via
// buildRolePrompt for other agent roles) + the chat layer's injected context (memories, summary, skills).
// Plan-first doctrine — the HIGHEST-priority rule every agent role sees, ahead of its own base prompt.
// Big work (new project / large change / major fix) must be planned + documented before any edit; small
// work is exempt so the agent keeps its judgment. Self-contained (no reliance on the base identity that
// follows it) so it reads cleanly when prepended.
const PLAN_FIRST =
  '# Plan before you build — HIGHEST PRIORITY (this overrides any default urge to start editing right away)\n' +
  'When you are about to start a NEW project, make a LARGE change (touches many files or the architecture), ' +
  'or fix a BIG problem in a software project, do NOT jump straight into edits. Plan first:\n' +
  '1. Investigate read-only, then call EnterPlanMode and lay out a concrete, step-by-step plan; call ' +
  'ExitPlanMode to present the plan before changing anything (in plan mode only read-only tools run). In ' +
  'full-auto/bypass runs ExitPlanMode is confirmed automatically — you do NOT wait on a human.\n' +
  "2. Write the plan / design as a markdown doc under the project's `docs/` directory (create `docs/` if it " +
  'is missing) so the plan is durable, then build against it.\n' +
  '3. Break large work into ordered steps and orchestrate them one at a time, verifying as you go.\n' +
  'For small, well-scoped tasks, plain questions, or chitchat, skip all of this and just do the work — you ' +
  'decide when a task is big enough to warrant a plan. Never let planning become busywork on trivial changes.'

// Tool awareness for non-dev agent roles (generalist / analyst / scheduler). Their role prompts are chat-
// style with no mention of tools, so in the agent loop they don't realize they CAN act (the generalist
// fetched an online math API for arithmetic instead of computing it). This is a NEUTRAL capability note
// that names NO specific tool — the roles' toolsets differ (generalist/analyst have code_execution,
// scheduler has none), so it points at the tool schema rather than promising a tool the role lacks. NOT a
// mandate to stay local. Dev roles (engineer / shuri) already carry detailed tool guidance, so skip this.
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
  'change, do NOT attempt it yourself: state plainly in your result that it needs Shuri (frontend) or Flynn ' +
  '(backend), and exactly what is required, so the coordinator routes it to them. Producing your own ' +
  'deliverable file when that file IS your output (a translation file, a report, notes) is fine; reaching ' +
  'into the existing source code is not.'

// Project-convention files (CLAUDE.md / AGENTS.md) from the agent's working dir — the user's
// project-specific rules. Injected as REFERENCE BELOW the hardcoded system rules (PLAN_FIRST), which
// always win; on conflict the agent follows the system rule and tells the user. Missing dir → null.
const CONVENTION_FILES = ['CLAUDE.md', 'AGENTS.md', join('.claude', 'CLAUDE.md')]
const MAX_CONVENTION_CHARS = 8000
function readProjectConventions(cwd: string | undefined): string | null {
  if (!cwd) return null
  const parts: string[] = []
  for (const rel of CONVENTION_FILES) {
    const p = join(cwd, rel)
    if (!existsSync(p)) continue
    try {
      const body = readFileSync(p, 'utf8').trim()
      if (body) parts.push(`--- ${rel} ---\n${body}`)
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
): string {
  const base = DEV_ROLES.has(roleId) ? DEV_PROMPT[roleId] : (buildRolePrompt(roleId) ?? ENGINEER_SYSTEM_PROMPT)
  // Verify-before-done + stay-in-scope discipline applies to EVERY tool-wielding expert, not just the dev
  // roles — a non-dev expert (e.g. the translator editing source files) must verify + stay in scope too.
  const parts = [PLAN_FIRST, base, CODING_DISCIPLINE]
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
