import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  EndpointDto,
  EndpointInput,
  EndpointTestResult,
  ChatSendInput,
  ChatCompressInput,
  ChatDelta,
  ChatDone,
  ChatErrorDto,
  AgentRunInput,
  AgentTextDelta,
  AgentToolStart,
  AgentAssistant,
  AgentToolResults,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionCancel,
  AgentDone,
  AgentErrorDto,
  ToolCallDto,
  RunTranscript,
  CoordinatorRunInputDto,
  CoordinatorDispatchEvent,
  CoordinatorStepStart,
  CoordinatorStepDelta,
  CoordinatorStepDone,
  CoordinatorDoneDto,
  CoordinatorErrorDto,
  CoordinatorToolStart,
  CoordinatorAssistant,
  CoordinatorToolResults,
  CoordinatorPermissionRequest,
  CoordinatorPermissionCancel,
  CoordinatorApprovalEvent,
  PendingApprovalDto,
  ImageToolRunInputDto,
  ImageToolDeltaDto,
  ImageToolImageStartDto,
  ImageToolImageDto,
  ImageToolTurnBreakDto,
  ImageToolDoneDto,
  ImageToolErrorDto,
  RoleBindingDto,
  RoleBindingInput,
  RoleStateDto,
  CustomRoleDto,
  CustomRoleCreateDto,
  CustomRoleUpdateDto,
  ConversationDto,
  ConversationCreateDto,
  ConversationTitleInput,
  MessageDto,
  MessageAppendDto,
  MemoryDto,
  MemoryAddInput,
  MemoryUpdateInput,
  MemoryOnTurnInput,
  McpServerDto,
  McpServerInput,
  McpTestResult,
  SkillDto,
  SkillInput,
  PluginDto,
  ProjectDto,
  ProjectTaskDto,
  ProjectTestDto,
  ProjectCreateInput,
  ProjectTaskInput,
  ProjectPhase,
  ProjectTaskStatus,
  ProjectTestStatus
} from '../main/ipc/contracts'

// Typed bridge exposed to the renderer as `window.api`. Window controls (Batch 0) + Batch 1
// data/LLM IPC. Renderer never imports node — everything crosses here.

// Subscribe to a main→renderer event channel; returns an unsubscribe fn.
function agentListen<T>(channel: string, cb: (d: T) => void): () => void {
  const h = (_e: IpcRendererEvent, d: T): void => cb(d)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.off(channel, h)
}

