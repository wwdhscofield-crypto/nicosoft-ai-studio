import { ipcMain } from 'electron'
import * as convService from '../services/conversation.service'
import type { ConversationCreateDto, ConversationTitleInput, MessageAppendDto } from './contracts'

// IPC boundary for persisted conversations + messages — parse args, call the service, return. No SQL.
export function registerConversationHandlers(): void {
  ipcMain.handle('conversations:list', () => convService.list())
  ipcMain.handle('conversations:create', (_e, input: ConversationCreateDto) => convService.create(input))
  ipcMain.handle('conversations:messages', (_e, convId: string) => convService.messages(convId))
  ipcMain.handle('conversations:append', (_e, convId: string, input: MessageAppendDto) =>
    convService.append(convId, input)
  )
  ipcMain.handle('conversations:rename', (_e, convId: string, title: string) => convService.rename(convId, title))
  ipcMain.handle('conversations:title', (_e, input: ConversationTitleInput) => convService.generateTitle(input))
  ipcMain.handle('conversations:remove', (_e, convId: string) => convService.remove(convId))
}
