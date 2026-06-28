import { connectToServer } from './connection'
import { discoverTools } from './discovery'
import { callMcpTool } from './execution'
import type { Tool } from '../agent/tool'
import type { ConnectedServer, McpScope, McpServerConfig } from './types'

interface ServerEntry {
  connection: ConnectedServer
  scope: McpScope
  tools: Tool[]
}

// In-process registry of connected MCP servers + their discovered tools. One instance per app (held by
// mcp.service). The whole point of toolsForRole: any agent role (Engineer today, custom agents later)
// gets exactly the MCP tools scoped to it — the injection is by roleId + scope, never hardwired.
export class McpManager {
  private servers = new Map<string, ServerEntry>()

  // (Re)connect a server: tear down any prior session for this id, connect, discover tools, cache them.
  async connect(
    id: string,
    name: string,
    config: McpServerConfig,
    scope: McpScope
  ): Promise<{ toolCount: number }> {
    await this.disconnect(id)
    const connection = await connectToServer(id, name, config)
    const tools = await discoverTools(connection)
    this.servers.set(id, { connection, scope, tools })
    return { toolCount: tools.length }
  }

  async disconnect(id: string): Promise<void> {
    const entry = this.servers.get(id)
    if (!entry) return
    this.servers.delete(id)
    try {
      await entry.connection.cleanup()
    } catch {
      /* best effort */
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((id) => this.disconnect(id)))
  }

  isConnected(id: string): boolean {
    return this.servers.has(id)
  }

  toolCount(id: string): number {
    return this.servers.get(id)?.tools.length ?? 0
  }

  // Call a tool on a connected server resolved by its display NAME (hook configs reference a server by name,
  // not its internal id) and TOOL name (the bare tool name, not the role-scoped mcp__server__tool alias).
  // Throws if the server isn't connected, or if the name is AMBIGUOUS — display names carry no uniqueness
  // guarantee, so silently picking the first match could route the call to the wrong server; fail loudly
  // instead. Used by the mcp_tool hook executor.
  async callToolByName(serverName: string, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ content: unknown; isError?: boolean }> {
    const matches = [...this.servers.values()].filter((e) => e.connection.name === serverName)
    if (matches.length === 0) throw new Error(`MCP server "${serverName}" is not connected.`)
    if (matches.length > 1) throw new Error(`MCP server name "${serverName}" is ambiguous — ${matches.length} connected servers share it; rename one so the hook can address it unambiguously.`)
    return callMcpTool(matches[0].connection, toolName, args, signal)
  }

  // Every MCP tool scoped to a role: server scope 'all', or its roleId list includes roleId.
  toolsForRole(roleId: string): Tool[] {
    const out: Tool[] = []
    for (const entry of this.servers.values()) {
      if (entry.scope === 'all' || entry.scope.includes(roleId)) out.push(...entry.tools)
    }
    return out
  }
}
