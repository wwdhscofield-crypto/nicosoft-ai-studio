// WebSearch — delegate to the server-side web_search tool via an ISOLATED secondary request, exactly
// like ccb's apiAdapter. The agent's main conversation never carries a server tool; this tool's
// call() fires a fresh, single-purpose request whose tools list is JUST web_search (none of Hex's
// local tools), so the server-side search stays fully isolated from the main loop — no multi-computer
// confusion. We extract the web_search_tool_result hits and hand them back as a normal tool_result.
//
// We pin web_search_20250305 (ccb's version): the standalone server search that returns
// web_search_tool_result directly. The newer web_search_20260209 routes through the code_execution
// sandbox instead (verified on the OAuth channel), which Hex deliberately avoids. Haiku doesn't
// support the server search, so this uses ctx.llm.searchModel (Sonnet by default), not smallModel.

import { z } from 'zod'
import type { AgentLlmAccess } from '../context'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

const inputSchema = z.object({
  query: z.string().min(2).describe('The search query'),
  allowed_domains: z.array(z.string()).optional().describe('Only include results from these domains'),
  blocked_domains: z.array(z.string()).optional().describe('Never include results from these domains'),
})

const WEB_SEARCH_TYPE = 'web_search_20250305' // standalone server search (returns web_search_tool_result directly)
const SEARCH_TIMEOUT_MS = 90_000
const MAX_USES = 5

interface SearchHit {
  title: string
  url: string
}
interface WebSearchOutput {
  query: string
  hits: SearchHit[]
  note?: string
}

interface MessagesResponse {
  content?: Array<{ type: string; content?: unknown }>
  usage?: { server_tool_use?: { web_search_requests?: number } }
}

function extractHits(content: NonNullable<MessagesResponse['content']>): SearchHit[] {
  const hits: SearchHit[] = []
  for (const block of content) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue
    for (const r of block.content as Array<Record<string, unknown>>) {
      if (r && typeof r === 'object' && typeof r.url === 'string') {
        hits.push({ title: typeof r.title === 'string' ? r.title : r.url, url: r.url })
      }
    }
  }
  return hits
}

async function delegatedSearch(
  llm: AgentLlmAccess,
  input: z.infer<typeof inputSchema>,
  signal: AbortSignal,
): Promise<WebSearchOutput> {
  const tool: Record<string, unknown> = { type: WEB_SEARCH_TYPE, name: 'web_search', max_uses: MAX_USES }
  if (input.allowed_domains?.length) tool.allowed_domains = input.allowed_domains
  if (input.blocked_domains?.length) tool.blocked_domains = input.blocked_domains

  const res = await fetch(`${llm.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    signal: AbortSignal.any([signal, AbortSignal.timeout(SEARCH_TIMEOUT_MS)]),
    headers: { 'x-api-key': llm.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: llm.searchModel,
      max_tokens: 1024,
      system: 'You are an assistant for performing a web search tool use.',
      messages: [{ role: 'user', content: `Perform a web search for the query: ${input.query}` }],
      tools: [tool],
      stream: false,
    }),
  })
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`web search request failed (HTTP ${res.status})${detail ? `: ${detail}` : ''}`)
  }
  const json = (await res.json()) as MessagesResponse
  const hits = extractHits(json.content ?? [])
  if (hits.length === 0) {
    const reqs = json.usage?.server_tool_use?.web_search_requests ?? 0
    return {
      query: input.query,
      hits: [],
      note:
        reqs === 0
          ? 'web search was not run (quota may be exhausted this turn — try again later)'
          : 'no results found',
    }
  }
  return { query: input.query, hits }
}

const DESCRIPTION = `- Searches the web for current information and returns matching result links (title + URL).
- Input: a search query, optionally scoped with allowed_domains or blocked_domains.
- Read-only. After using results, cite the source URLs in your answer.
- To fetch and read a specific page's full content, use WebFetch instead.`

export const webSearchTool = buildTool<typeof inputSchema, WebSearchOutput>({
  name: 'WebSearch',
  inputSchema,
  prompt: () => DESCRIPTION,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isDestructive: () => false,
  maxResultSizeChars: 50_000,
  async validateInput(input) {
    if (input.allowed_domains?.length && input.blocked_domains?.length) {
      return { result: false, message: 'Specify only one of allowed_domains or blocked_domains' }
    }
    return { result: true }
  },
  async call(input, ctx) {
    if (!ctx.llm) throw new Error('WebSearch requires an LLM-enabled context (ctx.llm is unset)')
    const out = await delegatedSearch(ctx.llm, input, ctx.signal)
    return { data: out }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    if (out.hits.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: `No web results for "${out.query}".${out.note ? ` (${out.note})` : ''}`,
      }
    }
    const lines = out.hits.map((h) => `- [${h.title}](${h.url})`).join('\n')
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: `Web search results for "${out.query}":\n\n${lines}\n\nCite the source URLs you use in your answer.`,
    }
  },
})
