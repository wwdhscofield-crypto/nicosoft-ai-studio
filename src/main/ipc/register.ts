import { registerAgentHandlers } from './agent.handler'
import { registerAtlasHandlers } from './atlas.handler'
import { registerConversationHandlers } from './conversations.handler'
import { registerEndpointHandlers } from './endpoints.handler'
import { registerProjectHandlers } from './project.handler'
import { registerRoleHandlers } from './roles.handler'
import { registerSettingsHandlers } from './settings.handler'
import { registerChatHandlers } from './chat.handler'
import { registerMemoryHandlers } from './memory.handler'

// Single entry point — main/index.ts calls this once on app ready.
export function registerIpc(): void {
  registerEndpointHandlers()
  registerSettingsHandlers()
  registerChatHandlers()
  registerAgentHandlers()
  registerAtlasHandlers()
  registerProjectHandlers()
  registerRoleHandlers()
  registerConversationHandlers()
  registerMemoryHandlers()
}
