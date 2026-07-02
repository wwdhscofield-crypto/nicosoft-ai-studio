// Pure type definitions for the chat store — no runtime code, no store state. chat.ts re-exports the
// public ones so consumers keep importing them from '@/stores/chat' (the store's API face).
import type { ThinkingParam } from '@/lib/thinking'
import type { AgentMode } from '@/lib/agent-mode'

export type ConversationDto = Awaited<ReturnType<typeof window.api.conversations.list>>[number]

export interface ToolCall {
  id: string
  name: string
  input: unknown
  status: 'running' | 'done' | 'error'
  result?: string
  stream?: string // live partial text from a quiet sub-agent (panel finder/skeptic/reader) — shown while running
  streamLen?: number // MONOTONIC total chars streamed (uncapped) — drives the Tasks-panel re-render key even after `stream` is tail-capped
  subTools?: ToolCall[]
}
// One renderable unit of an assistant turn, in EMISSION order. A 'tool' block references a tool by id in
// msg.tools (so tool status/result updates flow through msg.tools without touching this list). This is what
// lets the renderer interleave reasoning text and tool cards chronologically instead of stacking all text
// above all cards. msg.text / msg.tools are kept alongside for everything that reads them (live readout,
// token math, persistence, stop() cleanup); blocks is purely the ORDER overlay.
export type MsgBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string }
  // manual=true → the /compact receipt (user-initiated fold). auto=false WITHOUT manual is the legacy
  // microcompaction note shape, which the renderer still filters out (see chat-segment). pending=true →
  // the fold is still RUNNING: the same line renders as a ticking "Compacting… Ns" (startedAt anchors the
  // timer) and is settled IN PLACE into the receipt on success (removed on skip/failure) — one line, ever.
  | { kind: 'compaction'; tokens: number; auto: boolean; manual?: boolean; pending?: boolean; startedAt?: number }
  | { kind: 'reasoning'; text: string } // the model's VISIBLE thinking (extended thinking / reasoning summary) — rendered as a distinct dim "Thinking" block, interleaved before the turn's tools
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  blocks?: MsgBlock[] // ordered text+tool sequence for an agent turn; absent on plain-chat / user messages
  images?: { url: string; name: string }[]
  tools?: ToolCall[] // present on agent (tool-using) turns
  servers?: ServerNote[] // server-side tools the API ran (web_search etc.) — shown as faint status rows
  citations?: { url: string; title?: string }[] // web_search sources for the answer — shown as a Sources list
  streaming?: boolean
  parked?: boolean // collab: expert is between turns (parked) — hide its live readout though the bubble stays streaming
  // A live PHASE word for the readout while a long tool-less stretch runs inside the segment (e.g. 'Compacting'
  // during the minutes-long auto-summary call, which emits no other events). Set by phase-start events, cleared
  // by the matching settle (compaction done / step:done). Overrides the tool-derived activity while present.
  activityHint?: string
  // Coordinator-dispatched message: the contributing expert (engineer/translator/...) and (pipeline only) the dispatch
  // chain shared by every step of that turn. The renderer reads both to switch avatar/name per message
  // and draw a single dispatch badge spanning consecutive same-chain messages.
  expertId?: string | null
  dispatch?: string[] | null
  segmentKind?: string | null // closure-loop: 'verifier' = an independent Gate B reviewer step → renders a "· Verifier" identity badge (live + across reload)
  inputTokens?: number // CURRENT context size for THIS turn (count_tokens) — per-message so collab experts each show their own; drives the composer "/ window" meter, NOT the settlement total
  cacheReadTokens?: number // cache-read share of inputTokens for THIS turn (persisted via MessageDto) — drives the finalized "(+N cached)" note after the live overlay clears + across reloads
  outputTokens?: number // real output tokens for THIS turn (upstream usage) — live ↓ readout fallback while streaming; NOT summed or shown after the turn ends (no settled summary — see chat-segment.tsx)
  sentTokens?: number // cumulative billing input (incl. cache) actually SENT for THIS turn — billing/accounting only (persisted via MessageDto), NEVER displayed. Token state shows live during the turn, then clears; there is no settled per-turn readout to sum it into (that summing ballooned to the "↑ 48.1m" bug).
  liveInputTokens?: number // coordinator only: live ↑ for THIS segment while it streams (per-message, so concurrent segments don't all read the conv-level overlay — BUG 2). step:done supersedes it with inputTokens.
  liveOutputTokens?: number // coordinator only: live ↓ for THIS segment while it streams
  liveCachedTokens?: number // cache-read share of liveInputTokens — drives the cache-aware ↑ split (fresh main number + "(+N cached)")
}
// A server-side tool the API executed (e.g. OpenAI web_search) — carried as a server block, shown as a
// faint status row (no expand / result; the API ran it, not the loop).
export interface ServerNote {
  serverType: string // e.g. 'web_search_call'
  query?: string // search query (web_search 'search' action)
  url?: string // visited site (web_search 'open_page' action)
}
export interface PermissionPrompt {
  permissionId: string
  toolName: string
  input: unknown
  reason?: string
  // Which backend owns this prompt → respondPermission routes the answer to the right IPC channel. A
  // coordinator-dispatched expert's approval also carries roleId so the dialog can name the expert asking.
  source?: 'agent' | 'coordinator'
  roleId?: string
}

