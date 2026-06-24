// Multi-expert collaboration (consult — doc 19 §5 / §11 phase 3): run a set of experts as a
// CollabSession — each a persistent, mailbox-driven agent loop, scheduled concurrently and coordinating
// via send_message/assign_task/wait. Returns each expert's final text for the coordinator to synthesize;
// persistence stays with the caller (coordinator-collab).

import { mkdir } from 'node:fs/promises'
import { dataDir } from '../db/connection'
import { join } from 'node:path'
import type { AgentContext, PermissionRequest, PermissionDecision, StudioLensResult } from '../agent/context'
import type { AgentLlmEvent } from '../agent/llm'
import { runAgent, type AgentEvent, type AgentResult } from '../agent/loop'
import { promptTokensFromUsage } from '../agent/compact'
import { isContentBlock } from '../agent/types'
import type { ServerToolSchema } from '../agent/types'
import { displayName } from '../agent/roles/prompts'
import { sendMessageTool, assignTaskTool, waitTool } from '../agent/tools/consult'
import { CollabSession, type ExpertSpec, type CollabEvent } from '../agent/collab'
import { AsyncRegistry, formatAsyncHandle } from '../agent/async-registry'
import { awaitAsyncTool } from '../agent/tools/await-async'
import { launchAsyncTool } from '../agent/tools/launch-async'
import { ServiceRegistry, type ServiceInfo } from '../agent/service-registry'
import { LSPManager } from '../agent/lsp/manager'
import { startServiceTool, stopServiceTool, serviceLogsTool, listServicesTool } from '../agent/tools/service'
import { lspTool } from '../agent/tools/lsp'
import type { Tool } from '../agent/tool'
import type { AgentRunInput } from '../ipc/contracts'
import { agentEvents } from './event-bus'
import { manager as skillManager } from './skill.service'
import { DEV_ROLES, E2E_TOOLS, toolsForAgentRole } from './agent-tools'
import { buildAgentSystem } from './agent-system'
import { createLensHandle } from './lens/agent-lens'
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
  const base = buildAgentSystem(roleId, [], null, skillManager.listingForRole(roleId), cwd, true) // collab=true: skip the SOLO "every agent self-runs studio_lens before done" discipline — in a collab only the ELECTED driver runs the ONE consolidated panel (批C), not each expert (the per-expert flood was P1)
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
    "genuinely, fully done; only then finish, and the coordinator collects everyone's results and reviews." +
    // C2: open with a non-overlapping-scope handshake so two experts don't touch the same files (P4).
    '\n\n## Align before you build — non-overlapping scope\n' +
    'Before you start editing, sync with your teammates: use send_message / assign_task to AGREE the exact ' +
    'boundary of who owns what — NON-overlapping files / areas (e.g. backend owns the main process / IPC / ' +
    'services; frontend owns the renderer / UI) — and split your todos so they do NOT collide. Build only ' +
    "within your agreed scope; never edit a teammate's files. This opening alignment is what prevents two of " +
    'you touching the same files and duplicating or conflicting work.\n\n' +
    // dogfood2 P1/§4.5: collab implementers KEEP studio_lens but do NOT each self-run it — they ELECT one driver.
    '## Review in a collaboration — elect ONE of you to drive it\n' +
    'You DO have studio_lens here — but you do NOT each run your own (N overlapping panels flood the work; that ' +
    'was the bug). Instead, during your opening alignment (or as the work finishes), ELECT ONE of you — agree via ' +
    'send_message, e.g. whoever owns the larger / riskier surface — to drive the team\'s ONE consolidated review. ' +
    'Everyone else: self-check + fix after EACH batch (your own type-check / build + a careful re-read) and finish ' +
    'your COMPLETE part clean, so the review has little left to catch. The ELECTED driver, AFTER every teammate has ' +
    'finished, runs studio_lens ONCE over the WHOLE combined change (all of your files, review mode): it launches ' +
    'as an async handle — REPORT that it started (name the handle + what it covers, like driving a workflow), then ' +
    'await_async it to SUSPEND until the verdict lands, and report the result. The panel\'s own internal reviewers ' +
    'are independent of all of you, so a single elected driver does not compromise the review\'s independence.' +
    // C3 §6.7: tell the collab expert it can launch long ops async and suspend instead of blocking the turn.
    '\n\n## Long ops — launch async and suspend, don\'t block\n' +
    'Any long / event-driven op (a long check / analysis / probe script, a background task) you can run in the ' +
    'BACKGROUND instead of blocking your turn: launch_async starts a READ-ONLY command and returns a handle id ' +
    'immediately; report it started, keep coordinating, then await_async the handle — your turn ENDS and resumes ' +
    'when the op completes (a teammate can still message you meanwhile). Short ops just run inline. For a MUTATING ' +
    'command use Bash (gated, synchronous); for a long-lived server/dev process use start_service.'
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
): Promise<{ results: Map<string, { text: string; reason: AgentResult['reason']; inTokens: number; contextTokens: number; cacheReadTokens: number; outTokens: number }>; panelResult?: StudioLensResult }> {
  // One service registry per collaboration, shared by all its experts (Flynn starts a backend, Shuri
  // lists + connects). Tree-killed in the finally below when the session ends — no zombie ports survive.
  const registry = new ServiceRegistry()
  // One async-op registry per collaboration (C3 §6.2): experts launch long ops as background handles and
  // await_async them. Threaded the session signal so an aborted session cancels any in-flight handle (T3).
  const asyncRegistry = new AsyncRegistry(signal)
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
      // 批B (dogfood2 P1): collab implementers carry studio_lens AGAIN — 批3 had filtered it, which inverted the
      // user's explicit "don't remove studio_lens from collab experts" spec. The election + async-drive of it is
      // wired in 批C; here we just restore the tool so an ELECTED collaborator CAN drive the consolidated review
      // from its own turn. Independence still holds: the panel's internal finders/skeptics are independent roles
      // (driver ≠ reviewers — chooseVerifierRole excludes the implementer set).
      ...toolsForAgentRole(x.roleId),
      sendMessageTool,
      assignTaskTool,
      waitTool,
      awaitAsyncTool,
      launchAsyncTool,
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
      getTodos: () => todos, // 批H (P2): expose the live todo list so the scheduler's hand-off reconcile can check it
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
          async: asyncRegistry,
          lsp,
          // 批B (dogfood2 P1): restore ctx.panel for collab implementers (批3 had nulled it). Solo-style handle so
          // an elected collaborator can drive the consolidated review from its OWN turn (批C wraps the studio_lens
          // tool in ctx.async for non-blocking launch + await_async suspend). Gated on the tool's presence —
          // recursion-guard parity with solo agent-dispatch: no tool → no handle.
          panel: tools.some((t) => t.name === 'studio_lens')
            ? createLensHandle({
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
    const session = new CollabSession(specs, onEvent, nowMs)
    // C3 §6.5 (批8): route async-handle completions into the session so it wakes the parked expert + injects the
    // result (notifyHandleComplete → runExpert T1). Set before run() so a fast handle can't fire before it's wired.
    asyncRegistry.onComplete = (h) => session.notifyHandleComplete(h.id, formatAsyncHandle(h))
    const texts = await session.run(signal)
    // 批D (dogfood2 P1): the elected driver ran the consolidated panel from its OWN turn (批C) → its verdict is the
    // 'panel' handle in the shared async registry. Extract it BEFORE the finally dispose so the coordinator
    // (runCollabReview) uses THIS result instead of self-running a second independent panel (批E). Last completed
    // panel handle = the driver's consolidated review (absent if the team never elected/ran one → 批E falls back).
    const panelHandle = asyncRegistry.list().filter((h) => h.kind === 'lens' && h.status === 'done').pop()
    const panelResult = panelHandle?.result as StudioLensResult | undefined
    const results = new Map(
      [...texts].map(([roleId, text]): [string, { text: string; reason: AgentResult['reason']; inTokens: number; contextTokens: number; cacheReadTokens: number; outTokens: number }] => [roleId, { text, reason: reasonByRole.get(roleId) ?? 'completed', inTokens: inTokensByRole.get(roleId) ?? 0, contextTokens: contextByRole.get(roleId) ?? 0, cacheReadTokens: cacheReadByRole.get(roleId) ?? 0, outTokens: outTokensByRole.get(roleId) ?? 0 }])
    )
    return { results, panelResult }
  } finally {
    hooks.onServices?.([])
    clearActiveServices(convId, registry)
    broadcastConvServices(convId, []) // clear the Tasks panel's Services section on teardown
    registry.dispose() // tree-kill every service the collaboration started — no lingering ports
    asyncRegistry.dispose() // tree-kill any still-running launch_async op, INCLUDING unawaited ones — a normal quiescent end never aborts the signal, so this is the only cleanup hook
    for (const lsp of lspByExpert) lsp.dispose() // tree-kill each expert's language server
  }
}
