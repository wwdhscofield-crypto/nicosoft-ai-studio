import { registerAgentHandlers } from './agent.handler'
import { registerCoordinatorHandlers } from './coordinator.handler'
import { registerConversationHandlers } from './conversations.handler'
import { registerEndpointHandlers } from './endpoints.handler'
import { registerProjectHandlers } from './project.handler'
import { registerRoleHandlers } from './roles.handler'
import { registerSettingsHandlers } from './settings.handler'
import { registerChatHandlers } from './chat.handler'
import { registerMemoryHandlers } from './memory.handler'
import { registerImageToolHandlers } from './image-tool.handler'
import { registerMediaHandlers } from './media.handler'
import { registerMcpHandlers } from './mcp.handler'
import { registerSkillHandlers } from './skill.handler'
import { registerPluginHandlers } from './plugin.handler'
import { registerApprovalHandlers } from './approval.handler'

// Single entry point — main/index.ts calls this once on app ready.
export function registerIpc(): void {
  registerEndpointHandlers()
  registerSettingsHandlers()
  registerChatHandlers()
  registerAgentHandlers()
  registerCoordinatorHandlers()
  registerImageToolHandlers()
  registerProjectHandlers()
  registerRoleHandlers()
  registerConversationHandlers()
  registerMemoryHandlers()
  registerMediaHandlers()
  registerMcpHandlers()
  registerSkillHandlers()
  registerPluginHandlers()
  registerApprovalHandlers()
}
