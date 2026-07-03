import { cp, lstat, mkdir, readFile, readdir, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { AgentContext } from '../../agent/context'
import { baseHookPayload, hookContextFromAgent } from '../../agent/hooks/adapter'
import { runHooks } from '../../agent/hooks/engine'
import { hookRegistry } from '../../agent/hooks/registry'
import * as settingsService from '../settings.service'
import * as git from './git'

export type WorktreeBaseRefSetting = 'fresh' | 'head' | string
export type WorktreeBgIsolation = 'worktree' | 'none'

export interface WorktreeSettings {
  baseRef?: WorktreeBaseRefSetting
  bgIsolation: WorktreeBgIsolation
  symlinkDirectories: string[]
  sparsePaths: string[]
}

export interface ManagedWorktree {
  name: string
  slug: string
  root: string
  path: string
  branch?: string
  baseCommit?: string
  baseFile?: string
  existed: boolean
  createdByStudio: boolean
  hookManaged?: boolean
}

export type WorktreeRemoveSource = 'task' | 'exit_tool' | 'exit_dialog' | 'job_delete_force' | 'job_retention_sweep'

export interface WorktreeRemoveResult {
  status: 'removed' | 'kept'
  path: string
  branch?: string
  dirty?: boolean
  ahead?: number
  reason?: string
}

const WORKTREE_DIR = join('.studio', 'worktrees')
const BASE_FILE = 'STUDIO_WT_BASE'
const AUTO_MANAGED_NAME = /^(agent-a[0-9a-f]{7,16}|wf_.+|bridge-.+|job-.+)$/
const activeWorktrees = new Set<string>()
// Retention cutoff for the stale-worktree sweep — mirrors CC's startup retention sweep (FOo, mtime-cutoff). An
// auto-managed worktree idle this long, with no uncommitted/ahead changes and not active/locked, is reaped. Studio
// is multi-project (no single startup root like CC), so the sweep runs per-repo at worktree-create time (see
// createAgentWorktree) rather than once at boot. settings `worktree.retentionMs` overrides; default 24h.
// (Confirm the exact CC cutoff vs the binary if precise parity is needed — this is a conservative default, not a
// throttle CC lacks: CC's retention sweep has an mtime cutoff too.)
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : []
}

export function getWorktreeSettings(): WorktreeSettings {
  const raw = settingsService.get<Record<string, unknown>>('worktree')
  const obj = raw && typeof raw === 'object' ? raw : {}
  const baseRef = typeof obj.baseRef === 'string' && obj.baseRef.trim() ? obj.baseRef.trim() : undefined
  const bgIsolation = obj.bgIsolation === 'none' ? 'none' : 'worktree'
  return {
    baseRef,
    bgIsolation,
    symlinkDirectories: asStringArray(obj.symlinkDirectories),
    sparsePaths: asStringArray(obj.sparsePaths),
  }
}

export function worktreeSlug(name: string): string {
  return name.replaceAll('/', '+')
}

export function worktreeBranch(slug: string): string {
  return `worktree-${slug}`
}

export function worktreesDir(root: string): string {
  return join(root, WORKTREE_DIR)
}

export function worktreePathForName(root: string, name: string): { slug: string; path: string; branch: string } {
  const slug = worktreeSlug(name)
  const base = worktreesDir(root)
  const path = resolve(base, slug)
  assertInside(path, base, 'worktree path')
  return { slug, path, branch: worktreeBranch(slug) }
}

