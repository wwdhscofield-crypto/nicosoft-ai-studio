import { execFile } from 'node:child_process'
import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { GitFileDiff, GitWorkDiff, GitWorkStatus } from '../../ipc/contracts'

const execFileAsync = promisify(execFile)

// Read-only git helpers backing Engineer's path-selector branch chip plus Studio's worktree isolation.
// All commands run via execFile (NO shell): git-controlled branch names and validated paths are passed as
// separate argv entries, so shell metacharacters never execute; each call is time-boxed.

const SHORT_TIMEOUT = 5_000
const MEDIUM_TIMEOUT = 15_000
const LONG_TIMEOUT = 60_000

async function git(cwd: string, args: string[], timeout = MEDIUM_TIMEOUT, maxBuffer = 10 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, timeout, maxBuffer })
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

// Absolute path of the repo's COMMON git dir (`--git-common-dir`): the SHARED `.git` of the main worktree AND
// every linked worktree, so it identifies the one canonical repo regardless of which worktree cwd sits in.
// Compared against gitDir() this tells a linked worktree (git-dir = <main>/.git/worktrees/<slug>) apart from
// the main worktree / a plain checkout (git-dir === common-dir). null when it's not a repo or git fails.
export async function gitCommonDir(cwd: string): Promise<string | null> {
  try {
    const out = (await git(cwd, ['rev-parse', '--git-common-dir'], SHORT_TIMEOUT)).trim()
    if (!out) return null
    return isAbsolute(out) ? out : resolve(cwd, out)
  } catch {
    return null
  }
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

/* ============================================================================
   Workspace git status/diff — the composer chip + Diff panel read path.
   CC-aligned pipeline (docs/workspace-git-diff-design.md §3/§4/§6, forensics §10):
   base resolution (iEe) → stats-only (BZe) / full collection (nEe) → untracked
   tiers (E4t) → 5 MB exclude-retry overflow (rEn) → HEAD fallback (lEn), plus
   the TTL memos + stats→diff prefetch (GitStatusService). READS ONLY — every
   git mutation goes through the agent; the chip button just sends a chat
   message. All constants below are CC-verified (§6), not invented.
   ============================================================================ */

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904' // git's canonical empty tree — unborn-HEAD diff base
const DIFF_TIMEOUT = 30_000
const UNTRACKED_READ_CAP = 200 // content read for the first N untracked files only
const UNTRACKED_LIST_CAP = 400 // files 201–400 are listed as stubs; beyond that omitted (+log)
const UNTRACKED_FILE_BYTES_CAP = 1024 * 1024 // >1 MB → stub (never read into memory)
const UNTRACKED_INLINE_LINES_CAP = 2000 // ≤N lines → inline synthetic new-file patch, else stub-with-count
const PATCH_TOTAL_BYTES_CAP = 5 * 1024 * 1024 // total patch buffer (execFile maxBuffer — overflow throws)
const PATCH_EXCLUDE_BYTES_PER_LINE = 80 // overflow retry: estimated bytes per changed line
const PATCH_EXCLUDE_TARGET_RATIO = 0.8 // exclude largest files until the estimate fits 80% of the cap
const PATCH_EXCLUDE_MIN_LINES = 2000 // never exclude files with fewer changed lines (floor)
const PREFETCH_FILE_COUNT_CAP = 200 // stats→diff prefetch only when 1..N files changed
const PREFETCH_CONCURRENCY_CAP = 2
const INFO_TTL_MS = 5_000
const DIRTY_TTL_MS = 5_000
const STATS_TTL_MS = 30_000
const DIFF_TTL_MS = 30_000
const NOT_GIT_TTL_MS = 5 * 60_000 // non-repo verdict cached minutes — stop re-probing folders that aren't repos

interface GitBaseInfo {
  root: string
  branch: string | null // null = detached / unborn
  base: string // diff base: merge-base(resolvedBase, HEAD) | empty-tree (unborn) | 'HEAD' (metadata fallback)
  ahead: number
  behind: number
  hasUpstream: boolean
  hasRemote: boolean
}

// Base resolution (CC iEe): current branch → origin/<branch> preferred, local ref fallback →
// merge-base(resolvedBase, HEAD). Consequence (§2): ± spans uncommitted + unpushed together; commit keeps
// the chip, push zeroes it. No upstream → resolvedBase = the local ref → merge-base = HEAD → working-tree
// only (CC-identical degenerate case). A worktree conversation passes its own baseRef instead → the diff
// reads "what this sandboxed session changed since it forked". Any metadata failure → CC lEn: plain HEAD.
async function readBaseInfo(cwd: string, baseRef?: string): Promise<GitBaseInfo | null> {
  let root: string
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'], SHORT_TIMEOUT)).trim()
  } catch {
    return null // not a repo / bare / git missing — chip hidden, panel empty state (§6)
  }
  if (!root) return null
  const branch = await currentBranch(cwd)
  const hasRemote = await git(cwd, ['remote'], SHORT_TIMEOUT)
    .then((o) => o.trim().length > 0)
    .catch(() => false)
  const headOk = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], SHORT_TIMEOUT)
    .then(() => true)
    .catch(() => false)
  if (!headOk) return { root, branch, base: EMPTY_TREE_HASH, ahead: 0, behind: 0, hasUpstream: false, hasRemote } // unborn HEAD → everything reads as added
  const hasUpstream = branch
    ? await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], SHORT_TIMEOUT)
        .then((o) => o.trim().length > 0)
        .catch(() => false)
    : false
  if (baseRef) {
    try {
      const base = (await git(cwd, ['merge-base', baseRef, 'HEAD'], SHORT_TIMEOUT)).trim()
      const ahead = await worktreeAheadCount(cwd, base)
      return { root, branch, base: base || 'HEAD', ahead, behind: 0, hasUpstream, hasRemote }
    } catch {
      return { root, branch, base: 'HEAD', ahead: 0, behind: 0, hasUpstream, hasRemote }
    }
  }
  const resolvedBase = branch ? (hasUpstream ? `origin/${branch}` : branch) : 'HEAD'
  try {
    const base = (await git(cwd, ['merge-base', resolvedBase, 'HEAD'], SHORT_TIMEOUT)).trim()
    let ahead = 0
    let behind = 0
    if (hasUpstream) {
      // left = commits only on origin (behind), right = only on HEAD (ahead). Without an upstream the
      // range is empty by construction (resolvedBase IS HEAD) — skip the spawn.
      const lr = (await git(cwd, ['rev-list', '--left-right', '--count', `${resolvedBase}...HEAD`], SHORT_TIMEOUT)).trim().match(/^(\d+)\s+(\d+)$/)
      if (lr) {
        behind = Number.parseInt(lr[1], 10)
        ahead = Number.parseInt(lr[2], 10)
      }
    }
    return { root, branch, base: base || 'HEAD', ahead, behind, hasUpstream, hasRemote }
  } catch {
    return { root, branch, base: 'HEAD', ahead: 0, behind: 0, hasUpstream, hasRemote } // lEn fallback
  }
}

