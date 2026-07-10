// consult.ts — multi-expert collaboration tools (doc 19 §5): send_message / assign_task / wait. They are
// functional only inside a CollabSession (ctx.collab present); otherwise they return a clear "team only"
// message and do nothing, so they're harmless if ever wired onto a solo dispatch. The roster of reachable
// teammates is injected into the expert's system prompt by the session (tool prompts here are static).

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const NO_TEAM = 'Collaboration tools work only when you are part of a coordinator team. Nothing was sent.'

const messageSchema = z.object({
  target: z.string().describe("the teammate's NAME, from your teammates list (e.g. \"Shuri\")"),
  message: z.string().describe('the message body'),
})

export const sendMessageTool = buildTool<typeof messageSchema, { status: string }>({
  name: 'send_message',
  inputSchema: messageSchema,
  prompt: () =>
    'Notify a teammate WITHOUT interrupting them: the message lands in their mailbox and they read it on ' +
    'their next turn. Use for FYIs, "done — it\'s at <path>", or non-urgent context. If you need them to ' +
    'act on it now, use assign_task instead. Address them by NAME (see your teammates list).',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    return { data: { status: ctx.collab ? ctx.collab.send(input.target, input.message, ctx.currentToolUseId) : NO_TEAM } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: out.status }
  },
})

export const assignTaskTool = buildTool<typeof messageSchema, { status: string }>({
  name: 'assign_task',
  inputSchema: messageSchema,
  prompt: () =>
    'Hand a teammate a task and WAKE them to act on it now: the message lands in their mailbox and they ' +
    'run a turn immediately. Use when you need something from them to proceed (e.g. "I need GET /users ' +
    'returning {id,name}"). You keep going — they work in parallel. Address them by NAME.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    return { data: { status: ctx.collab ? ctx.collab.assign(input.target, input.message, ctx.currentToolUseId) : NO_TEAM } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: out.status }
  },
})

const waitSchema = z.object({})

export const waitTool = buildTool<typeof waitSchema, { status: string }>({
  name: 'wait',
  inputSchema: waitSchema,
  prompt: () =>
    'Pause until a teammate replies. Your current turn ends and you resume automatically when a teammate ' +
    'messages you (or after a timeout). Call this after assign_task when you have nothing else to do until ' +
    'they answer — do NOT busy-loop re-asking.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(_input, ctx) {
    return { data: { status: ctx.collab ? ctx.collab.requestWait() : NO_TEAM } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: out.status }
  },
})

const electSchema = z.object({
  driver: z.string().describe("the NAME of the teammate who will drive the team's consolidated Studio Lens review (from your teammates list, or yourself)"),
})

export const electLensDriverTool = buildTool<typeof electSchema, { status: string }>({
  name: 'elect_lens_driver',
  inputSchema: electSchema,
  prompt: () =>
    "Register WHO drives the team's ONE consolidated Studio Lens review (collab-review-flow). Decide this in your " +
    'opening alignment — right AFTER you divide the modules and BEFORE you start building — and call this ONCE with ' +
    "the agreed driver's name (the owner of the bigger / riskier surface is the natural choice). Only the registered " +
    'driver may run the consolidated review at the very end; every other teammate self-checks their OWN part and ' +
    'never runs it. This is the structural backstop behind that rule.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    return { data: { status: ctx.collab ? ctx.collab.electLensDriver(input.driver) : NO_TEAM } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: out.status }
  },
})
