// Multi-expert collaboration (consult — doc 19 §5 / §11 phase 3): run a set of experts as a
// CollabSession — each a persistent, mailbox-driven agent loop, scheduled concurrently and coordinating
// via send_message/assign_task/wait. Returns each expert's final text for the coordinator to synthesize;
// persistence stays with the caller (coordinator-collab).

import { mkdir } from 'node:fs/promises'
import { dataDir } from '../db/connection'
import { join } from 'node:path'
import type { AgentContext, PermissionRequest, PermissionDecision } from '../agent/context'
import type { AgentLlmEvent } from '../agent/llm'
import { runAgent, type AgentEvent, type AgentResult } from '../agent/loop'
import { promptTokensFromUsage } from '../agent/compact'
import { isContentBlock } from '../agent/types'
import type { ServerToolSchema } from '../agent/types'
import { displayName } from '../agent/roles/prompts'
import { sendMessageTool, assignTaskTool, waitTool } from '../agent/tools/consult'
import { CollabSession, type ExpertSpec, type CollabEvent } from '../agent/collab'
import { ServiceRegistry, type ServiceInfo } from '../agent/service-registry'
import { LSPManager } from '../agent/lsp/manager'
import { startServiceTool, stopServiceTool, serviceLogsTool, listServicesTool } from '../agent/tools/service'
import { lspTool } from '../agent/tools/lsp'
import type { Tool } from '../agent/tool'
import type { AgentRunInput } from '../ipc/contracts'
import { agentEvents } from './event-bus'
import { manager as skillManager } from './skill.service'
import { DEV_ROLES, E2E_TOOLS, toolsForAgentRole } from './agent-tools'
import { createPanelHandle } from './examine/agent-panel'
import { buildAgentSystem } from './agent-system'
import { setActiveServices, clearActiveServices, broadcastConvServices } from './active-services'
import * as workspaceTasks from './workspace-tasks.service'

// One expert in a collaboration: who, the task it starts on, its endpoint + cwd. Same per-role binding the
// coordinator resolves for a dispatch, but collected into a CollabSession instead of run one-shot.
export interface CollabExpertInput {
  roleId: string
  initialPrompt: string
  cwd: string
  protocol: 'anthropic' | 'openai' | 'gemini'
  baseUrl: string
  apiKey: string
  model: string
  // The user's permission mode for this expert (bypass = full auto, skipping coordinator self-approval).
  // Unset → 'default' (coordinator's safety classifier gates each mutating tool).
  permissionMode?: AgentContext['permissionMode']
  contextWindow?: number
  // Resolved thinking directive (from the role binding's thinkingDepth). Without it a collab expert thinks
  // ZERO — same bug as the dispatch path. The coordinator resolves + sets it when building the expert list.
  thinking?: AgentRunInput['thinking']
}

// Bridges a CollabSession's per-expert activity out to the coordinator (→ UI + audit). onEvent is the
// consult interaction stream (send/assign/wait/…); onExpertStream/onExpertEvent mirror a normal agent
// run's stream, tagged with roleId; requestPermission pops a teammate's mutating-tool approval to the user.
export interface CollabHooks {
  onEvent: (e: CollabEvent) => void
  onExpertStream: (roleId: string, ev: AgentLlmEvent) => void
  onExpertEvent: (roleId: string, ev: AgentEvent) => void
  // Live TodoWrite push per expert → the Tasks panel (roleId tags the writer; the panel groups by owner).
  // Was missing entirely → the collab Tasks panel stayed empty while experts wrote todos.
  onTodos?: (roleId: string, todos: { content: string; status: string }[]) => void
  // A collab expert entered/left a turn batch (active true/false) — drives the parked-readout toggle so a
  // parked expert (done its turn, waiting) stops showing "Thinking…".
  onExpertActive?: (roleId: string, active: boolean) => void
  requestPermission: (roleId: string, req: PermissionRequest, signal?: AbortSignal) => Promise<PermissionDecision>
  // phase 5c-C3: snapshot of the live dev services the collaboration started (empty when none / on teardown).
  onServices?: (services: ServiceInfo[]) => void
}