// --- TTL memos (CC GitStatusService §10.2). Values hold the PROMISE so concurrent asks (chip poll +
// panel pull + prefetch) share one git run; rejections evict so a transient failure never sticks.
interface MemoEntry<T> {
  at: number
  ttl: number
  p: Promise<T>
}
function memoGet<T>(map: Map<string, MemoEntry<T>>, key: string, ttl: number, fn: () => Promise<T>, ttlFor?: (v: T) => number): Promise<T> {
  const hit = map.get(key)
  if (hit && Date.now() - hit.at < hit.ttl) return hit.p
  const entry: MemoEntry<T> = { at: Date.now(), ttl, p: fn() }
  entry.p
    .then((v) => {
      if (ttlFor && map.get(key) === entry) entry.ttl = ttlFor(v)
    })
    .catch(() => {
      if (map.get(key) === entry) map.delete(key)
    })
  map.set(key, entry)
  return entry.p
}

const infoMemo = new Map<string, MemoEntry<GitBaseInfo | null>>()
const dirtyMemo = new Map<string, MemoEntry<boolean>>()
const statsMemo = new Map<string, MemoEntry<{ additions: number; deletions: number; fileCount: number }>>()
const diffMemo = new Map<string, MemoEntry<GitWorkDiff>>()
const statsFingerprint = new Map<string, string>()
let prefetchInflight = 0

