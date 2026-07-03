import { ipcMain } from 'electron'
import { pickDirectory } from './dialogs'
import * as pluginService from '../services/extensions/plugin'

// IPC boundary for plugins (Extensions → Plugins). install throws on a bad manifest / failed
// registration (after rolling back); the renderer surfaces the message.
export function registerPluginHandlers(): void {
  ipcMain.handle('plugins:list', () => pluginService.list())
  ipcMain.handle('plugins:install', (_e, dirPath: string) => pluginService.install(dirPath))
  ipcMain.handle('plugins:uninstall', (_e, id: string) => pluginService.uninstall(id))
  ipcMain.handle('plugins:toggle', (_e, id: string, enabled: boolean) => pluginService.setEnabled(id, enabled))
  // Folder picker for installing a plugin. Returns the chosen path, or null if cancelled.
  ipcMain.handle('plugins:pickDir', (e) => pickDirectory(e, { title: 'Select a plugin folder (containing plugin.json)' }))
}
