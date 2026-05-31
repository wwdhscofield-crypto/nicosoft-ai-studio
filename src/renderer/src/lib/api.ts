// Renderer-side aliases for the IPC DTOs, derived from the preload `window.api` surface so the
// renderer never imports main-process modules directly. Shapes mirror main/ipc/contracts.

export type EndpointDto = Awaited<ReturnType<typeof window.api.endpoints.list>>[number]
export type EndpointInput = Parameters<typeof window.api.endpoints.add>[0]
export type ModelInfo = EndpointDto['availableModels'][number]
export type RoleBindingDto = Awaited<ReturnType<typeof window.api.roles.listBindings>>[number]
export type RoleStateDto = Awaited<ReturnType<typeof window.api.roles.listStates>>[number]
export type ConversationDto = Awaited<ReturnType<typeof window.api.conversations.list>>[number]
