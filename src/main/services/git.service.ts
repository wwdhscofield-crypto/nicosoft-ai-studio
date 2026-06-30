import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Read-only git helpers backing Engineer's path-selector branch chip plus Studio's worktree isolation.
// All commands run via execFile (NO shell): git-controlled branch names and validated paths are passed as
// separate argv entries, so shell metacharacters never execute; each call is time-boxed.

const SHORT_TIMEOUT = 5_000
const MEDIUM_TIMEOUT = 15_000
const LONG_TIMEOUT = 60_000

async function git(cwd: string, args: string[], timeout = MEDIUM_TIMEOUT): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 })
  return stdout
}

// Best-effort current branch from .git/HEAD. null when it's not a repo, is detached, or unreadable.
export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const head = await readFile(join(cwd, '.git', 'HEAD'), 'utf-8')
    const m = head.match(/ref:\s*refs\/heads\/(.+)/)
    return m ? m[1].trim() : null
  } catch {
    try {
      const out = await git(cwd, ['branch', '--show-current'], SHORT_TIMEOUT)
      return out.trim() || null
    } catch {
      return null
    }
  }
}

// List local branch names. Empty array when it's not a repo or git fails.
export async function listBranches(cwd: string): Promise<string[]> {
  try {
    const stdout = await git(cwd, ['branch', '--format=%(refname:short)'], SHORT_TIMEOUT)
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

// Switch branch; true on success. The branch comes from listBranches (git's own output).
export async function checkout(cwd: string, branch: string): Promise<boolean> {
  try {
    await git(cwd, ['checkout', branch], 10_000)
    return true
  } catch {
    return false
  }
}

export async function gitRoot(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ['rev-parse', '--show-toplevel'], SHORT_TIMEOUT)
    return out.trim() || null
  } catch {
    return null
  }
}

export async function gitDir(cwd: string): Promise<string | null> {
  try {
    const out = (await git(cwd, ['rev-parse', '--git-dir'], SHORT_TIMEOUT)).trim()
    if (!out) return null
    return isAbsolute(out) ? out : resolve(cwd, out)
  } catch {
    return null
  }
}

export async function gitHead(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', 'HEAD'], SHORT_TIMEOUT)).trim()
}

export async function gitDefaultBranchRef(cwd: string): Promise<string | null> {
  try {
    const out = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], SHORT_TIMEOUT)).trim()
    if (out) return out
  } catch {
    // Fall through to local branch / HEAD.
  }
  const cur = await currentBranch(cwd)
  return cur || 'HEAD'
}

export interface GitWorktreeEntry {
  path: string
  branch?: string
  head?: string
  locked?: boolean
}

export async function worktreeList(cwd: string): Promise<GitWorktreeEntry[]> {
  const stdout = await git(cwd, ['worktree', 'list', '--porcelain'], MEDIUM_TIMEOUT)
  const entries: GitWorktreeEntry[] = []
  let cur: GitWorktreeEntry | undefined
  for (const raw of stdout.split('\n')) {
    const line = raw.trimEnd()
    if (!line) {
      if (cur) entries.push(cur)
      cur = undefined
      continue
    }
    const [key, ...rest] = line.split(' ')
    const value = rest.join(' ')
    if (key === 'worktree') cur = { path: value }
    else if (cur && key === 'HEAD') cur.head = value
    else if (cur && key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '')
    else if (cur && key === 'locked') cur.locked = true
  }
  if (cur) entries.push(cur)
  return entries
}

export async function worktreeAdd(cwd: string, input: { branch: string; path: string; baseRef: string; noCheckout?: boolean }): Promise<void> {
  const args = ['worktree', 'add']
  if (input.noCheckout) args.push('--no-checkout')
  // -b (create-only), NOT -B (create-or-RESET): -B would silently force-reset a pre-existing `worktree-<slug>`
  // branch to baseRef, discarding its commits — a footgun for EnterWorktree({name}) with a user-chosen name that
  // collides with an existing branch. Auto-managed names (agent-a<random-hex>) never collide; the resume path
  // handles an already-registered worktree before reaching here. A genuine stale-branch collision now FAILS loudly
  // (caller surfaces it) instead of destroying work — and the retention sweep reaps stale worktrees+branches anyway.
  args.push('--no-track', '-b', input.branch, input.path, input.baseRef)
  await git(cwd, args, LONG_TIMEOUT)
}

export async function worktreeLock(cwd: string, path: string, reason: string): Promise<void> {
  await git(cwd, ['worktree', 'lock', '--reason', reason, path], MEDIUM_TIMEOUT)
}

export async function worktreeUnlock(cwd: string, path: string): Promise<void> {
  await git(cwd, ['worktree', 'unlock', path], MEDIUM_TIMEOUT)
}

export async function worktreePrune(cwd: string): Promise<void> {
  await git(cwd, ['worktree', 'prune'], LONG_TIMEOUT)
}

export async function worktreeRemoveForce(cwd: string, path: string): Promise<void> {
  await git(cwd, ['worktree', 'remove', '--force', path], LONG_TIMEOUT)
}

export async function branchDeleteForce(cwd: string, branch: string): Promise<void> {
  await git(cwd, ['branch', '-D', branch], MEDIUM_TIMEOUT)
}

export async function worktreeStatusPorcelain(path: string): Promise<string> {
  return git(path, ['status', '--porcelain'], MEDIUM_TIMEOUT)
}

export async function worktreeAheadCount(path: string, baseCommit: string): Promise<number> {
  const out = await git(path, ['rev-list', '--count', `${baseCommit}..HEAD`], MEDIUM_TIMEOUT)
  const n = Number.parseInt(out.trim(), 10)
  return Number.isFinite(n) ? n : 0
}

export interface WorktreeChanges {
  dirty: boolean
  ahead: number
  status: string
}

export async function worktreeChanges(path: string, baseCommit: string): Promise<WorktreeChanges> {
  const status = await worktreeStatusPorcelain(path)
  const ahead = await worktreeAheadCount(path, baseCommit)
  return { dirty: status.trim().length > 0, ahead, status }
}
