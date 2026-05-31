import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  EndpointDto,
  EndpointInput,
  EndpointTestResult,
  ChatSendInput,
  ChatDelta,
  ChatDone,
  ChatErrorDto,
  AgentRunInput,
  AgentTextDelta,
  AgentAssistant,
  AgentToolResults,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentDone,
  AgentErrorDto
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
    onDone: (cb: (d: AgentDone) => void): (() => void) => agentListen('agent:done', cb),
    onError: (cb: (d: AgentErrorDto) => void): (() => void) => agentListen('agent:error', cb)
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
