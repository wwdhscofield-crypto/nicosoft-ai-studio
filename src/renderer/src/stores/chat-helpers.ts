// Pure module-level helpers + constants for the chat store — standalone functions that capture no store
// state. chat.ts re-exports the role predicates so consumers keep importing them from '@/stores/chat'.
import type { ChatMessage, ToolCall } from './chat-types'
import { AGENT_ROLE_IDS as AGENT_ROLES } from '@shared/roles'

// Roles whose replies run through the agent loop (tools) — in EVERY mode: a solo direct chat and a
// coordinator-dispatched step both run the same full tool-using loop and stream over the same
// coordinator:* wire (the drain unification); only pure custom/chat personas take the text-only chat path.
// AGENT_ROLES = @shared/roles.AGENT_ROLE_IDS (imported above) — was a literal hand-synced with main's copy.
// Roles that generate images (the ns_generate_image tool is in their kit). A UI predicate only: it drives
// the composer's image-model picker + passing imageModel to the run. Execution always goes through the
// agent loop (these roles are in AGENT_ROLES); the tool itself is gated server-side by the Tools setting.
const IMAGE_GEN_ROLES = new Set(['designer'])
const COORDINATOR_ID = 'coordinator'
export const roleHasAgent = (expertId: string): boolean => AGENT_ROLES.has(expertId)
export const roleHasImageGen = (expertId: string): boolean => IMAGE_GEN_ROLES.has(expertId)
export const roleIsCoordinator = (expertId: string): boolean => expertId === COORDINATOR_ID

export const uid = (): string => globalThis.crypto.randomUUID()

const upsertSubTool = (
  tools: ToolCall[] | undefined,
  parentToolId: string,
  subTool: ToolCall
): ToolCall[] | undefined => {
  if (!tools) return tools
  let changed = false
  const next = tools.map((tool) => {
    if (tool.id !== parentToolId) return tool
    const subTools = tool.subTools ?? []
    const idx = subTools.findIndex((t) => t.id === subTool.id)
    const nextSubTools = idx >= 0
      ? subTools.map((t, i) => i === idx ? { ...t, ...subTool, input: subTool.input ?? t.input } : t)
      : [...subTools, subTool]
    changed = true
    return { ...tool, subTools: nextSubTools }
  })
  return changed ? next : tools
}

const updateSubTool = (
  tools: ToolCall[] | undefined,
  parentToolId: string,
  toolUseId: string,
  patch: Partial<ToolCall>
): ToolCall[] | undefined => {
  if (!tools) return tools
  let changed = false
  const next = tools.map((tool) => {
    if (tool.id !== parentToolId) return tool
    const subTools = tool.subTools ?? []
    const idx = subTools.findIndex((t) => t.id === toolUseId)
    const fallback: ToolCall = {
      id: toolUseId,
      name: typeof patch.name === 'string' ? patch.name : 'tool',
      input: patch.input ?? {},
      status: patch.status ?? 'done',
      result: patch.result,
    }
    const nextSubTools = idx >= 0
      // MERGE the done event's input onto the start input (don't REPLACE): a sub-tool's done carries verdict /
      // token-count fields that must ADD to its start input (lens / focus / title), so a finder·skeptic·reader
      // row keeps its label AND gains its result. (Replacing dropped the start label whenever done set input.)
      ? subTools.map((t, i) => i === idx ? { ...t, ...patch, input: patch.input !== undefined ? { ...(t.input as Record<string, unknown> | undefined), ...(patch.input as Record<string, unknown>) } : t.input } : t)
      : [...subTools, fallback]
    changed = true
    return { ...tool, subTools: nextSubTools }
  })
  return changed ? next : tools
}

const summarizeValue = (v: unknown): string => {
  if (typeof v === 'string') return v
  try { return JSON.stringify(v) } catch { return String(v) }
}

// Which message a sub_tool event belongs to — for BOTH the coordinator path (roleId given) and the agent/solo
// path (roleId === ''). CARD-ANCHORED first: if the parent card (e.g. a StudioLens card, id=parentToolId) or
// this very sub-tool (toolUseId) already lives on a message, target THAT message — a re-emit of a subject's
// final state, or a refute nesting, MUST land on the message that owns the card, NOT some other message. This
// is also the fix for the agent path's old `.map(applySubToolStart over EVERY message)` bug: a sentinel parent
// (studio_lens's 'coordinator-gate-b') matched nothing, so the orphan-append ran on every message → a panel
// card duplicated after every block. Fallback for the FIRST event of a new card (no card match yet): the
// coordinator path opens it on the latest segment of roleId; the agent path (no roleId) opens it on the current
// streaming assistant message, else the latest assistant.
export const locateSubToolMsgIndex = (msgs: ChatMessage[], roleId: string, parentToolId: string, toolUseId: string): number => {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].tools?.some((t) => t.id === parentToolId || t.id === toolUseId)) return i
  }
  if (roleId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'assistant' && msgs[i].expertId === roleId) return i
    }
    return -1
  }
  // Agent / solo path (no per-event roleId): the sub-tool belongs to the turn in flight.
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant' && msgs[i].streaming) return i
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'assistant') return i
  return -1
}

