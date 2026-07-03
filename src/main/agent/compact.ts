// Compaction layers 2 & 3 (overflow prevention). Two-layer compaction: microcompact + autocompact.
// Layer 2 (microcompact): clear the CONTENT of old tool results, keep the most recent N — cheap,
//   non-destructive to message structure, preserves tool_use/tool_result pairing. Returns the freed
//   char count so the running token estimate can subtract it (else it over-estimates and fires the
//   destructive autocompact on a phantom).
// Layer 3 (autocompact): when the running token estimate crosses the threshold, LLM-summarize the
//   WHOLE conversation into one summary message (9 fixed sections, session model). The history is
//   serialized to a text transcript first (capped), so the summary call never carries dangling
//   tool_use blocks and can't itself overflow.

import { collectTurn } from './llm/anthropic'
import { isContentBlock } from './types'
import type { AgentMessage, ToolResultBlock, Usage } from './types'
import { CHARS_PER_TOKEN } from '../llm/estimate'

const COMPACTABLE_TOOLS = new Set(['Read', 'Bash', 'Grep', 'Glob', 'Edit', 'Write', 'MultiEdit', 'LS'])
const CLEARED_MARKER = '[old tool result content cleared to save context]'
const KEEP_RECENT_RESULTS = 5

// A gateway or platform may inject a system prompt that estimateTokens() can't see (~2300 tokens
// observed). Reserve a fixed amount so the estimate isn't blind to it (especially right after
// compaction / on turn 1). Harmless against a raw endpoint that injects nothing — just extra margin.
export const SYSTEM_PROMPT_RESERVE = 3_000

// === Layer 2: microcompact ===
export interface MicrocompactResult {
  messages: AgentMessage[]
  freedChars: number // total chars cleared this pass — caller subtracts from the running estimate
}

export function microcompact(messages: AgentMessage[], keepRecent = KEEP_RECENT_RESULTS): MicrocompactResult {
  const toolNameById = new Map<string, string>()
  const readPathById = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const b of m.content)
        if (isContentBlock(b) && b.type === 'tool_use') {
          toolNameById.set(b.id, b.name)
          const fp = b.name === 'Read' ? (b.input as { file_path?: unknown } | undefined)?.file_path : undefined
          if (typeof fp === 'string') readPathById.set(b.id, fp)
        }
    }
  }
  const compactable: ToolResultBlock[] = []
  for (const m of messages) {
    if (m.role !== 'user') continue
    for (const b of m.content) {
      if (isContentBlock(b) && b.type === 'tool_result' && typeof b.content === 'string' && b.content !== CLEARED_MARKER) {
        const name = toolNameById.get(b.tool_use_id)
        if (name && COMPACTABLE_TOOLS.has(name)) compactable.push(b)
      }
    }
  }
  if (compactable.length <= keepRecent) return { messages, freedChars: 0 }
  // Pinned-on-reread: a file Read ≥2 times this run is a task-critical reference the model keeps coming
  // back to (dogfood: a spec doc was read 6× — cleared, re-read, cleared again, burning a full re-read
  // each cycle). Keep the LATEST still-present result of any such file out of the clear set; older
  // duplicates of the same file still clear. Counted over ALL Read tool_uses (including already-cleared
  // ones), so the signal survives earlier microcompact passes.
  const readCount = new Map<string, number>()
  for (const p of readPathById.values()) readCount.set(p, (readCount.get(p) ?? 0) + 1)
  const latestByPath = new Map<string, ToolResultBlock>()
  for (const b of compactable) {
    const p = readPathById.get(b.tool_use_id)
    if (p && (readCount.get(p) ?? 0) >= 2) latestByPath.set(p, b) // message order → last wins
  }
  const pinned = new Set(latestByPath.values())
  const clear = new Set(compactable.slice(0, compactable.length - keepRecent).filter((b) => !pinned.has(b)))
  if (clear.size === 0) return { messages, freedChars: 0 }
  let freedChars = 0
  for (const b of clear) freedChars += typeof b.content === 'string' ? b.content.length : 0
  const next = messages.map((m) =>
    m.role !== 'user'
      ? m
      : {
          ...m,
          content: m.content.map((b) =>
            isContentBlock(b) && b.type === 'tool_result' && clear.has(b) ? { ...b, content: CLEARED_MARKER } : b,
          ),
        },
  )
  return { messages: next, freedChars }
}

// === Token accounting ===
export function tokensFromUsage(usage: Usage): number {
  return usage.inTokens + usage.outTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0)
}

