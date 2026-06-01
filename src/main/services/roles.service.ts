import * as roleRepo from '../repos/role.repo'
import * as memoryRepo from '../repos/memory.repo'
import * as convRepo from '../repos/conversation.repo'
import { transaction } from '../db/connection'
import type { RoleBindingDto, RoleBindingInput, RoleStateDto } from '../ipc/contracts'

// Business layer for role bindings (endpoint/model/thinking) + per-role state (enabled / self-learning).
// Maps the repo rows to the renderer-facing DTOs. Never touches IPC; never writes SQL directly.

function toBindingDto(b: roleRepo.RoleBinding): RoleBindingDto {
  return { roleId: b.roleId, endpointId: b.endpointId, model: b.model, thinkingDepth: b.thinkingDepth }
}

function toStateDto(s: roleRepo.RoleState): RoleStateDto {
  return { roleId: s.roleId, enabled: s.enabled, selfLearningEnabled: s.selfLearningEnabled }
}

export function listBindings(): RoleBindingDto[] {
  return roleRepo.listBindings().map(toBindingDto)
}

export function setBinding(roleId: string, input: RoleBindingInput): RoleBindingDto {
  roleRepo.setBinding(roleId, {
    endpointId: input.endpointId ?? null,
    model: input.model ?? null,
    thinkingDepth: input.thinkingDepth ?? null
  })
  const b = roleRepo.getBinding(roleId)
  return b
    ? toBindingDto(b)
    : { roleId, endpointId: input.endpointId ?? null, model: input.model ?? null, thinkingDepth: input.thinkingDepth ?? null }
}

export function listStates(): RoleStateDto[] {
  return roleRepo.listStates().map(toStateDto)
}

// Atlas is the router; disabling it leaves the multi-role system without a coordinator. Single source
// of truth lives here (not the renderer) so any caller — IPC handler, e2e tooling, future settings UI
// joining role_states directly — can't accidentally disable it. self-learning IS allowed to be
// turned off on atlas (a user choice about memory, not a router requirement).
const ATLAS_ROLE_ID = 'atlas'

export function setState(
  roleId: string,
  patch: { enabled?: boolean; selfLearningEnabled?: boolean }
): RoleStateDto {
  const safePatch = { ...patch }
  if (roleId === ATLAS_ROLE_ID && safePatch.enabled === false) {
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