const api = {
  minimizeWindow: (): void => ipcRenderer.send('app:minimize'),
  maximizeWindow: (): void => ipcRenderer.send('app:maximize'),
  closeWindow: (): void => ipcRenderer.send('app:close'),

  endpoints: {
    list: (): Promise<EndpointDto[]> => ipcRenderer.invoke('endpoints:list'),
    add: (input: EndpointInput): Promise<EndpointDto> => ipcRenderer.invoke('endpoints:add', input),
    update: (id: string, patch: Partial<EndpointInput>): Promise<EndpointDto | null> =>
      ipcRenderer.invoke('endpoints:update', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('endpoints:remove', id),
    test: (id: string): Promise<EndpointTestResult> => ipcRenderer.invoke('endpoints:test', id)
  },

  settings: {
    get: <T = unknown>(key: string): Promise<T | null> => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown): Promise<void> => ipcRenderer.invoke('settings:set', key, value)
  },

  chat: {
    send: (input: ChatSendInput): Promise<{ streamId: string }> => ipcRenderer.invoke('chat:send', input),
    stop: (streamId: string): Promise<void> => ipcRenderer.invoke('chat:stop', streamId),
    compress: (input: ChatCompressInput): Promise<void> => ipcRenderer.invoke('chat:compress', input),
    onDelta: (cb: (d: ChatDelta) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, d: ChatDelta): void => cb(d)
      ipcRenderer.on('chat:delta', h)
      return () => ipcRenderer.off('chat:delta', h)
    },
    onDone: (cb: (d: ChatDone) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, d: ChatDone): void => cb(d)
      ipcRenderer.on('chat:done', h)
      return () => ipcRenderer.off('chat:done', h)
    },
    onError: (cb: (d: ChatErrorDto) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, d: ChatErrorDto): void => cb(d)
      ipcRenderer.on('chat:error', h)
      return () => ipcRenderer.off('chat:error', h)
    }
  },

  agent: {
    run: (input: AgentRunInput): Promise<{ streamId: string }> => ipcRenderer.invoke('agent:run', input),
    stop: (streamId: string): Promise<void> => ipcRenderer.invoke('agent:stop', streamId),
    respondPermission: (resp: AgentPermissionResponse): Promise<void> =>
      ipcRenderer.invoke('agent:permission:respond', resp),
    onDelta: (cb: (d: AgentTextDelta) => void): (() => void) => agentListen('agent:delta', cb),
    onToolStart: (cb: (d: AgentToolStart) => void): (() => void) => agentListen('agent:tool:start', cb),
    onAssistant: (cb: (d: AgentAssistant) => void): (() => void) => agentListen('agent:assistant', cb),
    onResults: (cb: (d: AgentToolResults) => void): (() => void) => agentListen('agent:results', cb),
    onPermission: (cb: (d: AgentPermissionRequest) => void): (() => void) => agentListen('agent:permission', cb),
    onPermissionCancel: (cb: (d: AgentPermissionCancel) => void): (() => void) => agentListen('agent:permission:cancel', cb),
    onDone: (cb: (d: AgentDone) => void): (() => void) => agentListen('agent:done', cb),
    onError: (cb: (d: AgentErrorDto) => void): (() => void) => agentListen('agent:error', cb),
    transcript: (convId: string): Promise<Record<string, RunTranscript>> =>
      ipcRenderer.invoke('agent:transcript', convId)
  },

  coordinator: {
    run: (input: CoordinatorRunInputDto): Promise<{ streamId: string }> => ipcRenderer.invoke('coordinator:run', input),
    stop: (streamId: string): Promise<void> => ipcRenderer.invoke('coordinator:stop', streamId),
    onDispatch: (cb: (d: CoordinatorDispatchEvent) => void): (() => void) => agentListen('coordinator:dispatch', cb),
    onStepStart: (cb: (d: CoordinatorStepStart) => void): (() => void) => agentListen('coordinator:step:start', cb),
    onDelta: (cb: (d: CoordinatorStepDelta) => void): (() => void) => agentListen('coordinator:delta', cb),
    onStepDone: (cb: (d: CoordinatorStepDone) => void): (() => void) => agentListen('coordinator:step:done', cb),
    onDone: (cb: (d: CoordinatorDoneDto) => void): (() => void) => agentListen('coordinator:done', cb),
    onError: (cb: (d: CoordinatorErrorDto) => void): (() => void) => agentListen('coordinator:error', cb),
    // Agent-dispatched expert tool activity + approvals (doc 19 §11 phase 2) — same shapes as agent:* but
    // tagged with roleId. respondPermission reuses the agent permission-response payload.
    onToolStart: (cb: (d: CoordinatorToolStart) => void): (() => void) => agentListen('coordinator:tool:start', cb),
    onAssistant: (cb: (d: CoordinatorAssistant) => void): (() => void) => agentListen('coordinator:assistant', cb),
    onResults: (cb: (d: CoordinatorToolResults) => void): (() => void) => agentListen('coordinator:results', cb),
    onPermission: (cb: (d: CoordinatorPermissionRequest) => void): (() => void) => agentListen('coordinator:permission', cb),
    onPermissionCancel: (cb: (d: CoordinatorPermissionCancel) => void): (() => void) => agentListen('coordinator:permission:cancel', cb),
    respondPermission: (resp: AgentPermissionResponse): Promise<void> => ipcRenderer.invoke('coordinator:permission:respond', resp),
    onApproval: (cb: (d: CoordinatorApprovalEvent) => void): (() => void) => agentListen('coordinator:approval', cb)
  },

  // Deferred approval of red-zone actions (doc 19 §8): list a conversation's pending actions, then approve
  // (→ replayed in its cwd) or reject them.
  approval: {
    list: (convId: string): Promise<PendingApprovalDto[]> => ipcRenderer.invoke('approval:list', convId),
    approve: (id: string): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke('approval:approve', id),
    reject: (id: string): Promise<boolean> => ipcRenderer.invoke('approval:reject', id)
  },

  imagetool: {
    run: (input: ImageToolRunInputDto): Promise<{ streamId: string }> => ipcRenderer.invoke('imagetool:run', input),
    stop: (streamId: string): Promise<void> => ipcRenderer.invoke('imagetool:stop', streamId),
    onDelta: (cb: (d: ImageToolDeltaDto) => void): (() => void) => agentListen('imagetool:delta', cb),
    onImageStart: (cb: (d: ImageToolImageStartDto) => void): (() => void) => agentListen('imagetool:imagestart', cb),
    onImage: (cb: (d: ImageToolImageDto) => void): (() => void) => agentListen('imagetool:image', cb),
    onTurnBreak: (cb: (d: ImageToolTurnBreakDto) => void): (() => void) => agentListen('imagetool:turnbreak', cb),
    onDone: (cb: (d: ImageToolDoneDto) => void): (() => void) => agentListen('imagetool:done', cb),
    onError: (cb: (d: ImageToolErrorDto) => void): (() => void) => agentListen('imagetool:error', cb)
  },

  project: {
    pick: (): Promise<string | null> => ipcRenderer.invoke('project:pick'),
    branch: (cwd: string): Promise<string | null> => ipcRenderer.invoke('project:branch', cwd),
    branches: (cwd: string): Promise<string[]> => ipcRenderer.invoke('project:branches', cwd),
    checkout: (cwd: string, branch: string): Promise<boolean> => ipcRenderer.invoke('project:checkout', cwd, branch),
    list: (): Promise<ProjectDto[]> => ipcRenderer.invoke('project:list'),
    get: (id: string): Promise<ProjectDto | null> => ipcRenderer.invoke('project:get', id),
    create: (input: ProjectCreateInput): Promise<ProjectDto> => ipcRenderer.invoke('project:create', input),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('project:remove', id),
    phase: (id: string, phase: ProjectPhase): Promise<void> => ipcRenderer.invoke('project:phase', id, phase),
    addTask: (projectId: string, input: ProjectTaskInput): Promise<ProjectTaskDto> =>
      ipcRenderer.invoke('project:task:add', projectId, input),
    setTaskStatus: (projectId: string, taskId: string, status: ProjectTaskStatus, output?: string | null): Promise<void> =>
      ipcRenderer.invoke('project:task:status', projectId, taskId, status, output),
    addTest: (projectId: string, title: string): Promise<ProjectTestDto> =>
      ipcRenderer.invoke('project:test:add', projectId, title),
    setTestStatus: (projectId: string, testId: string, status: ProjectTestStatus): Promise<void> =>
      ipcRenderer.invoke('project:test:status', projectId, testId, status)
  },

  roles: {
    listBindings: (): Promise<RoleBindingDto[]> => ipcRenderer.invoke('roles:bindings:list'),
    setBinding: (roleId: string, input: RoleBindingInput): Promise<RoleBindingDto> =>
      ipcRenderer.invoke('roles:binding:set', roleId, input),
    listStates: (): Promise<RoleStateDto[]> => ipcRenderer.invoke('roles:states:list'),
    setState: (
      roleId: string,
      patch: { enabled?: boolean; selfLearningEnabled?: boolean }
    ): Promise<RoleStateDto> => ipcRenderer.invoke('roles:state:set', roleId, patch),
    remove: (roleId: string): Promise<void> => ipcRenderer.invoke('roles:remove', roleId),
    listCustom: (): Promise<CustomRoleDto[]> => ipcRenderer.invoke('roles:custom:list'),
    createCustom: (input: CustomRoleCreateDto): Promise<CustomRoleDto> =>
      ipcRenderer.invoke('roles:custom:create', input),
    updateCustom: (id: string, patch: CustomRoleUpdateDto): Promise<CustomRoleDto | null> =>
      ipcRenderer.invoke('roles:custom:update', id, patch)
  },

  conversations: {
    list: (): Promise<ConversationDto[]> => ipcRenderer.invoke('conversations:list'),
    create: (input: ConversationCreateDto): Promise<ConversationDto> =>
      ipcRenderer.invoke('conversations:create', input),
    messages: (convId: string): Promise<MessageDto[]> => ipcRenderer.invoke('conversations:messages', convId),
    append: (convId: string, input: MessageAppendDto): Promise<MessageDto> =>
      ipcRenderer.invoke('conversations:append', convId, input),
    rename: (convId: string, title: string): Promise<void> =>
      ipcRenderer.invoke('conversations:rename', convId, title),
    title: (input: ConversationTitleInput): Promise<string> =>
      ipcRenderer.invoke('conversations:title', input),
    remove: (convId: string): Promise<void> => ipcRenderer.invoke('conversations:remove', convId),
    export: (convId: string, format: 'md' | 'json'): Promise<string | null> =>
      ipcRenderer.invoke('conversations:export', convId, format)
  },
  memory: {
    list: (): Promise<MemoryDto[]> => ipcRenderer.invoke('memory:list'),
    add: (input: MemoryAddInput): Promise<MemoryDto> => ipcRenderer.invoke('memory:add', input),
    update: (input: MemoryUpdateInput): Promise<void> => ipcRenderer.invoke('memory:update', input),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('memory:remove', id),
    onTurn: (ctx: MemoryOnTurnInput): Promise<void> => ipcRenderer.invoke('memory:onTurn', ctx)
  },
  media: {
    // Save a generated image (nsai-media:// ref) to a user-chosen path; returns the path or null.
    save: (url: string, name: string): Promise<string | null> => ipcRenderer.invoke('media:save', url, name)
  },
  mcp: {
    list: (): Promise<McpServerDto[]> => ipcRenderer.invoke('mcp:list'),
    add: (input: McpServerInput): Promise<McpServerDto> => ipcRenderer.invoke('mcp:add', input),
    update: (id: string, patch: McpServerInput): Promise<McpServerDto | null> =>
      ipcRenderer.invoke('mcp:update', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('mcp:remove', id),
    test: (id: string): Promise<McpTestResult> => ipcRenderer.invoke('mcp:test', id)
  },
  skills: {
    list: (): Promise<SkillDto[]> => ipcRenderer.invoke('skills:list'),
    add: (input: SkillInput): Promise<SkillDto> => ipcRenderer.invoke('skills:add', input),
    update: (id: string, patch: SkillInput): Promise<SkillDto | null> =>
      ipcRenderer.invoke('skills:update', id, patch),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('skills:remove', id),
    pickDir: (): Promise<string | null> => ipcRenderer.invoke('skills:pickDir')
  },
  plugins: {
    list: (): Promise<PluginDto[]> => ipcRenderer.invoke('plugins:list'),
    install: (dirPath: string): Promise<PluginDto> => ipcRenderer.invoke('plugins:install', dirPath),
    uninstall: (id: string): Promise<void> => ipcRenderer.invoke('plugins:uninstall', id),
    toggle: (id: string, enabled: boolean): Promise<PluginDto | null> =>
      ipcRenderer.invoke('plugins:toggle', id, enabled),
    pickDir: (): Promise<string | null> => ipcRenderer.invoke('plugins:pickDir')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (fallback when contextIsolation is off — not used in this app)
  window.api = api
}

export type Api = typeof api
