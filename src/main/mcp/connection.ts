import { app } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { McpTimeoutError } from './errors'
import { buildTransport } from './transport'
import type { ConnectedServer, McpServerConfig } from './types'

const CONNECT_TIMEOUT_MS = 30_000

export function createMcpClient(): Client {
  // Client identity sent to MCP servers (like a User-Agent): the brand display name + the app's real
  // version, read dynamically from package.json via Electron rather than hardcoded.
  return new Client({ name: 'NicoSoft AI Studio', version: app.getVersion() }, { capabilities: {} })
}

// Connect to a server: build the transport, connect under a 30s timeout, read capabilities, and return
// a handle whose cleanup() closes the client (which also tears down a stdio subprocess via the SDK).
export async function connectToServer(
  id: string,
  name: string,
  config: McpServerConfig
): Promise<ConnectedServer> {
  const client = createMcpClient()
  const transport = await buildTransport(name, config)

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpTimeoutError(name, CONNECT_TIMEOUT_MS)), CONNECT_TIMEOUT_MS)
  })
  try {
    await Promise.race([client.connect(transport), timeout])
  } catch (e) {
    try {
      await client.close()
    } catch {
      /* nothing started */
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }

  const capabilities = (client.getServerCapabilities() ?? {}) as Record<string, unknown>
  const cleanup = async (): Promise<void> => {
    try {
      await client.close()
    } catch {
      /* already closed */
    }
  }
  return { id, name, client, capabilities, cleanup }
}
