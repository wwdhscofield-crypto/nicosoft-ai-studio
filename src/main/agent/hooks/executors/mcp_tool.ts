// hooks/executors/mcp_tool.ts — the mcp_tool hook: call a connected MCP server/tool, then parse its result
// through the shared command protocol (parse.ts). The config's `input` object is interpolated against the
// event payload: any string value of the form ${path.to.field} is replaced with that field from the payload
// (e.g. ${tool_input.command} pulls the bash command being run). The MCP result text is parsed exactly like a
// command hook's stdout, so an MCP tool can return a structured decision.

import { manager as mcpManager } from '../../../services/extensions/mcp'
import type { McpToolHookConfig, HookExecContext, HookOutcome } from '../types'
import type { HookPayload } from '../events'
import { parseHookResult } from '../parse'

// Resolve a dotted path (a.b.c / a.0.b) against the payload; returns undefined if any segment is missing.
function lookupPath(root: unknown, path: string): unknown {
  let cur: unknown = root
  for (const seg of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    // Never traverse prototype-chain keys — a config-authored ${__proto__.…} / ${constructor.…} must not read
    // built-in machinery into the MCP input. Treat such a segment as a missing field.
    if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

// Interpolate ${path} placeholders in string values. A WHOLE-string ${path} keeps the resolved value's native
// type (object/number/array); an embedded ${path} is stringified into the surrounding text. Non-string values
// pass through untouched; nested objects/arrays are interpolated recursively.
function interpolate(value: unknown, payload: HookPayload): unknown {
  if (typeof value === 'string') {
    const whole = /^\$\{([^}]+)\}$/.exec(value)
    if (whole) {
      const resolved = lookupPath(payload, whole[1].trim())
      return resolved === undefined ? value : resolved
    }
    return value.replace(/\$\{([^}]+)\}/g, (m, p: string) => {
      const r = lookupPath(payload, p.trim())
      return r === undefined ? m : typeof r === 'string' ? r : JSON.stringify(r)
    })
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, payload))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = interpolate(v, payload)
    return out
  }
  return value
}

function resultToText(content: unknown): string {
  if (typeof content === 'string') return content
  // MCP content is typically an array of { type:'text', text } parts — concatenate the text parts.
  if (Array.isArray(content)) {
    const parts = content
      .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .filter(Boolean)
    if (parts.length) return parts.join('\n')
  }
  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

export async function executeMcpToolHook(config: McpToolHookConfig, payload: HookPayload, opts: HookExecContext): Promise<HookOutcome> {
  const input = interpolate(config.input ?? {}, payload) as Record<string, unknown>
  let res: { content: unknown; isError?: boolean }
  try {
    res = await mcpManager.callToolByName(config.server, config.tool, input, opts.signal)
  } catch (err) {
    if (opts.signal.aborted) return { outcome: 'cancelled' }
    return { outcome: 'non_blocking_error', systemMessage: `MCP tool hook failed: ${err instanceof Error ? err.message : String(err)}` }
  }
  // An MCP-tool error is a NON-blocking error (exit 1, matching the reference): a flaky/erroring MCP server must
  // not veto the user's action. Only an explicit decision in a NORMAL (non-error) result body — parsed as the
  // command protocol at exit 0 — can block.
  return parseHookResult({ stdout: resultToText(res.content), stderr: '', exitCode: res.isError ? 1 : 0, event: payload.hook_event_name })
}
