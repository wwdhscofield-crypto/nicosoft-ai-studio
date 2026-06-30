// Multi-expert collaboration (consult — doc 19 §5 / §11 phase 3): run a set of experts as a
// CollabSession — each a persistent, mailbox-driven agent loop, scheduled concurrently and coordinating
// via send_message/assign_task/wait. Returns each expert's final text for the coordinator to synthesize;
// persistence stays with the caller (coordinator-collab).

import { mkdir } from 'node:fs/promises'
import { dataDir } from '../db/connection'
import { ulid } from '../db/id'
import { join } from 'node:path'
import type { AgentContext, PermissionRequest, PermissionDecision } from '../agent/context'
import type { AgentLlmEvent } from '../agent/llm'
import { MAIN_DISPATCH_STALL_TIMEOUT_MS, runAgent, type AgentEvent, type AgentResult, type CompactCarry } from '../agent/loop'
import { promptTokensFromUsage } from '../agent/compact'
import { isContentBlock } from '../agent/types'
import type { AgentMessage, ServerToolSchema } from '../agent/types'
import { displayName, ROLE_BLURB } from '../agent/roles/prompts'
import { sendMessageTool, assignTaskTool, waitTool } from '../agent/tools/consult'
import { CollabSession, type ExpertSpec, type CollabEvent } from '../agent/collab'
import { runHooks } from '../agent/hooks/engine'
import { hookRegistry } from '../agent/hooks/registry'
import { baseHookPayload, hookContextFromAgent } from '../agent/hooks/adapter'
import { AsyncRegistry, formatAsyncHandle } from '../agent/async-registry'
import { sessionBus } from '../agent/session-bus'
import { awaitAsyncTool } from '../agent/tools/await-async'
import { launchAsyncTool } from '../agent/tools/launch-async'
import { ServiceRegistry, type ServiceInfo } from '../agent/service-registry'
import { LSPManager } from '../agent/lsp/manager'
import { startServiceTool, stopServiceTool, serviceLogsTool, listServicesTool } from '../agent/tools/service'
import { lspTool } from '../agent/tools/lsp'
import { disposePlaywrightSessionsOwnedBy } from '../agent/tools/playwright-browser'
import type { Tool } from '../agent/tool'
import type { AgentRunInput } from '../ipc/contracts'
import { agentEvents } from './event-bus'
import { manager as skillManager } from './skill.service'
import { DEV_ROLES, PLAYWRIGHT_TOOLS, PREVIEW_AGENT_TOOLS, toolsForAgentRole } from './agent-tools'
import { monitorService } from './monitor.service'
import { selfRhythmService } from './self-rhythm.service'
import { buildAgentSystem } from './agent-system'
import { createLensHandle } from './lens/agent-lens'
import { setActiveServices, clearActiveServices, broadcastConvServices } from './active-services'
import { createPreviewHandle } from './active-preview'
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
function assistantVisibleText(message: AgentMessage): string {
  return message.content
    .filter((b): b is { type: 'text'; text: string } => isContentBlock(b) && b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function replaceAssistantDisplay(message: AgentMessage, text: string): AgentMessage {
  const nonText = message.content.filter((b) => !(isContentBlock(b) && b.type === 'text'))
  return { ...message, content: [{ type: 'text', text }, ...nonText] }
}

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
  // The studio_lens reviewer (chooseVerifierRole) runs NESTED inside a builder's turn (ctx.panel), so it is not
  // a top-level expert — these forward its OWN step lifecycle to the coordinator (→ cb.onStepStart/onStepDone)
  // so it gets a verifier chat bubble the same way Gate-B's reviewer does. Active reuses onExpertActive.
  onReviewerStepStart?: (roleId: string, dispatch: string[] | null, model: string) => void
  onReviewerStepDone?: (roleId: string, text: string) => void
  requestPermission: (roleId: string, req: PermissionRequest, signal?: AbortSignal) => Promise<PermissionDecision>
  // phase 5c-C3: snapshot of the live dev services the collaboration started (empty when none / on teardown).
  onServices?: (services: ServiceInfo[]) => void
}

// The role's coding/section prompt + a "working as a team" addendum naming the reachable teammates, so the
// expert knows who to consult and to stay in its own area. Memories/summary are skipped — a collaboration
// is a fresh shared task, not a continuation of the role's chat history.
function buildCollabSystem(roleId: string, teammates: { id: string; name: string }[], cwd?: string): string {
  // A single-expert "collab" (no teammates) behaves like SOLO: keep the solo studio_lens-before-done discipline
  // and let it drive its own review ANYTIME — there is no one to elect among or wait for. The elected-driver /
  // wait-for-everyone flow below only applies with ≥1 teammate (2+ experts).
  if (teammates.length === 0) return buildAgentSystem(roleId, [], null, skillManager.listingForRole(roleId), cwd, false)
  const base = buildAgentSystem(roleId, [], null, skillManager.listingForRole(roleId), cwd, true) // collab=true (2+ experts): skip the SOLO "every agent self-runs studio_lens before done" discipline — only the ELECTED driver runs the ONE consolidated panel AFTER everyone is done, not each expert and not early (the per-expert flood AND the premature drive were the bugs)
  // Roster lists each teammate by NAME + a domain blurb (what they do) — NEVER the role_id. The model addresses
  // teammates by name everywhere (prose, todos, and the consult tools, which take a name). Exposing the role_id
  // here made a weak model parrot it ("the frontend teammate" instead of "Shuri").
  const roster = teammates.map((t) => `- ${t.name} — ${ROLE_BLURB[t.id] ?? 'specialist'}`).join('\n')
  return (
    base +
    '\n\n## Working as a team\n' +
    'You are collaborating with other experts on one shared project, working in parallel — each owns part ' +
    'of it. Your teammates:\n' +
    roster +
    '\n\nAlways refer to a teammate by their NAME (the names listed above) — in your todos, messages, and prose, ' +
    'and as the send_message / assign_task target. Never call a teammate by their domain ("the frontend") or any ' +
    'internal id; use the name.' +
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
    // C2: open with a non-overlapping-scope handshake so two experts don't touch the same files (P4). The review
    // driver is also decided HERE, up front (user spec) — not left for the end, so no one spins a premature panel.
    '\n\n## Align before you build — FIRST divide the modules, THEN pick the review driver\n' +
    'Before you write ANY code, sync with your teammates via send_message / assign_task and settle these IN ORDER:\n' +
    'FIRST — divide the work into NON-overlapping modules: agree the exact boundary of who OWNS / IMPLEMENTS what ' +
    '(e.g. backend owns the main process / IPC / services; frontend owns the renderer / UI) and split your todos so ' +
    'they do NOT collide. Be explicit — every area has exactly one owner, no two of you touching the same files.\n' +
    "THEN — now that you know who owns the bigger / riskier surface, DECIDE who will drive the team's ONE final " +
    'consolidated studio_lens review (see below), and say it out loud so everyone agrees.\n' +
    'Both are settled BEFORE the work starts — module ownership first, then the review driver; never leave the ' +
    "driver for the end. Build only within your agreed scope; never edit a teammate's files.\n\n" +
    // The collab review is TIMED + SINGLE-DRIVER: elect one, run it only AFTER everyone is done, finished-first
    // self-checks + waits (never a premature panel — the dogfood waste), findings distributed to owners.
    '## Review in a collaboration — ONE driver, ONLY after EVERY teammate is done\n' +
    'You each have studio_lens, but on a team you do NOT each run it, and you do NOT run it early. The rules:\n' +
    '1. The ONE driver was already DECIDED in your opening alignment, before any code (above) — that person, and ' +
    "only that person, runs the team's ONE consolidated review at the END. If you are NOT that driver, you NEVER " +
    'run the consolidated review — not your own, not ever; your ONLY review duty is to self-check your part and ' +
    'tell the driver when you are done. So word your review-related todo as "self-check my part + confirm done to ' +
    '<driver>" — do NOT give yourself a "drive the consolidated review" todo; only the one elected driver carries ' +
    'that. (If you somehow did not settle the driver up front, settle it NOW via send_message before anyone ' +
    'reviews — never just start a panel.)\n' +
    '2. As you build, SELF-CHECK your own part: your own type-check / build + a careful re-read after each batch, and ' +
    'FIX your own issues. That self-check IS your review of your own code — it is NOT a studio_lens run.\n' +
    '3. If you FINISH FIRST while a teammate is still working: do NOT run studio_lens. Self-check and fix your own ' +
    'part, then send_message that you are done and wait() / keep coordinating until the others finish. Driving a ' +
    'panel over a half-built tree (a teammate still mid-change) wastes the ENTIRE fan-out — that is exactly the ' +
    'waste to avoid.\n' +
    '4. ONLY after EVERY teammate has confirmed their COMPLETE part is done does the ELECTED driver run studio_lens ' +
    'ONCE over the WHOLE combined change (all files, review mode): launch it as an async handle, report it started ' +
    '(name the handle + what it covers, like driving a workflow), await_async it to SUSPEND until the verdict, report it.\n' +
    '5. studio_lens is your TEAM self-check: the driver IS the reviewer of your own combined change, and its finder ' +
    'fan-out hunts defects from many independent angles — that multi-perspective hunt is its value, not who reviews. ' +
    'DISTRIBUTE the findings: each confirmed defect goes to the expert who OWNS that file / area; that owner FIXES it ' +
    '— ONE round. Then you are done. Do NOT re-run the review to "confirm" or loop until spotless: disposition each ' +
    'finding once (fix a real defect at its ROOT; refute a false alarm in one line and leave correct code AS-IS).\n' +
    '(This panel is the TEAM reviewing ITSELF — the driver is the reviewer, so it is NOT an independent audit and is ' +
    'not meant to be. Independence comes LATER and SEPARATELY: once you ALL finish, the coordinator routes the ' +
    'combined result to ONE reviewer independent of every collaborator for the single final audit, then closes with ' +
    'that verdict in hand. So your job here is a thorough team self-check + one fix round — never a fix-until-spotless loop.)' +
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
): Promise<{ results: Map<string, { text: string; reason: AgentResult['reason']; inTokens: number; contextTokens: number; cacheReadTokens: number; outTokens: number }> }> {
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
  const emitCollabHook = (event: 'TeammateIdle' | 'TaskCreated' | 'TaskCompleted', payload: Record<string, unknown>): void => {
    if (!hookRegistry.hasAny(event)) return
    const first = experts[0]
    const hookCtx: AgentContext = {
      cwd: first?.cwd ?? process.cwd(),
      signal,
      roleId: first?.roleId,
      convId,
      permissionMode: first?.permissionMode ?? 'default',
      sessionDir: join(dataDir(), 'sessions', convId),
      readFileState: new Map(),
      requestPermission: async () => ({ allow: false, message: 'Collaboration lifecycle hooks cannot request tool permissions.' }),
      todos: [],
    }
    void runHooks(event, { ...baseHookPayload(event, hookCtx), ...payload }, hookContextFromAgent(hookCtx)).catch(() => undefined)
  }
  const submittedPromptByRole = new Map<string, string>()
  if (hookRegistry.hasAny('UserPromptSubmit')) {
    await Promise.all(experts.map(async (x) => {
      const hookCtx: AgentContext = {
        cwd: x.cwd,
        signal,
        roleId: x.roleId,
        convId,
        permissionMode: x.permissionMode ?? 'default',
        sessionDir: join(dataDir(), 'sessions', convId, x.roleId),
        readFileState: new Map(),
        requestPermission: async () => ({ allow: false, message: 'Hooks cannot request tool permissions during prompt submission.' }),
        todos: [],
      }
      const promptHook = await runHooks(
        'UserPromptSubmit',
        { ...baseHookPayload('UserPromptSubmit', hookCtx), prompt: x.initialPrompt, session_title: undefined },
        hookContextFromAgent(hookCtx),
      )
      if (promptHook.permissionBehavior === 'deny') throw new Error(promptHook.permissionReason ?? (promptHook.blockingErrors.join('; ') || 'User prompt blocked by hook'))
      const rewritten = typeof promptHook.updatedInput?.prompt === 'string' ? promptHook.updatedInput.prompt : undefined
      const contexts = promptHook.additionalContexts
      const prompt = promptHook.suppressOriginalPrompt
        ? rewritten ?? (contexts.join('\n\n') || '[original prompt suppressed by hook]')
        : [rewritten ?? x.initialPrompt, ...contexts].filter(Boolean).join('\n\n')
      submittedPromptByRole.set(x.roleId, prompt)
    }))
  }
  const lspByExpert: LSPManager[] = [] // one per dev expert; tree-killed in the finally
  const runIdsByExpert: string[] = []
  const specs: ExpertSpec[] = experts.map((x) => {
    // Per-expert state shared across its turns: the read-file cache + todo list persist as it loops, so it
    // doesn't forget what it read between being woken.
    const readFileState: AgentContext['readFileState'] = new Map()
    const todos: AgentContext['todos'] = []
    // §4a — the compaction anchor persists across this expert's mailbox wakes. Each wake seeds runAgent with
    // it so the turn-1 estimate sees the expert's TRUE cumulative context (not char/4 of one wake) → autocompact
    // fires on time instead of overshooting. Starts empty → the first wake behaves exactly as before.
    let compactCarry: CompactCarry = { usageAt: 0, autoFails: 0 }
    const toolNames = new Map<string, string>() // tool_use id → name, to pair tool:post with its tool (audit)
    const runId = ulid()
    runIdsByExpert.push(runId)
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
      ...(DEV_ROLES.has(x.roleId) ? [lspTool as unknown as Tool, ...PLAYWRIGHT_TOOLS, ...PREVIEW_AGENT_TOOLS] : [])
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
      initialPrompt: submittedPromptByRole.get(x.roleId) ?? x.initialPrompt,
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
          runId,
          roleId: x.roleId,
          convId, // session-scoped tools (monitor_*) key off it; injectExternal routes the wakeup back to this expert
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
          preview: DEV_ROLES.has(x.roleId) ? createPreviewHandle(convId, sig) : undefined,
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
                requestPermission: (req, s) => hooks.requestPermission(x.roleId, req, s),
                // Reviewer bubble (③b): forward its step lifecycle out so a ctx.panel-driven review surfaces a
                // verifier bubble. Presence of onReviewerStepStart also gates persistence (solo leaves it unset).
                onReviewerStepStart: hooks.onReviewerStepStart,
                onReviewerStepDone: hooks.onReviewerStepDone,
                onReviewerActive: hooks.onExpertActive,
                // Collab team self-check (collab-review-flow §A): the elected driver reviews the team's OWN combined
                // change → reviewer = the driver itself, not chooseVerifierRole's independent pick. Independence comes
                // later from Danny's single Turing final audit (runCollabReview), not from this in-team panel.
                reviewerOverride: x.roleId
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
          seedCompact: compactCarry, // §4a — carry the anchor in from the prior wake
          stallTimeoutMs: MAIN_DISPATCH_STALL_TIMEOUT_MS,
          // No turn cap: a collab expert is bounded by autocompact + microcompact (loop.ts), like CC/codex —
          // never a fixed turn limit that would kill a big task mid-build. A genuine runaway is contained by the
          // renderer error boundary + autocompact keeping context bounded, not by aborting the work.
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
            let emitted = value
            if (emitted.type === 'assistant' && hookRegistry.hasAny('MessageDisplay')) {
              const md = await runHooks(
                'MessageDisplay',
                { ...baseHookPayload('MessageDisplay', ctx), turn_id: ctx.runId ?? `${convId}:${x.roleId}`, message_id: `${ctx.runId ?? x.roleId}:${turnOut}`, index: turnOut, final: true, delta: assistantVisibleText(emitted.message) },
                hookContextFromAgent(ctx),
              )
              if (md.permissionBehavior === 'deny') continue
              if (md.displayContent !== undefined) emitted = { ...emitted, message: replaceAssistantDisplay(emitted.message, md.displayContent) }
            }
            hooks.onExpertEvent(x.roleId, emitted)
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
        compactCarry = result.compact // §4a — hand the anchor to the next wake
        return result.messages
      },
    }
  })
  // phase 5c-C3: snapshot the live services on every collab event so an open ProjectDetail shows them as
  // they come up; clear on teardown when the registry is disposed.
  const onEvent = (e: CollabEvent): void => {
    hooks.onEvent(e)
    // teammate_name is a NAME field → use displayName, never the role_id (task_id stays an internal id).
    if (e.kind === 'wait') emitCollabHook('TeammateIdle', { teammate_name: displayName(e.roleId), team_name: 'collab' })
    else if (e.kind === 'assign') emitCollabHook('TaskCreated', { task_id: `${e.roleId}:${e.to}:${Date.now()}`, task_subject: e.text, task_description: e.text, teammate_name: e.to ? displayName(e.to) : '', team_name: 'collab' })
    else if (e.kind === 'done') emitCollabHook('TaskCompleted', { task_id: e.roleId, task_subject: `${displayName(e.roleId)} completed their part`, teammate_name: displayName(e.roleId), team_name: 'collab' })
    hooks.onServices?.(registry.list())
  }
  try {
    // hasKeepalive lets the session block its own quiescence while a session-level keepalive reason holds (an
    // armed Monitor) — the collaboration stays open for injected wakeups until the reason clears.
    const session = new CollabSession(specs, onEvent, nowMs, () => sessionBus.hasKeepalive(convId))
    // C3 §6.5 (批8): route async-handle completions into the session so it wakes the parked expert + injects the
    // result (notifyHandleComplete → runExpert T1). Set before run() so a fast handle can't fire before it's wired.
    asyncRegistry.onComplete = (h) => session.notifyHandleComplete(h.id, formatAsyncHandle(h))
    // Unified session bus: an injection (Monitor / hook / scheduled wakeup) wakes a parked expert and seeds the
    // note as its next turn (injectExternal); when the last keepalive reason is removed, re-check quiescence so a
    // session held open only by a Monitor can end. Collab does NOT mark the bus active — it leaves running-vs-
    // parked serialization to its own scheduler, so an inject delivers immediately instead of waiting for idle.
    sessionBus.armDelivery(convId, (note, roleId) => session.injectExternal(note, roleId))
    sessionBus.armIdleCheck(convId, () => session.pokeSettle())
    const texts = await session.run(signal)
    // collab-review-flow: the elected driver ran studio_lens as the TEAM's self-check from its OWN turn (reviewer =
    // the driver), surfaced in chat as the driver's own tool call + handled by owners during the build. Its verdict
    // is NOT threaded to the coordinator anymore — the post-collab pass is the ONE independent Turing final audit
    // (runCollabReview), not a re-run seeded by this panel. So nothing to extract here.
    const results = new Map(
      [...texts].map(([roleId, text]): [string, { text: string; reason: AgentResult['reason']; inTokens: number; contextTokens: number; cacheReadTokens: number; outTokens: number }] => [roleId, { text, reason: reasonByRole.get(roleId) ?? 'completed', inTokens: inTokensByRole.get(roleId) ?? 0, contextTokens: contextByRole.get(roleId) ?? 0, cacheReadTokens: cacheReadByRole.get(roleId) ?? 0, outTokens: outTokensByRole.get(roleId) ?? 0 }])
    )
    return { results }
  } finally {
    // Unarm the bus delivery + idle-check so a late injection can't try to wake a torn-down session, then dispose
    // any session-scoped Monitor / self-wakeup armed during this collaboration. A collaboration only reaches
    // teardown with a Monitor still armed via abort / all-experts-error — a Monitor's keepalive otherwise blocks
    // quiescence — and once delivery is unarmed the watcher can wake nobody, so a surviving Monitor would leak its
    // probe timer AND its `monitor:<id>` keepalive. That keepalive is convId-global, so it would wedge the NEXT
    // collaboration on this conv (hasKeepalive stays true → it never quiesces → run() never resolves) and grow the
    // bus queue unbounded. disposeForConv is idempotent and clears each watcher's timer + keepalive (manual stop,
    // no inject), so it is safe even when nothing was armed.
    sessionBus.armDelivery(convId, undefined)
    sessionBus.armIdleCheck(convId, undefined)
    monitorService.disposeForConv(convId)
    selfRhythmService.disposeForConv(convId)
    hooks.onServices?.([])
    clearActiveServices(convId, registry)
    broadcastConvServices(convId, []) // clear the Tasks panel's Services section on teardown
    registry.dispose() // tree-kill every service the collaboration started — no lingering ports
    asyncRegistry.dispose() // tree-kill any still-running launch_async op, INCLUDING unawaited ones — a normal quiescent end never aborts the signal, so this is the only cleanup hook
    await Promise.allSettled(runIdsByExpert.map((runId) => disposePlaywrightSessionsOwnedBy(runId)))
    for (const lsp of lspByExpert) lsp.dispose() // tree-kill each expert's language server
  }
}
