// SQLite schema — v1.0.1 full set (built once; later batches use these tables, no re-migration).
// node:sqlite. ULID TEXT primary keys; timestamps are ISO-8601 TEXT; JSON columns are TEXT.
// API keys / MCP credentials are NOT stored here — they live in the OS keychain; tables hold refs.

export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS endpoints (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  protocol         TEXT NOT NULL,                 -- openai | anthropic | gemini | custom
  base_url         TEXT NOT NULL,
  default_model    TEXT,
  available_models TEXT NOT NULL DEFAULT '[]',    -- JSON string[]
  enabled          INTEGER NOT NULL DEFAULT 1,
  cache_enabled    INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_bindings (
  role_id        TEXT PRIMARY KEY,                -- built-in 8 + custom
  endpoint_id    TEXT,
  model          TEXT,
  thinking_depth TEXT,                            -- low | medium | high | max (null = provider default)
  image_model    TEXT,                            -- designer's image backend slug (null = Nano Banana Pro default)
  FOREIGN KEY (endpoint_id) REFERENCES endpoints (id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS custom_roles (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  avatar          TEXT,
  color           TEXT,
  system_prompt   TEXT,
  tools           TEXT NOT NULL DEFAULT '[]',     -- JSON string[]
  greeting        TEXT,
  example_queries TEXT NOT NULL DEFAULT '[]',     -- JSON string[]
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_states (
  role_id              TEXT PRIMARY KEY,          -- Coordinator row cannot be disabled (enforced in service)
  enabled              INTEGER NOT NULL DEFAULT 1,
  self_learning_enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,                  -- single | multi
  primary_role_id TEXT,
  title           TEXT,
  project_id      TEXT,
  pinned          INTEGER NOT NULL DEFAULT 0,     -- 1 = pinned to the top of History
  archived        INTEGER NOT NULL DEFAULT 0,     -- 1 = moved to the Archived group
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  author          TEXT NOT NULL,                  -- user | expert
  expert_id       TEXT,
  model           TEXT,
  content         TEXT NOT NULL DEFAULT '',
  attachments     TEXT NOT NULL DEFAULT '[]',     -- JSON
  in_tokens       INTEGER NOT NULL DEFAULT 0,    -- DISPLAY: current context size (last turn) — composer "/ window" meter
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  out_tokens      INTEGER NOT NULL DEFAULT 0,    -- SETTLE ↓: cumulative output (total received) for the segment
  sent_tokens     INTEGER NOT NULL DEFAULT 0,    -- SETTLE ↑: cumulative input (total sent, billing) for the segment
  dispatch        TEXT,                           -- JSON string[] | null
  run_id          TEXT,                           -- agent run id (Engineer); links to transcript. null for plain chat
  segment_kind    TEXT,                           -- closure-loop: 'verifier' (independent Gate B reviewer segment) | null (normal). Drives the "· Verifier" identity badge across reload.
  created_at      TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS summaries (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  parent_id       TEXT,
  content         TEXT NOT NULL,
  covered_up_to   TEXT,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memories (
  id         TEXT PRIMARY KEY,
  layer      TEXT NOT NULL,                       -- shared | role | collab
  role_id    TEXT,
  project_id TEXT,
  type       TEXT NOT NULL,                       -- fact | preference | learning
  content    TEXT NOT NULL,
  source     TEXT NOT NULL,                       -- explicit | user | auto
  tokens     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories (layer, role_id);

CREATE TABLE IF NOT EXISTS memory_versions (
  id         TEXT PRIMARY KEY,
  memory_id  TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memories (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  goal       TEXT,
  cwd        TEXT,                                 -- working directory the experts operate in (project/folder path)
  phase      TEXT NOT NULL DEFAULT 'planning',    -- planning | executing | testing | done
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Project memory (coordinator dispatch §4): Danny's synthesized project-shape map, keyed by the NORMALIZED
-- project cwd (realpath + worktree-to-main + case-fold — NOT project_id, so every conversation/worktree on
-- the same folder shares it). Recalled before an L1 routing investigation as the starting point; re-scanned
-- on the DELTA when the fingerprint (a coarse STRUCTURAL digest — top-level layout + surface markers, not
-- git HEAD) no longer matches the tree. The natural key is the cwd, so PRIMARY KEY is the path, not a ULID.
CREATE TABLE IF NOT EXISTS project_maps (
  cwd         TEXT PRIMARY KEY,                    -- normalized project key (§10.1); the recall/upsert key
  fingerprint TEXT NOT NULL,                       -- structural digest (§10.2); mismatch = shape changed → re-scan delta
  map         TEXT NOT NULL,                       -- Danny's concise project-shape summary (the reusable memory)
  project_id  TEXT,                                -- optional link to a projects row when the cwd is a Studio project
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Agent memory (auto-memory, CC "# Memory" parity — docs/auto-memory-design.md): durable single-fact
-- entries the agent AUTHORS itself via the remember/forget/recall_memory tools. Distinct from memories
-- (the passive extraction layer): agent-written, keyed by the same normalized project cwd as project_maps,
-- named by a CC kebab-slug unique per project (upsert-by-name = CC's "update, don't duplicate").
CREATE TABLE IF NOT EXISTS agent_memories (
  id             TEXT PRIMARY KEY,
  cwd            TEXT NOT NULL,                    -- normalized project key (project-map §10.1 discipline)
  name           TEXT NOT NULL,                    -- kebab-case slug (CC shape); the upsert/recall key
  description    TEXT NOT NULL,                    -- one-liner used to decide relevance during recall
  type           TEXT NOT NULL CHECK (type IN ('user','feedback','project','reference')),
  content        TEXT NOT NULL,                    -- the fact (markdown body, clamped in the service)
  origin_role    TEXT,                             -- audit: which role wrote it
  origin_conv_id TEXT,                             -- audit: from which conversation
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (cwd, name)
);

CREATE INDEX IF NOT EXISTS idx_agent_memories_cwd ON agent_memories (cwd, updated_at DESC);

CREATE TABLE IF NOT EXISTS project_tasks (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  step_no          INTEGER NOT NULL,
  title            TEXT NOT NULL,
  assignee_role_id TEXT,
  deps             TEXT NOT NULL DEFAULT '[]',    -- JSON string[]
  status           TEXT NOT NULL DEFAULT 'todo',  -- todo | doing | done
  output           TEXT,
  created_at       TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_tests (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',     -- pending | pass | fail
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_consults (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  from_role  TEXT NOT NULL,
  to_role    TEXT NOT NULL,
  kind       TEXT NOT NULL,                        -- send | assign
  text       TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_tool_events (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  role_id    TEXT NOT NULL,
  src_id     TEXT,                                  -- the tool_use block id (dedup across compaction retries)
  seq        INTEGER NOT NULL,
  tool_name  TEXT NOT NULL,
  target     TEXT,
  zone       TEXT NOT NULL DEFAULT 'green',         -- green (auto) | yellow (auto+log) | red (needs approval)
  created_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pte_src ON project_tool_events (project_id, src_id);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,                     -- once | daily | weekly | cron
  trigger_spec TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  next_run     TEXT,
  last_run     TEXT,
  last_result  TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_steps (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL,
  step_no     INTEGER NOT NULL,
  kind        TEXT NOT NULL,                      -- expert | tool | send_email | project
  expert_id   TEXT,
  instruction TEXT,
  config      TEXT NOT NULL DEFAULT '{}',         -- JSON
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  transport       TEXT NOT NULL,                  -- stdio | http
  endpoint_or_cmd TEXT NOT NULL,                  -- stdio command | http url
  args            TEXT NOT NULL DEFAULT '[]',     -- JSON string[] (stdio args; http unused)
  scope           TEXT NOT NULL DEFAULT '"all"',  -- JSON: "all" | string[]
  enabled         INTEGER NOT NULL DEFAULT 1,
  tool_count      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'idle',   -- connected | error | idle
  owner_plugin_id TEXT,                            -- set when installed by a plugin (locked in the UI)
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  when_to_use   TEXT,
  source        TEXT NOT NULL DEFAULT 'builtin',   -- imported | builtin
  body          TEXT,                              -- builtin: inline instructions; imported: SKILL.md snapshot
  dir_path      TEXT,                              -- imported: skill folder; builtin: null
  allowed_tools TEXT NOT NULL DEFAULT '[]',        -- JSON string[]
  scope         TEXT NOT NULL DEFAULT '"all"',     -- JSON: "all" | string[]
  enabled       INTEGER NOT NULL DEFAULT 1,
  owner_plugin_id TEXT,                            -- set when installed by a plugin (locked in the UI)
  created_at    TEXT
);

CREATE TABLE IF NOT EXISTS plugins (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  version     TEXT,
  author      TEXT,
  dir_path    TEXT,
  bundles     TEXT NOT NULL DEFAULT '[]',         -- JSON [{type,id,name}] of installed resources
  source      TEXT NOT NULL DEFAULT 'imported',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT
);

CREATE TABLE IF NOT EXISTS usage_events (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT,
  expert_id       TEXT,
  model           TEXT NOT NULL,
  provider        TEXT NOT NULL,
  in_tokens       INTEGER NOT NULL DEFAULT 0,
  out_tokens      INTEGER NOT NULL DEFAULT 0,
  tool_calls      TEXT,                           -- JSON | null
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events (created_at);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,                         -- profile | general | privacy
  value TEXT NOT NULL                             -- JSON
);

CREATE TABLE IF NOT EXISTS extraction_state (
  conversation_id TEXT PRIMARY KEY,               -- memory-extraction concurrency control (replaces Redis)
  lock_until      TEXT,
  turn_counter    INTEGER NOT NULL DEFAULT 0,
  idle_due        TEXT,
  FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pending_approvals (
  id          TEXT PRIMARY KEY,                   -- red-zone action deferred for user approval (doc 19 §8)
  conv_id     TEXT NOT NULL,                      -- bound to the conversation (project_id/task_id in phase 5)
  role_id     TEXT NOT NULL,                      -- the agent that requested the red-zone action
  tool_name   TEXT NOT NULL,
  tool_input  TEXT NOT NULL,                      -- JSON
  cwd         TEXT NOT NULL,                      -- where to replay it on approval
  reason      TEXT NOT NULL,                      -- why it classified red
  status      TEXT NOT NULL DEFAULT 'pending',    -- pending | approved | rejected | executed | failed
  created_at  TEXT NOT NULL,
  resolved_at TEXT,
  FOREIGN KEY (conv_id) REFERENCES conversations (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pending_conv ON pending_approvals (conv_id, status);

CREATE TABLE IF NOT EXISTS gate_outcomes (
  id          TEXT PRIMARY KEY,                   -- one row per verification-gate closure (Gate B step / Gate C run)
  conv_id     TEXT NOT NULL,
  gate        TEXT NOT NULL,                      -- 'B' (independent step verify) | 'C' (background e2e)
  role_id     TEXT NOT NULL,                      -- the implementer the gate judged
  outcome     TEXT NOT NULL,                      -- B: pass|fixed|false-positive|unresolved|unverified  C: PASS|FAIL|BLOCKED|SKIP
  rounds      INTEGER NOT NULL DEFAULT 1,         -- verifier passes run (B) / e2e rounds (C)
  evidence    TEXT NOT NULL DEFAULT '',           -- verdict tail, truncated — enough to recognize the case
  row_kind    TEXT NOT NULL DEFAULT 'floor',      -- studio-lens (§6): 'floor' (single verifier, existing behavior) | 'aggregate' (worst-of fold) | 'subject' (per-subject)
  step_id     TEXT,                               -- one ulid per gated step; links a floor/aggregate row to its subject rows
  subject     TEXT,                               -- ReviewSubject key for row_kind='subject'; NULL otherwise
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gate_outcomes_created ON gate_outcomes (created_at);

-- Workspace Tasks panel history (design §5): completed-phase TODO snapshots + studio_lens verdicts,
-- per conversation. dedup_key makes capture replay-idempotent (phase=convId:setHash; examine=convId:
-- examinedAt). A user Clear flips cleared=1 (rows are kept so the dedup_key still blocks re-add — clear
-- stays durable against a re-snapshot of identical content); the read filters cleared=0.
CREATE TABLE IF NOT EXISTS workspace_task_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  kind            TEXT NOT NULL,                  -- 'phase' | 'examine'
  dedup_key       TEXT NOT NULL,
  payload         TEXT NOT NULL,                  -- JSON snapshot
  cleared         INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  UNIQUE (conversation_id, kind, dedup_key),
  FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_wth_conv ON workspace_task_history (conversation_id, created_at);
`
