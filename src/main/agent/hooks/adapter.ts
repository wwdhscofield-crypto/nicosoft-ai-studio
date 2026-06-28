// hooks/adapter.ts — the single bridge from the agent runtime's AgentContext to the hooks layer's
// HookExecContext, so the engine/executors stay decoupled from the full agent context. The emit sites
// (execution.ts, loop.ts) call this to build the per-event execution context + base payload.

import type { AgentContext } from '../context'
import type { HookExecContext } from './types'
import type { HookBasePayload, HookEventName } from './events'

export function hookContextFromAgent(ctx: AgentContext): HookExecContext {
  return {
    convId: ctx.convId ?? '',
    cwd: ctx.cwd,
    sessionDir: ctx.sessionDir,
    permissionMode: ctx.permissionMode,
    signal: ctx.signal,
    roleId: ctx.roleId,
    selfAgentId: ctx.hookAgentId,
    // LLM access for prompt/agent executors — built from the run's endpoint + main model (a hook's own `model`
    // config can override). Present only when the agent context carries llm + a model.
    llm: ctx.llm && ctx.model ? { protocol: ctx.llm.protocol, baseUrl: ctx.llm.baseUrl, apiKey: ctx.llm.apiKey, model: ctx.model, smallModel: ctx.llm.smallModel } : undefined,
  }
}

export function baseHookPayload(event: HookEventName, ctx: AgentContext): HookBasePayload {
  return {
    hook_event_name: event,
    session_id: ctx.convId ?? '',
    cwd: ctx.cwd,
    permission_mode: ctx.permissionMode,
    transcript_path: ctx.sessionDir ? `${ctx.sessionDir}/transcript.jsonl` : undefined,
    agent_id: ctx.hookAgentId ?? ctx.roleId,
    agent_type: ctx.roleId,
  }
}