// Event-push invalidation (§4.2): a git-mutating Bash tool result just landed for this cwd — drop every
// memo so the next ask (the conv:git-triggered renderer refresh) reruns git instead of serving stale state.
export function invalidateGitCaches(cwd: string): void {
  for (const map of [infoMemo, statsMemo, diffMemo, statsFingerprint] as Map<string, unknown>[]) {
    for (const key of map.keys()) if (key === cwd || key.startsWith(cwd + '\0')) map.delete(key)
  }
  dirtyMemo.delete(cwd)
}

const memoKey = (cwd: string, baseRef?: string): string => `${cwd}\0${baseRef ?? ''}`
const memoInfo = (cwd: string, baseRef?: string): Promise<GitBaseInfo | null> =>
  memoGet(infoMemo, memoKey(cwd, baseRef), INFO_TTL_MS, () => readBaseInfo(cwd, baseRef), (v) => (v === null ? NOT_GIT_TTL_MS : INFO_TTL_MS))

// --- Untracked handling (CC E4t tiers, §6): first 200 files → content read (>1 MB → stub; NUL byte →
// binary → stub; ≤2000 lines → inline synthetic patch, else stub with the real count); 201–400 → listed
// as stubs (no read); beyond 400 → omitted + log. The stats path runs the same tiers with patches off.
interface UntrackedFile {
  path: string
  additions: number
  patch: string
}
async function collectUntracked(cwd: string, root: string, withPatch: boolean): Promise<UntrackedFile[]> {
  let names: string[]
  try {
    names = (await git(cwd, ['ls-files', '--others', '--exclude-standard', '--full-name', ':/'], DIFF_TIMEOUT)).split('\n').filter(Boolean)
  } catch {
    return []
  }
  if (names.length > UNTRACKED_LIST_CAP) console.log(`[git] ${names.length - UNTRACKED_LIST_CAP} additional untracked files omitted (>${UNTRACKED_LIST_CAP})`)
  const listed = names.slice(0, UNTRACKED_LIST_CAP)
  const files: UntrackedFile[] = []
  for (let i = 0; i < listed.length; i++) {
    const p = listed[i]
    if (i >= UNTRACKED_READ_CAP) {
      files.push({ path: p, additions: 0, patch: '' }) // 201–400: listed, content never read
      continue
    }
    try {
      const abs = join(root, p) // --full-name paths are repo-root-relative, from git's own output
      const st = await stat(abs)
      if (!st.isFile() || st.size > UNTRACKED_FILE_BYTES_CAP) {
        files.push({ path: p, additions: 0, patch: '' })
        continue
      }
      const buf = await readFile(abs)
      if (buf.includes(0)) {
        files.push({ path: p, additions: 0, patch: '' }) // NUL sniff → binary
        continue
      }
      const text = buf.toString('utf-8')
      const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
      const patch = withPatch && lines > 0 && lines <= UNTRACKED_INLINE_LINES_CAP ? syntheticNewFilePatch(p, text, lines) : ''
      files.push({ path: p, additions: lines, patch })
    } catch {
      files.push({ path: p, additions: 0, patch: '' })
    }
  }
  return files
}

