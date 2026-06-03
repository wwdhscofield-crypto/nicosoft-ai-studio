// Agent permission mode — the user-facing modes the composer ModePicker exposes. A subset of the
// loop's runtime PermissionMode (src/main/agent/context.ts): 'auto' isn't surfaced since it behaves
// like 'default'. Mirrors AgentPermissionMode in the IPC contract (src/main/ipc/contracts.ts) — keep
// the two in sync. The model can still flip the mode at runtime via EnterPlanMode / ExitPlanMode.
export type AgentMode = 'default' | 'plan' | 'bypass'

export const MODE_OPTIONS: { value: AgentMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask', hint: 'Approve edits & commands before they run' },
  { value: 'plan', label: 'Plan', hint: 'Read-only — investigate and plan first' },
  { value: 'bypass', label: 'Auto', hint: 'Run everything without asking' }
]

export function modeLabel(mode: AgentMode): string {
  return MODE_OPTIONS.find((o) => o.value === mode)?.label ?? 'Ask'
}
