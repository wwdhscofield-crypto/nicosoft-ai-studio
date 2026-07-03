import { ipcMain } from 'electron'
import * as mcpService from '../services/extensions/mcp'
import type { McpServerInput } from './contracts'

// IPC boundary for MCP servers (Extensions → MCP). Parse args, call the service, return — no logic here.
// Secrets (env/headers) ride in McpServerInput.secrets → keychain; they never come back out (DTO exposes
// only hasSecrets).
export function registerMcpHandlers(): void {
  ipcMain.handle('mcp:list', () => mcpService.list())
  ipcMain.handle('mcp:add', (_e, input: McpServerInput) => mcpService.add(input))
  ipcMain.handle('mcp:update', (_e, id: string, patch: McpServerInput) => mcpService.update(id, patch))
  ipcMain.handle('mcp:remove', (_e, id: string) => mcpService.remove(id))
  ipcMain.handle('mcp:test', (_e, id: string) => mcpService.test(id))
}
