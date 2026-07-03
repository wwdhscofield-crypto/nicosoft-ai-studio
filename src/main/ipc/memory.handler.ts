import { ipcMain } from 'electron'
import * as memoryService from '../services/memory/service'
import type { MemoryAddInput, MemoryUpdateInput, MemoryOnTurnInput } from './contracts'

// IPC boundary for memory: list/add/update/remove for the Memory UI, plus onTurn — the post-turn /
// explicit extraction trigger the renderer fires after each assistant reply. Thin pass-through: all
// rules (length cap, type/layer normalization, token cost, dedup precedence) live in memory.service.
// No SQL, no repo, no business logic here.
export function registerMemoryHandlers(): void {
  ipcMain.handle('memory:list', () => memoryService.list())
  ipcMain.handle('memory:add', (_e, input: MemoryAddInput) => memoryService.add(input))
  ipcMain.handle('memory:update', (_e, input: MemoryUpdateInput) => memoryService.update(input))
  ipcMain.handle('memory:remove', (_e, id: string) => memoryService.remove(id))
  // Fire-and-forget from the renderer; runs the post-turn cadence + explicit cue in the backend.
  ipcMain.handle('memory:onTurn', (_e, ctx: MemoryOnTurnInput) => memoryService.onTurn(ctx))
}
