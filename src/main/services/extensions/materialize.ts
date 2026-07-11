// Materialize installed extensions into <dataDir>/extensions/ (docs/extension-install-design.md §4).
// Installing a skill/plugin used to only write a DB row pointing at the USER'S folder — move/delete that
// folder and the skill silently degrades to a stale snapshot. Materializing copies the payload into
// Studio's own data root so an install is self-contained, survives the original download being deleted,
// and is backup/sync-able. Naming: each entry is the extension row's own ULID id (same convention as
// sessions/<convId> and media/<convId>) — NOT a content hash, because edits mutate the copy in place.
//
//   extensions/skills/<skillId>/    imported: deep copy of the source folder (SKILL.md + assets)
//                                   builtin/distilled: a generated SKILL.md MIRROR of the DB body
//   extensions/plugins/<pluginId>/  deep copy of the whole plugin folder (its skills/* live inside)
//   extensions/mcp/<mcpId>.json     declarative manifest (never secrets — those stay in the keychain)
//   extensions/mcp/<mcpId>/         local-folder stdio servers only: copy of the server folder (run cwd)
//
// Existing rows installed before this feature keep their external dir_path untouched (no migration —
// design decision 2); only NEW installs are materialized.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { cp, lstat, mkdir, rename, rm } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { dataDir } from '../../db/connection'
import { ulid } from '../../db/id'

export type ExtensionKind = 'skills' | 'plugins' | 'mcp'

export function extensionsRoot(): string {
  return join(dataDir(), 'extensions')
}

// Ids come from our own ulid() (also the DB primary key), but removal builds paths from them — reject
// anything that isn't a plain path segment so a corrupt id can never traverse out of the root.
function safeSegment(id: string): string {
  if (!/^[0-9A-Za-z_-]+$/.test(id)) throw new Error(`invalid extension id: ${id}`)
  return id
}

// Generate the id for a new extension row BEFORE creating it, so the materialized copy and the DB row
// share one ULID (folder name = row id, 1:1).
export function newExtensionId(): string {
  return ulid()
}

export function materializedDir(kind: ExtensionKind, id: string): string {
  return join(extensionsRoot(), kind, safeSegment(id))
}

// True when a path already lives under extensions/ — e.g. a plugin-owned skill whose folder sits inside
// the plugin's materialized copy. Such paths are referenced in place, never copied a second time.
export function isMaterializedPath(p: string): boolean {
  return resolve(p).startsWith(resolve(extensionsRoot()) + sep)
}

// Size guardrails for a materialized copy. Generous enough for a real payload (an MCP server folder can
// legitimately carry node_modules), far below a mis-pointed source (~ or a repo checkout root) that would
// flood the app data dir. Exceeding either aborts the copy — and thanks to the tmp+swap dance below, an
// aborted copy costs nothing: the previous payload stays untouched.
export const MATERIALIZE_MAX_FILES = 50_000
export const MATERIALIZE_MAX_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB

export interface MaterializeOptions {
  // Paths (relative to the copy root) that MUST exist in the copy before it replaces the old payload —
  // e.g. a skill's SKILL.md. Catches the "critical file was a symlink and got skipped" install: better a
  // clean failure that keeps the previous copy than a silently gutted one.
  requireFiles?: string[]
  // Test seams — production callers never pass these.
  maxFiles?: number
  maxBytes?: number
}

// Deep-copy the user's source folder into extensions/<kind>/<id>/, replacing any prior copy for that id
// ATOMICALLY: copy into a sibling tmp dir, verify it, then swap it in (old aside → tmp in → drop old).
// The old rm-then-cp order destroyed the previous payload BEFORE the new copy was proven — a mid-copy
// failure left the DB row pointing at a gutted dir. Now the copy either fully lands or the previous
// payload stays untouched (a failed swap rolls the old dir back).
// SYMLINKS ARE SKIPPED OUTRIGHT (not dereferenced, not preserved): dereference:true would follow a link
// pointing ANYWHERE — a skill folder containing `creds -> ~/.ssh` copied the target's CONTENT into the
// app's data root — and copying the link itself would leave the materialized payload pointing outside
// its own folder. Nothing in a self-contained copy may reference the world outside it. Async end to end:
// this runs on install — sometimes from an agent tool mid-turn — and a large source folder must not block
// the main process. .git and .DS_Store are dead weight and are skipped. Returns the internal path.
// Serialize materialize calls per (kind/id): the fixed `.tmp-`/`.old-` staging names mean two concurrent
// copies of the SAME id would delete each other's in-flight staging (the rm at the top of each run nukes the
// other's tmp). Studio is a single main process, so an in-process per-id queue is the whole story — there is
// no cross-process race (two windows still share one main). Different ids run in parallel (independent keys).
const materializeLocks = new Map<string, Promise<unknown>>()
function withIdLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = materializeLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn) // run after the previous op for this id settles (resolve OR reject)
  const guard = next.then(() => {}, () => {}) // stored promise swallows errors so it never poisons the chain
  materializeLocks.set(key, guard)
  void guard.then(() => {
    if (materializeLocks.get(key) === guard) materializeLocks.delete(key)
  })
  return next
}

