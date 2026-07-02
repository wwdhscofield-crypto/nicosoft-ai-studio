// Project memory (coordinator dispatch §4) — the service layer over project-map.repo. Owns the two things
// the raw repo must NOT: (1) NORMALIZING a raw cwd into the stable PM key (§10.1 — realpath, worktree→main,
// trailing-slash + case fold) and (2) computing the coarse STRUCTURAL fingerprint (§10.2 — top-level layout +
// surface markers, NOT git HEAD) that decides whether a remembered map is still current.
//
// recall() hands Danny's routing investigation a STARTING POINT (it never short-circuits the investigation,
// §4.3); remember() writes back a synthesized shape — from Danny's router after an investigation (§4.4) AND
// from any executing agent via the remember_project_map tool (§4.6: seed when none is recorded, refresh when
// the remembered one proved stale or wrong; the WHEN is prompt-gated, not mechanical). Every entry point is
// BEST-EFFORT: no cwd / a realpath or git failure / an unreadable tree degrades to null (recall) or a
// swallowed no-op (remember), so project memory can never block or break a dispatch (§4.5).

import { createHash } from 'node:crypto'
import { readdir, realpath } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { gitCommonDir, gitDir } from './git.service'
import * as repo from '../repos/project-map.repo'

// Top-level directories that are build output / tooling caches / VCS internals, not part of the project's
// SHAPE — excluded from the fingerprint so a fresh `node_modules` or `dist` never reads as a structure change.
const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.studio', '.hg', '.svn', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.svelte-kit', 'target', 'vendor', '__pycache__', '.venv', 'venv',
  '.turbo', '.cache', '.parcel-cache', 'tmp', '.idea', '.vscode', '.gradle', 'bin', 'obj',
])
// Volatile top-level files whose presence/absence is noise, not a surface change (lockfiles regenerate).
const IGNORE_FILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'Cargo.lock',
  'poetry.lock', 'go.sum', 'composer.lock', 'Gemfile.lock',
])

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32'

// Hard bound on a remembered project-shape summary (every prompt asks ≤1200 chars; this is headroom, not a
// target). Single source — the router's route_decision capture and the remember_project_map tool both clamp to it.
export const PROJECT_MAP_MAX_CHARS = 4000

// Resolve a linked git worktree to its MAIN worktree root so every worktree of a project (and the main
// checkout) share ONE project-memory key (§10.1). A plain repo, a subdirectory of the main worktree, or a
// non-repo path returns null (keep the path as-is — only linked worktrees remap). Best-effort.
async function mainWorktreeRoot(cwd: string): Promise<string | null> {
  const [dir, common] = await Promise.all([gitDir(cwd), gitCommonDir(cwd)])
  if (!dir || !common) return null
  const norm = (p: string): string => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p).replace(/[/\\]+$/, '')
  // Same git-dir and common-dir → the main worktree or a plain checkout (possibly a subdir of it): do NOT
  // remap, so a picked subfolder keeps its own key. They DIFFER only for a linked worktree.
  if (norm(dir) === norm(common)) return null
  // Linked worktree: the shared common dir is <main>/.git → its parent is the main worktree root.
  if (basename(common) === '.git') return dirname(common)
  return null
}

// Normalize a raw cwd into the stable project-memory key (§10.1): realpath (resolve symlinks — e.g. macOS
// /tmp→/private/tmp) → worktree→main → strip a trailing separator → case-fold on a case-insensitive FS.
// Returns null when there's no usable path (folder-free chat → no project memory at all).
export async function normalizeProjectKey(rawCwd: string | undefined): Promise<string | null> {
  if (!rawCwd) return null
  let p = await realpath(rawCwd).catch(() => rawCwd)
  const main = await mainWorktreeRoot(p).catch(() => null)
  if (main) p = await realpath(main).catch(() => main)
  p = p.replace(/[/\\]+$/, '')
  if (CASE_INSENSITIVE_FS) p = p.toLowerCase()
  return p
}

// Coarse STRUCTURAL fingerprint (§10.2): a digest of the top-level layout — directory names (minus build/
// tooling noise) plus non-dot, non-lockfile file names. It captures the project's SHAPE (which surfaces
// exist: a `frontend/` appearing, a `go.mod` added) and is invariant to edits deep in the tree, so a mere
// code change never invalidates the map — only a genuine surface change does. '' when the tree is unreadable.
export async function fingerprintProject(cwd: string): Promise<string> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true })
    const dirs: string[] = []
    const files: string[] = []
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) dirs.push(e.name)
      } else if (e.isFile()) {
        if (!e.name.startsWith('.') && !IGNORE_FILES.has(e.name)) files.push(e.name)
      }
    }
    const digest = `dirs:${dirs.sort().join(',')}|files:${files.sort().join(',')}`
    return createHash('sha256').update(digest).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

