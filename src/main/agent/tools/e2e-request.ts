// e2e_request tool — structured Playwright APIRequestContext driver for end-to-end API dogfooding. A
// single tool dispatched by an `action` field (get / post / assert / close). launch-free: the first action
// that needs a context creates one lazily and returns a sessionId the caller threads through; the
// APIRequestContext lives in a module-level Map so headers/cookies persist across calls, and close disposes
// it. playwright is a devDependency → imported DYNAMICALLY so a production build never hard-fails on it.
// Every action emits sub_tool_start / sub_tool_done through ctx.onSubAgentToolEvent (parentToolId =
// ctx.currentToolUseId), mirroring task.ts's child-event shape so the parent stream shows each request.

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { buildTool } from '../tool'
import type { AgentContext } from '../context'
import type { ToolResultBlock } from '../types'

/* eslint-disable @typescript-eslint/no-explicit-any */
type APIRequestContext = any
type APIResponse = any
/* eslint-enable @typescript-eslint/no-explicit-any */

interface RequestSession {
  context: APIRequestContext
  last?: { status: number; body: string }
}

const sessions = new Map<string, RequestSession>()

const inputSchema = z.object({
  action: z.enum(['get', 'post', 'assert', 'close']).describe('which request operation to run'),
  sessionId: z
    .string()
    .optional()
    .describe('session id from a prior call; omit on the first get/post to open a fresh context'),
  url: z.string().optional().describe('get/post only: the request URL'),
  body: z.string().optional().describe('post only: JSON string sent as the request body'),
  headers: z.record(z.string(), z.string()).optional().describe('get/post only: extra request headers'),
  kind: z
    .enum(['status', 'jsonPath'])
    .optional()
    .describe('assert only: status = last response status === expected; jsonPath = dotted path into last JSON body'),
  path: z.string().optional().describe('assert kind=jsonPath only: dotted path, e.g. "data.0.id"'),
  expected: z.string().optional().describe('assert only: expected value (compared as string)'),
})

type Input = z.infer<typeof inputSchema>

interface ActionResult {
  sessionId?: string
  ok: boolean
  detail?: string
  status?: number
  body?: string
  pass?: boolean
  error?: string
}

function emit(
  ctx: AgentContext,
  type: 'sub_tool_start' | 'sub_tool_done',
  toolUseId: string,
  name: string,
  args: Record<string, unknown>,
  extra?: { result?: unknown; isError?: boolean },
): void {
  ctx.onSubAgentToolEvent?.({
    type,
    parentToolId: ctx.currentToolUseId ?? '',
    toolUseId,
    name,
    input: args,
    result: extra?.result,
    isError: extra?.isError,
  })
}

async function getOrCreate(input: Input): Promise<{ sessionId: string; session: RequestSession }> {
  if (input.sessionId) {
    const existing = sessions.get(input.sessionId)
    if (!existing) throw new Error(`unknown sessionId "${input.sessionId}" (it was closed)`)
    return { sessionId: input.sessionId, session: existing }
  }
  const { request } = await import('playwright')
  const context = await request.newContext()
  const sessionId = randomUUID()
  const session: RequestSession = { context }
  sessions.set(sessionId, session)
  return { sessionId, session }
}

function requireSession(input: Input): { sessionId: string; session: RequestSession } {
  if (!input.sessionId) throw new Error(`action "${input.action}" requires a sessionId`)
  const session = sessions.get(input.sessionId)
  if (!session) throw new Error(`unknown sessionId "${input.sessionId}" (it was closed)`)
  return { sessionId: input.sessionId, session }
}

async function capture(session: RequestSession, res: APIResponse): Promise<{ status: number; body: string }> {
  const status = res.status()
  const body = await res.text()
  session.last = { status, body }
  return { status, body }
}

