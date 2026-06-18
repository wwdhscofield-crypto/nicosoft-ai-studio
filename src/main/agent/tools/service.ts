// service.ts — runtime co-debugging tools (doc 19 §10): start_service / stop_service / service_logs /
// list_services. They drive the per-collaboration ServiceRegistry via ctx.services (Flynn starts a backend
// server, Shuri's frontend connects to it). Functional only inside a collaboration; outside one they no-op
// with a clear message. start/stop are not read-only (they spawn/kill processes) but run in the collab's
// green zone (cwd-confined, auto-approved — doc 19 §8); logs/list are read-only.

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import type { ServiceInfo } from '../service-registry'

const NO_REGISTRY = 'Service tools work only inside a collaboration (a coordinator team with a shared project). Nothing happened.'

function line(i: ServiceInfo): string {
  return `${i.name} (id ${i.id}, pid ${i.pid}${i.port != null ? `, port ${i.port}` : ', port unknown'}, ${i.status})`
}

const startSchema = z.object({
  name: z.string().describe('short label for the service, e.g. "backend" or "vite"'),
  command: z.string().describe('shell command that starts it, e.g. "npm run dev" — must keep running'),
  readyLog: z.string().optional().describe('wait until this substring appears in the logs (e.g. "ready in")'),
  readyUrl: z.string().optional().describe('wait until this URL responds (e.g. "http://localhost:3000")')
})

export const startServiceTool = buildTool<typeof startSchema, { info?: ServiceInfo; error?: string }>({
  name: 'start_service',
  inputSchema: startSchema,
  prompt: () =>
    'Start a long-running dev service (a server, dev server, watcher) in the background — use this instead ' +
    'of Bash for anything that does not exit, since Bash kills long processes at its timeout. Pass a short ' +
    'name + the command. Optionally pass readyLog or readyUrl so it waits until the service is actually up ' +
    'before returning. Returns the id + detected port; a teammate can list_services to find it and connect.',
  async call(input, ctx) {
    if (!ctx.services) return { data: { error: NO_REGISTRY } }
    try {
      const info = await ctx.services.start({ name: input.name, command: input.command, cwd: ctx.cwd, owner: ctx.roleId, readyLog: input.readyLog, readyUrl: input.readyUrl })
      return { data: { info } }
    } catch (e) {
      return { data: { error: e instanceof Error ? e.message : String(e) } }
    }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    const content = out.error ?? `Started ${line(out.info!)}.`
    return { type: 'tool_result', tool_use_id: toolUseId, content }
  }
})

const idSchema = z.object({ id: z.string().describe('the service id from start_service / list_services') })

export const stopServiceTool = buildTool<typeof idSchema, { ok: boolean }>({
  name: 'stop_service',
  inputSchema: idSchema,
  prompt: () => 'Stop a service you started, by id. Tree-kills it and any child processes it forked.',
  async call(input, ctx) {
    return { data: { ok: ctx.services ? ctx.services.stop(input.id) : false } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: out.ok ? 'Service stopped.' : 'No running service with that id.' }
  }
})

export const serviceLogsTool = buildTool<typeof idSchema, { logs: string | null }>({
  name: 'service_logs',
  inputSchema: idSchema,
  prompt: () => "Read a service's recent logs (head + tail) by id — to see why it failed or what port it bound.",
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(input, ctx) {
    return { data: { logs: ctx.services ? ctx.services.getLogs(input.id) : null } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: out.logs ?? 'No logs / unknown service id.' }
  }
})

const emptySchema = z.object({})

export const listServicesTool = buildTool<typeof emptySchema, { services: ServiceInfo[] }>({
  name: 'list_services',
  inputSchema: emptySchema,
  prompt: () =>
    'List the services running in this collaboration (id, name, port, status). The frontend uses this to ' +
    "find the backend's actual port to connect to.",
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call(_input, ctx) {
    return { data: { services: ctx.services ? ctx.services.list() : [] } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    const content = out.services.length ? out.services.map(line).join('\n') : 'No services running.'
    return { type: 'tool_result', tool_use_id: toolUseId, content }
  }
})
