import { ulid } from '../db/id'
import { getDb } from '../db/connection'
import { asJson, buildUpdate } from './_sql'

// role_bindings + custom_roles + role_states tables. Pure SQL.
// - bindings: which endpoint+model a role talks to (role_id PK, UPSERT).
// - states: per-role enabled / self-learning flags stored 0/1 (role_id PK, UPSERT).
// - custom: user-defined roles; `tools` and `example_queries` are JSON string[].

export interface RoleBinding {
  roleId: string
  endpointId: string | null
  model: string | null
  thinkingDepth: string | null
  imageModel: string | null
}

export interface RoleState {
  roleId: string
  enabled: boolean
  selfLearningEnabled: boolean
}

export interface CustomRoleRow {
  id: string
  name: string
  avatar: string | null
  color: string | null
  systemPrompt: string | null
  tools: string[]
  greeting: string | null
  exampleQueries: string[]
  createdAt: string
}

export interface CustomRoleCreateInput {
  name: string
  avatar?: string
  color?: string
  systemPrompt?: string
  tools?: string[]
  greeting?: string
  exampleQueries?: string[]
}

export interface CustomRoleUpdatePatch {
  name?: string
  avatar?: string | null
  color?: string | null
  systemPrompt?: string | null
  tools?: string[]
  greeting?: string | null
  exampleQueries?: string[]
}

interface RoleBindingRaw {
  role_id: string
  endpoint_id: string | null
  model: string | null
  thinking_depth: string | null
  image_model: string | null
}

interface RoleStateRaw {
  role_id: string
  enabled: number
  self_learning_enabled: number
}

interface CustomRoleRaw {
  id: string
  name: string
  avatar: string | null
  color: string | null
  system_prompt: string | null
  tools: string
  greeting: string | null
  example_queries: string
  created_at: string
}

function mapBinding(raw: RoleBindingRaw): RoleBinding {
  return {
    roleId: raw.role_id,
    endpointId: raw.endpoint_id,
    model: raw.model,
    thinkingDepth: raw.thinking_depth,
    imageModel: raw.image_model
  }
}

function mapState(raw: RoleStateRaw): RoleState {
  return {
    roleId: raw.role_id,
    enabled: raw.enabled === 1,
    selfLearningEnabled: raw.self_learning_enabled === 1
  }
}

function mapCustom(raw: CustomRoleRaw): CustomRoleRow {
  return {
    id: raw.id,
    name: raw.name,
    avatar: raw.avatar,
    color: raw.color,
    systemPrompt: raw.system_prompt,
    tools: JSON.parse(raw.tools) as string[],
    greeting: raw.greeting,
    exampleQueries: JSON.parse(raw.example_queries) as string[],
    createdAt: raw.created_at
  }
}

// --- bindings ---

export function getBinding(roleId: string): RoleBinding | null {
  const row = getDb().prepare('SELECT * FROM role_bindings WHERE role_id = ?').get(roleId) as unknown as
    | RoleBindingRaw
    | undefined
  return row ? mapBinding(row) : null
}

export function setBinding(
  roleId: string,
  patch: { endpointId: string | null; model: string | null; thinkingDepth: string | null; imageModel: string | null }
): void {
  getDb()
    .prepare(
      `INSERT INTO role_bindings (role_id, endpoint_id, model, thinking_depth, image_model) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(role_id) DO UPDATE SET
         endpoint_id = excluded.endpoint_id,
         model = excluded.model,
         thinking_depth = excluded.thinking_depth,
         image_model = excluded.image_model`
    )
    .run(roleId, patch.endpointId, patch.model, patch.thinkingDepth, patch.imageModel)
}

export function listBindings(): RoleBinding[] {
  const rows = getDb().prepare('SELECT * FROM role_bindings').all() as unknown as RoleBindingRaw[]
  return rows.map(mapBinding)
}

export function removeBinding(roleId: string): void {
  getDb().prepare('DELETE FROM role_bindings WHERE role_id = ?').run(roleId)
}

// --- states ---