export interface RecalledMap {
  map: string
  // true → the stored fingerprint still matches the tree, so the map is CURRENT (Danny can confirm cheaply);
  // false → the project's shape changed since the map was written, so treat it as a stale starting point and
  // re-investigate the delta.
  fresh: boolean
}

// Recall the remembered project map for a raw cwd, plus whether it's still structurally current. null when
// there's no project (folder-free), no stored map yet (new project), or any lookup failure — every one of
// those degrades to "no starting point, investigate from scratch" (§4.5), never an error.
export async function recall(rawCwd: string | undefined): Promise<RecalledMap | null> {
  try {
    const key = await normalizeProjectKey(rawCwd)
    if (!key) return null
    const row = repo.get(key)
    if (!row) return null
    const current = await fingerprintProject(key)
    return { map: row.map, fresh: current !== '' && current === row.fingerprint }
  } catch (e) {
    console.warn('[coordinator] project-map recall failed (investigating from scratch):', e instanceof Error ? e.message : e)
    return null
  }
}

// Write back the project shape Danny synthesized, keyed by the normalized cwd + the current structural
// fingerprint, so the next task on this folder starts from it. Best-effort — a failure is logged and
// swallowed (project memory must never break a dispatch, §4.5). No-op for a folder-free chat or an empty map.
export async function remember(rawCwd: string | undefined, map: string, projectId?: string | null): Promise<void> {
  try {
    const trimmed = map.trim()
    if (!trimmed) return
    const key = await normalizeProjectKey(rawCwd)
    if (!key) return
    const fingerprint = await fingerprintProject(key)
    repo.upsert({ cwd: key, fingerprint, map: trimmed, projectId })
  } catch (e) {
    console.warn('[coordinator] project-map remember failed (map not persisted this turn):', e instanceof Error ? e.message : e)
  }
}

// Format the project-memory section for injection into an executing agent's SYSTEM prompt. §4: project memory is
// SYSTEM-WIDE — EVERY agent role + solo reads it (not just Danny's router), so an implementer orients fast without
// re-scanning a known project; called by all agent entry points (agent.service / runDispatchedAgent /
// buildCollabSystem). §4.6 shapes both variants: a recorded map injects as a VERIFY-BEFORE-TRUST hint (the text
// itself demands second-sourcing every claim against the live tree — a remembered map is never evidence), and an
// empty slot injects a SEED brief pointing at remember_project_map. Returns undefined only for a folder-free run
// (no cwd → no project to remember). Degrades silently: a lookup failure reads as "none recorded" (worst case an
// agent re-seeds a map that failed to load).
export async function recallText(rawCwd: string | undefined): Promise<string | undefined> {
  if (!rawCwd) return undefined
  const recalled = await recall(rawCwd)
  if (!recalled) {
    return (
      '# PROJECT MAP (none recorded for this project yet)\n' +
      "No shape map is remembered for this folder. If this task leads you to explore the project's overall " +
      'structure anyway, record a concise map with the remember_project_map tool once you have VERIFIED it ' +
      '(≤1200 chars: top-level layout, which surfaces exist, key modules) — the next run on this project starts ' +
      'from it. Skip this when you only saw a narrow slice; never record guesses.'
    )
  }
  const note = recalled.fresh
    ? 'top-level layout unchanged since it was written'
    : 'possibly STALE — the top-level layout changed since it was written'
  return (
    `# PROJECT MAP (remembered shape of this project — ${note})\n` +
    "A prior run recorded this project's structure. Treat it as a HINT, not ground truth: it may be outdated or " +
    'plain wrong, and the freshness note above only compares the TOP-LEVEL layout (deep restructuring does not ' +
    "show up in it). Before you rely on any specific claim here (a path, a module's role, a surface), VERIFY that " +
    'claim against the live tree (Glob/Read/Grep) — never cite this map as evidence for a conclusion. If your ' +
    'verified reading shows it is stale or wrong, submit a corrected map with the remember_project_map tool ' +
    '(≤1200 chars, only what you verified).\n\n' +
    recalled.map
  )
}
