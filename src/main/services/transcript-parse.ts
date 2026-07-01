// Session-transcript (transcript.jsonl) → per-run UI artifacts. A LEAF module (imports only the contracts
// types) so the reload-rebuild logic is directly testable off-Electron — agent.service.readTranscript owns
// the file read and delegates the parsing here.
//
// Two line kinds matter:
//   { t: 'run', runId, roleId, ts, ephemeralDisplay? }   — the run's attribution metadata. roleId + ts let the
//     renderer position/attribute a run; ephemeralDisplay marks a run that persisted NO message row yet must
//     rebuild as a visible segment on reload (Danny's routing investigation). Runs without the marker that no
//     message row references (lens finders/skeptics, sub-agents) stay invisible on reload — by design.
//   { t: 'event', runId, event }                          — the run's assistant/tool_results stream, replayed
//     into tool cards + the chronological text+tool block sequence (mirrors the live MsgBlock stream).

import { reasoningText } from '../agent/types'
import type { AnyBlock } from '../agent/types'
import type { RunTranscript } from '../ipc/contracts'

export function parseTranscript(lines: string[]): Record<string, RunTranscript> {
  const byRun: Record<string, RunTranscript> = {}
  const citeSeen: Record<string, Set<string>> = {} // per-run url dedup for citations
  for (const line of lines) {
    if (!line) continue
    let obj: {
      t?: string
      runId?: string
      ts?: number
      roleId?: string
      ephemeralDisplay?: { segmentKind?: string }
      event?: { type?: string; message?: { content?: unknown[] } }
    }
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if (!obj.runId) continue
    // 'run' line → the run's attribution metadata (roleId / start ts / the ephemeral-display marker).
    if (obj.t === 'run') {
      const run = (byRun[obj.runId] ??= { tools: [], blocks: [], servers: [], citations: [] })
      if (typeof obj.roleId === 'string') run.roleId = obj.roleId
      if (typeof obj.ts === 'number') run.ts = obj.ts
      if (obj.ephemeralDisplay && typeof obj.ephemeralDisplay === 'object') run.ephemeralDisplay = { segmentKind: obj.ephemeralDisplay.segmentKind }
      continue
    }
    if (obj.t !== 'event' || !obj.event) continue
    const content = obj.event.message?.content
    if (!Array.isArray(content)) continue
    const run = (byRun[obj.runId] ??= { tools: [], blocks: [], servers: [], citations: [] })
    if (obj.event.type === 'assistant') {
      for (const b of content as {
        type?: string
        id?: string
        name?: string
        input?: unknown
        text?: string
        action?: { query?: string; url?: string }
        citations?: { url?: string; title?: string }[]
      }[]) {
        if (b.type === 'tool_use' && b.id) {
          run.tools.push({ id: b.id, name: b.name ?? '', input: b.input, status: 'running' })
          run.blocks.push({ kind: 'tool', id: b.id }) // chronological position of this card across the run's turns
        } else if (b.type === 'text') {
          // Carry the turn's prose in order so it interleaves with the tool cards. Skip empty/whitespace-only
          // text (some turns are pure tool calls) to avoid blank segments. Merge into a trailing text block so
          // consecutive text across turns reads as one paragraph.
          if (b.text && b.text.trim()) {
            const last = run.blocks[run.blocks.length - 1]
            if (last && last.kind === 'text') last.text += b.text
            else run.blocks.push({ kind: 'text', text: b.text })
          }
          // Citations ride on the SAME text block (a server-tool answer carries prose + citations together), so
          // they MUST be extracted here. A separate `else if (b.type === 'text' && Array.isArray(b.citations))`
          // is unreachable — the `b.type === 'text'` arm above already catches every text block — which silently
          // dropped ALL citations on transcript rebuild (run.citations stayed [] when a conversation reopened).
          // Independent of the prose-trim check above: a whitespace-only text block can still carry citations.
          if (Array.isArray(b.citations)) {
            const seen = (citeSeen[obj.runId] ??= new Set()) // per-run url dedup
            for (const c of b.citations) {
              if (c.url && !seen.has(c.url)) {
                seen.add(c.url)
                run.citations.push({ url: c.url, title: c.title })
              }
            }
          }
        } else if (b.type === 'web_search_call') {
          // search → query, open_page → url (visited site). Other opaque server blocks aren't shown.
          const sv: { serverType: string; query?: string; url?: string } = { serverType: b.type }
          if (b.action?.query) sv.query = b.action.query
          if (b.action?.url) sv.url = b.action.url
          run.servers.push(sv)
        } else if (b.type === 'reasoning') {
          // Visible thinking persisted in the transcript → restore as a reasoning block so a reopened
          // conversation renders the Thinking section exactly like the live run (parity with appendReasoning).
          const r = reasoningText(b as unknown as AnyBlock)
          if (r.trim()) run.blocks.push({ kind: 'reasoning', text: r })
        }
      }
    } else if (obj.event.type === 'tool_results') {
      for (const b of content as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
        if (b.type !== 'tool_result' || !b.tool_use_id) continue
        const t = run.tools.find((x) => x.id === b.tool_use_id)
        if (t) {
          t.status = b.is_error ? 'error' : 'done'
          t.result = typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
        }
      }
    }
  }
  return byRun
}
