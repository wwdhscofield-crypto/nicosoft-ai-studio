// Run a collaboration (collaborate mode — doc 19 §5): resolve each agent expert's binding, hand them all
// the same task as a CollabSession, and bridge their concurrent activity (text deltas + tool cards +
// approvals) to the per-role coordinator callbacks. Persists each expert's final reply (tagged with the
// chain) and returns them for synthesis. Experts coordinate among themselves via the consult tools — those
// calls surface as ordinary tool cards (onToolEvent); the richer orchestration-tree event stream (onEvent)
// is wired to the UI in phase 5. A Gemini-backed expert is skipped (the agent loop is Anthropic/OpenAI only).

import * as endpointRepo from '../repos/endpoint.repo'
import * as keychain from '../keychain/keychain'
import * as rolesService from './roles.service'
import * as agentService from './agent-collab'
import * as convService from './conversation.service'
import * as collabProject from './collab-project.service'
import { resolveDepth } from '../llm/thinking'
import { protocolFamily } from '@shared/thinking'
import { isContentBlock } from '../agent/types'
import { LlmError } from '../llm/types'
import { coordinatorApproval } from './coordinator-approvals'
import type { CoordinatorCallbacks, CoordinatorRunInput } from './coordinator-types'
import type { AgentResult } from '../agent/loop'
import type { StudioLensResult } from '../agent/context'

