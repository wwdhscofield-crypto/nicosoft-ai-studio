// monitor_start / monitor_stop — the agent's interface to session-level conditional polling (Monitor). A
// Monitor samples a data source on an interval and wakes THIS conversation only when the value changes, at zero
// LLM cost between changes. Available to every agent role (solo + collab), not just dev roles — capability
// parity. The actual polling / diffing / throttling lives in services/monitor.service.ts; these tools just
// register and cancel watchers, attributing each to the calling conversation + role (collab routing).

import { z } from 'zod'
import { buildTool, type ValidationResult } from '../tool'
import type { AgentContext } from '../context'
import type { ToolResultBlock } from '../types'
import { monitorService } from '../../services/monitor.service'

const startSchema = z.object({
  kind: z.enum(['preview', 'http', 'file']).describe('Probe type: "preview" evaluates a JS expression in the live Preview webview, "http" GETs a URL, "file" reads a file under the project.'),
  intervalMs: z.number().int().describe('How often to sample, in milliseconds (clamped to [1000, 3600000]). For a fast-moving source use 5000–30000.'),
  prompt: z.string().describe('What to tell yourself when the watched value CHANGES — your standing instruction (e.g. "the viewer count changed; greet new viewers"). Delivered to you, wrapped as a system notification, with the before/after diff.'),
  label: z.string().optional().describe('Short human label shown in the Scheduled panel.'),
  previewExpression: z.string().optional().describe('kind=preview: a JavaScript expression evaluated in the Preview page; its RETURN VALUE is the watched datum (e.g. "document.querySelector(\'.count\').textContent").'),
  url: z.string().url().optional().describe('kind=http: the http/https URL to GET (the response body is watched). Must be a PUBLIC endpoint — loopback / private-LAN / metadata addresses are rejected; watch a LOCAL app via kind=preview instead.'),
  filePath: z.string().optional().describe('kind=file: a path under the project working directory whose content is watched.'),
  changeThreshold: z.number().positive().optional().describe('Optional positive numeric threshold: when both samples are numbers, only wake if they differ by at least this much. Omit (do not pass 0) to wake on any change.'),
})

const stopSchema = z.object({
  id: z.string().describe('The monitor id returned by monitor_start.'),
})

function textResult(toolUseId: string, text: string, isError = false): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }
}

export const monitorStartTool = buildTool({
  name: 'monitor_start',
  inputSchema: startSchema,
  prompt: () =>
    'Start a session Monitor: a NON-LLM background probe that samples a data source on an interval and wakes ' +
    'you ONLY when the value changes (no model tokens are spent between changes). Use it to react to a live ' +
    'page value (kind=preview), an endpoint (kind=http), or a file (kind=file) without polling it yourself. ' +
    'When the value changes, you are re-invoked with your `prompt` + the before/after diff. A jittery source is ' +
    'rate-limited (a token bucket) and a monitor that would wake you too often auto-stops. Stop it with ' +
    'monitor_stop when you no longer need it. The conversation stays alive while a monitor is armed.',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  validateInput: async (input): Promise<ValidationResult> => {
    if (input.kind === 'preview' && !input.previewExpression?.trim()) return { result: false, message: 'kind=preview requires previewExpression.' }
    if (input.kind === 'http' && !input.url?.trim()) return { result: false, message: 'kind=http requires url.' }
    if (input.kind === 'file' && !input.filePath?.trim()) return { result: false, message: 'kind=file requires filePath.' }
    if (!input.prompt.trim()) return { result: false, message: 'prompt is required — say what you should do when the value changes.' }
    return { result: true }
  },
  call: async (input, ctx: AgentContext) => {
    if (!ctx.convId) return { data: { error: 'monitor_start is unavailable in this context (no conversation).' } }
    try {
      const { id, label } = monitorService.start({
        convId: ctx.convId,
        roleId: ctx.roleId,
        kind: input.kind,
        intervalMs: input.intervalMs,
        prompt: input.prompt,
        label: input.label,
        previewExpression: input.previewExpression,
        url: input.url,
        filePath: input.filePath,
        changeThreshold: input.changeThreshold,
        cwd: ctx.cwd,
      })
      return { data: { id, label } }
    } catch (err) {
      // A start-time precondition failure (e.g. kind=preview with no Preview attached) surfaces as a tool error
      // instead of registering a watcher that would silently never fire.
      return { data: { error: err instanceof Error ? err.message : String(err) } }
    }
  },
  mapResult: (out: { id?: string; label?: string; error?: string }, toolUseId) => {
    if (out.error) return textResult(toolUseId, out.error, true)
    return textResult(
      toolUseId,
      `Monitor started (id: ${out.id}, "${out.label}"). You will be woken automatically when the watched value ` +
        `changes — do not poll it yourself. Stop it with monitor_stop("${out.id}") when done.`,
    )
  },
})

export const monitorStopTool = buildTool({
  name: 'monitor_stop',
  inputSchema: stopSchema,
  prompt: () => 'Stop a running session Monitor by its id (from monitor_start). Frees the watcher and lets the conversation end normally if nothing else keeps it alive.',
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  call: async (input, ctx: AgentContext) => {
    const stopped = monitorService.stop(input.id, { reason: 'manual' })
    return { data: { stopped, id: input.id, convId: ctx.convId } }
  },
  // Stopping a monitor is idempotent: an id that's already gone (auto-stopped, or the conversation disposed it)
  // is a benign no-op, NOT an error — surfacing is_error would push the model to retry a successful intent. (L3)
  mapResult: (out: { stopped: boolean; id: string }, toolUseId) =>
    textResult(toolUseId, out.stopped ? `Monitor ${out.id} stopped.` : `Monitor ${out.id} was not running (already stopped).`),
})