// The role's coding/section prompt + a "working as a team" addendum naming the reachable teammates, so the
// expert knows who to consult and to stay in its own area. Memories/summary are skipped — a collaboration
// is a fresh shared task, not a continuation of the role's chat history.
function buildCollabSystem(roleId: string, teammates: { id: string; name: string }[], cwd?: string): string {
  const base = buildAgentSystem(roleId, [], null, skillManager.listingForRole(roleId), cwd)
  const roster = teammates.map((t) => `- ${t.name} (roleId: ${t.id})`).join('\n')
  return (
    base +
    '\n\n## Working as a team\n' +
    'You are collaborating with other experts on one shared project, working in parallel — each owns part ' +
    'of it. Your teammates:\n' +
    roster +
    '\n\nCoordinate with the consult tools: assign_task hands someone work and wakes them now (e.g. ask the ' +
    'backend for an endpoint you need); send_message notifies without interrupting (e.g. "done, it\'s at ' +
    '<path>"); wait pauses you until a teammate replies. For runtime integration use the service tools: ' +
    'start_service runs a long-lived server / dev process (it stays up — Bash would kill it); list_services ' +
    "shows what's running + each service's port (the frontend uses it to find the backend's port); " +
    "service_logs reads a service's output to debug. Build against the contracts you agree on; do not " +
    "reimplement a teammate's area. Finish your COMPLETE part before you stop — every file written, your " +
    "own checks passing, and the agreed integration actually working. Do NOT end your turn after " +
    "scaffolding a few files assuming the session keeps running: when every expert stops at once the whole " +
    "build ends right there, unfinished. Keep working — and consult teammates — until your piece is " +
    "genuinely, fully done; only then finish, and the coordinator collects everyone's results and reviews."
  )
}