export function getState(roleId: string): RoleState | null {
  const row = getDb().prepare('SELECT * FROM role_states WHERE role_id = ?').get(roleId) as unknown as
    | RoleStateRaw
    | undefined
  return row ? mapState(row) : null
}

// Patch semantics: only the provided flags are written. On first insert, omitted columns use the
// schema defaults (both 1); on update, omitted columns keep their current value (COALESCE). Lets
// `enabled` and `self_learning_enabled` be set independently instead of clobbering each other.
export function setState(
  roleId: string,
  patch: { enabled?: boolean; selfLearningEnabled?: boolean }
): void {
  const enabled = patch.enabled === undefined ? null : patch.enabled ? 1 : 0
  const selfLearning = patch.selfLearningEnabled === undefined ? null : patch.selfLearningEnabled ? 1 : 0
  getDb()
    .prepare(
      `INSERT INTO role_states (role_id, enabled, self_learning_enabled)
       VALUES (?, COALESCE(?, 1), COALESCE(?, 1))
       ON CONFLICT(role_id) DO UPDATE SET
         enabled = COALESCE(?, enabled),
         self_learning_enabled = COALESCE(?, self_learning_enabled)`
    )
    .run(roleId, enabled, selfLearning, enabled, selfLearning)
}

export function listStates(): RoleState[] {
  const rows = getDb().prepare('SELECT * FROM role_states').all() as unknown as RoleStateRaw[]
  return rows.map(mapState)
}

export function removeState(roleId: string): void {
  getDb().prepare('DELETE FROM role_states WHERE role_id = ?').run(roleId)
}

// --- custom roles ---

export function createCustom(input: CustomRoleCreateInput): CustomRoleRow {
  const id = ulid()
  const createdAt = new Date().toISOString()
  const tools = JSON.stringify(input.tools ?? [])
  const exampleQueries = JSON.stringify(input.exampleQueries ?? [])
  getDb()
    .prepare(
      `INSERT INTO custom_roles (id, name, avatar, color, system_prompt, tools, greeting, example_queries, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.name,
      input.avatar ?? null,
      input.color ?? null,
      input.systemPrompt ?? null,
      tools,
      input.greeting ?? null,
      exampleQueries,
      createdAt
    )
  return {
    id,
    name: input.name,
    avatar: input.avatar ?? null,
    color: input.color ?? null,
    systemPrompt: input.systemPrompt ?? null,
    tools: input.tools ?? [],
    greeting: input.greeting ?? null,
    exampleQueries: input.exampleQueries ?? [],
    createdAt
  }
}

export function updateCustom(id: string, patch: CustomRoleUpdatePatch): CustomRoleRow | null {
  const { sets, args } = buildUpdate([
    ['name', patch.name],
    ['avatar', patch.avatar],
    ['color', patch.color],
    ['system_prompt', patch.systemPrompt],
    ['tools', asJson(patch.tools)],
    ['greeting', patch.greeting],
    ['example_queries', asJson(patch.exampleQueries)],
  ])
  if (sets.length > 0) {
    getDb()
      .prepare(`UPDATE custom_roles SET ${sets.join(', ')} WHERE id = ?`)
      .run(...args, id)
  }
  const row = getDb().prepare('SELECT * FROM custom_roles WHERE id = ?').get(id) as unknown as
    | CustomRoleRaw
    | undefined
  return row ? mapCustom(row) : null
}

export function removeCustom(id: string): void {
  getDb().prepare('DELETE FROM custom_roles WHERE id = ?').run(id)
}

export function listCustom(): CustomRoleRow[] {
  const rows = getDb()
    .prepare('SELECT * FROM custom_roles ORDER BY created_at ASC')
    .all() as unknown as CustomRoleRaw[]
  return rows.map(mapCustom)
}

export function getCustom(id: string): CustomRoleRow | null {
  const row = getDb().prepare('SELECT * FROM custom_roles WHERE id = ?').get(id) as unknown as
    | CustomRoleRaw
    | undefined
  return row ? mapCustom(row) : null
}
