import * as roleRepo from '../repos/role.repo'
import * as memoryRepo from '../repos/memory.repo'
import * as convRepo from '../repos/conversation.repo'
import { transaction } from '../db/connection'
import { AGENT_ROLE_IDS } from '@shared/roles'
import type {
  CustomRoleCreateDto,
  CustomRoleDto,
  CustomRoleUpdateDto,
  RoleBindingDto,
  RoleBindingInput,
  RoleStateDto
} from '../ipc/contracts'

// Business layer for role bindings (endpoint/model/thinking) + per-role state (enabled / self-learning).
// Maps the repo rows to the renderer-facing DTOs. Never touches IPC; never writes SQL directly.

function toBindingDto(b: roleRepo.RoleBinding): RoleBindingDto {
  return { roleId: b.roleId, endpointId: b.endpointId, model: b.model, thinkingDepth: b.thinkingDepth, imageModel: b.imageModel }
}

function toStateDto(s: roleRepo.RoleState): RoleStateDto {
  return { roleId: s.roleId, enabled: s.enabled, selfLearningEnabled: s.selfLearningEnabled }
}

export function listBindings(): RoleBindingDto[] {
  const rows = roleRepo.listBindings().map(toBindingDto)
  // Shuri (frontend) defaults to Flynn's (engineer) binding until configured separately (doc 19 phase 1):
  // same Anthropic endpoint + opus model + thinking depth. A user-set Shuri binding overrides this.
  if (!rows.some((b) => b.roleId === 'frontend')) {
    const eng = rows.find((b) => b.roleId === 'engineer')
    if (eng) rows.push({ ...eng, roleId: 'frontend' })
  }
  return rows
}

// Resolve a SINGLE role's binding with the same Shuri→engineer fallback listBindings applies (doc 19 phase
// 1): a Shuri binding not yet configured separately defaults to Flynn's. Service-layer callers (coordinator
// dispatch / collaboration / facilitation) MUST use this, never roleRepo.getBinding directly, or Shuri —
// which has no own DB row until the user sets one — resolves to null and gets dropped.
export function getBinding(roleId: string): RoleBindingDto | null {
  const b = roleRepo.getBinding(roleId)
  if (b) return toBindingDto(b)
  if (roleId === 'frontend') {
    const eng = roleRepo.getBinding('engineer')
    if (eng) return { ...toBindingDto(eng), roleId: 'frontend' }
  }
  return null
}

export function setBinding(roleId: string, input: RoleBindingInput): RoleBindingDto {
  roleRepo.setBinding(roleId, {
    endpointId: input.endpointId ?? null,
    model: input.model ?? null,
    thinkingDepth: input.thinkingDepth ?? null,
    imageModel: input.imageModel ?? null
  })
  const b = roleRepo.getBinding(roleId)
  return b
    ? toBindingDto(b)
    : {
        roleId,
        endpointId: input.endpointId ?? null,
        model: input.model ?? null,
        thinkingDepth: input.thinkingDepth ?? null,
        imageModel: input.imageModel ?? null
      }
}

export function listStates(): RoleStateDto[] {
  return roleRepo.listStates().map(toStateDto)
}

// Coordinator is the router; disabling it leaves the multi-role system without a coordinator. Single source
// of truth lives here (not the renderer) so any caller — IPC handler, e2e tooling, future settings UI
// joining role_states directly — can't accidentally disable it. self-learning IS allowed to be
// turned off on coordinator (a user choice about memory, not a router requirement).
const COORDINATOR_ROLE_ID = 'coordinator'

export function setState(
  roleId: string,
  patch: { enabled?: boolean; selfLearningEnabled?: boolean }
): RoleStateDto {
  const safePatch = { ...patch }
  if (roleId === COORDINATOR_ROLE_ID && safePatch.enabled === false) {
    delete safePatch.enabled // silently ignore the disable; keep any selfLearningEnabled change
  }
  roleRepo.setState(roleId, safePatch)
  const s = roleRepo.getState(roleId)
  return s
    ? toStateDto(s)
    : { roleId, enabled: safePatch.enabled ?? true, selfLearningEnabled: safePatch.selfLearningEnabled ?? true }
}

// Delete a role and cascade its data atomically: role-layer memories + the role's conversations
// (messages, summaries, extraction_state cascade via FK) + bindings + state + the custom-role row.
// Shared memory is global and intentionally kept.
export function remove(roleId: string): void {
  // Only custom roles can be deleted — never cascade-delete a built-in role's conversations/memory,
  // even if an IPC caller asks. Built-ins aren't in custom_roles, so getCustom gates them out.
  if (!roleRepo.getCustom(roleId)) return
  transaction(() => {
    memoryRepo.removeByRole(roleId)
    convRepo.removeByRole(roleId)
    roleRepo.removeBinding(roleId)
    roleRepo.removeState(roleId)
    roleRepo.removeCustom(roleId)
  })
}

// --- Custom roles ---

function toCustomDto(r: roleRepo.CustomRoleRow): CustomRoleDto {
  return {
    id: r.id,
    name: r.name,
    avatar: r.avatar,
    color: r.color,
    systemPrompt: r.systemPrompt,
    tools: r.tools,
    greeting: r.greeting,
    exampleQueries: r.exampleQueries,
    agent: r.agent,
    createdAt: r.createdAt
  }
}

export function getCustom(roleId: string): CustomRoleDto | null {
  const row = roleRepo.getCustom(roleId)
  return row ? toCustomDto(row) : null
}

// THE capability predicate: does this role run the full agent loop (tool kit + multi-turn transcript)?
// Built-in agent roles (AGENT_ROLE_IDS — a CONSTANT of the 8 built-ins, no longer a predicate) plus any
// custom role whose Agent capability is switched on. Every main-process capability gate (kit tiers,
// dispatch execution, scheduled expert steps, workflow lint, collab membership) asks THIS, never the
// built-in set directly — the be388d6 predicate discipline (roleHasAgent = routing vs runsAgentLoop =
// capability) carried to data-driven membership.
export function runsAgentLoop(roleId: string): boolean {
  return AGENT_ROLE_IDS.has(roleId) || roleRepo.getCustom(roleId)?.agent === true
}

export function listCustom(): CustomRoleDto[] {
  return roleRepo.listCustom().map(toCustomDto)
}

// Create a new user-defined role. The fresh role starts ENABLED (no role_states row inserted; the
// renderer treats "no row" as enabled). Bindings are set in a separate call once the user picks an
// endpoint+model from the editor — keeps the create call cheap and idempotent.
export function createCustom(input: CustomRoleCreateDto): CustomRoleDto {
  const trimmed = input.name?.trim()
  if (!trimmed) throw new Error('custom role name is required')
  return toCustomDto(roleRepo.createCustom({ ...input, name: trimmed }))
}

// Update a custom role's fields. Built-in roles are NOT in custom_roles, so updateCustom on a
// built-in id is a silent no-op (returns null) — the IPC layer surfaces that as null to the caller.
export function updateCustom(id: string, patch: CustomRoleUpdateDto): CustomRoleDto | null {
  const trimmed = patch.name?.trim()
  const safe = trimmed !== undefined ? { ...patch, name: trimmed || undefined } : patch
  const row = roleRepo.updateCustom(id, safe)
  return row ? toCustomDto(row) : null
}