export const applySubToolStart = (message: ChatMessage, parentToolId: string, toolUseId: string, name: string, input: unknown): ChatMessage => {
  const subTool: ToolCall = { id: toolUseId, name, input: input ?? {}, status: 'running' }
  const tools = upsertSubTool(message.tools, parentToolId, subTool)
  if (tools !== message.tools) return { ...message, tools }

  // Coordinator gates are emitted as sub-tool events even though they are orchestration steps rather than
  // children of an agent tool_use. Surface those orphan events as first-class tool cards so Danny's plan
  // review + the independent verifier verdict are visible in the conversation stream.
  const existing = message.tools?.some((tool) => tool.id === toolUseId)
  if (existing) return message
  return {
    ...message,
    tools: [...(message.tools ?? []), subTool],
    blocks: [...(message.blocks ?? []), { kind: 'tool', id: toolUseId }],
  }
}

// `input` on a DONE event carries final structured metadata (studio_lens re-emits a subject's resolved
// outcome / refute tally / fixed-by here). Most done events omit it → input stays whatever the start set.
export const applySubToolDone = (message: ChatMessage, parentToolId: string, toolUseId: string, name: string, result: unknown, isError?: boolean, input?: unknown): ChatMessage => {
  const patch: Partial<ToolCall> = {
    name,
    status: isError ? 'error' : 'done',
    result: summarizeValue(result),
  }
  if (input !== undefined) patch.input = input
  const tools = updateSubTool(message.tools, parentToolId, toolUseId, patch)
  if (tools !== message.tools) return { ...message, tools }

  const existingIdx = message.tools?.findIndex((tool) => tool.id === toolUseId) ?? -1
  if (existingIdx >= 0) {
    const nextTools = (message.tools ?? []).map((tool, i) => i === existingIdx ? { ...tool, ...patch } : tool)
    return { ...message, tools: nextTools }
  }

  return {
    ...message,
    tools: [...(message.tools ?? []), { id: toolUseId, name, input: input ?? {}, status: isError ? 'error' : 'done', result: summarizeValue(result) }],
    blocks: [...(message.blocks ?? []), { kind: 'tool', id: toolUseId }],
  }
}

// A sub-tool's streaming text (workflow /workflows parity) — appended live so each panel finder/skeptic/reader
// row shows its reasoning as it's produced, not just on completion. Tail-capped so a long agent can't bloat the
// store. A delta for an unknown sub-tool (start lost the IPC race) is a no-op — the start/done carry the result.
const STREAM_CAP = 4000
const appendSubToolStream = (tools: ToolCall[] | undefined, parentToolId: string, toolUseId: string, delta: string): ToolCall[] | undefined => {
  if (!tools) return tools
  let changed = false
  const next = tools.map((tool) => {
    if (tool.id !== parentToolId) return tool
    const subTools = tool.subTools ?? []
    const idx = subTools.findIndex((t) => t.id === toolUseId)
    if (idx < 0) return tool
    changed = true
    // `stream` is tail-capped (bounded memory + the row only shows the tail); `streamLen` accumulates the FULL
    // count so the Tasks-panel re-render key keeps advancing past the cap (else a long agent's live tail freezes).
    return { ...tool, subTools: subTools.map((t, i) => (i === idx ? { ...t, stream: ((t.stream ?? '') + delta).slice(-STREAM_CAP), streamLen: (t.streamLen ?? 0) + delta.length } : t)) }
  })
  return changed ? next : tools
}

export const applySubToolDelta = (message: ChatMessage, parentToolId: string, toolUseId: string, delta: string): ChatMessage => {
  const tools = appendSubToolStream(message.tools, parentToolId, toolUseId, delta)
  return tools !== message.tools ? { ...message, tools } : message
}

