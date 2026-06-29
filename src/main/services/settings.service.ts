import * as settingRepo from '../repos/setting.repo'
import { dataDir } from '../db/connection'
import type { AgentContext } from '../agent/context'

// Thin business layer over the settings key/value table (profile / general / privacy).
// Kept as a service (not called straight from IPC) so later validation/defaults have a home.

export function get<T = unknown>(key: string): T | null {
  return settingRepo.get<T>(key)
}

export function set<T = unknown>(key: string, value: T): void {
  settingRepo.set<T>(key, value)
  void emitConfigChange(key)
}

async function emitConfigChange(key: string): Promise<void> {
  const { hookRegistry } = await import('../agent/hooks/registry')
  if (!hookRegistry.hasAny('ConfigChange')) return
  const [{ runHooks }, { baseHookPayload, hookContextFromAgent }] = await Promise.all([
    import('../agent/hooks/engine'),
    import('../agent/hooks/adapter'),
  ])
  const signal = new AbortController().signal
  const ctx: AgentContext = {
    cwd: process.cwd(),
    signal,
    convId: '',
    permissionMode: 'default',
    sessionDir: dataDir(),
    readFileState: new Map(),
    requestPermission: async () => ({ allow: false, message: 'ConfigChange hooks cannot request tool permissions.' }),
    todos: [],
  }
  await runHooks('ConfigChange', { ...baseHookPayload('ConfigChange', ctx), source: 'settings', file_path: key }, hookContextFromAgent(ctx)).catch(() => undefined)
}