// Input tokens actually SENT this turn = non-cached prefix + cache read + cache creation. With prompt
// caching (Claude OAuth uses cache_control), message_start.input_tokens is only the tiny
// non-cached delta — the bulk lands in cache_read/cache_creation. Summing all three gives the true ↑
// prompt size for the readout; without it a cache-heavy turn reports a misleadingly tiny ↑ (e.g. 8).
export function promptTokensFromUsage(usage: Usage): number {
  return usage.inTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0)
}

export function estimateTokens(messages: AgentMessage[]): number {
  let chars = 0
  for (const m of messages) {
    for (const b of m.content) {
      if (!isContentBlock(b)) chars += JSON.stringify(b).length // server block — estimate by raw size
      else if (b.type === 'text') chars += b.text.length
      else if (b.type === 'tool_use') chars += b.name.length + JSON.stringify(b.input).length
      else if (b.type === 'tool_result') chars += typeof b.content === 'string' ? b.content.length : 2_000
      else if (b.type === 'image') chars += 8_000 // ~2000 tokens flat
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

const RESERVED_OUTPUT = 20_000
const AUTOCOMPACT_BUFFER = 13_000
// Never returns a negative threshold (a window < 33K would otherwise fire autocompact every turn).
export function autocompactThreshold(contextWindow: number): number {
  const raw = contextWindow - Math.min(RESERVED_OUTPUT, contextWindow) - AUTOCOMPACT_BUFFER
  return Math.max(raw, 1_000)
}

// === Layer 3: autocompact ===
const COMPACT_MAX_OUTPUT = 20_000
// Cap the transcript fed to the summary call so the compaction call itself can't overflow (else the
// overflow-fixer is disabled by overflow). When over, keep HEAD + TAIL — never tail-only: the head
// holds the original request and earliest decisions (exactly what the summary's "Primary Request"
// section needs); the tail keeps the most recent work.
const MAX_TRANSCRIPT_CHARS = 400_000
const TRANSCRIPT_HEAD_CHARS = 20_000
const MAX_TOOL_RESULT_IN_TRANSCRIPT = 800

const COMPACT_SYSTEM = 'You are a helpful AI assistant tasked with summarizing conversations.'

// CC 2.1.186 autocompact prompt, byte-verbatim — the "continuing session" variant the binary uses for
// in-context compaction (extracted 2026-07-02; the manual /compact and partial-compaction variants are
// different texts serving CC features Studio implements elsewhere — conversation-level manual
// compression is compression.service's chained-summary system). CC appends a "do not call tools" tail
// because its summary call runs with the tool environment attached; Studio's summary call is a bare
// text call, so that tail is not ported.
export const COMPACT_PROMPT = `Your task is to create a detailed summary of this conversation. This summary will be placed at the start of a continuing session; newer messages that build on this context will follow after your summary (you do not see them here). Summarize thoroughly so that someone reading only your summary and then the newer messages can fully understand what happened and continue the work.

Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
   - Note any security-relevant instructions or constraints the user stated (e.g., sensitive files or data to avoid, operations that must not be performed, credential or secret handling rules). These MUST be preserved verbatim in the summary so they continue to apply after compaction.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.

Your summary should include the following sections:

1. Primary Request and Intent: Capture the user's explicit requests and intents in detail
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. Preserve any security-relevant instructions or constraints verbatim so they remain in effect after compaction.
7. Pending Tasks: Outline any pending tasks.
8. Work Completed: Describe what was accomplished by the end of this portion.
9. Context for Continuing Work: Summarize any context, decisions, or state that would be needed to understand and continue the work in subsequent messages.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important Code Snippet]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Problem Solving:
   [Description]

6. All user messages:
    - [Detailed non tool use user message]

7. Pending Tasks:
   - [Task 1]

8. Work Completed:
   [Description of what was accomplished]

9. Context for Continuing Work:
   [Key context, decisions, or state needed to continue the work]

</summary>
</example>

Please provide your summary following this structure, ensuring precision and thoroughness in your response.`

// Studio glue (not CC text): CC replays the history as real messages; Studio serializes it into the
// prompt, so a header separates the instructions from the serialized conversation.
const TRANSCRIPT_HEADER = '\n\nConversation transcript:\n'

// Serialize the full history into plain text — avoids sending raw tool_use/tool_result blocks (which
// would need pairing) to the summary call. tool_use input is kept in FULL (it's the code the agent
// wrote — the thing most worth preserving); tool_result is truncated (large ones are already on disk
// via layer 1, recoverable by path).
function messagesToTranscript(messages: AgentMessage[]): string {
  const out: string[] = []
  for (const m of messages) {
    const parts: string[] = []
    for (const b of m.content) {
      if (!isContentBlock(b)) parts.push(`[${b.type}]`) // server block — opaque in the transcript
      else if (b.type === 'text') parts.push(b.text)
      else if (b.type === 'tool_use') parts.push(`[called ${b.name}(${JSON.stringify(b.input)})]`)
      else if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content.slice(0, MAX_TOOL_RESULT_IN_TRANSCRIPT) : '<non-text>'
        parts.push(`[tool result: ${c}]`)
      } else if (b.type === 'image') parts.push('[image]')
    }
    out.push(`${m.role.toUpperCase()}: ${parts.join('\n')}`)
  }
  let transcript = out.join('\n\n')
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    const head = transcript.slice(0, TRANSCRIPT_HEAD_CHARS)
    const tail = transcript.slice(-(MAX_TRANSCRIPT_CHARS - TRANSCRIPT_HEAD_CHARS))
    transcript = head + '\n\n[... middle of the history truncated to fit the summary call ...]\n\n' + tail
  }
  return transcript
}

const COMPACT_PREFIX =
  'This session is being continued from a previous conversation that ran out of context. The summary ' +
  'below covers the earlier portion of the conversation.\n\n'
const COMPACT_SUFFIX =
  '\n\nContinue the conversation from where it left off. Resume directly — do not acknowledge this ' +
  'summary or recap; pick up the work.'

// The task brief must survive compaction STRUCTURALLY — pinned verbatim next to the summary, not left
// to the summary model's discretion. Observed failure (bench gemini-sse-compact, 32K window): the
// summary saw the full transcript yet the continuation came back with "the previous session's task
// didn't carry over — what would you like me to work on?" mid-fix. Chained compaction reuses the
// pinned block from the prior compact message (the regex below must stay in sync with these headers).
const ORIGINAL_REQUEST_HEADER = '## Original request (verbatim)'
const SUMMARY_HEADER = '## Session summary'
const ORIGINAL_REQUEST_MAX_CHARS = 6_000

function originalRequestOf(messages: AgentMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  if (!first) return ''
  const text = first.content
    .filter(isContentBlock)
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim()
  const pinned = text.match(/## Original request \(verbatim\)\n\n([\s\S]*?)\n\n## Session summary/)
  if (pinned) return pinned[1]
  if (text.startsWith(COMPACT_PREFIX)) return '' // prior compact without a pinned block — nothing to carry
  return text.slice(0, ORIGINAL_REQUEST_MAX_CHARS)
}

export interface CompactConfig {
  protocol: 'anthropic' | 'openai' | 'gemini'
  baseUrl: string
  apiKey: string
  model: string
  signal?: AbortSignal
  customInstructions?: string
}

// Summarize the whole conversation into one user message. On failure, returns the original messages
// (caller decides) rather than throwing — never wedge the loop on a compaction error.
export async function autocompact(messages: AgentMessage[], config: CompactConfig): Promise<AgentMessage[]> {
  try {
    const transcript = messagesToTranscript(messages)
    const extraInstructions = config.customInstructions?.trim()
    // Custom-instruction joint is CC-verbatim ("Additional Instructions"); the transcript header is glue.
    const prompt =
      (extraInstructions ? `${COMPACT_PROMPT}\n\nAdditional Instructions:\n${extraInstructions}` : COMPACT_PROMPT) +
      TRANSCRIPT_HEADER +
      transcript
    const turn = await collectTurn({
      protocol: config.protocol,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model, // session model — quality over cost
      system: COMPACT_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      tools: [],
      maxTokens: COMPACT_MAX_OUTPUT,
      signal: config.signal,
    })
    const raw = turn.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
    // Strip <analysis>…</analysis>; unwrap <summary> tags. If stripping analysis leaves nothing (model
    // reasoned but forgot the summary tags), fall back to the raw text.
    const stripped = raw.replace(/<analysis>[\s\S]*?<\/analysis>/g, '').replace(/<\/?summary>/g, '').trim()
    const summary = stripped || raw.trim()
    if (!summary) return messages // empty — keep original history; caller may retry
    const original = originalRequestOf(messages)
    const body = original
      ? `${ORIGINAL_REQUEST_HEADER}\n\n${original}\n\n${SUMMARY_HEADER}\n\n${summary}`
      : summary
    return [{ role: 'user', content: [{ type: 'text', text: COMPACT_PREFIX + body + COMPACT_SUFFIX }] }]
  } catch {
    return messages // compaction call failed (network / itself too long) — don't lose history
  }
}

export { CLEARED_MARKER }
