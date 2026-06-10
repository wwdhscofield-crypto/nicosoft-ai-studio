import { ipcMain } from 'electron'
import { pickDirectory } from './dialogs'
import * as skillService from '../services/skill.service'
import type { SkillInput } from './contracts'

// IPC boundary for skills (Extensions → Skills). Parse args, call the service, return — no logic here.
// skills:add throws on a bad import (no SKILL.md / empty body); the renderer surfaces the message.
export function registerSkillHandlers(): void {
  ipcMain.handle('skills:list', () => skillService.list())
  ipcMain.handle('skills:add', (_e, input: SkillInput) => skillService.add(input))
  ipcMain.handle('skills:update', (_e, id: string, patch: SkillInput) => skillService.update(id, patch))
  ipcMain.handle('skills:remove', (_e, id: string) => skillService.remove(id))
  // Folder picker for importing a SKILL.md directory. Returns the chosen path, or null if cancelled.
  ipcMain.handle('skills:pickDir', (e) => pickDirectory(e, { title: 'Select a skill folder (containing SKILL.md)' }))
}
