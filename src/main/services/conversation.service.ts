import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from '../db/connection'
import * as convRepo from '../repos/conversation.repo'
import * as titleService from './title.service'
import { persistDataUrl, removeConversationMedia } from '../media/storage'
import type {
  ConversationCreateDto,
  ConversationDto,
  ConversationTitleInput,
  MessageAppendDto,
  MessageAttachmentDto,
  MessageDto
} from '../ipc/contracts'

// Business layer for persisted conversations + messages. Maps repo rows to renderer DTOs. Appending a
// message also touches the conversation's updated_at so the history list (ordered by updated_at) stays
// fresh. Never touches IPC; never writes SQL directly.

function toConvDto(r: convRepo.ConversationRow): ConversationDto {
  return {
    id: r.id,
    kind: r.kind,
    primaryRoleId: r.primaryRoleId,
    title: r.title,
    projectId: r.projectId,
    pinned: r.pinned,
    archived: r.archived,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  }
}

function toMsgDto(r: convRepo.MessageRow): MessageDto {
  return {
    id: r.id,
    conversationId: r.conversationId,
    author: r.author,
    expertId: r.expertId,
    model: r.model,
    content: r.content,
    attachments: (r.attachments as MessageAttachmentDto[]) ?? [],
    runId: r.runId,
    inputTokens: r.inTokens,
    cacheReadTokens: r.cacheReadTokens,
    outputTokens: r.outTokens,
    dispatch: r.dispatch,
    createdAt: r.createdAt
  }
}

export function list(): ConversationDto[] {
  return convRepo.list().map(toConvDto)
}

export function create(input: ConversationCreateDto): ConversationDto {
  return toConvDto(
    convRepo.create({ kind: input.kind, primaryRoleId: input.primaryRoleId, title: input.title })
  )
}

export function messages(convId: string): MessageDto[] {
  return convRepo.listByConversation(convId).map(toMsgDto)
}

export function append(convId: string, input: MessageAppendDto): MessageDto {
  // Every image attachment is written to the media store first; the DB keeps only the nsai-media://
  // reference (a base64 data: URL would bloat sqlite). Non-image / already-referenced attachments
  // pass through untouched. Covers ALL roles — user vision uploads, designer art, anyone's pictures.
  const attachments = (input.attachments ?? []).map((a) => persistDataUrl(convId, a))
  const row = convRepo.append(convId, {
    author: input.author,
    expertId: input.expertId,
    model: input.model,
    content: input.content,
    attachments,
    runId: input.runId,
    inTokens: input.inputTokens,
    cacheReadTokens: input.cacheReadTokens,
    outTokens: input.outputTokens,
    dispatch: input.dispatch
  })
  convRepo.touch(convId) // bump updated_at so the history list re-sorts
  return toMsgDto(row)
}

export function rename(convId: string, title: string): void {
  convRepo.rename(convId, title)
}

export function setPinned(convId: string, pinned: boolean): void {
  convRepo.setPinned(convId, pinned)
}

export function setArchived(convId: string, archived: boolean): void {
  convRepo.setArchived(convId, archived)
}

// Generate a title for a fresh conversation from the user's first message (small/fast model — see
// title.service) and persist it. Returns the title so the renderer can patch its history list.
export async function generateTitle(input: ConversationTitleInput): Promise<string> {
  const title = await titleService.generate({
    firstMessage: input.firstMessage,
    endpointId: input.endpointId,
    model: input.model
  })
  convRepo.rename(input.convId, title)
  return title
}

export function remove(convId: string): void {
  convRepo.remove(convId)
  removeConversationMedia(convId) // DB rows cascade via FK; the media files don't — drop them too
  // Agent runs persist transcript.jsonl + tool-results/ (and e2e screenshots) under
  // ~/.nsai/sessions/<convId>/ — outside both the DB and the media dir, so neither cleanup above touches
  // it. Without this, deleted conversations leave their full tool-output history on disk forever.
  // Fire-and-forget: a failed disk cleanup must not block the user-facing delete.
  void rm(join(dataDir(), 'sessions', convId), { recursive: true, force: true }).catch(() => {})
}

// Serialize a conversation to Markdown or JSON for the export action (the handler writes it to disk).
export function exportContent(convId: string, format: 'md' | 'json'): { content: string; suggestedName: string } {
  const conv = convRepo.getById(convId)
  const msgs = convRepo.listByConversation(convId)
  const title = conv?.title || 'Conversation'
  const safe = (title.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'conversation').toLowerCase()
  if (format === 'json') {
    const payload = {
      title,
      exportedAt: new Date().toISOString(),
      messages: msgs.map((m) => ({ author: m.author, expertId: m.expertId, model: m.model, content: m.content, createdAt: m.createdAt }))
    }
    return { content: JSON.stringify(payload, null, 2), suggestedName: `${safe}.json` }
  }
  const lines = [`# ${title}`, '']
  for (const m of msgs) {
    const who = m.author === 'user' ? 'You' : m.expertId ? m.expertId.charAt(0).toUpperCase() + m.expertId.slice(1) : 'Assistant'
    lines.push(`## ${who}`, '', m.content, '')
  }
  return { content: lines.join('\n').trimEnd() + '\n', suggestedName: `${safe}.md` }
}
