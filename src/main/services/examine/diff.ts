import { execFile } from 'node:child_process'
import type { WrittenFile } from '../../agent/context'

// Git helpers for the panel Gate B content trigger (panel-examine §3.2 / M2): capture the
// implementer's REAL changed paths so dimension selection is content-driven, not size/prompt-driven.
// Mirrors git-snapshot.ts's runner — resolves '' / [] on any error, never throws (the trigger must
// degrade to floor-only, never break a gated step).

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
// untracked files — exactly the "brand-new auth/migration file" case the content trigger must catch
// (audit finding on git-snapshot's tracked-only stash). Empty when not a repo or nothing changed.
export async function changedPathsSince(cwd: string | undefined, base: string): Promise<string[]> {
  if (!cwd || !base) return []
  const tracked = (await git(cwd, ['diff', '--name-only', base])).split('\n').filter(Boolean)
  const untracked = (await git(cwd, ['ls-files', '--others', '--exclude-standard'])).split('\n').filter(Boolean)
  return [...new Set([...tracked, ...untracked])]
}

// The actual diff TEXT since `base`, truncated — fed to the SEMANTIC subject trigger so it judges the risk axis
// from the CHANGE itself (an edit weakening a token check = security), not from file names. Lightweight:
// `git diff` only, NOT a build (the full shared build runs later, only if a subject fires). Tracked changes
// only — a brand-new untracked file's content is invisible to `git diff`, but its PATH still reaches the
// trigger via changedPathsSince, so the trigger sees "new file X exists" even when it can't see the body.
// '' on any error → the trigger falls back to judging from the path list alone (degrade, never throw).
export async function diffSince(cwd: string | undefined, base: string, paths: readonly string[] = [], maxChars = 20_000): Promise<string> {
  if (!cwd || !base) return ''
  // `paths` LIMITS the diff to this step's own changed files — a pipeline shares one cwd with no commit between
  // steps, so an unlimited `git diff base` would carry prior steps' edits into the trigger and mis-attribute
  // their risk to this step (P1a). Empty paths → whole-tree diff (the single-step / first-step case).
  const args = ['diff', base, ...(paths.length ? ['--', ...paths] : [])]
  const diff = await git(cwd, args)
  return diff.length > maxChars ? `${diff.slice(0, maxChars)}\n…[diff truncated for subject trigger]` : diff
}

// --- Git-free change event bus (subject-trigger event-bus) -------------------------------------------------
// THE fix for greenfield / non-git subject triggering: a brand-new project is all-untracked, so `git diff base`
// emits ZERO bytes for every file even though 100+ files were created — the semantic trigger then sees an
// empty diff and selects no dimensions (it won't commit to a risk axis from a bare path list). The agent
// loop's OWN Write/Edit operations (WrittenFile[]) are the always-available source of "what changed + what
// it now says", independent of any VCS. Git, when the repo exists, ENRICHES this with precise hunks for
// modified TRACKED files (a 5-line edit shows 5 lines, not the whole 2000-line file); the event bus then
// fills in the new/untracked files git can't show. Result: subjects fire on any tree, git or not.

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
// mis-extracts a path containing " b/" (a non-greedy `a/.+? b/` grabs the wrong boundary), while `+++ b/`
// carries exactly one path. A deleted file shows `+++ /dev/null` and is correctly skipped (it's not a write).
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
      const trunc = f.content.length > PER_FILE_DIFF ? '\n+…[file truncated for subject trigger]' : ''
      return `diff --git a/${f.path} b/${f.path}\nnew file\n--- /dev/null\n+++ b/${f.path}\n${lines}${trunc}`
    })
    .join('\n')
}

// Combine git (when present) with the event bus into ONE changed-set + diff for the subject trigger:
//   changed = (git delta since base, minus paths already changed before this step) ∪ (event-bus paths)
//   diff    = git hunks for tracked-modified files  +  synthesized content for new/untracked files
// `base` '' / non-git → git contributes nothing and the event bus stands alone (the greenfield path).
// `baseChanged` de-contaminates the GIT side only (prior pipeline steps share one cwd); event paths are
// already this-step-only (the loop's writtenPaths is fresh per run), so they need no such filter.
// Best-effort like the rest of this module: any git error degrades to the event bus, never throws.
// PATH FORM: both sides are expected cwd==repo-root relative (the studio norm — the user picks the project
// root). Event paths are realpath-cwd-relative (harvested in runAgentLoop). A project folder that is a strict
// SUBDIR of a larger repo can double-emit a tracked-modified file (git reports it repo-root-relative, the
// event bus cwd-relative) — benign redundancy for the LLM trigger, never breakage, and it long predates this
// path (git ls-files --others is itself cwd-relative while git diff --name-only is repo-root-relative).
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
  const diff = combined.length > maxChars ? `${combined.slice(0, maxChars)}\n…[diff truncated for subject trigger]` : combined
  return { changed, diff }
}