export async function materializeDirCopy(kind: ExtensionKind, id: string, srcDir: string, opts?: MaterializeOptions): Promise<string> {
  return withIdLock(`${kind}/${safeSegment(id)}`, () => doMaterializeDirCopy(kind, id, srcDir, opts))
}

async function doMaterializeDirCopy(kind: ExtensionKind, id: string, srcDir: string, opts?: MaterializeOptions): Promise<string> {
  if (!existsSync(srcDir)) throw new Error(`source folder not found: ${srcDir}`)
  const safe = safeSegment(id)
  const dest = materializedDir(kind, id)
  // Staging siblings of dest (same fs → rename is atomic). safeSegment never allows dots, so `.tmp-…` /
  // `.old-…` can't collide with a real extension id.
  const tmp = join(extensionsRoot(), kind, `.tmp-${safe}`)
  const old = join(extensionsRoot(), kind, `.old-${safe}`)
  // Crash recovery: a prior run that died AFTER `rename(dest → old)` but BEFORE `rename(tmp → dest)` left the
  // id with NO dest while `.old` holds the previous payload. Restore it BEFORE clearing leftovers — otherwise
  // the rm(old) below deletes the ONLY surviving copy (the deterministic-name "self-healing" was in fact
  // destructive here). After the restore `.old` is gone, so the rm is a no-op and the fresh copy replaces it.
  if (!existsSync(dest) && existsSync(old)) {
    // Do NOT swallow this and fall through to rm(old) — that would delete the ONLY surviving copy. Let it
    // throw so the install aborts with .old intact for the next attempt / the boot sweep to recover.
    await rename(old, dest)
  }
  await rm(tmp, { recursive: true, force: true })
  // Drop a leftover .old ONLY when dest is safely present (recovery above succeeded, or dest was never
  // gone). If a recovery rename threw we never reach here, so .old is preserved for the next attempt.
  if (existsSync(dest)) await rm(old, { recursive: true, force: true })
  const maxFiles = opts?.maxFiles ?? MATERIALIZE_MAX_FILES
  const maxBytes = opts?.maxBytes ?? MATERIALIZE_MAX_BYTES
  let files = 0
  let bytes = 0
  try {
    await mkdir(tmp, { recursive: true })
    await cp(srcDir, tmp, {
      recursive: true,
      dereference: false,
      filter: async (src) => {
        const b = basename(src)
        if (b === '.git' || b === '.DS_Store') return false
        const st = await lstat(src)
        if (st.isSymbolicLink()) return false
        if (st.isFile()) {
          files += 1
          bytes += st.size
          if (files > maxFiles || bytes > maxBytes) {
            // Throwing from the filter rejects the whole cp() — the tmp dir is discarded below.
            throw new Error(
              `source folder exceeds the install limit (${maxFiles.toLocaleString()} files / ${Math.round(maxBytes / (1024 * 1024))} MB) — point the install at the extension's own folder, not a parent directory`
            )
          }
        }
        return true
      }
    })
    for (const f of opts?.requireFiles ?? []) {
      if (!existsSync(join(tmp, f))) {
        throw new Error(`the copied folder is missing required file "${f}" — if it is a symlink in the source, replace it with a real file (symlinks are not copied)`)
      }
    }
    // Swap. If moving tmp into place fails after the old copy was set aside, restore the old copy —
    // never leave the id with NO payload while its DB row still points here.
    const hadOld = existsSync(dest)
    if (hadOld) await rename(dest, old)
    try {
      await rename(tmp, dest)
    } catch (e) {
      if (hadOld) await rename(old, dest).catch(() => {})
      throw e
    }
    await rm(old, { recursive: true, force: true }).catch(() => {})
    return dest
  } catch (e) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw e
  }
}

