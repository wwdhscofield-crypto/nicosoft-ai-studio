// Renderer-side aliases for the IPC DTOs, derived from the preload `window.api` surface so the
// renderer never imports main-process modules directly. Shapes mirror main/ipc/contracts.

export type EndpointDto = Awaited<ReturnType<typeof window.api.endpoints.list>>[number]
export type EndpointInput = Parameters<typeof window.api.endpoints.add>[0]
export type ModelInfo = EndpointDto['availableModels'][number]
export type CustomRoleDto = Awaited<ReturnType<typeof window.api.roles.listCustom>>[number]
export type CustomRoleCreateDto = Parameters<typeof window.api.roles.createCustom>[0]
export type CustomRoleUpdateDto = Parameters<typeof window.api.roles.updateCustom>[1]
export type ConversationDto = Awaited<ReturnType<typeof window.api.conversations.list>>[number]
export type FsListDirResult = Awaited<ReturnType<typeof window.api.fs.listDir>>
export type FsEntry = FsListDirResult['entries'][number]
export type FsReadForView = Awaited<ReturnType<typeof window.api.fs.readForView>>
export type WorkspaceTaskHistory = Awaited<ReturnType<typeof window.api.tasks.history>>
export type WorkspacePhase = WorkspaceTaskHistory['phases'][number]
export type WorkspaceExamine = WorkspaceTaskHistory['examines'][number]
export type MemoryDto = Awaited<ReturnType<typeof window.api.memory.list>>[number]
export type AnalyticsSummary = Awaited<ReturnType<typeof window.api.analytics.summary>>
export type AppInfo = Awaited<ReturnType<typeof window.api.app.info>>
export type McpServerDto = Awaited<ReturnType<typeof window.api.mcp.list>>[number]
export type McpServerInput = Parameters<typeof window.api.mcp.add>[0]
export type McpTransport = McpServerDto['transport']
export type SkillDto = Awaited<ReturnType<typeof window.api.skills.list>>[number]
export type SkillInput = Parameters<typeof window.api.skills.add>[0]
export type SkillSource = SkillDto['source']
export type PluginDto = Awaited<ReturnType<typeof window.api.plugins.list>>[number]
