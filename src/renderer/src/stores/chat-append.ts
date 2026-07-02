// Minimal-immutable append reducers for the chat store (docs/streaming-render-alignment §3.2), shaped
// after Claude Desktop's delta reducer: `{...tail, text: tail.text + delta}` on a shallow-copied array.
// The ONLY elements that change identity are the array itself and the one message being appended to —
// every other message keeps its reference, so memoized message components skip re-rendering on each
// delta. (The old reducers cloned EVERY message per delta, defeating all memoization down the tree —
// the invalidation storm behind the streaming jank.) Pure functions; e2e/stream-render.mts pins the
// reference-stability contract directly.
import type { ChatMessage, MsgBlock } from './chat-types'

// Extend the trailing text block or open a new one (text emitted after a tool card starts its own
// segment, so the renderer interleaves it below that card). Copy-on-write: returns a NEW blocks array.
export function appendTextBlock(blocks: readonly MsgBlock[] | undefined, text: string): MsgBlock[] {
  const next = blocks ? [...blocks] : []
  const last = next[next.length - 1]
  if (last && last.kind === 'text') next[next.length - 1] = { kind: 'text', text: last.text + text }
  else next.push({ kind: 'text', text })
  return next
}

// Reasoning (visible thinking) rides its own block kind, NEVER msg.text — rendered as a distinct
// section that breaks the tool fold exactly where the model paused to think.
export function appendReasoningBlock(blocks: readonly MsgBlock[] | undefined, text: string): MsgBlock[] {
  const next = blocks ? [...blocks] : []
  const last = next[next.length - 1]
  if (last && last.kind === 'reasoning') next[next.length - 1] = { kind: 'reasoning', text: last.text + text }
  else next.push({ kind: 'reasoning', text })
  return next
}

// Append a text delta to the trailing streaming assistant message; start a fresh one (via `make`) if
// the tail isn't a streaming assistant. Plain-chat path — role-tagged streams use appendTextToRole.
export function appendTextToTail(msgs: readonly ChatMessage[], text: string, make: () => ChatMessage): ChatMessage[] {
  const last = msgs[msgs.length - 1]
  if (!last || last.role !== 'assistant' || !last.streaming) {
    const m = make()
    return [...msgs, { ...m, text: m.text + text, blocks: appendTextBlock(m.blocks, text) }]
  }
  return [...msgs.slice(0, -1), { ...last, text: last.text + text, blocks: appendTextBlock(last.blocks, text) }]
}

export function appendReasoningToTail(msgs: readonly ChatMessage[], text: string, make: () => ChatMessage): ChatMessage[] {
  const last = msgs[msgs.length - 1]
  if (!last || last.role !== 'assistant' || !last.streaming) {
    const m = make()
    return [...msgs, { ...m, blocks: appendReasoningBlock(m.blocks, text) }]
  }
  return [...msgs.slice(0, -1), { ...last, blocks: appendReasoningBlock(last.blocks, text) }]
}

// Route a delta to the streaming bubble tagged with its roleId (coordinator/collab: experts stream
// CONCURRENTLY, so "the last bubble" would interleave their text). Returns null when no matching
// streaming bubble exists yet (step:start creates it first) — the caller drops rather than mis-routes.
export function appendTextToRole(msgs: readonly ChatMessage[], roleId: string, text: string): ChatMessage[] | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'assistant' && m.streaming && m.expertId === roleId) {
      const next = [...msgs]
      next[i] = { ...m, text: m.text + text, blocks: appendTextBlock(m.blocks, text) }
      return next
    }
  }
  return null
}

export function appendReasoningToRole(msgs: readonly ChatMessage[], roleId: string, text: string): ChatMessage[] | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'assistant' && m.streaming && m.expertId === roleId) {
      const next = [...msgs]
      next[i] = { ...m, blocks: appendReasoningBlock(m.blocks, text) }
      return next
    }
  }
  return null
}
