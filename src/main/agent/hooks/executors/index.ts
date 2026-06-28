// hooks/executors/index.ts — register the five external hook-type executors into the engine's executor table.
// Called once at startup. The engine runs callback/function hooks directly; these fill in the config-driven
// types. Adding a new external type is a ONE-LINE change here (+ its executor module) — the engine is untouched.

import { hookRegistry, type HookExecutor } from '../registry'
import { executeCommandHook } from './command'
import { executeHttpHook } from './http'
import { executeMcpToolHook } from './mcp_tool'
import { executePromptHook } from './prompt'
import { executeAgentHook } from './agent'
import type { CommandHookConfig, HttpHookConfig, McpToolHookConfig, PromptHookConfig, AgentHookConfig } from '../types'

export function registerHookExecutors(): void {
  // Each wrapper narrows the union config to the executor's concrete type — the engine only ever dispatches a
  // config to the executor registered for its own `type`, so the cast is sound.
  const wrap = <C>(fn: (c: C, p: Parameters<HookExecutor>[1], o: Parameters<HookExecutor>[2]) => ReturnType<HookExecutor>): HookExecutor => (c, p, o) => fn(c as C, p, o)
  hookRegistry.registerExecutor('command', wrap<CommandHookConfig>(executeCommandHook))
  hookRegistry.registerExecutor('http', wrap<HttpHookConfig>(executeHttpHook))
  hookRegistry.registerExecutor('mcp_tool', wrap<McpToolHookConfig>(executeMcpToolHook))
  hookRegistry.registerExecutor('prompt', wrap<PromptHookConfig>(executePromptHook))
  hookRegistry.registerExecutor('agent', wrap<AgentHookConfig>(executeAgentHook))
}
