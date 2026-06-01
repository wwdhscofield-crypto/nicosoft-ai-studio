import type { DatabaseSync } from 'node:sqlite'
import { SCHEMA_SQL } from './schema'

// Idempotent: every statement in SCHEMA_SQL is CREATE TABLE/INDEX IF NOT EXISTS, so this is safe on
// every boot. ensureColumn backfills columns added to a table after its first install — CREATE TABLE
// IF NOT EXISTS won't alter an existing table. Future breaking changes gate behind PRAGMA user_version.
export function runMigrations(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL)
  ensureColumn(db, 'role_bindings', 'thinking_depth', 'TEXT')
  ensureColumn(db, 'role_bindings', 'image_model', 'TEXT')
  ensureColumn(db, 'messages', 'run_id', 'TEXT')
}

// Add a column only if the table doesn't already have it (SQLite lacks ADD COLUMN IF NOT EXISTS).
function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}
