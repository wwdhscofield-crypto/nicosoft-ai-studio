// Cross-process single source for the built-in roles' display names. The role_id keys stay the internal
// contract (routing / bindings / dispatch / AGENT_ROLES) — only the surface name ever changes, so a rename
// never touches the wiring. Previously hand-mirrored in main agent/roles/prompts.ts and renderer
// data/studio-data.ts. Environment-neutral: no node, no DOM.

export const ROLE_DISPLAY_NAMES: Record<string, string> = {
  coordinator: 'Danny',
  generalist: 'Amélie',
  engineer: 'Flynn',
  shuri: 'Shuri',
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
