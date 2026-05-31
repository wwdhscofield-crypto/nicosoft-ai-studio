// Hex agent service: resolve endpoint + key, run the agent loop against the project cwd, and persist
// a per-session transcript under ~/.nsai/sessions/<convId>/. Streaming + permission bridging happen
// in the IPC boundary (agent.handler.ts); this service is the loop driver. Mirrors chat.service's
// resolve pattern but drives runAgent (tool use) instead of a plain chat.

import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { AgentContext, PermissionDecision, PermissionRequest } from '../agent/context'
import type { AgentLlmEvent } from '../agent/llm'
import { runAgent, type AgentEvent } from '../agent/loop'
import { CORE_TOOLS } from '../agent/registry'
import { HEX_SYSTEM_PROMPT } from '../agent/system-prompt'
import type { AgentRunInput } from '../ipc/contracts'
import * as keychain from '../keychain/keychain'
import { LlmError } from '../llm/types'
import * as endpointRepo from '../repos/endpoint.repo'

export interface AgentCallbacks {
  onStream: (e: AgentLlmEvent) => void // fine-grained deltas (text + tool_use input) for streaming UI
  onEvent: (e: AgentEvent) => void // completed assistant turns + tool_results
  requestPermission: (req: PermissionRequest) => Promise<PermissionDecision> // bridged to the renderer
}

export async function run(
  input: AgentRunInput,
  cb: AgentCallbacks,
  signal: AbortSignal,
): Promise<{ reason: string; turns: number; convId: string }> {
  const ep = endpointRepo.getById(input.endpointId)
  if (!ep) throw new LlmError('bad_request', 'endpoint not found')
  // Hex's loop speaks the Anthropic Messages protocol (tool use over /v1/messages).
  if (ep.protocol !== 'anthropic') {
    throw new LlmError('bad_request', 'Hex requires an Anthropic-protocol endpoint')
  }
  const key = keychain.getApiKey(input.endpointId)
  if (!key) throw new LlmError('bad_key', 'no API key configured for this endpoint')

  const convId = input.convId ?? ulid()
  const sessionDir = join(homedir(), '.nsai', 'sessions', convId)
  await mkdir(join(sessionDir, 'tool-results'), { recursive: true })
  const transcript = createWriteStream(join(sessionDir, 'transcript.jsonl'), { flags: 'a' })
  const log = (obj: unknown): void => void transcript.write(JSON.stringify(obj) + '\n')
  log({ t: 'run', convId, cwd: input.cwd, model: input.model })

  const ctx: AgentContext = {
    cwd: input.cwd,
    signal,
    readFileState: new Map(),
    permissionMode: 'default', // read-only auto-allows; writes / dangerous ops ask via the UI
    requestPermission: cb.requestPermission,
    todos: [],
    sessionDir,
  }

  const gen = runAgent({
    baseUrl: ep.baseUrl,
    apiKey: key,
    model: input.model,
    system: HEX_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: input.prompt }] }],
    tools: CORE_TOOLS,
    ctx,
    contextWindow: input.contextWindow ?? 200_000,
    onStream: cb.onStream,
  })

  try {
    for (;;) {
      const { value, done } = await gen.next()
      if (done) {
        log({ t: 'done', reason: value.reason, turns: value.turns })
        return { reason: value.reason, turns: value.turns, convId }
      }
      log({ t: 'event', event: value })
      cb.onEvent(value)
    }
  } finally {
    transcript.end()
  }
}
