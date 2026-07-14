// Cross-process single source for the built-in roles' display names. The role_id keys stay the internal
// contract (routing / bindings / dispatch / AGENT_ROLES) — only the surface name ever changes, so a rename
// never touches the wiring. Previously hand-mirrored in main agent/roles/prompts.ts and renderer
// data/studio-data.ts. Environment-neutral: no node, no DOM.

export const ROLE_DISPLAY_NAMES: Record<string, string> = {
  coordinator: 'Danny',
  generalist: 'Amélie',
  engineer: 'Flynn',
  frontend: 'Shuri',
  designer: 'Georgia',
  translator: 'Louise',
  editor: 'Miranda',
  analyst: 'Turing',
  scheduler: 'Joan'
}

// Display name shown to the user + used by Danny when it refers to a teammate.
export function displayName(roleId: string): string {
  return ROLE_DISPLAY_NAMES[roleId] ?? roleId
}

// Accepts either the display name (@Flynn) or the raw id (@engineer); unknown names pass through lowercased.
export function roleIdFromName(name: string): string {
  const lower = name.trim().toLowerCase()
  for (const [id, n] of Object.entries(ROLE_DISPLAY_NAMES)) if (id === lower || n.toLowerCase() === lower) return id
  return lower
}

// Roles that run a FULL agent loop (tools + multi-turn transcript) when dispatched — the SINGLE source of
// truth, imported by BOTH main (agent-tools re-exports it; agent-dispatch re-exports that) and renderer
// (chat-helpers keys agent:run vs chat:send on it). Was two literals hand-synced across the IPC boundary.
// coordinator is never a member (it never dispatches to itself). Environment-neutral: no node, no DOM.
export const AGENT_ROLE_IDS: ReadonlySet<string> = new Set(['engineer', 'frontend', 'generalist', 'analyst', 'scheduler', 'translator', 'editor', 'designer'])

// Roles with WRITE permission — the doers that may edit files / run write-kit tools. The SINGLE source for main's
// DEV_ROLES (agent-tools re-points at this) AND the renderer (the /migrate red-zone guard: studio_migrate writes,
// in isolated worktrees, so only these roles may drive it). Subset of AGENT_ROLE_IDS. Environment-neutral.
export const WRITE_ROLE_IDS: ReadonlySet<string> = new Set(['engineer', 'frontend'])
