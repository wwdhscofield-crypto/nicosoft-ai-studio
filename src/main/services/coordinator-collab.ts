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

export async function runCollaboration(
  input: CoordinatorRunInput,
  roleIds: string[],
  fullChain: string[],
  cb: CoordinatorCallbacks,
  signal: AbortSignal,
  project?: collabProject.CollabProject,
): Promise<{ role: string; text: string }[]> {
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
    onExpertStream: (roleId, ev) => {
      if (ev.type === 'text') cb.onDelta(roleId, ev.delta)
      else if (ev.type === 'tool_use_start') cb.onToolStart?.(roleId, ev.id, ev.name)
      else if (ev.type === 'usage') cb.onUsage?.(roleId, ev.inputTokens, ev.outputTokens, ev.cachedTokens)
      else if (ev.type === 'turn-final') cb.onTurnFinalUsage?.(ev.usage)
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
  const results = await agentService.runCollabSession(input.convId, experts, hooks, signal, () => Date.now())

  const outputs: { role: string; text: string }[] = []
  for (const [roleId, { text, contextTokens, cacheReadTokens, outTokens }] of results) {
    if (text) {
      convService.append(input.convId, {
        author: 'expert',
        expertId: roleId,
        model: models.get(roleId) ?? '',
        content: text,
        inputTokens: contextTokens, // DISPLAY: current context size (collab path not instrumented for billing)
        cacheReadTokens, // cache-read share of that last turn — persistent "(+N cached)" note
        outputTokens: outTokens,
        dispatch: fullChain
      })
      outputs.push({ role: roleId, text })
    }
    cb.onStepDone(roleId, text, contextTokens, outTokens)
  }
  return outputs
}
