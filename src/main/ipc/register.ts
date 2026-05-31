import { registerAgentHandlers } from './agent.handler'
import { registerEndpointHandlers } from './endpoints.handler'
import { registerProjectHandlers } from './project.handler'
import { registerSettingsHandlers } from './settings.handler'
import { registerChatHandlers } from './chat.handler'

// Single entry point — main/index.ts calls this once on app ready.
export function registerIpc(): void {
  registerEndpointHandlers()
  registerSettingsHandlers()
  registerChatHandlers()
  registerAgentHandlers()
  registerProjectHandlers()
}
