import { DatabaseSync } from 'node:sqlite'
import { app } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { runMigrations } from './migrate'

// Single DatabaseSync instance for the main process. ALL app data (settings, endpoints, roles, chats,
// memory, …) lives under ~/.nsai — the same root as the Engineer session transcripts — not Electron's
// default userData dir.
let instance: DatabaseSync | null = null

export function dataDir(): string {
  // Isolated-world override for e2e drivers (pairs with STUDIO_USER_DATA in main/index.ts): keeps the
  // driver's SQLite + media in a throwaway dir instead of the user's real ~/.nsai.
  const dir = process.env.STUDIO_DATA_DIR || join(homedir(), '.nsai')
  mkdirSync(dir, { recursive: true })
  return dir
}

// One-time migration: if the db exists only at the old Electron userData location, move it (+ its
// WAL/SHM sidecars) into ~/.nsai, then delete the originals so nothing stale is left behind.
function migrateLegacy(target: string): void {
  if (existsSync(target)) return
  let legacyBase: string
  try {
    legacyBase = join(app.getPath('userData'), 'nicosoft-studio.db')
  } catch {
    return // userData unavailable (e.g. tests) — nothing to migrate
  }
  if (!existsSync(legacyBase)) return
  const exts = ['', '-wal', '-shm']
  // Copy first, tracking what actually copied. If ANY copy fails, abort the whole migration and keep
  // the legacy files intact for a retry next launch — never delete an original we couldn't copy.
  const copied: string[] = []
  for (const ext of exts) {
    if (!existsSync(legacyBase + ext)) continue
    try {
      copyFileSync(legacyBase + ext, target + ext)
      copied.push(ext)
    } catch {
      for (const c of copied) {
        try {
          unlinkSync(target + c) // clean up half-written copies
        } catch {
          /* ignore */
        }
      }
      return
    }
  }
  // Every copy succeeded → now it's safe to remove the originals.
  for (const ext of copied) {
    try {
      unlinkSync(legacyBase + ext)
    } catch {
      /* ignore */
    }
  }
}

export function getDb(): DatabaseSync {
  if (instance) return instance
  const file = join(dataDir(), 'studio.db')
  migrateLegacy(file)
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  runMigrations(db)
  instance = db
  return instance
}


// Run fn inside a transaction; commit on success, roll back on throw. For multi-table operations that
// must be atomic — e.g. deleting a role and cascading its memories + conversations.
export function transaction<T>(fn: () => T): T {
  const db = getDb()
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
