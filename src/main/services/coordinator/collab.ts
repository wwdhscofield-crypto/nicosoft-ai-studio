// Run a collaboration (collaborate mode — doc 19 §5): resolve each agent expert's binding, hand them all
// the same task as a CollabSession, and bridge their concurrent activity (text deltas + tool cards +
// approvals) to the per-role coordinator callbacks. Persists each expert's final reply (tagged with the
// chain) and returns them for synthesis. Experts coordinate among themselves via the consult tools — those
// calls surface as ordinary tool cards (onToolEvent); the richer orchestration-tree event stream (onEvent)
// is wired to the UI in phase 5. A Gemini-backed expert is skipped (the agent loop is Anthropic/OpenAI only).

import * as endpointRepo from '../../repos/endpoint.repo'
import * as keychain from '../../keychain/keychain'
import * as rolesService from '../roles.service'
import * as agentService from '../agent-collab'
import * as convService from '../conversation.service'
import * as collabProject from '../collab-project.service'
import { forwardLlmEvent } from '../agent-dispatch'
import { resolveDepth } from '../../llm/thinking'
import { protocolFamily } from '@shared/thinking'
import { isContentBlock } from '../../agent/types'
import { LlmError } from '../../llm/types'
import { coordinatorApproval } from './approvals'
import type { CoordinatorCallbacks, CoordinatorRunInput } from './types'
import type { AgentResult } from '../../agent/loop'

export async function runCollaboration(
  input: CoordinatorRunInput,
  roleIds: string[],
  fullChain: string[],
  cb: CoordinatorCallbacks,
  signal: AbortSignal,
  project?: collabProject.CollabProject,
): Promise<{ outputs: { role: string; text: string; reason: AgentResult['reason'] }[]; reasons: AgentResult['reason'][] }> {
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
    // Forward the expert's fine-grained stream to the coordinator UI through the ONE shared per-verb fan-out
    // (agent-dispatch.forwardLlmEvent) — the coordinator callbacks ARE a RunStreamSink structurally, so the
    // dispatch path, the solo path (agent.handler), and this seam all speak the identical mapping. The old
    // hand-copied switch here is where sub_tool_* once fell through and collab-only sub-tool cards vanished.
    onExpertStream: (roleId, ev) => forwardLlmEvent(cb, roleId, ev),
    // An expert's tool image (already persisted + redacted by the shared drain) → surface live.
    onToolImage: (_roleId, att) => cb.onToolImage?.(att),
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
  const { results } = await agentService.runCollabSession(input.convId, experts, hooks, signal, () => Date.now())

  const outputs: { role: string; text: string; reason: AgentResult['reason'] }[] = []
  const reasons: AgentResult['reason'][] = [] // every expert's terminal reason, independent of the text gate
  for (const [roleId, { text, reason, inTokens, contextTokens, cacheReadTokens, outTokens, runId, attachments }] of results) {
    reasons.push(reason) // capture even an empty-text silent failure (incomplete / thrash_stop) so it bubbles up
    if (text || attachments.length) {
      convService.append(input.convId, {
        author: 'expert',
        expertId: roleId,
        model: models.get(roleId) ?? '',
        content: text,
        attachments, // tool-generated images (nsai-media:// refs) — reopening re-reads them from the DB
        runId, // keys the reload rebuild: openConversation reattaches this expert's tool cards from the session transcript
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
  return { outputs, reasons }
}