// Remove an extension's materialized payload (dir + the mcp manifest file). Best-effort by design: a
// missing entry (legacy row, or a mirror that failed to write) is a no-op, and removal must never block
// the DB delete it accompanies.
export function removeMaterialized(kind: ExtensionKind, id: string): Promise<void> {
  const safe = safeSegment(id)
  // Through the SAME per-id lock as materializeDirCopy: a remove must not race a running copy's swap and
  // delete `dest` mid-rename. Best-effort (the DB delete already happened) — errors are logged, not thrown.
  return withIdLock(`${kind}/${safe}`, async () => {
    try {
      // Async rm (fs/promises), not rmSync: a payload can be up to the materialize cap (50k files / 2 GiB),
      // and this runs on the main process during a DB delete — a synchronous recursive unlink of that would
      // freeze the UI. The per-id lock already serializes against a running copy's swap.
      await rm(join(extensionsRoot(), kind, safe), { recursive: true, force: true })
      if (kind === 'mcp') await rm(join(extensionsRoot(), 'mcp', `${safe}.json`), { force: true })
    } catch (e) {
      console.error('[extensions] failed to remove materialized payload', kind, id, e)
    }
  })
}

// Boot-time sweep: heal any materialize interrupted by a crash. For each `.old-<id>` whose real dest is
// missing (a process death mid-swap after dest→.old), restore it; drop orphaned `.tmp-<id>` staging (a
// crashed copy) and any `.old-<id>` whose dest is already present (a stale leftover). Best-effort — a
// failure here logs and moves on, never blocks boot. Runs at startup so recovery isn't deferred to the
// next materialize of that same id (which might never come — the extension stays broken until then).
// ASYNC (await rm/rename): a leftover .old/.tmp can be a full payload (up to the materialize cap), so a
// synchronous recursive unlink would freeze the main process during boot. The caller AWAITS this before
// loadSkills/connectMcp read the dirs, so the ordering guarantee holds while the event loop stays live.
export async function recoverMaterializeLeftovers(): Promise<void> {
  for (const kind of ['skills', 'plugins', 'mcp'] as ExtensionKind[]) {
    const base = join(extensionsRoot(), kind)
    let entries: string[]
    try {
      entries = readdirSync(base)
    } catch {
      continue // that kind's dir doesn't exist yet — nothing to sweep
    }
    for (const name of entries) {
      try {
        if (name.startsWith('.tmp-')) {
          await rm(join(base, name), { recursive: true, force: true })
        } else if (name.startsWith('.old-')) {
          const rawId = name.slice('.old-'.length)
          if (!/^[0-9A-Za-z_-]+$/.test(rawId)) {
            await rm(join(base, name), { recursive: true, force: true }) // not one of ours (crafted name) — drop it
            continue
          }
          const dest = join(base, rawId)
          if (existsSync(dest)) await rm(join(base, name), { recursive: true, force: true })
          else await rename(join(base, name), dest) // restore the mid-swap-crash payload
        }
      } catch (e) {
        console.error('[extensions] materialize leftover sweep failed for', join(kind, name), e)
      }
    }
  }
}

// ---- MCP manifest (extensions/mcp/<id>.json) — the "mcp info lands in .nsai" projection ----
// Declarative config only. Secrets NEVER enter this file (keychain-only, by design decision 6), so a
// synced/backed-up manifest carries the shape of the server but not the credentials.

export interface McpManifest {
  id: string
  name: string
  transport: 'stdio' | 'http'
  endpointOrCmd: string
  args: string[]
  cwd: string | null
  scope: 'all' | string[]
}

export function writeMcpManifest(manifest: McpManifest): void {
  try {
    const dir = join(extensionsRoot(), 'mcp')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${safeSegment(manifest.id)}.json`), JSON.stringify(manifest, null, 2) + '\n', 'utf-8')
  } catch (e) {
    // A manifest is a projection of the DB row (the runtime source of truth) — failing to write it must
    // not fail the install. It self-heals on the next update of the same row.
    console.error('[extensions] failed to write mcp manifest', manifest.id, e)
  }
}

export function hasMcpManifest(id: string): boolean {
  return existsSync(join(extensionsRoot(), 'mcp', `${safeSegment(id)}.json`))
}

// ---- Skill mirror (extensions/skills/<id>/SKILL.md for builtin/distilled rows) ----
// The DB body stays the editing + runtime source of truth (dir_path remains NULL — resolveBody keeps
// reading the DB); the mirror only makes every skill visible on disk for backup/sync (decision 3).

export function writeSkillMirror(id: string, content: string): void {
  try {
    const dir = materializedDir('skills', id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), content, 'utf-8')
  } catch (e) {
    console.error('[extensions] failed to write skill mirror', id, e)
  }
}
