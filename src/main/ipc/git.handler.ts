import { ipcMain } from 'electron'
import * as gitService from '../services/workspace/git'

// IPC boundary for the composer git chip + the Workspace Diff panel (docs/workspace-git-diff-design.md §4).
// READS ONLY — both channels land on git.service's TTL memos (info/dirty 5 s, stats/diff 30 s), so the
// renderer's 5 s/15 s pollers cost one real git run per TTL at most. cwd is the renderer-resolved conv cwd
// (resolveConvCwd — same value the Files panel uses); the service degrades non-repos to hidden/null.
export function registerGitHandlers(): void {
  ipcMain.handle('git:status', (_e, cwd: string) => (typeof cwd === 'string' && cwd ? gitService.workStatus(cwd) : null))
  ipcMain.handle('git:diff', (_e, cwd: string) => (typeof cwd === 'string' && cwd ? gitService.workDiff(cwd) : null))
}
