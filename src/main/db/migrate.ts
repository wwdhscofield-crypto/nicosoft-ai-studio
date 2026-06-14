import type { DatabaseSync } from 'node:sqlite'
import { SCHEMA_SQL } from './schema'

// Idempotent: every statement in SCHEMA_SQL is CREATE TABLE/INDEX IF NOT EXISTS, so this is safe on
// every boot. ensureColumn backfills columns added to a table after its first install — CREATE TABLE
// IF NOT EXISTS won't alter an existing table. Future breaking changes gate behind PRAGMA user_version.
export function runMigrations(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL)
  ensureColumn(db, 'endpoints', 'cache_enabled', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'role_bindings', 'thinking_depth', 'TEXT')
  ensureColumn(db, 'role_bindings', 'image_model', 'TEXT')
  ensureColumn(db, 'messages', 'run_id', 'TEXT')
  ensureColumn(db, 'messages', 'cache_read_tokens', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'messages', 'sent_tokens', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'mcp_servers', 'args', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(db, 'skills', 'when_to_use', 'TEXT')
  ensureColumn(db, 'skills', 'body', 'TEXT')
  ensureColumn(db, 'skills', 'dir_path', 'TEXT')
  ensureColumn(db, 'skills', 'allowed_tools', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(db, 'skills', 'created_at', 'TEXT')
  ensureColumn(db, 'skills', 'owner_plugin_id', 'TEXT')
  ensureColumn(db, 'mcp_servers', 'owner_plugin_id', 'TEXT')
  ensureColumn(db, 'plugins', 'version', 'TEXT')
  ensureColumn(db, 'plugins', 'author', 'TEXT')
  ensureColumn(db, 'plugins', 'dir_path', 'TEXT')
  ensureColumn(db, 'plugins', 'created_at', 'TEXT')
  ensureColumn(db, 'projects', 'cwd', 'TEXT')
  ensureColumn(db, 'conversations', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'conversations', 'archived', 'INTEGER NOT NULL DEFAULT 0')
  // Memory self-learning upgrades: provenance (which conversation a memory was learned from), decay
  // bookkeeping (when recall last selected it), and the extractor's incremental watermark.
  ensureColumn(db, 'memories', 'source_conv_id', 'TEXT')
  ensureColumn(db, 'memories', 'last_recalled_at', 'TEXT')
  ensureColumn(db, 'extraction_state', 'last_extracted_id', 'TEXT')
  // Multi-lens Gate B (gate-b-multilens §6): floor/aggregate/lens row discrimination + per-step linkage.
  // row_kind defaults to 'floor' so every existing row keeps the single-verifier pass-rate semantics.
  ensureColumn(db, 'gate_outcomes', 'row_kind', "TEXT NOT NULL DEFAULT 'floor'")
  ensureColumn(db, 'gate_outcomes', 'step_id', 'TEXT')
  ensureColumn(db, 'gate_outcomes', 'lens', 'TEXT')
}

// Add a column only if the table doesn't already have it (SQLite lacks ADD COLUMN IF NOT EXISTS).
function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}
