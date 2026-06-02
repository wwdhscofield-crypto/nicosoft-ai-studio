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
  AgentAssistant,
  AgentToolResults,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionCancel,
  AgentDone,
  AgentErrorDto,
  ToolCallDto,
  CoordinatorRunInputDto,
  CoordinatorDispatchEvent,
  CoordinatorStepStart,
  CoordinatorStepDelta,
  CoordinatorStepDone,
  CoordinatorDoneDto,
  CoordinatorErrorDto,
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
  SkillInput
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
    onAssistant: (cb: (d: AgentAssistant) => void): (() => void) => agentListen('agent:assistant', cb),
    onResults: (cb: (d: AgentToolResults) => void): (() => void) => agentListen('agent:results', cb),
    onPermission: (cb: (d: AgentPermissionRequest) => void): (() => void) => agentListen('agent:permission', cb),
    onPermissionCancel: (cb: (d: AgentPermissionCancel) => void): (() => void) => agentListen('agent:permission:cancel', cb),
    onDone: (cb: (d: AgentDone) => void): (() => void) => agentListen('agent:done', cb),
    onError: (cb: (d: AgentErrorDto) => void): (() => void) => agentListen('agent:error', cb),
    transcript: (convId: string): Promise<Record<string, ToolCallDto[]>> =>
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
    onError: (cb: (d: CoordinatorErrorDto) => void): (() => void) => agentListen('coordinator:error', cb)
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
    checkout: (cwd: string, branch: string): Promise<boolean> => ipcRenderer.invoke('project:checkout', cwd, branch)
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