function assertInside(path: string, root: string, label: string): void {
  const rel = relative(resolve(root), resolve(path))
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return
  throw new Error(`Invalid ${label}: path escapes ${root}`)
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

async function resolveBaseRef(root: string, settings = getWorktreeSettings()): Promise<string> {
  if (settings.baseRef === 'head') return 'HEAD'
  if (settings.baseRef && settings.baseRef !== 'fresh') return settings.baseRef
  return (await git.gitDefaultBranchRef(root)) ?? 'HEAD'
}

async function writeBaseCommit(path: string): Promise<{ baseCommit: string; baseFile: string }> {
  const baseCommit = await git.gitHead(path)
  const dir = await git.gitDir(path)
  if (!dir) throw new Error(`Unable to resolve git dir for worktree: ${path}`)
  const baseFile = join(dir, BASE_FILE)
  await writeFile(baseFile, `${baseCommit}\n`, 'utf-8')
  return { baseCommit, baseFile }
}

async function copyIfPresent(root: string, worktreePath: string, relPath: string): Promise<void> {
  const src = join(root, relPath)
  if (!(await exists(src))) return
  const dst = join(worktreePath, relPath)
  await mkdir(dirname(dst), { recursive: true })
  await cp(src, dst, { recursive: true, force: true, verbatimSymlinks: true })
}

async function copyWorktreeIncludes(root: string, worktreePath: string): Promise<void> {
  const includeFile = join(root, '.worktreeinclude')
  if (!(await exists(includeFile))) return
  await copyIfPresent(root, worktreePath, '.worktreeinclude')
  const text = await readFile(includeFile, 'utf-8').catch(() => '')
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const rel = line.replace(/^\.\//, '')
    const src = resolve(root, rel)
    assertInside(src, root, '.worktreeinclude entry')
    await copyIfPresent(root, worktreePath, rel).catch(() => undefined)
  }
}

async function copyLocalSettings(root: string, worktreePath: string): Promise<void> {
  await copyIfPresent(root, worktreePath, join('.studio', 'settings.local.json'))
  await copyIfPresent(root, worktreePath, join('.claude', 'settings.local.json'))
}

async function symlinkConfiguredDirectories(root: string, worktreePath: string, relPaths: string[]): Promise<void> {
  for (const raw of relPaths) {
    const rel = raw.replace(/^\.\//, '')
    const src = resolve(root, rel)
    assertInside(src, root, 'symlink source')
    const srcStat = await lstat(src).catch(() => null)
    if (!srcStat?.isDirectory()) continue
    const dst = resolve(worktreePath, rel)
    assertInside(dst, worktreePath, 'symlink target')
    if (await exists(dst)) continue
    await mkdir(dirname(dst), { recursive: true })
    await symlink(src, dst, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

async function afterCreate(root: string, worktreePath: string, settings: WorktreeSettings): Promise<{ baseCommit: string; baseFile: string }> {
  await copyLocalSettings(root, worktreePath)
  await copyWorktreeIncludes(root, worktreePath)
  await symlinkConfiguredDirectories(root, worktreePath, settings.symlinkDirectories)
  return writeBaseCommit(worktreePath)
}

export async function createAgentWorktree(ctxOrCwd: AgentContext | string, name: string): Promise<ManagedWorktree> {
  const ctx = typeof ctxOrCwd === 'string' ? undefined : ctxOrCwd
  const cwd = typeof ctxOrCwd === 'string' ? ctxOrCwd : ctxOrCwd.cwd
  if (ctx && hookRegistry.hasAny('WorktreeCreate')) {
    const result = await runHooks('WorktreeCreate', { ...baseHookPayload('WorktreeCreate', ctx), name }, hookContextFromAgent(ctx))
    const hookPath = result.worktreePath?.trim()
    if (!hookPath) throw new Error('WorktreeCreate hook did not return hookSpecificOutput.worktreePath.')
    const st = await stat(hookPath).catch(() => null)
    if (!st?.isDirectory()) throw new Error(`WorktreeCreate hook returned a non-directory path: ${hookPath}`)
    const root = (await git.gitRoot(hookPath)) ?? (await git.gitRoot(cwd)) ?? cwd
    activeWorktrees.add(resolve(hookPath))
    return { name, slug: worktreeSlug(name), root, path: hookPath, branch: undefined, baseCommit: undefined, baseFile: undefined, existed: false, createdByStudio: false, hookManaged: true }
  }

  const root = await git.gitRoot(cwd)
  if (!root) throw new Error('Worktree isolation requires a git repository.')
  const settings = getWorktreeSettings()
  const { slug, path, branch } = worktreePathForName(root, name)
  const listed = await git.worktreeList(root).catch(() => [])
  const registered = listed.some((w) => resolve(w.path) === resolve(path))
  await mkdir(worktreesDir(root), { recursive: true })

  if (registered && (await exists(path))) {
    const now = new Date()
    await utimes(path, now, now).catch(() => undefined)
    const dir = await git.gitDir(path)
    const baseFile = dir ? join(dir, BASE_FILE) : join(path, '.git', BASE_FILE)
    const baseCommit = (await readFile(baseFile, 'utf-8').catch(() => '')).trim() || (await git.gitHead(path))
    activeWorktrees.add(resolve(path))
    console.log(`[worktree] Resuming existing agent worktree ${name} at ${path}`)
    return { name, slug, root, path, branch, baseCommit, baseFile, existed: true, createdByStudio: true }
  }

  if (await exists(path)) throw new Error(`Worktree path exists but is not registered with git: ${path}`)

  // P2 GC: reap stale auto-managed worktrees in THIS repo before creating a new one (CC's startup retention sweep,
  // adapted per-repo for Studio's multi-project model). Awaited (not fire-and-forget) so its prune/remove can't race
  // this create's git ops; best-effort. It skips active/locked/dirty/ahead/recent worktrees, so it never touches
  // live sessions or unsaved work.
  await cleanupStaleAgentWorktrees(root, { cutoffMs: DEFAULT_RETENTION_MS }).catch(() => undefined)

  const baseRef = await resolveBaseRef(root, settings)
  await git.worktreeAdd(root, { branch, path, baseRef })
  const { baseCommit, baseFile } = await afterCreate(root, path, settings)
  await git.worktreeLock(root, path, `studio agent ${name} (pid ${process.pid} start ${new Date().toISOString()})`)
  activeWorktrees.add(resolve(path))
  console.log(`[worktree] Created agent worktree ${name} at ${path}`)
  return { name, slug, root, path, branch, baseCommit, baseFile, existed: false, createdByStudio: true }
}

export async function readWorktreeBase(path: string): Promise<{ baseCommit: string; baseFile: string } | null> {
  const dir = await git.gitDir(path)
  if (!dir) return null
  const baseFile = join(dir, BASE_FILE)
  const baseCommit = (await readFile(baseFile, 'utf-8').catch(() => '')).trim()
  return baseCommit ? { baseCommit, baseFile } : null
}

// cwd → this worktree's immutable base commit (STUDIO_WT_BASE), or undefined for any non-Studio-worktree
// cwd (main checkout, non-repo, foreign worktree). The git-status IPC composes it into workStatus/workDiff
// so a worktree conversation's ± reads "what this sandboxed session changed since it forked" instead of
// the no-upstream degenerate case (merge-base = HEAD → commit zeroes the chip). Cached with a short TTL:
// the base file is written once at create and never changes, but the chip polls every 5 s and each miss
// costs a `git rev-parse --git-dir` spawn; the TTL also lets a swept-and-recreated path converge.
const BASE_REF_TTL_MS = 60_000
const baseRefCache = new Map<string, { at: number; ref?: string }>()
export async function worktreeBaseRefFor(cwd: string): Promise<string | undefined> {
  const key = resolve(cwd)
  const hit = baseRefCache.get(key)
  if (hit && Date.now() - hit.at < BASE_REF_TTL_MS) return hit.ref
  const ref = (await readWorktreeBase(cwd).catch(() => null))?.baseCommit || undefined
  baseRefCache.set(key, { at: Date.now(), ref })
  return ref
}

function isForceRemoveSource(source: WorktreeRemoveSource, discardChanges?: boolean): boolean {
  return discardChanges === true || source === 'job_delete_force'
}

export async function removeAgentWorktree(worktree: ManagedWorktree, source: WorktreeRemoveSource, discardChanges = false, ctx?: AgentContext): Promise<WorktreeRemoveResult> {
  const force = isForceRemoveSource(source, discardChanges)
  activeWorktrees.delete(resolve(worktree.path))
  let removeHookSucceeded = false
  if (ctx && hookRegistry.hasAny('WorktreeRemove')) {
    const hookResult = await runHooks('WorktreeRemove', { ...baseHookPayload('WorktreeRemove', ctx), worktree_path: worktree.path }, hookContextFromAgent(ctx)).catch(() => undefined)
    removeHookSucceeded = (hookResult?.counts.success ?? 0) > 0
  }
  if (worktree.hookManaged) {
    return removeHookSucceeded
      ? { status: 'removed', path: worktree.path, branch: worktree.branch }
      : { status: 'kept', path: worktree.path, branch: worktree.branch, reason: 'hook_managed' }
  }
  if (!worktree.branch || !worktree.baseCommit) {
    return { status: 'kept', path: worktree.path, branch: worktree.branch, reason: 'not_studio_managed' }
  }

  let unlocked = false
  try {
    const changes = await git.worktreeChanges(worktree.path, worktree.baseCommit)
    if ((changes.dirty || changes.ahead > 0) && !force) {
      console.log(`[worktree] Agent worktree kept at: ${worktree.path}`)
      return { status: 'kept', path: worktree.path, branch: worktree.branch, dirty: changes.dirty, ahead: changes.ahead, reason: 'dirty_or_ahead' }
    }
    await git.worktreeUnlock(worktree.root, worktree.path).then(() => {
      unlocked = true
    }).catch(() => undefined)
    await git.worktreeRemoveForce(worktree.root, worktree.path)
    await git.branchDeleteForce(worktree.root, worktree.branch).catch((err) => {
      console.warn(`[worktree] failed to delete branch ${worktree.branch}: ${err instanceof Error ? err.message : String(err)}`)
    })
    console.log(`[worktree] Removed agent worktree ${worktree.name} at ${worktree.path}`)
    return { status: 'removed', path: worktree.path, branch: worktree.branch, dirty: changes.dirty, ahead: changes.ahead }
  } catch (err) {
    if (unlocked) await git.worktreeLock(worktree.root, worktree.path, `studio agent ${worktree.name} (pid ${process.pid} cleanup keep ${new Date().toISOString()})`).catch(() => undefined)
    console.warn(`[worktree] keeping worktree after cleanup failure at ${worktree.path}: ${err instanceof Error ? err.message : String(err)}`)
    return { status: 'kept', path: worktree.path, branch: worktree.branch, reason: 'git_error' }
  }
}

export async function removeExistingWorktree(input: { root: string; path: string; branch?: string; discardChanges: boolean; source: WorktreeRemoveSource }): Promise<WorktreeRemoveResult> {
  const base = await readWorktreeBase(input.path)
  const branch = input.branch ?? (await git.worktreeList(input.root).then((list) => list.find((w) => resolve(w.path) === resolve(input.path))?.branch).catch(() => undefined))
  if (!base || !branch) return { status: 'kept', path: input.path, branch, reason: 'not_studio_managed' }
  return removeAgentWorktree(
    { name: branch.replace(/^worktree-/, ''), slug: branch.replace(/^worktree-/, ''), root: input.root, path: input.path, branch, baseCommit: base.baseCommit, baseFile: base.baseFile, existed: true, createdByStudio: true },
    input.source,
    input.discardChanges,
  )
}

export interface CleanupStaleOptions {
  cutoffMs: number
}

export async function cleanupStaleAgentWorktrees(root: string, options: CleanupStaleOptions): Promise<WorktreeRemoveResult[]> {
  await git.worktreePrune(root).catch(() => undefined)
  const dir = worktreesDir(root)
  const names = await readdir(dir).catch(() => [])
  const now = Date.now()
  const results: WorktreeRemoveResult[] = []
  const listed = await git.worktreeList(root).catch(() => [])
  for (const name of names) {
    if (!AUTO_MANAGED_NAME.test(name)) continue
    const path = join(dir, name)
    if (activeWorktrees.has(resolve(path))) continue
    const st = await stat(path).catch(() => null)
    if (!st || now - st.mtimeMs < options.cutoffMs) continue
    const entry = listed.find((w) => resolve(w.path) === resolve(path))
    if (!entry?.branch || entry.locked) continue
    const base = await readWorktreeBase(path)
    if (!base) continue
    const changes = await git.worktreeChanges(path, base.baseCommit).catch(() => null)
    if (!changes || changes.dirty || changes.ahead > 0) continue
    results.push(
      await removeAgentWorktree(
        { name, slug: name, root, path, branch: entry.branch, baseCommit: base.baseCommit, baseFile: base.baseFile, existed: true, createdByStudio: true },
        'job_retention_sweep',
      ),
    )
  }
  return results
}

