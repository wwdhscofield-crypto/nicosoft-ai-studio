// Core domain types consumed by the UI. Most screens now read real IPC-backed data; the few types
// still backing the static studio-data seed (Expert, Greeting, ExtensionsData) sit alongside the
// domain types (Conversation, Project, MemoryItem, …) used by the real views.

export type Family = 'anthropic' | 'openai' | 'gemini' | null

export interface Expert {
  id: string
  name: string
  color: string
  specialty: string
  personality: string
  model: string | null
  family: Family
  coordinator?: boolean
  custom?: boolean
  agent?: boolean // custom roles only: Agent capability on (badge + capability UI); built-ins use the predicate
  unconfigured?: boolean
}

export interface MemoryItem {
  id: string
  text: string
}

export interface McpServer {
  name: string
  transport: 'http' | 'stdio'
  endpoint: string
  status: 'connected' | 'error' | 'idle'
  tools: number
  scope: 'all' | string[]
  error?: string
}
export interface Skill {
  name: string
  desc: string
  source: string
  enabled: boolean
  scope: 'all' | string[]
}
export interface PluginBundle {
  type: 'skill' | 'mcp' | 'role'
  name: string
}
export interface Plugin {
  name: string
  desc: string
  source: string
  enabled: boolean
  bundles: PluginBundle[]
  summary: string
}
export interface ExtensionsData {
  mcp: McpServer[]
  skills: Skill[]
  plugins: Plugin[]
}

export interface Greeting {
  greeting: string
  chips: string[]
}
export interface StudioData {
  EXPERTS: Expert[]
  EXPERT_BY_ID: Record<string, Expert>
  GREETINGS: Record<string, Greeting>
  USER_PROFILE: { name: string }
  EXTENSIONS: ExtensionsData
}