export async function runCollaboration(
  input: CoordinatorRunInput,
  roleIds: string[],
  fullChain: string[],
  cb: CoordinatorCallbacks,
  signal: AbortSignal,
  project?: collabProject.CollabProject,
): Promise<{ outputs: { role: string; text: string; reason: AgentResult['reason'] }[]; reasons: AgentResult['reason'][]; panelResult?: StudioLensResult }> {
  const experts: agentService.CollabExpertInput[] = []
  const models = new Map<string, string>()
  for (const roleId of roleIds) {
    const binding = rolesService.getBinding(roleId)
    if (!binding?.endpointId || !binding.model) continue
    const ep = endpointRepo.getById(binding.endpointId)
    if (!ep?.enabled) continue
    const apiKey = keychain.getApiKey(binding.endpointId)
    if (!apiKey) continue
    // Collaboration runs Anthropic/OpenAI experts only — a gemini-bound role is skipped (CollabSession
    // doesn't drive the Gemini tool loop yet), so don't collapse this to a bare protocolFamily() gate.
    const family = protocolFamily(ep.protocol)
    const protocol = family === 'gemini' ? null : family
    if (!protocol) continue
    models.set(roleId, binding.model)
    cb.onStepStart(roleId, fullChain, binding.model)
    experts.push({
      roleId,
      initialPrompt: input.prompt,
      cwd: input.cwdByRole?.[roleId] ?? '',
      protocol,
      baseUrl: ep.baseUrl,
      apiKey,
      model: binding.model,
      // B1/#3: real window for this expert's autocompact threshold (else agent-collab falls back to 200K,
      // so proactive compaction never fires for a sub-200K-bound expert). `|| undefined` preserves that fallback for 0.
      contextWindow: ep.availableModels.find((m) => m.slug === binding.model)?.contextLength || undefined,
      permissionMode: input.modeByRole?.[roleId],
      thinking: resolveDepth(ep.protocol, binding.model, binding.thinkingDepth)
    })
  }
  if (experts.length < 2) throw new LlmError('bad_request', 'collaboration needs at least 2 bound agent experts')

  const hooks: agentService.CollabHooks = {
    onEvent: (e) => {
      // phase 5c: a collab event that moves task state (turn/done) refetches an open ProjectDetail so lanes
      // change in real time. send/assign/wait/wake don't move tasks → no push (consult arrows in phase 5c-B).
      if (project && collabProject.applyCollabEvent(project, e)) cb.onProjectUpdated?.(project.projectId)
    },
    // phase 5c-C3: forward the collaboration's live dev services to the project workbench.
    onServices: (services) => {
      if (project) cb.onServices?.(project.projectId, services.map((s) => ({ name: s.name, port: s.port, status: s.status })))
    },
    // Per-expert live TodoWrite push → the coordinator UI's Tasks panel (groups by owner). cb.onTodos →
    // coordinator.handler broadcastConvTodos(convId, roleId, todos) + recordTodos.
    onTodos: (roleId, todos) => cb.onTodos?.(roleId, todos),
    onExpertActive: (roleId, active) => cb.onExpertActive?.(roleId, active),
    // Forward the expert's fine-grained stream to the coordinator UI. EXHAUSTIVE over AgentLlmEvent
    // (agent/llm.ts) on purpose: the tool/sub_tool lifecycle must reach the renderer the SAME way the
    // solo path forwards it (agent.handler onStream), so a collab expert's studio_lens fan-out and its
    // Task sub-agents render their sub-tool cards instead of being silently dropped at this seam. The
    // `never` default turns a newly-added stream event type into a compile error here rather than a
    // silent collab-only UI gap — that omission (sub_tool_* fell through the old if/else) WAS the bug.
    onExpertStream: (roleId, ev) => {
      switch (ev.type) {
        case 'text':
          cb.onDelta(roleId, ev.delta)
          break
        case 'reasoning':
          cb.onReasoning?.(roleId, ev.delta)
          break
        case 'tool_use_start':
          cb.onToolStart?.(roleId, ev.id, ev.name)
          break
        case 'sub_tool_start':
        case 'sub_tool_done':
        case 'sub_tool_delta':
        case 'sub_tool_progress':
          // Canonical sub-tool sink: coordinator.handler onToolEvent → coordinator:sub-tool:* → renderer
          // PanelCard (anchored by roleId) — the SAME path the coordinator's own Gate-B panel uses.
          // onExpertEvent routes AgentEvent tool activity here; the fine-grained sub_tool lifecycle
          // (AgentLlmEvent, from a studio_lens fan-out or a Task sub-agent) must too.
          cb.onToolEvent?.(roleId, ev)
          break
        case 'usage':
          cb.onUsage?.(roleId, ev.inputTokens, ev.outputTokens, ev.cachedTokens)
          break
        case 'turn-final':
          cb.onTurnFinalUsage?.(ev.usage)
          break
        case 'tool_use_input':
          // Streaming tool-call JSON — not surfaced live (matches the solo path, agent.handler onStream,
          // which also drops it). Explicit case so it stays a decision, not a silent omission.
          break
        default: {
          const _exhaustive: never = ev
          void _exhaustive
        }
      }
    },
    onExpertEvent: (roleId, ev) => {
      // Tool-card timeline (doc 19): persist each expert tool call onto the project as it streams, so the
      // Workbench lane shows a live READ/WRITE/BASH timeline. assistant events carry the tool_use blocks.
      if (project && ev.type === 'assistant') {
        const cwd = experts.find((e) => e.roleId === roleId)?.cwd ?? ''
        for (const b of ev.message.content) {
          if (isContentBlock(b) && b.type === 'tool_use') collabProject.recordToolEvent(project, roleId, b.name, b.input, cwd, b.id)
        }
        cb.onProjectUpdated?.(project.projectId)
      }
      cb.onToolEvent?.(roleId, ev)
    },
    // phase 4: coordinator self-approves each expert's tool via the safety classifier (doc §8) — green/yellow
    // auto-run (yellow worth surfacing), red hard-denied + recorded for the user to approve later. cwd is the
    // requesting expert's own (red-zone replay needs it).
    requestPermission: (roleId, req) =>
      coordinatorApproval(input.convId, roleId, experts.find((e) => e.roleId === roleId)?.cwd ?? '', req, cb, input.prompt)
  }
  const { results, panelResult } = await agentService.runCollabSession(input.convId, experts, hooks, signal, () => Date.now())

  const outputs: { role: string; text: string; reason: AgentResult['reason'] }[] = []
  const reasons: AgentResult['reason'][] = [] // every expert's terminal reason, independent of the text gate
  for (const [roleId, { text, reason, inTokens, contextTokens, cacheReadTokens, outTokens }] of results) {
    reasons.push(reason) // capture even an empty-text silent failure (incomplete / thrash_stop) so it bubbles up
    if (text) {
      convService.append(input.convId, {
        author: 'expert',
        expertId: roleId,
        model: models.get(roleId) ?? '',
        content: text,
        inputTokens: contextTokens, // DISPLAY: current context size (last turn, overwrite — drives the "/ window" meter)
        cacheReadTokens, // cache-read share of that last turn — persistent "(+N cached)" note
        outputTokens: outTokens,
        sentTokens: inTokens, // SETTLE ↑: cumulative billing input across this expert's collab turns (total sent)
        dispatch: fullChain
      })
      outputs.push({ role: roleId, text, reason })
    }
    cb.onStepDone(roleId, text, contextTokens, outTokens, inTokens)
  }
  return { outputs, reasons, panelResult }
}
