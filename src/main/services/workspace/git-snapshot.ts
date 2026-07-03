import { execFile } from 'node:child_process'

// Pre-fix-round workspace snapshot. Autonomous fix rounds (Gate B fail handler, Gate C fix legs) edit
// code in the USER'S real working tree on top of the implementer's changes — a bad fix can degrade a
// good implementation with nothing to roll back to. `git stash create` writes a dangling commit
// capturing the tracked state WITHOUT touching the working tree, the index, or the stash list (no
// worktree, no branch — recover with `git stash apply <sha>`; an unreferenced sha is gc-safe for
// weeks, far beyond any recovery window). Untracked files are not in that commit, so they're listed
// alongside — the round log shows exactly what a recovery would NOT bring back.
//
// Recovery is deliberately MANUAL: "did the fix round make things worse" is not machine-judgeable,
// and a wrong auto-revert is worse than none. This module only guarantees the rollback point exists.
// Never throws; null when there's nothing to snapshot (clean tree, not a repo, git unavailable).

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 10_000 }, (err, stdout) => resolve(err ? '' : String(stdout).trim()))
  })
}

export interface WorkspaceSnapshot {
  sha: string // '' when the tracked tree was clean (nothing to capture — untracked may still exist)
  untracked: string[]
}

export async function snapshotWorkspace(cwd: string | undefined): Promise<WorkspaceSnapshot | null> {
  if (!cwd) return null
  if ((await git(cwd, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return null
  const sha = await git(cwd, ['stash', 'create'])
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean)
  if (!sha && untracked.length === 0) return null
  return { sha, untracked }
}

// One-line description for round logs / gate evidence.
export function describeSnapshot(snap: WorkspaceSnapshot): string {
  const parts: string[] = []
  if (snap.sha) parts.push(`recover tracked changes with \`git stash apply ${snap.sha}\``)
  else parts.push('tracked tree was clean')
  if (snap.untracked.length) parts.push(`${snap.untracked.length} untracked file(s) NOT in the snapshot: ${snap.untracked.slice(0, 10).join(', ')}${snap.untracked.length > 10 ? ', …' : ''}`)
  return parts.join('; ')
}
