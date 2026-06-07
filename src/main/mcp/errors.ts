// MCP error hierarchy (trimmed). Each carries the server name so the
// service/UI can attribute failures.

export class McpError extends Error {
  constructor(
    message: string,
    public readonly serverName: string
  ) {
    super(message)
    this.name = 'McpError'
  }
}

export class McpConnectionError extends McpError {
  constructor(serverName: string, message: string) {
    super(message, serverName)
    this.name = 'McpConnectionError'
  }
}

export class McpTimeoutError extends McpError {
  constructor(
    serverName: string,
    public readonly timeoutMs: number
  ) {
    super(`MCP connection to "${serverName}" timed out after ${timeoutMs}ms`, serverName)
    this.name = 'McpTimeoutError'
  }
}

export class McpToolCallError extends McpError {
  constructor(
    serverName: string,
    public readonly toolName: string,
    message: string
  ) {
    super(message, serverName)
    this.name = 'McpToolCallError'
  }
}
