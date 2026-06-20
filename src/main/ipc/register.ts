import { registerAgentHandlers } from './agent.handler'
import { registerCoordinatorHandlers } from './coordinator.handler'
import { registerConversationHandlers } from './conversations.handler'
import { registerEndpointHandlers } from './endpoints.handler'
import { registerProjectHandlers } from './project.handler'
import { registerRoleHandlers } from './roles.handler'
import { registerSettingsHandlers } from './settings.handler'
import { registerChatHandlers } from './chat.handler'
import { registerMemoryHandlers } from './memory.handler'
import { registerMediaHandlers } from './media.handler'
import { registerFsHandlers } from './fs.handler'
import { registerTaskHandlers } from './tasks.handler'
import { registerTerminalHandlers } from './terminal.handler'
import { registerMcpHandlers } from './mcp.handler'
import { registerSkillHandlers } from './skill.handler'
import { registerPluginHandlers } from './plugin.handler'
import { registerApprovalHandlers } from './approval.handler'
import { registerScheduledHandlers } from './scheduled.handler'
import { registerAnalyticsHandlers } from './analytics.handler'
import { registerServiceHandlers } from './services.handler'
import { registerUpdateHandlers } from './update.handler'

// Single entry point — main/index.ts calls this once on app ready.
export function registerIpc(): void {
  registerEndpointHandlers()
  registerSettingsHandlers()
  registerChatHandlers()
  registerAgentHandlers()
  registerCoordinatorHandlers()
  registerProjectHandlers()
  registerRoleHandlers()
  registerConversationHandlers()
  registerMemoryHandlers()
  registerMediaHandlers()
  registerFsHandlers()
  registerTaskHandlers()
  registerTerminalHandlers()
  registerMcpHandlers()
  registerSkillHandlers()
  registerPluginHandlers()
  registerApprovalHandlers()
  registerScheduledHandlers()
  registerAnalyticsHandlers()
  registerServiceHandlers()
  registerUpdateHandlers()
}
