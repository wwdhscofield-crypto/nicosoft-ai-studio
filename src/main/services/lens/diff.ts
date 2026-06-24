import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { confineReal } from '../../agent/confine'
import type { WrittenFile } from '../../agent/context'

// Git helpers for the Studio Lens content trigger (moved verbatim from examine/diff.ts; logic unchanged):
// capture the implementer's REAL changed paths so lens selection is content-driven, not size/prompt-driven.
// Resolves '' / [] on any error, never throws (the trigger must degrade to floor-only, never break a step).

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 10_000 }, (err, stdout) => resolve(err ? '' : String(stdout).trim()))
  })
}

// The commit the implementer starts from — record this BEFORE the implementer runs. '' if not a git repo
// (then the content trigger simply finds no diff and the step stays floor-only).
export async function gitHead(cwd: string | undefined): Promise<string> {
  if (!cwd) return ''
  if ((await git(cwd, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return ''
  return git(cwd, ['rev-parse', 'HEAD'])
}

// Paths the implementer changed since `base`, INCLUDING new untracked files. Plain `git diff` misses
// untracked files — exactly the "brand-new auth/migration file" case the content trigger must catch.
// Empty when not a repo or nothing changed.
export async function changedPathsSince(cwd: string | undefined, base: string): Promise<string[]> {
  if (!cwd || !base) return []
  const tracked = (await git(cwd, ['diff', '--name-only', base])).split('\n').filter(Boolean)
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean)
  return [...new Set([...tracked, ...untracked])]
}

// The actual diff TEXT since `base`, truncated — fed to the SEMANTIC lens trigger so it judges the risk axis
// from the CHANGE itself (an edit weakening a token check = security), not from file names. Lightweight:
// `git diff` only, NOT a build. Tracked changes only — a brand-new untracked file's content is invisible to
// `git diff`, but its PATH still reaches the trigger via changedPathsSince. '' on any error → the trigger
// falls back to judging from the path list alone (degrade, never throw).
export async function diffSince(cwd: string | undefined, base: string, paths: readonly string[] = [], maxChars = 20_000): Promise<string> {
  if (!cwd || !base) return ''
  // `paths` LIMITS the diff to this step's own changed files — a pipeline shares one cwd with no commit between
  // steps, so an unlimited `git diff base` would carry prior steps' edits into the trigger and mis-attribute
  // their risk to this step (P1a). Empty paths → whole-tree diff (the single-step / first-step case).
  const args = ['diff', base, ...(paths.length ? ['--', ...paths] : [])]
  const diff = await git(cwd, args)
  return diff.length > maxChars ? `${diff.slice(0, maxChars)}\n…[diff truncated for lens trigger]` : diff
}

// --- Git-free change event bus (subject-trigger event-bus) -------------------------------------------------
// THE fix for greenfield / non-git triggering: a brand-new project is all-untracked, so `git diff base` emits
// ZERO bytes for every file even though 100+ files were created — the semantic trigger then sees an empty diff
// and selects no lenses. The agent loop's OWN Write/Edit operations (WrittenFile[]) are the always-available
// source of "what changed + what it now says", independent of any VCS. Git, when the repo exists, ENRICHES this
// with precise hunks for modified TRACKED files; the event bus then fills in the new/untracked files git can't
// show. Result: lenses fire on any tree, git or not.

const PER_FILE_DIFF = 1500 // cap each synthesized new-file block so a sample of MANY files reaches the trigger, not one giant file

// Last-write-wins dedup: when the implementer AND a fail-handler both wrote a file, the handler's content
// (passed later) is the current truth. Keeps one block per path in the synthesized diff.
function dedupeWritten(files: readonly WrittenFile[]): WrittenFile[] {
  const m = new Map<string, string>()
  for (const f of files) m.set(f.path, f.content)
  return [...m].map(([path, content]) => ({ path, content }))
}

// Paths git already produced a hunk for (so the event bus shouldn't double-emit them as "new files").
// Parse the `+++ b/<path>` hunk-header line, NOT `diff --git a/<a> b/<b>`: the latter's two-path form
// mis-extracts a path containing " b/". A deleted file shows `+++ /dev/null` and is correctly skipped.
function pathsInGitDiff(diff: string): Set<string> {
  const set = new Set<string>()
  for (const m of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) set.add(m[1])
  return set
}

// Synthesize a unified-diff-style "new file" block per event-bus file git couldn't show, so the trigger
// reads real CONTENT (imports, signatures, the risky line) — not just a path. Each block is capped; the
// caller clips the joined result to the overall budget.
function synthesizeNewFileDiff(files: readonly WrittenFile[]): string {
  return files
    .map((f) => {
      const body = f.content.slice(0, PER_FILE_DIFF)
      const lines = body.split('\n').map((l) => `+${l}`).join('\n')
      const trunc = f.content.length > PER_FILE_DIFF ? '\n+…[file truncated for lens trigger]' : ''
      return `diff --git a/${f.path} b/${f.path}\nnew file\n--- /dev/null\n+++ b/${f.path}\n${lines}${trunc}`
    })
    .join('\n')
}

// Combine git (when present) with the event bus into ONE changed-set + diff for the lens trigger:
//   changed = (git delta since base, minus paths already changed before this step) ∪ (event-bus paths)
//   diff    = git hunks for tracked-modified files  +  synthesized content for new/untracked files
// `base` '' / non-git → git contributes nothing and the event bus stands alone (the greenfield path).
// `baseChanged` de-contaminates the GIT side only (prior pipeline steps share one cwd); event paths are
// already this-step-only. Best-effort: any git error degrades to the event bus, never throws.
export async function buildChangedSet(
  cwd: string | undefined,
  base: string,
  baseChanged: readonly string[],
  written: readonly WrittenFile[],
  maxChars = 24_000,
): Promise<{ changed: string[]; diff: string }> {
  const files = dedupeWritten(written)
  const eventPaths = files.map((f) => f.path)
  const before = new Set(baseChanged)
  const gitChanged = cwd && base ? (await changedPathsSince(cwd, base)).filter((p) => !before.has(p)) : []
  const changed = [...new Set([...gitChanged, ...eventPaths])]
  if (changed.length === 0) return { changed: [], diff: '' }

  const gitDiff = cwd && base ? await diffSince(cwd, base, changed, maxChars) : ''
  const covered = pathsInGitDiff(gitDiff)
  const eventDiff = synthesizeNewFileDiff(files.filter((f) => !covered.has(f.path)))
  const combined = [gitDiff, eventDiff].filter(Boolean).join('\n')
  const diff = combined.length > maxChars ? `${combined.slice(0, maxChars)}\n…[diff truncated for lens trigger]` : combined
  return { changed, diff }
}

// Read the target files' content (capped) so the SELECT step can author lenses from the CODE itself, not only
// the diff — essential for the explicit entry (no diff) and surgical changes (thin diff), where a diff-only
// selector starves. Carved verbatim from examine/panel.ts (must-fix ②). Skips unreadable / out-of-bounds paths
// (confineReal); caps per-file (8k) + total (24k) so a large target can't bloat the selection prompt.
export async function readTargetContent(cwd: string | undefined, paths: readonly string[], maxTotal = 24_000): Promise<string> {
  if (!cwd) return ''
  const parts: string[] = []
  let total = 0
  for (const p of paths.slice(0, 40)) {
    if (total >= maxTotal) break
    try {
      const abs = await confineReal(cwd, p)
      let body = await readFile(abs, 'utf-8')
      if (body.length > 8_000) body = body.slice(0, 8_000) + `\n…[${p} truncated]`
      const block = `--- ${p} ---\n${body}`
      parts.push(block)
      total += block.length
    } catch {
      /* unreadable / out-of-bounds path — skip */
    }
  }
  const out = parts.join('\n\n')
  return out.length > maxTotal ? out.slice(0, maxTotal) + '\n…[content truncated for lens selection]' : out
}
