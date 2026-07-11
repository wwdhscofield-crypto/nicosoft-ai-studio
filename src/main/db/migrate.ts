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
  // closure-loop: the independent Gate B reviewer renders as its own "· Verifier" segment; this marks the
  // persisted step so the identity survives reload. null on every existing row (a normal expert/coordinator step).
  ensureColumn(db, 'messages', 'segment_kind', 'TEXT')
  // The @mention target resolved + persisted when a coordinator-conversation user turn was sent (P2-5): a
  // STABLE audit fact of who the message addressed, so the mention chip no longer drifts as roles are later
  // renamed/deleted (it used to re-derive from the live roster every render). NULL = no mention / legacy row.
  ensureColumn(db, 'messages', 'target_role_id', 'TEXT')
  ensureColumn(db, 'mcp_servers', 'args', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(db, 'skills', 'when_to_use', 'TEXT')
  ensureColumn(db, 'skills', 'body', 'TEXT')
  ensureColumn(db, 'skills', 'dir_path', 'TEXT')
  ensureColumn(db, 'skills', 'allowed_tools', "TEXT NOT NULL DEFAULT '[]'")
  ensureColumn(db, 'skills', 'created_at', 'TEXT')
  ensureColumn(db, 'skills', 'owner_plugin_id', 'TEXT')
  // Skill distillation (docs/skill-distillation-design.md §3.1): provenance for agent-authored
  // ('distilled') skills — which role learned it, from which conversation. NULL on imported/builtin.
  ensureColumn(db, 'skills', 'origin_role', 'TEXT')
  ensureColumn(db, 'skills', 'origin_conv_id', 'TEXT')
  ensureColumn(db, 'mcp_servers', 'owner_plugin_id', 'TEXT')
  // Extension materialization (docs/extension-install-design.md §4): the stdio spawn dir for a
  // local-folder MCP server copied into extensions/mcp/<id>/. NULL on every existing row.
  ensureColumn(db, 'mcp_servers', 'cwd', 'TEXT')
  ensureColumn(db, 'plugins', 'version', 'TEXT')
  ensureColumn(db, 'plugins', 'author', 'TEXT')
  ensureColumn(db, 'plugins', 'dir_path', 'TEXT')
  ensureColumn(db, 'plugins', 'created_at', 'TEXT')
  ensureColumn(db, 'projects', 'cwd', 'TEXT')
  ensureColumn(db, 'conversations', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'conversations', 'archived', 'INTEGER NOT NULL DEFAULT 0')
  // Per-conversation working dir (replaces the renderer's per-expert cwd for new conversations). NULL on every
  // existing row → the renderer falls back to the legacy per-expert cwd until the conversation gets its own.
  ensureColumn(db, 'conversations', 'cwd', 'TEXT')
  // Memory self-learning upgrades: provenance (which conversation a memory was learned from), decay
  // bookkeeping (when recall last selected it), and the extractor's incremental watermark.
  ensureColumn(db, 'memories', 'source_conv_id', 'TEXT')
  ensureColumn(db, 'memories', 'last_recalled_at', 'TEXT')
  ensureColumn(db, 'extraction_state', 'last_extracted_id', 'TEXT')
  // studio-lens (§6): floor/aggregate/subject row discrimination + per-step linkage.
  // row_kind defaults to 'floor' so every existing row keeps the single-verifier pass-rate semantics.
  ensureColumn(db, 'gate_outcomes', 'row_kind', "TEXT NOT NULL DEFAULT 'floor'")
  ensureColumn(db, 'gate_outcomes', 'step_id', 'TEXT')
  ensureColumn(db, 'gate_outcomes', 'subject', 'TEXT')
  // Workflow-run provenance (§7.5 launch discipline): WHO launched a run — initiating role id (NULL = the
  // user by hand), the conversation it was launched from (launch-card / Tasks anchor), and the scheduled
  // task that fired it. NULL on existing rows (an honest "unknown"). schema.ts carries them for fresh DBs.
  ensureColumn(db, 'workflow_runs', 'initiator', 'TEXT')
  ensureColumn(db, 'workflow_runs', 'origin_conv_id', 'TEXT')
  ensureColumn(db, 'workflow_runs', 'origin_task_id', 'TEXT')
  // Project tool-event rich artifacts (Gap D): the nsai-media:// ref of an image a tool produced (computer-use
  // screenshot / ns_generate_image), attached from its result so the project timeline shows a thumbnail. NULL
  // on existing rows + non-image tools.
  ensureColumn(db, 'project_tool_events', 'media_url', 'TEXT')
  // Project archive (批4): archived projects leave the default list and a scheduled advance skips them.
  // 0 on existing rows; schema.ts carries the column for fresh DBs.
  ensureColumn(db, 'projects', 'archived', 'INTEGER NOT NULL DEFAULT 0')
  // Custom agent roles: opt-in agent-loop capability for user-defined roles. 0 on existing rows (pure
  // chat personas, behavior unchanged); the `tools` JSON column's meaning shifts from the old dead
  // checkbox labels to capability-group keys — old values were never consumed, so no value migration.
  ensureColumn(db, 'custom_roles', 'agent', 'INTEGER NOT NULL DEFAULT 0')
  // Consult arrows exact anchoring: the tool_use id of the send/assign call that produced the consult —
  // joins the row to its project_tool_events card (which already stores src_id). NULL on existing rows
  // (the renderer falls back to positional pairing for those); schema.ts carries it for fresh DBs.
  ensureColumn(db, 'project_consults', 'src_id', 'TEXT')
  migrateShuriToFrontend(db)
}

// One-time role_id rename: the frontend engineer's role_id used to be the character name `shuri`; it is now the
// functional id `frontend` (the DISPLAY name stays "Shuri" via ROLE_DISPLAY_NAMES — only the internal key changed).
// role_id is NOT a foreign key anywhere (FKs are on endpoint/conversation/project/task/memory ids only), so renaming
// the value across every role_id-bearing column is a plain UPDATE with no cascade. Idempotent (WHERE = 'shuri' is a
// no-op once renamed) and gated by user_version so the table scan runs exactly once. Columns are DISCOVERED from the
// live schema so no role_id-bearing table can be missed by a hardcoded list.
function migrateShuriToFrontend(db: DatabaseSync): void {
  const ver = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (ver >= 1) return
  const ROLE_COLS = new Set(['role_id', 'primary_role_id', 'assignee_role_id'])
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
  db.exec('BEGIN')
  try {
    for (const { name } of tables) {
      const cols = db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]
      for (const c of cols) {
        if (ROLE_COLS.has(c.name)) db.prepare(`UPDATE "${name}" SET "${c.name}" = 'frontend' WHERE "${c.name}" = 'shuri'`).run()
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  db.exec('PRAGMA user_version = 1') // idempotent UPDATEs already ran; mark done so the scan is skipped next boot
}

// Add a column only if the table doesn't already have it (SQLite lacks ADD COLUMN IF NOT EXISTS).
function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
  }
}