// #8 COARSE per-tool liveness (Workflow lastToolName/lastToolSummary parity) — set the row's CURRENT tool name + a
// short input hint into its input, so the lens card shows "Read foo.ts" while the agent works. ONE event per tool
// call, never per token (that was the removed firehose). No-op for an unknown sub-tool (start lost the IPC race);
// merges onto the existing input so the row keeps its lens/focus/title.
const setSubToolProgress = (tools: ToolCall[] | undefined, parentToolId: string, toolUseId: string, tool: string, summary?: string): ToolCall[] | undefined => {
  if (!tools) return tools
  let changed = false
  const next = tools.map((t) => {
    if (t.id !== parentToolId) return t
    const subTools = t.subTools ?? []
    const idx = subTools.findIndex((st) => st.id === toolUseId)
    if (idx < 0) return t
    changed = true
    return { ...t, subTools: subTools.map((st, i) => (i === idx ? { ...st, input: { ...(st.input as Record<string, unknown> | undefined), lastTool: tool, lastToolSummary: summary } } : st)) }
  })
  return changed ? next : tools
}

export const applySubToolProgress = (message: ChatMessage, parentToolId: string, toolUseId: string, tool: string, summary?: string): ChatMessage => {
  const tools = setSubToolProgress(message.tools, parentToolId, toolUseId, tool, summary)
  return tools !== message.tools ? { ...message, tools } : message
}

// Server blocks shown as user-facing status rows (web_search). reasoning / thinking blocks are
// round-tripped for context only, not shown. Extend when adding server tools (code_interpreter, image gen).
export const SHOWN_SERVER_BLOCKS = new Set(['web_search_call'])

// — Segment-identity model (run grouping) ————————————————————————————————————————————————————————————
// Pure data logic for how consecutive assistant messages merge into ONE rendered segment — kept here
// (JSX-free) so the display-unification regression tests can import it directly; chat-segment re-exports.

// True when this assistant message represents Coordinator's synthesis step — the final pipeline message
// where Coordinator merges the experts' outputs. Detected by being expertId='coordinator' inside a dispatch chain.
export function isSynthesis(msg: ChatMessage): boolean {
  return msg.role === 'assistant' && (msg.expertId ?? null) === 'coordinator' && Array.isArray(msg.dispatch) && msg.dispatch.length > 0
}

// Two dispatch chains match when they're the same array contents in the same order. Used to decide
// whether a message starts a fresh dispatch group (badge above) or continues an existing one.
export function sameChain(a: string[] | null | undefined, b: string[] | null | undefined): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// Consecutive assistant messages merge into one segment when they share the expert, the segment kind, the
// dispatch chain, and the synthesis-ness — the "one turn, one speaker" model. User messages never merge.
// segmentKind is a merge condition so a Verifier step — and Danny's 'investigate' groundwork — each render
// as their OWN segment, never smeared into an adjacent intro/direct/normal step of the same role (GAP-2).
export function canMerge(a: ChatMessage, b: ChatMessage): boolean {
  const chainsEqual = Array.isArray(a.dispatch) || Array.isArray(b.dispatch) ? sameChain(a.dispatch, b.dispatch) : true
  return (
    a.role === 'assistant' &&
    b.role === 'assistant' &&
    (a.expertId ?? null) === (b.expertId ?? null) &&
    (a.segmentKind ?? null) === (b.segmentKind ?? null) &&
    chainsEqual &&
    isSynthesis(a) === isSynthesis(b)
  )
}

// Claude runs ONE tool per turn, so an agent's work arrives as a RUN of separate assistant messages. The
// whole consecutive merge-compatible run renders as ONE segment (speaker once).
export function groupRuns(messages: ChatMessage[]): ChatMessage[][] {
  const runs: ChatMessage[][] = []
  for (const m of messages) {
    const cur = runs[runs.length - 1]
    if (cur && canMerge(cur[cur.length - 1], m)) cur.push(m)
    else runs.push([m])
  }
  return runs
}

// PRODUCT RULE (long-standing; re-broken once by treating it as a special-case to delete — dogfood
// 2026-07-02): in a coordinator conversation, the HOST's own segments (Danny's voice — intro, direct
// answers, his pre-routing investigation, his synthesis) always render FULL-HEIGHT; ONLY dispatched
// expert steps (a non-empty dispatch chain) fold into the fixed-height scroll window. Danny's
// investigation is Danny speaking — segmentKind 'investigate' gives it its own merge boundary
// (canMerge above) but must never make it foldable. Synthesis carries a chain but is excluded by the
// caller's !isSynthesis gate (it renders full-height with the accent treatment instead).
export function segmentFolds(first: ChatMessage): boolean {
  return first.role === 'assistant' && !isSynthesis(first) && first.expertId != null && !!first.dispatch?.length
}