// AskUserQuestion prompt — the agent paused to ask the user to clarify intent (multiple choice).
export interface QuestionPrompt {
  questionId: string
  question: string
  header?: string
  options: string[]
  roleId?: string
}

// A coordinator unattended-approval card shown in chat (doc 19 §8). yellow = auto-approved (a note);
// red = hard-denied + recorded as pending (pendingId) — the user approves (→ replay) or rejects it.
export interface ApprovalCard {
  key: string
  roleId: string
  zone: 'yellow' | 'red'
  toolName: string
  reason: string
  pendingId?: string
  status: 'open' | 'executing' | 'approved' | 'rejected' | 'failed'
  result?: string
}

export interface SendOpts {
  expertId: string
  endpointId: string
  model: string
  thinking?: ThinkingParam // single source @shared/thinking — an inline copy here drifted when 'max'/adaptive landed
  text: string
  images?: { dataUrl: string; mime: string; name: string }[]
  cwd?: string // the project dir — required for agent roles, ignored for plain chat
  contextWindow?: number // agent roles pass the model's context window (drives compaction)
  permissionMode?: AgentMode // agent roles: initial permission mode (default / plan / bypass)
  imageModel?: string // designer image backend slug (image-tool roles only)
}

export interface ChatState {
  conversations: ConversationDto[]
  activeConv: string | null
  byConversation: Record<string, ChatMessage[]>
  streaming: Record<string, boolean>
  error: Record<string, string | null>
  permission: Record<string, PermissionPrompt | null> // per-conversation (future: parallel agent runs)
  question: Record<string, QuestionPrompt | null> // per-conversation AskUserQuestion prompt
  approvals: Record<string, ApprovalCard[]> // per-conversation coordinator approval cards (yellow notes + red pending)
  contextTokens: Record<string, number> // per-conversation CURRENT context size (count_tokens of the last sent turn) — drives the composer "/ window" indicator
  liveInput: Record<string, number> // per-conversation REAL input tokens of the in-flight request (full prompt incl cache), streamed live (↑ readout) — overwritten by streaming pings; NOT accumulated
  liveOutput: Record<string, number> // per-conversation REAL output tokens, streamed live during a turn (↓ readout) — overwritten by streaming pings; NOT accumulated
  liveCached: Record<string, number> // per-conversation cache-read share of liveInput — the cache-aware ↑ split renders fresh = liveInput − liveCached as the main number, cached as a "(+N cached)" note
  streamStartedAt: Record<string, number> // per-conversation epoch ms when the current turn started; read only while streaming (Overview "In progress" elapsed). Overwritten each send, left stale after (never read when not streaming)
  retry: Record<string, { attempt: number; max: number; since: number } | null> // per-conversation transient-failure retry status ("retrying (N/M)"); null/absent when not retrying
  compacting: Record<string, boolean> // per-conversation manual /compact in flight — de-dups the command (the visible progress line lives in chat as a pending compaction block)
  loadConversations: () => Promise<void>
  openConversation: (convId: string) => Promise<void>
  newConversation: () => void
  send: (opts: SendOpts) => Promise<void>
  stop: () => void
  compactNow: (convId: string) => Promise<void> // manual /compact — awaits the fold, shows the receipt/skip reason
  cancelCompact: (convId: string) => void // Stop button while compacting — aborts the fold (nothing written)
  respondPermission: (convId: string, allow: boolean) => void
  respondQuestion: (convId: string, answer: string) => void
  approveApproval: (convId: string, pendingId: string) => Promise<void>
  rejectApproval: (convId: string, pendingId: string) => void
  removeConversation: (convId: string) => Promise<void>
  rename: (convId: string, title: string) => Promise<void>
  setPinned: (convId: string, pinned: boolean) => Promise<void>
  setArchived: (convId: string, archived: boolean) => Promise<void>
}
