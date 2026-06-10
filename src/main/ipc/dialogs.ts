// Native-dialog boilerplate shared by the IPC handlers (plugin/skill/project pickers, media/conversation
// saves). Folder picks are window-scoped when the sender still has a window (macOS shows them as a sheet);
// Electron's no-window overload covers the race where it's already gone.

import { BrowserWindow, dialog, type IpcMainInvokeEvent } from 'electron'
import { writeFile } from 'node:fs/promises'

// Open a directory picker; returns the chosen absolute path or null when cancelled.
export async function pickDirectory(
  e: IpcMainInvokeEvent,
  opts: { title?: string; create?: boolean } = {}
): Promise<string | null> {
  const win = BrowserWindow.fromWebContents(e.sender)
  const properties: Array<'openDirectory' | 'createDirectory'> = opts.create
    ? ['openDirectory', 'createDirectory']
    : ['openDirectory']
  const dialogOpts = { ...(opts.title ? { title: opts.title } : {}), properties }
  const res = await (win ? dialog.showOpenDialog(win, dialogOpts) : dialog.showOpenDialog(dialogOpts))
  return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0]
}

// Save-dialog → write → return the saved path, or null when the user cancels.
export async function saveToFile(
  opts: { defaultPath: string; filters: Electron.FileFilter[] },
  content: string | NodeJS.ArrayBufferView
): Promise<string | null> {
  const result = await dialog.showSaveDialog(opts)
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, content)
  return result.filePath
}