function syntheticNewFilePatch(path: string, text: string, lines: number): string {
  const body = (text.endsWith('\n') ? text.slice(0, -1) : text)
    .split('\n')
    .map((l) => '+' + l)
    .join('\n')
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines} @@\n${body}\n`
}

// --- Parsers ---
interface NumstatEntry {
  path: string
  oldPath?: string
  additions: number
  deletions: number
}
function parseNumstat(out: string): NumstatEntry[] {
  const entries: NumstatEntry[] = []
  for (const line of out.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (!m) continue // binary files report "-\t-" (kept, 0/0); anything unparsable is skipped
    const { path, oldPath } = parseRenamedPath(m[3])
    entries.push({
      path,
      ...(oldPath ? { oldPath } : {}),
      additions: m[1] === '-' ? 0 : Number.parseInt(m[1], 10),
      deletions: m[2] === '-' ? 0 : Number.parseInt(m[2], 10)
    })
  }
  return entries
}
// numstat -M renames come as `dir/{old => new}/file` (partial) or `old => new` (whole path) — CC parses
// the same two shapes (§10.4). `{ => sub}` legitimately yields a double slash on one side — collapse it.
function parseRenamedPath(raw: string): { path: string; oldPath?: string } {
  const brace = raw.match(/^(.*)\{(.*) => (.*)\}(.*)$/)
  if (brace) {
    const clean = (s: string): string => s.replace(/\/{2,}/g, '/')
    return { path: clean(brace[1] + brace[3] + brace[4]), oldPath: clean(brace[1] + brace[2] + brace[4]) }
  }
  const i = raw.indexOf(' => ')
  if (i > 0) return { path: raw.slice(i + 4), oldPath: raw.slice(0, i) }
  return { path: raw }
}

function parseNameStatus(out: string): Map<string, GitFileDiff['status']> {
  const map = new Map<string, GitFileDiff['status']>()
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const code = parts[0]?.[0]
    if (!code) continue
    if (code === 'R' || code === 'C') {
      if (parts[2]) map.set(parts[2], code === 'R' ? 'renamed' : 'added') // R<score>\told\tnew — key by NEW path
    } else if (code === 'A') {
      if (parts[1]) map.set(parts[1], 'added')
    } else if (code === 'D') {
      if (parts[1]) map.set(parts[1], 'removed')
    } else if (parts[1]) {
      map.set(parts[1], 'modified') // M / T (type change) / U — all render as modified
    }
  }
  return map
}

// Split one full-repo patch into per-file chunks, keyed by the b-side path (git prints `b/<path>` even for
// deletions, and the b side IS the new path on renames — one key shape for every status).
function splitPatchByFile(patch: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!patch.trim()) return map
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue
    const nl = chunk.indexOf('\n')
    const header = nl === -1 ? chunk : chunk.slice(0, nl)
    const quoted = header.match(/ "b\/(.+)"$/)
    if (quoted) {
      map.set(quoted[1], chunk)
      continue
    }
    const i = header.lastIndexOf(' b/') // paths with spaces aren't quoted by git — anchor on the LAST ` b/`
    if (i > 0) map.set(header.slice(i + 3), chunk)
  }
  return map
}

// --- Full-patch collection with the CC rEn overflow ladder: 5 MB maxBuffer → on overflow, exclude the
// LARGEST files (est. 80 B × changed lines) until the estimate fits 80% of the cap — never files under
// 2000 changed lines — and retry with `:(top,exclude)` pathspecs; still over → omit ALL patches. The file
// list + per-file ± NEVER truncate; only patch bodies degrade, largest-first.
const PATCH_ARGS = ['diff', '--no-ext-diff', '--no-textconv', '-M', '--no-color', '--src-prefix=a/', '--dst-prefix=b/']

function isOverflow(err: unknown): boolean {
  const e = err as { code?: string; message?: string }
  return e?.code === 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER' || /maxBuffer/i.test(e?.message ?? '')
}

async function retryPatchWithExclusions(cwd: string, base: string, numstat: NumstatEntry[]): Promise<Map<string, string>> {
  const est = numstat.map((e) => ({ path: e.path, lines: e.additions + e.deletions })).sort((a, b) => b.lines - a.lines)
  let total = est.reduce((s, e) => s + e.lines * PATCH_EXCLUDE_BYTES_PER_LINE, 0)
  const target = PATCH_TOTAL_BYTES_CAP * PATCH_EXCLUDE_TARGET_RATIO
  const excluded: string[] = []
  for (const e of est) {
    if (total <= target) break
    if (e.lines < PATCH_EXCLUDE_MIN_LINES) break // sorted desc — nothing below the floor is excludable
    excluded.push(e.path)
    total -= e.lines * PATCH_EXCLUDE_BYTES_PER_LINE
  }
  if (excluded.length === 0) return new Map()
  console.log(`[git] patch over ${PATCH_TOTAL_BYTES_CAP} B — retrying with ${excluded.length} largest file(s) excluded`)
  try {
    const out = await git(cwd, [...PATCH_ARGS, base, '--', ...excluded.map((p) => `:(top,exclude)${p}`)], DIFF_TIMEOUT, PATCH_TOTAL_BYTES_CAP)
    return splitPatchByFile(out)
  } catch {
    return new Map() // still over / failed → omit ALL patches (counts and the file list survive)
  }
}

// --- Stats-only collection (CC BZe) — the chip's cheap path: numstat + untracked counts, NO patch.
async function readStats(cwd: string, info: GitBaseInfo): Promise<{ additions: number; deletions: number; fileCount: number }> {
  const [numstatOut, untracked] = await Promise.all([
    git(cwd, ['diff', '--no-textconv', '--numstat', '-M', info.base], DIFF_TIMEOUT).catch(() => ''),
    collectUntracked(cwd, info.root, false)
  ])
  const tracked = parseNumstat(numstatOut)
  let additions = 0
  let deletions = 0
  for (const e of tracked) {
    additions += e.additions
    deletions += e.deletions
  }
  for (const u of untracked) additions += u.additions
  return { additions, deletions, fileCount: tracked.length + untracked.length }
}

async function readDirty(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['status', '--porcelain'], DIFF_TIMEOUT)).trim().length > 0 // NEVER -uall (§6)
  } catch {
    return false
  }
}

// --- Full collection (CC nEe): numstat ∥ name-status ∥ full patch ∥ untracked, all parallel + 30 s
// timeboxed. The patch task resolves to an overflow MARKER instead of failing the barrier: the
// exclude-retry needs numstat, so overflow handling runs after — parallelism kept, dependency honored.
async function readWorkDiff(cwd: string, info: GitBaseInfo): Promise<GitWorkDiff> {
  const [numstatOut, nameStatusOut, patchAttempt, untracked, subjects] = await Promise.all([
    git(cwd, ['diff', '--no-textconv', '--numstat', '-M', info.base], DIFF_TIMEOUT).catch(() => ''),
    git(cwd, ['diff', '--name-status', '-M', info.base], DIFF_TIMEOUT).catch(() => ''),
    git(cwd, [...PATCH_ARGS, info.base], DIFF_TIMEOUT, PATCH_TOTAL_BYTES_CAP)
      .then((out) => ({ out, overflow: false, failed: false }))
      .catch((err: unknown) => ({ out: '', overflow: isOverflow(err), failed: true })),
    collectUntracked(cwd, info.root, true),
    info.ahead > 0
      ? git(cwd, ['log', `${info.base}..HEAD`, '--format=%s'], SHORT_TIMEOUT)
          .then((o) => o.split('\n').filter(Boolean))
          .catch(() => [] as string[])
      : Promise.resolve([] as string[])
  ])
  const tracked = parseNumstat(numstatOut)
  const statusByPath = parseNameStatus(nameStatusOut)
  let byFile: Map<string, string>
  let patchesOmitted = false
  if (patchAttempt.overflow) {
    byFile = await retryPatchWithExclusions(cwd, info.base, tracked)
    patchesOmitted = true
  } else {
    byFile = splitPatchByFile(patchAttempt.out)
    patchesOmitted = patchAttempt.failed && tracked.length > 0 // non-overflow patch failure → counts-only, say so
  }
  const files: GitFileDiff[] = tracked.map((e) => ({
    path: e.path,
    ...(e.oldPath ? { oldPath: e.oldPath } : {}),
    status: e.oldPath ? ('renamed' as const) : (statusByPath.get(e.path) ?? 'modified'),
    additions: e.additions,
    deletions: e.deletions,
    patch: byFile.get(e.path) ?? ''
  }))
  for (const u of untracked) files.push({ path: u.path, status: 'added', additions: u.additions, deletions: 0, patch: u.patch })
  return { branch: info.branch, ahead: info.ahead, files, patchesOmitted, unpushedSubjects: subjects }
}

// Stats→full-diff prefetch (CC maybePrefetchFullDiff §10.2): when the stats fingerprint changes, the
// change is prefetch-sized (1..200 files), no fresh diff is cached and fewer than 2 prefetches are in
// flight → warm the diff memo in the background so opening the Diff panel is instant.
function maybePrefetchFullDiff(cwd: string, key: string, info: GitBaseInfo, stats: { additions: number; deletions: number; fileCount: number }): void {
  const fp = `${stats.additions}:${stats.deletions}:${stats.fileCount}`
  if (statsFingerprint.get(key) === fp) return
  statsFingerprint.set(key, fp)
  if (stats.fileCount < 1 || stats.fileCount > PREFETCH_FILE_COUNT_CAP) return
  const cached = diffMemo.get(key)
  if (cached && Date.now() - cached.at < cached.ttl) return
  if (prefetchInflight >= PREFETCH_CONCURRENCY_CAP) return
  prefetchInflight++
  void memoGet(diffMemo, key, DIFF_TTL_MS, () => readWorkDiff(cwd, info))
    .catch(() => {})
    .finally(() => {
      prefetchInflight--
    })
}

// The chip's status read (IPC git:status). Composes the 5 s info/dirty memos with the 30 s stats memo —
// CC's exact TTL split — so the renderer may ask every 5 s for free; real git runs at most once per TTL.
// realpath-normalized first: the renderer passes the user-picked path while the agent loop's ctx.cwd (the
// invalidation key) is already realpath'd — without one canonical key a /tmp-symlinked project would dodge
// its own invalidation.
export async function workStatus(rawCwd: string, baseRef?: string): Promise<GitWorkStatus> {
  const cwd = await realpath(rawCwd).catch(() => rawCwd)
  const key = memoKey(cwd, baseRef)
  const info = await memoInfo(cwd, baseRef)
  if (!info) return { isRepo: false, branch: null, dirty: false, additions: 0, deletions: 0, fileCount: 0, ahead: 0, behind: 0, hasUpstream: false, hasRemote: false }
  const [dirty, stats] = await Promise.all([
    memoGet(dirtyMemo, cwd, DIRTY_TTL_MS, () => readDirty(cwd)),
    memoGet(statsMemo, key, STATS_TTL_MS, () => readStats(cwd, info))
  ])
  maybePrefetchFullDiff(cwd, key, info, stats)
  return { isRepo: true, branch: info.branch, dirty, ...stats, ahead: info.ahead, behind: info.behind, hasUpstream: info.hasUpstream, hasRemote: info.hasRemote }
}

// The panel's full read (IPC git:diff). null = not a repo (panel empty state).
export async function workDiff(rawCwd: string, baseRef?: string): Promise<GitWorkDiff | null> {
  const cwd = await realpath(rawCwd).catch(() => rawCwd)
  const key = memoKey(cwd, baseRef)
  const info = await memoInfo(cwd, baseRef)
  if (!info) return null
  return memoGet(diffMemo, key, DIFF_TTL_MS, () => readWorkDiff(cwd, info))
}
