// MCP tool naming — fully-qualified `mcp__<server>__<tool>`. Uses the fully-qualified MCP naming convention so the
// agent loop sees a stable, namespaced tool name. Normalization keeps names within the Anthropic
// tool-name charset [a-zA-Z0-9_-] by replacing anything else with '_'.

export function normalizeNameForMCP(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function mcpPrefix(serverName: string): string {
  return `mcp__${normalizeNameForMCP(serverName)}__`
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${mcpPrefix(serverName)}${normalizeNameForMCP(toolName)}`
}