// Run a set of experts as a collaboration (consult). Each runs a persistent, mailbox-driven agent loop;
// CollabSession schedules them concurrently and they coordinate via send_message/assign_task/wait. Returns
// each expert's final text for the coordinator to synthesize. Does NOT persist — the coordinator owns that.
export async function runCollabSession(
  convId: string,
  experts: CollabExpertInput[],
  hooks: CollabHooks,
  signal: AbortSignal,
  nowMs: () => number,
): Promise<Map<string, { text: string; reason: AgentResult['reason']; inTokens: number; contextTokens: number; cacheReadTokens: number; outTokens: number }>> {
  // One service registry per collaboration, shared by all its experts (Flynn starts a backend, Shuri
  // lists + connects). Tree-killed in the finally below when the session ends — no zombie ports survive.
  const registry = new ServiceRegistry()
  // Live Tasks-panel wiring: push the active service set on every change; archive each one to history as it
  // exits; register the handle so the renderer can stop / read logs of a running service on demand.
  registry.setHooks({
    onChange: (activeSvcs) => broadcastConvServices(convId, activeSvcs),
    onExit: (info) => workspaceTasks.recordServiceExit(convId, info)
  })
  setActiveServices(convId, registry)
  const inTokensByRole = new Map<string, number>() // accumulated TOTAL prompt tokens (incl. cache) per expert → billing
  const contextByRole = new Map<string, number>() // per expert: LAST turn's context size → per-message ↑ display (overwrite, NOT accumulated)
  const outTokensByRole = new Map<string, number>() // accumulated output tokens per expert → its per-message ↓ readout
  const cacheReadByRole = new Map<string, number>() // per expert: LAST turn's cache-read share → per-message "(+N cached)" note (overwrite, NOT accumulated)
  const reasonByRole = new Map<string, AgentResult['reason']>() // per expert: its loop's terminal reason → bubbles incomplete/thrash_stop up to coordinator:done (not just text)
  const roster = experts.map((x) => ({ id: x.roleId, name: displayName(x.roleId) ?? x.roleId }))
  const lspByExpert: LSPManager[] = [] // one per dev expert; tree-killed in the finally
  const specs: ExpertSpec[] = experts.map((x) => {
    // Per-expert state shared across its turns: the read-file cache + todo list persist as it loops, so it
    // doesn't forget what it read between being woken.
    const readFileState: AgentContext['readFileState'] = new Map()
    const todos: AgentContext['todos'] = []
    const toolNames = new Map<string, string>() // tool_use id → name, to pair tool:post with its tool (audit)
    // Per-expert language server (dev roles) — Shuri's TS frontend benefits most; persists across this
    // expert's turns, lazily spawns on the first lsp query, disposed when the collaboration ends.
    const lsp = DEV_ROLES.has(x.roleId) ? new LSPManager(x.cwd) : undefined
    if (lsp) lspByExpert.push(lsp)
    const tools = [
      ...toolsForAgentRole(x.roleId),
      sendMessageTool,
      assignTaskTool,
      waitTool,
      startServiceTool,
      stopServiceTool,
      serviceLogsTool,
      listServicesTool,
      ...(DEV_ROLES.has(x.roleId) ? [lspTool as unknown as Tool, ...E2E_TOOLS] : [])
    ]
    const serverTools: ServerToolSchema[] = x.protocol === 'openai' ? [{ type: 'web_search', name: 'web_search' }] : []
    const system = buildCollabSystem(
      x.roleId,
      roster.filter((r) => r.id !== x.roleId),
      x.cwd,
    )
    const sessionDir = join(dataDir(), 'sessions', convId, x.roleId)
    return {
      roleId: x.roleId,
      name: roster.find((r) => r.id === x.roleId)?.name ?? x.roleId,
      initialPrompt: x.initialPrompt,
      runTurn: async (messages, collab, sig) => {
        hooks.onExpertActive?.(x.roleId, true) // expert is actively working this turn → show its live readout
        // The gen loop below has its own try/finally that clears the readout; guard the one await BEFORE it
        // (mkdir) too, so an mkdir rejection (ENOSPC/EROFS/EACCES) can't leave the bubble stuck on "Thinking…".
        try {
          await mkdir(join(sessionDir, 'tool-results'), { recursive: true })
        } catch (e) {
          hooks.onExpertActive?.(x.roleId, false)
          throw e
        }
        const ctx: AgentContext = {
          cwd: x.cwd,
          signal: sig,
          roleId: x.roleId,
          readFileState,
          permissionMode: x.permissionMode ?? 'default',
          requestPermission: (req, s) => hooks.requestPermission(x.roleId, req, s),
          todos,
          // Per-expert live push to the Tasks panel (was missing → empty collab panel). roleId tags the writer so
          // the panel groups by owner; ctx.setTodos stays (todos)=>void (TodoWrite calls it with just the list).
          setTodos: hooks.onTodos ? (next) => hooks.onTodos!(x.roleId, next) : undefined,
          sessionDir,
          collab,
          services: registry,
          lsp,
          // panel_examine bridge (panel-examine §4.1 / closure-loop decision ⑤): collab is precisely the
          // from-scratch / cross-cutting work the tool targets. Inject the handle iff the expert's kit carries the
          // panel_examine tool (every agent role now does) — handle-presence ⟺ tool-presence, same guard as the
          // single-run path. Captures the collab convId/cwd/sig + the expert's hooks.
          panel: tools.some((t) => t.name === 'panel_examine')
            ? createPanelHandle({
                convId,
                callerRoleId: x.roleId,
                cwd: x.cwd,
                permissionMode: x.permissionMode ?? 'default',
                signal: sig,
                onStream: (ev) => hooks.onExpertStream(x.roleId, ev),
                requestPermission: (req, s) => hooks.requestPermission(x.roleId, req, s)
              })
            : undefined,
          onSubAgentToolEvent: (ev) => hooks.onExpertStream(x.roleId, ev),
        }
        const gen = runAgent({
          protocol: x.protocol,
          baseUrl: x.baseUrl,
          apiKey: x.apiKey,
          model: x.model,
          system,
          messages,
          tools,
          serverTools,
          ctx,
          contextWindow: x.contextWindow ?? 200_000,
          thinking: x.thinking,
          onStream: (ev) => hooks.onExpertStream(x.roleId, ev),
        })
        let result!: AgentResult
        let turnIn = 0 // total incl. cache → billing
        let turnContext = 0 // last turn's context size → display (overwrite)
        let turnCacheRead = 0 // last turn's cache-read share → display (overwrite)
        let turnOut = 0
        try {
          for (;;) {
            const { value, done } = await gen.next()
            if (done) {
              result = value
              break
            }
            // Emit the same tool:pre/post audit trail as runAgentLoop, so a collaboration's tool usage is
            // observable too (previously a gap — collab experts don't go through runAgentLoop).
            if (value.type === 'assistant') {
              turnIn += promptTokensFromUsage(value.usage) // total incl. cache → billing
              turnContext = promptTokensFromUsage(value.usage) // current context size (last turn's prompt) — overwrite
              turnCacheRead = value.usage.cacheReadTokens ?? 0 // cache-read share of last turn — overwrite
              turnOut += value.usage.outTokens
              for (const b of value.message.content) {
                if (isContentBlock(b) && b.type === 'tool_use') {
                  toolNames.set(b.id, b.name)
                  agentEvents.emit({ type: 'tool:pre', convId, roleId: x.roleId, tool: b.name, ts: Date.now() })
                }
              }
            } else if (value.type === 'tool_results') {
              for (const b of value.message.content) {
                if (isContentBlock(b) && b.type === 'tool_result') {
                  agentEvents.emit({ type: 'tool:post', convId, roleId: x.roleId, tool: toolNames.get(b.tool_use_id) ?? 'unknown', isError: b.is_error ?? false, ts: Date.now() })
                }
              }
            }
            hooks.onExpertEvent(x.roleId, value)
          }
        } finally {
          // Clear the live readout when the turn ends — on a normal park AND on a thrown/aborted turn (gen.next()
          // rejecting). Without the finally, an errored expert's bubble hangs on "Thinking…" until session end.
          hooks.onExpertActive?.(x.roleId, false) // turn batch finished → the expert parks; hide its live readout
        }
        inTokensByRole.set(x.roleId, (inTokensByRole.get(x.roleId) ?? 0) + turnIn)
        contextByRole.set(x.roleId, turnContext) // overwrite with this run's last context size (not accumulated)
        cacheReadByRole.set(x.roleId, turnCacheRead) // overwrite with this run's last cache-read share
        outTokensByRole.set(x.roleId, (outTokensByRole.get(x.roleId) ?? 0) + turnOut)
        reasonByRole.set(x.roleId, result.reason)
        return result.messages
      },
    }
  })
  // phase 5c-C3: snapshot the live services on every collab event so an open ProjectDetail shows them as
  // they come up; clear on teardown when the registry is disposed.
  const onEvent = (e: CollabEvent): void => {
    hooks.onEvent(e)
    hooks.onServices?.(registry.list())
  }
  try {
    const texts = await new CollabSession(specs, onEvent, nowMs).run(signal)
    return new Map(
      [...texts].map(([roleId, text]): [string, { text: string; reason: AgentResult['reason']; inTokens: number; contextTokens: number; cacheReadTokens: number; outTokens: number }] => [roleId, { text, reason: reasonByRole.get(roleId) ?? 'completed', inTokens: inTokensByRole.get(roleId) ?? 0, contextTokens: contextByRole.get(roleId) ?? 0, cacheReadTokens: cacheReadByRole.get(roleId) ?? 0, outTokens: outTokensByRole.get(roleId) ?? 0 }])
    )
  } finally {
    hooks.onServices?.([])
    clearActiveServices(convId, registry)
    broadcastConvServices(convId, []) // clear the Tasks panel's Services section on teardown
    registry.dispose() // tree-kill every service the collaboration started — no lingering ports
    for (const lsp of lspByExpert) lsp.dispose() // tree-kill each expert's language server
  }
}
