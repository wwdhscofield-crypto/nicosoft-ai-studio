import { registerAgentHandlers, abortAllAgentRuns } from './agent.handler'
import { registerCoordinatorHandlers, abortAllCoordinatorRuns } from './coordinator.handler'
import { registerConversationHandlers } from './conversations.handler'
import { registerEndpointHandlers } from './endpoints.handler'
import { registerProjectHandlers } from './project.handler'
import { registerAssignmentHandlers } from './assignment.handler'
import { registerRoleHandlers } from './roles.handler'
import { registerSettingsHandlers } from './settings.handler'
import { registerChatHandlers, abortAllChatRuns } from './chat.handler'
import { registerMemoryHandlers } from './memory.handler'
import { registerMediaHandlers } from './media.handler'
import { registerFsHandlers } from './fs.handler'
import { registerGitHandlers } from './git.handler'
import { registerTaskHandlers } from './tasks.handler'
import { registerTerminalHandlers } from './terminal.handler'
import { registerMcpHandlers } from './mcp.handler'
import { registerSkillHandlers } from './skill.handler'
import { registerPluginHandlers } from './plugin.handler'
import { registerExtensionInstallHandlers } from './extension-install.handler'
import { registerApprovalHandlers } from './approval.handler'
import { registerScheduledHandlers } from './scheduled.handler'
import { registerMonitorHandlers } from './monitor.handler'
import { registerAnalyticsHandlers } from './analytics.handler'
import { registerServiceHandlers } from './services.handler'
import { registerUpdateHandlers } from './update.handler'
import { registerPreviewHandlers } from './preview.handler'
import { registerComputerUseHandlers } from './computer-use.handler'
import { registerWorkflowHandlers, abortAllWorkflowRuns } from './workflow.handler'
import { registerResearchHandlers, abortAllResearchRuns } from './research.handler'
import { registerDesignHandlers, abortAllDesignRuns } from './design.handler'
import { registerMigrateHandlers, abortAllMigrateRuns } from './migrate.handler'

// Single entry point — main/index.ts calls this once on app ready.
export function registerIpc(): void {
  registerEndpointHandlers()
  registerSettingsHandlers()
  registerChatHandlers()
  registerAgentHandlers()
  registerCoordinatorHandlers()
  registerProjectHandlers()
  registerAssignmentHandlers()
  registerRoleHandlers()
  registerConversationHandlers()
  registerMemoryHandlers()
  registerMediaHandlers()
  registerFsHandlers()
  registerGitHandlers()
  registerTaskHandlers()
  registerTerminalHandlers()
  registerMcpHandlers()
  registerSkillHandlers()
  registerPluginHandlers()
  registerExtensionInstallHandlers()
  registerApprovalHandlers()
  registerScheduledHandlers()
  registerMonitorHandlers()
  registerAnalyticsHandlers()
  registerServiceHandlers()
  registerPreviewHandlers()
  registerComputerUseHandlers()
  registerWorkflowHandlers()
  registerResearchHandlers()
  registerDesignHandlers()
  registerMigrateHandlers()
  registerUpdateHandlers()
}

// app `before-quit`: proactively abort EVERY in-flight run (chat + solo-agent + coordinator/collab) so a quit
// taken mid-fan-out tears down its live LLM fetch streams immediately. Those open sockets are active libuv handles
// that otherwise keep the process alive past the quit → the app hangs and gets SIGKILL'd (dogfood57: a 128-min
// Studio Lens review with 8 concurrent streams + a parked collab expert; quit → 2s hang → SIGKILL). Synchronous +
// idempotent; safe to call once on before-quit.
export function abortAllRuns(): void {
  abortAllChatRuns()
  abortAllAgentRuns()
  abortAllCoordinatorRuns()
  abortAllWorkflowRuns()
  abortAllResearchRuns()
  abortAllDesignRuns()
  abortAllMigrateRuns()
}
