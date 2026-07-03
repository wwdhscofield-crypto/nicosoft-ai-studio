import { ipcMain } from 'electron'
import * as gitService from '../services/workspace/git'
import { worktreeBaseRefFor } from '../services/workspace/worktree'

// IPC boundary for the composer git chip + the Workspace Diff panel (docs/workspace-git-diff-design.md §4).
// READS ONLY — both channels land on git.service's TTL memos (info/dirty 5 s, stats/diff 30 s), so the
// renderer's 5 s/15 s pollers cost one real git run per TTL at most. cwd is the renderer-resolved conv cwd
// (resolveConvCwd — same value the Files panel uses); the service degrades non-repos to hidden/null.
// When the cwd is a STUDIO WORKTREE, its immutable base commit (STUDIO_WT_BASE, cached lookup) is composed
// in as the diff base — the renderer stays baseRef-blind and a worktree conversation's ± reads "changed
// since this sandbox forked" instead of the no-upstream degenerate case (where a commit zeroes the chip).
export function registerGitHandlers(): void {
  ipcMain.handle('git:status', async (_e, cwd: string) =>
    typeof cwd === 'string' && cwd ? gitService.workStatus(cwd, await worktreeBaseRefFor(cwd)) : null
  )
  ipcMain.handle('git:diff', async (_e, cwd: string) =>
    typeof cwd === 'string' && cwd ? gitService.workDiff(cwd, await worktreeBaseRefFor(cwd)) : null
  )
}