async function run(input: Input): Promise<ActionResult> {
  switch (input.action) {
    case 'get': {
      if (!input.url) throw new Error('get requires `url`')
      const { sessionId, session } = await getOrCreate(input)
      const res = await session.context.get(input.url, { headers: input.headers })
      const { status, body } = await capture(session, res)
      return { sessionId, ok: true, status, body, detail: `GET ${input.url} → ${status}` }
    }

    case 'post': {
      if (!input.url) throw new Error('post requires `url`')
      const { sessionId, session } = await getOrCreate(input)
      const res = await session.context.post(input.url, {
        headers: { 'content-type': 'application/json', ...input.headers },
        data: input.body,
      })
      const { status, body } = await capture(session, res)
      return { sessionId, ok: true, status, body, detail: `POST ${input.url} → ${status}` }
    }

    case 'assert': {
      const { sessionId, session } = requireSession(input)
      if (!session.last) throw new Error('assert requires a prior get/post on this session')
      const kind = input.kind ?? 'status'
      const expected = input.expected ?? ''
      let pass = false
      let detail = ''
      if (kind === 'status') {
        pass = String(session.last.status) === expected
        detail = `status was ${session.last.status}, expected ${expected}`
      } else {
        // jsonPath: walk a dotted path into the parsed last body
        if (!input.path) throw new Error('assert kind=jsonPath requires `path`')
        let value: unknown
        try {
          value = JSON.parse(session.last.body)
        } catch {
          throw new Error('last response body is not valid JSON')
        }
        for (const seg of input.path.split('.')) {
          if (value == null) break
          value = (value as Record<string, unknown>)[seg]
        }
        pass = String(value) === expected
        detail = `jsonPath "${input.path}" was "${String(value)}", expected "${expected}"`
      }
      return { sessionId, ok: true, pass, detail }
    }

    case 'close': {
      const { sessionId, session } = requireSession(input)
      try {
        await session.context.dispose()
      } finally {
        sessions.delete(sessionId)
      }
      return { sessionId, ok: true, detail: 'session closed' }
    }
  }
}

export const e2eRequestTool = buildTool<typeof inputSchema, ActionResult>({
  name: 'e2e_request',
  inputSchema,
  prompt: () =>
    'Make HTTP API calls for end-to-end testing via Playwright APIRequestContext. action=get/post returns a ' +
    'sessionId (omit sessionId on the first call to open a fresh context; reuse it to keep headers/cookies). ' +
    'assert(kind=status|jsonPath, expected) checks the LAST response and returns { pass, detail }. Always ' +
    'close the session when finished.',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => false,
  async call(input, ctx) {
    const evtId = randomUUID()
    const args = input as unknown as Record<string, unknown>
    emit(ctx, 'sub_tool_start', evtId, input.action, args)
    try {
      const data = await run(input)
      emit(ctx, 'sub_tool_done', evtId, input.action, args, { result: data, isError: data.ok === false })
      return { data }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      const data: ActionResult = { sessionId: input.sessionId, ok: false, error }
      if (input.action === 'close' && input.sessionId) {
        const s = sessions.get(input.sessionId)
        if (s) {
          try {
            await s.context.dispose()
          } catch {
            /* best effort */
          }
          sessions.delete(input.sessionId)
        }
      }
      emit(ctx, 'sub_tool_done', evtId, input.action, args, { result: data, isError: true })
      return { data }
    }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    if (out.error) {
      return { type: 'tool_result', tool_use_id: toolUseId, content: `[e2e_request error] ${out.error}`, is_error: true }
    }
    const lines: string[] = []
    if (out.sessionId) lines.push(`sessionId: ${out.sessionId}`)
    if (out.detail) lines.push(out.detail)
    if (out.pass !== undefined) lines.push(`assert: ${out.pass ? 'PASS' : 'FAIL'}`)
    if (out.body !== undefined) lines.push(`body: ${out.body.slice(0, 2000)}`)
    return { type: 'tool_result', tool_use_id: toolUseId, content: lines.join('\n') || 'ok' }
  },
})
