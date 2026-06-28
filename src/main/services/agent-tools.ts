// Role→tool kits for the agent loop — the CORE subset each agent role gets (doc 16 §5), the dev-role
// augmentations (plan / service / e2e / async sub-agent tools), and the shared role sets. Module-level
// shared state (DEV_ROLES / ENGINEER_ROLE_ID / the kit arrays) lives here exactly once; every entry
// point (run / dispatched / collab / system building) imports it from here.

import { CORE_TOOLS } from '../agent/registry'
import { ENGINEER_SYSTEM_PROMPT, SHURI_SYSTEM_PROMPT } from '../agent/system-prompt'
import { enterPlanModeTool } from '../agent/tools/enter-plan-mode'
import { exitPlanModeTool } from '../agent/tools/exit-plan-mode'
import { askUserQuestionTool } from '../agent/tools/ask-user-question'
import { studioLensTool } from '../agent/tools/studio-lens'
import { startServiceTool, stopServiceTool, serviceLogsTool, listServicesTool } from '../agent/tools/service'
import { agentSpawnTool, agentSendTool, agentWaitTool, agentCloseTool, agentBatchTool } from '../agent/tools/async-subagent'
import { playwrightBrowserTool } from '../agent/tools/playwright-browser'
import { playwrightRequestTool } from '../agent/tools/playwright-request'
import { PREVIEW_TOOLS } from '../agent/tools/preview'
import { monitorStartTool, monitorStopTool } from '../agent/tools/monitor'
import { scheduleWakeupTool } from '../agent/tools/schedule-wakeup'
import type { Tool } from '../agent/tool'
import * as settingsService from './settings.service'
import { manager as mcpManager } from './mcp.service'
import { manager as skillManager } from './skill.service'

export const ENGINEER_ROLE_ID = 'engineer'
// Full-stack dev roles: Flynn (backend) + Shuri (frontend). Both get the complete tool set, a
// coding-agent system prompt, and a required cwd (doc 19 phase 1).
export const DEV_ROLES = new Set([ENGINEER_ROLE_ID, 'shuri'])
export const DEV_PROMPT: Record<string, string> = { engineer: ENGINEER_SYSTEM_PROMPT, shuri: SHURI_SYSTEM_PROMPT }

// Roles that run a full agent loop (tools + multi-turn transcript) when dispatched by the coordinator,
// rather than a single llmChat turn. Same set the renderer's chat store keys agent:run vs chat:send on —
// kept in sync across the IPC boundary by hand (main can't import the renderer copy, nor the reverse).
// coordinator never dispatches to itself. translator + editor + designer run the full gemini agent loop —
// Louise localizes whole files, Miranda reads/distills documents, Georgia generates images + reads briefs —
// so a dispatched Louise/Miranda/Georgia needs tools (Georgia's ns_generate_image included). Lives here (not
// agent-dispatch) so the kit builder can reference it without a cycle; agent-dispatch re-exports it.
export const AGENT_ROLE_IDS = new Set(['engineer', 'shuri', 'generalist', 'analyst', 'scheduler', 'translator', 'editor', 'designer'])

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
  analyst: ['Read', 'WebFetch', 'code_execution', 'schedule_create', 'schedule_list', 'schedule_delete'],
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

// Plan-mode tools (EnterPlanMode/ExitPlanMode) — every agent role gets them (doc 17). They're
// read-only (mode switch + plan presentation), so they're never gated by the plan-mode mutation deny.
const PLAN_TOOLS = [enterPlanModeTool, exitPlanModeTool] as unknown as Tool[]
// studio_lens (closure-loop §3.5 / decision ⑤) is a UNIVERSAL-tier tool like the plan-mode tools — NOT part
// of the filterable CORE_TOOLS. It is appended to EVERY agent role (review + understand both open, not just the
// dev roles); the runtime chooseVerifierRole gate decides whether a panel can actually form. It carries ctx.panel:
// the injection sites (runAgentLoop / collab) key off the kit containing this tool, so handle-presence ⟺
// tool-presence — a fixed-kit verifier / sub-agent (no studio_lens) automatically gets no handle (recursion guard).
const PANEL_TOOLS = [studioLensTool] as unknown as Tool[]
// Session-pacing tools — UNIVERSAL across agent roles, NOT gated to DEV_ROLES (capability parity): Monitor
// (conditional polling, wakes on change) + schedule_wakeup (self-paced timed wakeup). Both are session-scoped
// and route their wakeup through the unified bus; sub-agents have them stripped in loop.ts.
const MONITOR_TOOLS = [monitorStartTool, monitorStopTool, scheduleWakeupTool] as unknown as Tool[]
// Dev roles (Flynn/Shuri) get the service tools in the SINGLE-agent path too (collab already had them),
// so they run dev servers via start_service — detached + readiness-probed + tree-killed — instead of a
// blocking `Bash ... &` that wedges the loop and leaks the process.
export const SERVICE_TOOLS = [startServiceTool, stopServiceTool, serviceLogsTool, listServicesTool] as unknown as Tool[]
export const PLAYWRIGHT_TOOLS = [playwrightBrowserTool, playwrightRequestTool] as unknown as Tool[]
export const PREVIEW_AGENT_TOOLS = PREVIEW_TOOLS as unknown as Tool[]
// Async sub-agent tools (batch 3) — only on top-level dev-role runs, which reach ctx.subAgents (set by
// runAgentLoop). Sub-agents and collab experts don't get them: their ctx.subAgents is undefined (the loop
// also strips agent_* from the child tool set), so a child can't spawn children (depth 1).
export const SUBAGENT_TOOLS = [agentSpawnTool, agentSendTool, agentWaitTool, agentCloseTool, agentBatchTool] as unknown as Tool[]

export function toolsForAgentRole(roleId: string): Tool[] {
  let core =
    DEV_ROLES.has(roleId)
      ? [...CORE_TOOLS]
      : CORE_TOOLS.filter((t) => (ROLE_CORE_TOOLS[roleId] ?? []).includes(t.name))
  // ns_generate_image is opt-out in Extensions → Tools (default on). When disabled, drop it from the kit so
  // designer becomes a text-only design consultant (research + specs) instead of generating images.
  if (settingsService.get<boolean>('tools.generate_image.enabled') === false) {
    core = core.filter((t) => t.name !== 'ns_generate_image')
  }
  const skill = skillManager.skillTool(roleId)
  // studio_lens for every agent role (decision ⑤). coordinator's read-only DIRECT kit is not an agent role,
  // so it does not get it; the runtime gate handles whether an independent reviewer can be formed.
  const panel = AGENT_ROLE_IDS.has(roleId) ? PANEL_TOOLS : []
  const monitor = AGENT_ROLE_IDS.has(roleId) ? MONITOR_TOOLS : []
  return [...core, ...PLAN_TOOLS, askUserQuestionTool as unknown as Tool, ...panel, ...monitor, ...mcpManager.toolsForRole(roleId), ...(skill ? [skill] : [])]
}
