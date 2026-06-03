// Execution context threaded through the agent loop into every tool call: the confined working
// directory, the abort signal, the read-file cache (for stale-write detection), and the permission
// callback (the approval hook). See docs/nicosoft-studio/12-hex-coding-agent.md §3.

// Content + mtime of each file the agent has Read, so Edit/Write can detect a stale write (the file
// changed on disk since the agent last saw it). Keyed by absolute path.
export interface ReadFileEntry {
  content: string
  mtimeMs: number
}

export type PermissionMode = 'default' | 'plan' | 'auto' | 'bypass'

export interface PermissionRequest {
  toolName: string
  input: Record<string, unknown>
  reason?: string
}

export interface PermissionDecision {
  allow: boolean
  updatedInput?: Record<string, unknown>
}

// The approval hook. When a tool's checkPermissions returns 'ask', the loop calls this; the UI shows
// an approval dialog and blocks on the user, while a headless script can auto-allow/deny. The optional
// signal lets the caller cancel a pending prompt (turn/run abort) so it denies instead of hanging.
export type RequestPermission = (req: PermissionRequest, signal?: AbortSignal) => Promise<PermissionDecision>

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

// For the Task tool: run an isolated sub-agent loop and return its final text. runAgent injects this
// into the context tools see; the sub-agent gets a fresh readFileState/todos and no Task tool, so
// recursion is bounded to one level.
export type SpawnSubAgent = (input: { description: string; prompt: string }) => Promise<string>

export interface AgentContext {
  cwd: string // confined project root; every tool path must resolve under this
  signal: AbortSignal // cancellation — threaded into bash spawns and sub-agents
  readFileState: Map<string, ReadFileEntry> // keyed by absolute path; powers stale-write detection
  permissionMode: PermissionMode
  // EnterPlanMode/ExitPlanMode flip the mode at runtime (doc 17); set by runAgent so the change
  // persists across turns (the loop re-reads it when assembling each turn's context).
  setPermissionMode?: (mode: PermissionMode) => void
  requestPermission: RequestPermission
  todos: TodoItem[] // the agent's working todo list (TodoWrite replaces it); UI renders it in H4
  spawnSubAgent?: SpawnSubAgent // set by runAgent for the Task tool; undefined inside a sub-agent
  sessionDir: string // large tool results persist to <sessionDir>/tool-results/<tool_use_id>.txt
  // LLM access for tools that call a small/fast model (WebFetch content extraction, WebSearch's
  // isolated secondary request). Injected by runAgent from its own baseUrl/apiKey + a small model.
  llm?: AgentLlmAccess
}

// What a tool needs to make its own LLM call (a content-extraction summary, a delegated search).
export interface AgentLlmAccess {
  baseUrl: string
  apiKey: string
  smallModel: string // model for content extraction (WebFetch); defaults to the agent's main model
  searchModel: string // model for the server web_search tool (WebSearch); defaults to the main model
}
