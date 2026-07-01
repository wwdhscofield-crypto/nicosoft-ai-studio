// Shared IPC serializers: an agent loop turn's assistant blocks / tool_results → the renderer DTOs. This exact
// logic was duplicated verbatim in agent.handler + coordinator.handler (the CB-1 unification audit flagged it as
// the core "each feature written twice" seam). One copy here; both handlers import it. Pure transform, no I/O.

import { isContentBlock, reasoningText, type AnyBlock } from '../agent/types'
import type { AgentBlockDto, AgentResultDto } from './contracts'

// Assistant turn content → ordered display blocks (reasoning / server tool call / text+citations / tool_use).
// tool_result + image never appear in an assistant turn, so they're skipped.
export function serializeAssistantBlocks(content: readonly AnyBlock[]): AgentBlockDto[] {
  const blocks: AgentBlockDto[] = []
  for (const b of content) {
    if (!isContentBlock(b)) {
      // Reasoning/thinking server block → surface its VISIBLE summary as a distinct ordered block (interleaved
      // before this turn's tools, so it breaks the tool fold and shows what the model thought).
      const reasoning = reasoningText(b)
      if (reasoning) { blocks.push({ type: 'reasoning', text: reasoning }); continue }
      // web_search_call action: search → query, open_page → url (the visited site). Surface both.
      const action = (b as { action?: { query?: string; url?: string } }).action
      const dto: AgentBlockDto = { type: 'server', serverType: b.type }
      if (action?.query) dto.query = action.query
      if (action?.url) dto.url = action.url
      blocks.push(dto)
    } else if (b.type === 'text') {
      const tb = b as { text: string; citations?: { url: string; title?: string }[] }
      blocks.push(tb.citations?.length ? { type: 'text', text: tb.text, citations: tb.citations } : { type: 'text', text: tb.text })
    } else if (b.type === 'tool_use') {
      blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input })
    }
    // tool_result / image don't appear in an assistant turn — skip
  }
  return blocks
}

// tool_results turn content → result DTOs (tool_use id + string content + isError).
export function serializeToolResults(content: readonly AnyBlock[]): AgentResultDto[] {
  const results: AgentResultDto[] = []
  for (const b of content) {
    if (isContentBlock(b) && b.type === 'tool_result') {
      results.push({
        toolUseId: b.tool_use_id,
        content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content),
        isError: b.is_error === true,
      })
    }
  }
  return results
}
