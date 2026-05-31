import * as convRepo from '../repos/conversation.repo'
import * as titleService from './title.service'
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
  const row = convRepo.append(convId, {
    author: input.author,
    expertId: input.expertId,
    model: input.model,
    content: input.content,
    attachments: input.attachments ?? []
  })
  convRepo.touch(convId) // bump updated_at so the history list re-sorts
  return toMsgDto(row)
}

export function rename(convId: string, title: string): void {
  convRepo.rename(convId, title)
}

// Generate a title for a fresh conversation from the user's first message (small/fast model — see
// title.service) and persist it. Returns the title so the renderer can patch its history list.
export async function generateTitle(input: ConversationTitleInput): Promise<string> {
  const title = await titleService.generate({
    firstMessage: input.firstMessage,
    fallbackEndpointId: input.fallbackEndpointId,
    fallbackModel: input.fallbackModel
  })
  convRepo.rename(input.convId, title)
  return title
}

export function remove(convId: string): void {
  convRepo.remove(convId)
}
