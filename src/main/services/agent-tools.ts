// Role→tool kits for the agent loop — the CORE subset each agent role gets (doc 16 §5), the dev-role
// augmentations (plan / service / e2e / async sub-agent tools), and the shared role sets. Module-level
// shared state (DEV_ROLES / ENGINEER_ROLE_ID / the kit arrays) lives here exactly once; every entry
// point (run / dispatched / collab / system building) imports it from here.

import { CORE_TOOLS } from '../agent/registry'
import { ENGINEER_SYSTEM_PROMPT, FRONTEND_SYSTEM_PROMPT } from '../agent/system-prompt'
import { enterPlanModeTool } from '../agent/tools/enter-plan-mode'
import { exitPlanModeTool } from '../agent/tools/exit-plan-mode'
import { askUserQuestionTool } from '../agent/tools/ask-user-question'
import { studioLensTool } from '../agent/tools/studio-lens'
import { studioResearchTool } from '../agent/tools/studio-research'
import { studioDesignTool } from '../agent/tools/studio-design'
import { studioMigrateTool } from '../agent/tools/studio-migrate'
import { readMeTool, showWidgetTool } from '../agent/tools/visualize'
import { readTool } from '../agent/tools/read'
import { globTool } from '../agent/tools/glob'
import { grepTool } from '../agent/tools/grep'
import { taskTool } from '../agent/tools/task'
import { awaitAsyncTool } from '../agent/tools/await-async'
import { startServiceTool, stopServiceTool, serviceLogsTool, listServicesTool } from '../agent/tools/service'
import { agentSpawnTool, agentSendTool, agentWaitTool, agentCloseTool, agentBatchTool } from '../agent/tools/async-subagent'
import { playwrightBrowserTool } from '../agent/tools/playwright-browser'
import { playwrightRequestTool } from '../agent/tools/playwright-request'
import { computerUseTool } from '../agent/tools/computer-use'
import { computerUseToolAvailable } from './computer-use'
import { PREVIEW_TOOLS } from '../agent/tools/preview'
import { monitorStartTool, monitorStopTool } from '../agent/tools/monitor'
import { scheduleWakeupTool } from '../agent/tools/schedule-wakeup'
import { rememberProjectMapTool } from '../agent/tools/remember-project-map'
import { workflowStatusTool } from '../agent/tools/workflow-status'
import { rememberTool, forgetTool, recallMemoryTool } from '../agent/tools/memory'
import { distillSkillTool } from '../agent/tools/distill-skill'
import { workflowDraftTool } from '../agent/tools/workflow-draft'
import { installSkillTool, installMcpTool, installPluginTool } from '../agent/tools/install-extension'
import { studioGuideTool } from '../agent/tools/studio-guide'
import type { Tool } from '../agent/tool'
import { AGENT_ROLE_IDS, WRITE_ROLE_IDS } from '@shared/roles'
import * as settingsService from './settings.service'
import * as rolesService from './roles.service'
import { manager as mcpManager } from './extensions/mcp'
import { manager as skillManager } from './extensions/skill'

export const ENGINEER_ROLE_ID = 'engineer'
// Full-stack dev roles: Flynn (backend) + Shuri (frontend). Both get the complete tool set, a
// coding-agent system prompt, and a required cwd (doc 19 phase 1).
export const DEV_ROLES = WRITE_ROLE_IDS // single source: @shared/roles.WRITE_ROLE_IDS (also the renderer /migrate guard)
export const DEV_PROMPT: Record<string, string> = { engineer: ENGINEER_SYSTEM_PROMPT, frontend: FRONTEND_SYSTEM_PROMPT }

// Roles that run a full agent loop (tools + multi-turn transcript) when dispatched by the coordinator, rather
// than a single llmChat turn. SINGLE SOURCE is @shared/roles.AGENT_ROLE_IDS (imported above) — previously a
// literal hand-synced across the IPC boundary (this file + renderer chat-helpers); now both import the one copy.
// Re-exported here so existing `agentService.AGENT_ROLE_IDS` callers (via agent-dispatch's re-export) and this
// file's own kit builder (roleHasPanel/Monitor below) stay unchanged.
export { AGENT_ROLE_IDS }

// CORE tool subset per agent role (doc 16 §5). Engineer = full set; other roles get a tailored baseline.
// Writes / exec / orchestration (Edit/MultiEdit/Bash/Task/TodoWrite) stay Engineer-only. WebSearch now works
// on ANY family — anthropic AND gemini delegate to an isolated server search (web-search.ts: anthropic
// web_search_20250305 / gemini google_search grounding), and OpenAI roles instead get the hosted web_search
// as a serverTool in run(). So translator/scheduler list WebSearch directly here.
// MCP + Skill are layered on by scope for every agent role.
const ROLE_CORE_TOOLS: Record<string, readonly string[]> = {
  // doc 28: any "doer" role can author/list/cancel its own scheduled tasks (schedule_*). generalist/analyst
  // create directly; the orchestrator (Danny) plans the chain and dispatches Joan to land it — quality, since
  // Joan is a small model, so the heavy planning stays with Danny.
  generalist: ['Read', 'WebFetch', 'code_execution', 'schedule_create', 'schedule_list', 'schedule_delete'],
  // Turing runs disk-based analysis workflows (analyst-quant-backtest design §3.1): Write lands datasets /
  // strategy scripts under the cwd (confineReal is the safety boundary), Glob/Grep explore the user's data
  // files and logs. Deliberately NO Bash — python runs through code_execution; library installs stay with
  // the user (the prompt makes him probe imports and hand back the pip line).
  analyst: ['Read', 'Write', 'Glob', 'Grep', 'WebFetch', 'code_execution', 'schedule_create', 'schedule_list', 'schedule_delete'],
  // doc 29: Louise (Gemini agent loop) — read i18n/md/txt → translate → write back; Grep/Glob to find strings.
  translator: ['Read', 'Write', 'WritePdf', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  // Miranda (Gemini agent loop) — read docs/transcripts/posts → distill → write the summary; same tool kit.
  editor: ['Read', 'Write', 'WritePdf', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  // Georgia (Gemini agent loop) — generate images + the file/web kit so she can read a brief, research
  // references (WebSearch/WebFetch), produce visuals (ns_generate_image), and write specs/exports.
  designer: ['ns_generate_image', 'Read', 'Write', 'WritePdf', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],
  // scheduler (Joan): Read context, Write drafts/output, WebSearch for background, code_execution for
  // time/cron math, schedule_* to create/list/delete tasks. Real email/calendar send (MCP) is v2.
  scheduler: ['Read', 'Write', 'WebFetch', 'WebSearch', 'code_execution', 'schedule_create', 'schedule_list', 'schedule_delete'],
  // coordinator (Danny) in DIRECT mode only: a READ-ONLY kit so the front door can answer a quick file /
  // web lookup itself instead of dispatching. Deliberately no Write/Edit/Bash/code — mutating or multi-step
  // work is a specialist's job (the prompt steers him to hand off). Read/Glob need a cwd; WebSearch doesn't.
  coordinator: ['Read', 'Glob', 'WebSearch']
}

// Capability groups for CUSTOM agent roles (custom-agent-roles design §4) — the ONE group→tools mapping;
// the role editor's checkboxes and the custom_roles.tools column speak these keys, never raw tool names.
// Deliberately absent from any group (see §4 exclusion table): TodoWrite (built-in non-dev roles don't
// have it either) and enter/exit_worktree (dev-kit boundary — a "custom engineer" is a separate decision).
// The universal tiers below (plan/panel/visualize/preview/monitor/memory/guide/MCP/Skill) are automatic
// infrastructure, not checkboxes — they follow runsAgentLoop like every built-in agent role.
export const CUSTOM_AGENT_TOOL_GROUPS: Record<string, readonly string[]> = {
  read: ['Read', 'LS', 'Glob', 'Grep', 'view_image'],
  write: ['Write', 'Edit', 'MultiEdit'],
  web: ['WebFetch', 'WebSearch'],
  code: ['code_execution'],
  schedule: ['schedule_create', 'schedule_list', 'schedule_delete'],
  bash: ['Bash'],
  image: ['ns_generate_image'], // additionally gated by the tools.generate_image.enabled global (filter below)
  pdf: ['WritePdf'],
  task: ['Task'],
}
// Editor defaults for a freshly-enabled agent (§4): the safe everyday kit. bash/image/pdf/task start unchecked.
export const CUSTOM_AGENT_DEFAULT_GROUPS: readonly string[] = ['read', 'write', 'web', 'code', 'schedule']

// Group keys → allowed CORE tool names for a custom agent. Unknown keys (legacy checkbox labels that
// predate the semantics change, typos) are ignored; `write ⇒ read` is enforced HERE as well as in the
// editor UI — an agent that can edit files but not read them can't complete a single edit loop, so
// stored data missing `read` must not produce a broken kit.
export function customAgentToolNames(groups: readonly string[]): Set<string> {
  const keys = new Set(groups.filter((g) => g in CUSTOM_AGENT_TOOL_GROUPS))
  if (keys.has('write')) keys.add('read')
  const names = new Set<string>()
  for (const key of keys) for (const name of CUSTOM_AGENT_TOOL_GROUPS[key]) names.add(name)
  return names
}

// Plan-mode tools (EnterPlanMode/ExitPlanMode) — every agent role gets them (doc 17). They're
// read-only (mode switch + plan presentation), so they're never gated by the plan-mode mutation deny.
const PLAN_TOOLS = [enterPlanModeTool, exitPlanModeTool] as unknown as Tool[]
// studio_lens (closure-loop §3.5 / decision ⑤) is a UNIVERSAL-tier tool like the plan-mode tools — NOT part
// of the filterable CORE_TOOLS. It is appended to EVERY agent role (review + understand both open, not just the
// dev roles); the runtime chooseVerifierRole gate decides whether a panel can actually form. It carries ctx.panel:
// the injection sites (runAgentLoop / collab) key off the kit containing this tool, so handle-presence ⟺
// tool-presence — a fixed-kit verifier / sub-agent (no studio_lens) automatically gets no handle (recursion guard).
// studio_research (research-role-driven-redesign §4.1) is a UNIVERSAL-tier tool alongside studio_lens: a deep
// web-research fan-out any agent role drives in its OWN turn, carrying ctx.research (same handle⟺tool guard — the
// injection sites key off the kit containing this tool). Grouped with lens because both surface as top-level
// progress cards in the Tasks panel. (design joins this group in a later batch; migrate is red-zone, gated separately.)
const PANEL_TOOLS = [studioLensTool, studioResearchTool, studioDesignTool] as unknown as Tool[]
// studio_migrate (research-role-driven-redesign §4.1, RED ZONE) — WRITE-gated (DEV_ROLES only), NOT universal like
// the other script tools: it transforms code (in isolated worktrees → a reviewable patch), so only write-permission
// roles carry it. Same handle⟺tool injection guard (ctx.migrate) at the dispatch/collab sites.
const MIGRATE_TOOLS = [studioMigrateTool] as unknown as Tool[]
// visualize (CC "Imagine" parity) — UNIVERSAL-tier like studio_lens: read_me returns drawing guidance,
// show_widget carries the widget as streaming tool INPUT (the renderer's WidgetCard draws it off
// tool_use_input deltas; the handler only returns CC's fixed receipt). Every agent role; chat-only
// personas and coordinator-direct excluded by construction (docs/visualize-alignment-design.md §5.1).
const VISUALIZE_TOOLS = [readMeTool, showWidgetTool] as unknown as Tool[]
// Session-pacing tools — UNIVERSAL across agent roles, NOT gated to DEV_ROLES (capability parity): Monitor
// (conditional polling, wakes on change) + schedule_wakeup (self-paced timed wakeup). Both are session-scoped
// and route their wakeup through the unified bus; sub-agents have them stripped in loop.ts.
const MONITOR_TOOLS = [monitorStartTool, monitorStopTool, scheduleWakeupTool] as unknown as Tool[]
// Dev roles (Flynn/Shuri) get the service tools in the SINGLE-agent path too (collab already had them),
// so they run dev servers via start_service — detached + readiness-probed + tree-killed — instead of a
// blocking `Bash ... &` that wedges the loop and leaks the process.
export const SERVICE_TOOLS = [startServiceTool, stopServiceTool, serviceLogsTool, listServicesTool] as unknown as Tool[]
export const PLAYWRIGHT_TOOLS = [playwrightBrowserTool, playwrightRequestTool] as unknown as Tool[]
// preview_* — UNIVERSAL across agent roles (user decision 2026-07-02): non-dev roles open the shared
// Preview to COLLECT data (navigate a URL → snapshot/screenshot/console/network); dev roles additionally
// pair it with start_service for local apps (SERVICE_TOOLS stays DEV_ROLES-only). Granted in
// toolsForAgentRole below; the ctx.preview handle follows tool-presence at the injection sites
// (handle ⟺ tool, same recursion-guard pattern as studio_lens), and sub-agents keep being stripped in
// loop.ts — the Preview panel is a conversation-level surface, a child has no anchor for it.
export const PREVIEW_AGENT_TOOLS = PREVIEW_TOOLS as unknown as Tool[]
// Async sub-agent tools (batch 3) — only on top-level dev-role runs, which reach ctx.subAgents (set by
// runAgentLoop). Sub-agents and collab experts don't get them: their ctx.subAgents is undefined (the loop
// also strips agent_* from the child tool set), so a child can't spawn children (depth 1).
export const SUBAGENT_TOOLS = [agentSpawnTool, agentSendTool, agentWaitTool, agentCloseTool, agentBatchTool] as unknown as Tool[]
// Danny's routing-investigation kit (coordinator dispatch §3.0 — L1). READ-ONLY + DELEGATION only: Read/Glob
// to peek, Task to spin an isolated sub-agent (its raw reads land in the sub-agent's context, not Danny's),
// studio_lens (understand mode) to fan a module out into a shared map, await_async to collect a backgrounded
// lens. Deliberately NO write/exec (Edit/Write/Bash) — Danny investigates + decides + delegates; he NEVER
// implements. The read-only-by-construction kit IS the anti-runaway guard (delegation keeps his own context
// lean), so no turn cap is imposed on the routing agent. Used verbatim via runDispatchedAgent's `toolset`.
export const COORDINATOR_INVESTIGATION_TOOLS = [globTool, readTool, grepTool, taskTool, studioLensTool, awaitAsyncTool, rememberTool, forgetTool, recallMemoryTool] as unknown as Tool[]

// Agent memory (auto-memory, CC "# Memory" parity) — the remember_project_map tier: EVERY agent role
// plus coordinator-direct (Danny's routing consumes feedback/project memories, and his corrections are
// where feedback memories are born) plus the investigation kit above. Sub-agents are stripped in
// loop.ts (a Task/async child sees a narrow slice by construction — exactly the write the # Memory
// rules forbid). App-DB only, read-only classified.
export const MEMORY_TOOLS = [rememberTool, forgetTool, recallMemoryTool] as unknown as Tool[]

// ns_computer_use (computer-use P0.5) — a GLOBALLY-toggled tool (Extensions → Tools), not a per-role
// grant: when enabled + macOS + the helper app is installed, every agent role gets it. It drives the
// user's real desktop through the native helper (services/computer-use). Like studio_lens/preview it's a
// conversation-level surface (one physical desktop, one overlay banner), so sub-agents have it stripped
// in loop.ts — a Task/async child must not race the parent for the mouse.
export const COMPUTER_USE_TOOLS = [computerUseTool] as unknown as Tool[]

// distill_skill (skill distillation §3.2) — same tier as MEMORY_TOOLS: every agent role plus
// coordinator-direct, alongside the Skill tool's injection point below (a role that can LOAD skills can
// also propose them). Output is a per-role DRAFT gated by the user in Extensions → Skills. Sub-agents
// are stripped in loop.ts (a child's narrow slice is exactly what the distillation gate forbids saving).
export const DISTILL_TOOLS = [distillSkillTool] as unknown as Tool[]

// workflow_draft (workflow-assisted-authoring §4) — every AGENT role (built-in + agent-enabled custom),
// gated on isAgent below so coordinator-direct stays out: in a Danny conversation the DISPATCHED role
// drafts, and the card lands in that same conversation. Sub-agents are stripped in loop.ts (the card is
// a conversation-level, user-facing confirmation surface — a child must never present one).
export const WORKFLOW_AUTHOR_TOOLS = [workflowDraftTool] as unknown as Tool[]

// install_{skill,mcp,plugin} (extension-install-design §5) — a GLOBALLY-toggled tier like computer-use:
// when extensions.agentInstallEnabled is on (default OFF, Extensions → Tools), every agent role can
// PROPOSE an install; the user remains the gate — each call is red-floor (approval.ts) and lands in the
// interactive install confirmation. Sub-agents are stripped in loop.ts (an install is a conversation-
// level, user-facing decision — a child must never raise the dialog).
export const INSTALL_TOOLS = [installSkillTool, installMcpTool, installPluginTool] as unknown as Tool[]

export function toolsForAgentRole(roleId: string): Tool[] {
  // Membership is the runsAgentLoop PREDICATE (built-in agent set ∪ custom roles with Agent on), computed
  // once for the tier gates below. A custom agent's CORE subset comes from its checked capability groups
  // (CUSTOM_AGENT_TOOL_GROUPS union); built-ins keep their curated ROLE_CORE_TOOLS lists.
  const customRow = AGENT_ROLE_IDS.has(roleId) ? null : rolesService.getCustom(roleId)
  const customAllowed = customRow?.agent ? customAgentToolNames(customRow.tools) : null
  const isAgent = AGENT_ROLE_IDS.has(roleId) || customAllowed !== null
  let core =
    DEV_ROLES.has(roleId)
      ? [...CORE_TOOLS]
      : customAllowed
        ? CORE_TOOLS.filter((t) => customAllowed.has(t.name))
        : CORE_TOOLS.filter((t) => (ROLE_CORE_TOOLS[roleId] ?? []).includes(t.name))
  // ns_generate_image is opt-out in Extensions → Tools (default on). When disabled, drop it from the kit so
  // designer becomes a text-only design consultant (research + specs) instead of generating images. Applies
  // to a custom agent's `image` group too (the group grants the tool; the global switch still filters it).
  if (settingsService.get<boolean>('tools.generate_image.enabled') === false) {
    core = core.filter((t) => t.name !== 'ns_generate_image')
  }
  const skill = skillManager.skillTool(roleId)
  // studio_lens for every agent role (decision ⑤). coordinator's read-only DIRECT kit is not an agent role,
  // so it does not get it; the runtime gate handles whether an independent reviewer can be formed.
  const panel = isAgent ? PANEL_TOOLS : []
  // studio_migrate (RED ZONE) — WRITE-gated to DEV_ROLES (engineer/frontend), not universal like the other script
  // tools: it transforms code. DEV_ROLES ⊂ AGENT_ROLE_IDS, so membership already implies isAgent.
  const migrate = DEV_ROLES.has(roleId) ? MIGRATE_TOOLS : []
  const visualize = isAgent ? VISUALIZE_TOOLS : []
  const preview = isAgent ? PREVIEW_AGENT_TOOLS : []
  const monitor = isAgent ? MONITOR_TOOLS : []
  // ns_computer_use: global toggle + macOS + helper installed (computerUseToolAvailable). Every agent role;
  // coordinator-direct (not an agent role) is excluded by construction — desktop control is a doer's job.
  const computerUse = isAgent && computerUseToolAvailable() ? COMPUTER_USE_TOOLS : []
  // install_{skill,mcp,plugin}: global opt-in toggle (default OFF). When off, the tools are not in ANY
  // kit — an agent can't even propose an install. The red-floor classifier + install confirmation gate
  // the calls when on (extension-install-design §5.2).
  const install = isAgent && settingsService.get<boolean>('extensions.agentInstallEnabled') === true ? INSTALL_TOOLS : []
  // workflow_status (§7.5 batch C): the read-only run window — plus workflow_draft (assisted authoring
  // §4), which PROPOSES a workflow as an in-chat confirmation card. Launching stays behind the per-turn
  // review closure and creating stays behind the user's confirm click, so watching ≠ drafting ≠ starting.
  const wfStatus = isAgent ? [workflowStatusTool as unknown as Tool] : []
  const wfAuthor = isAgent ? WORKFLOW_AUTHOR_TOOLS : []
  // remember_project_map — project memory's write side for every role incl. coordinator-direct (§4.6: seed when
  // none recorded / refresh when verified stale; app-DB only, read-only classified). Sub-agents are stripped in
  // loop.ts (a Task/async child sees a narrow slice by construction — exactly the write the prompt forbids).
  // studio_guide — the product-manual read (studio-guide-product-manual): same tier as the memory tools —
  // every agent role plus coordinator-direct (Danny is the front door for "what can Studio do?"), sub-agents
  // stripped in loop.ts. Pairs with the standing STUDIO_GUIDE_INDEX prompt section (buildAgentSystem).
  return [...core, ...PLAN_TOOLS, askUserQuestionTool as unknown as Tool, rememberProjectMapTool as unknown as Tool, studioGuideTool as unknown as Tool, ...MEMORY_TOOLS, ...DISTILL_TOOLS, ...install, ...panel, ...migrate, ...visualize, ...preview, ...monitor, ...computerUse, ...wfStatus, ...wfAuthor, ...mcpManager.toolsForRole(roleId), ...(skill ? [skill] : [])]
}
