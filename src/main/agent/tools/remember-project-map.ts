// remember_project_map — the write side of project memory for EXECUTING agents (coordinator dispatch §4.6).
// Danny's router writes the map after a routing investigation (route_decision → remember); this tool lets any
// agent role SEED the map when none is recorded or REFRESH it when the remembered one proved stale or wrong,
// so a solo-first project isn't map-less forever and drift self-corrects. WHEN to write is prompt-gated (only
// a shape the agent verified this run; never a narrow slice), not mechanical — the store is a plain upsert.
// Writes only the app's own DB (no user-system mutation) → isReadOnly:true: auto-allowed, usable in plan mode.

import { z } from 'zod'
import { buildTool } from '../tool'
import type { AgentContext } from '../context'
import type { ToolResultBlock } from '../types'
import { remember, PROJECT_MAP_MAX_CHARS } from '../../services/memory/project-map'

const schema = z.object({
  map: z
    .string()
    .describe("≤1200 chars: the project's VERIFIED shape — top-level layout, which surfaces exist (frontend / backend / CLI / …), key modules. Plain text or markdown. Only what you confirmed against the live tree this run; no guesses."),
  reason: z
    .string()
    .optional()
    .describe('one short line for the audit trail: why this write — e.g. "none recorded", "stale: src/ was restructured", "wrong: map said X, code does Y"'),
})

function textResult(toolUseId: string, text: string, isError = false): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }
}

export const rememberProjectMapTool = buildTool({
  name: 'remember_project_map',
  inputSchema: schema,
  prompt: () =>
    "Record or refresh this project's remembered map — the shared shape summary injected into every future run " +
    'on this folder (solo, dispatched and collab; the router reads it too). Call it AT MOST ONCE, late in the ' +
    'run, and only for a shape you VERIFIED yourself this run: seed it when none is recorded, or submit a ' +
    'corrected map when the remembered one proved stale or wrong. Skip it when you only saw a narrow slice — a ' +
    'shallow overwrite is worse than none. ≤1200 chars, factual; future readers are told to re-verify every ' +
    'claim against the live code.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (input, ctx: AgentContext) => {
    if (!ctx.cwd) return { data: { error: 'remember_project_map is unavailable here (no project folder open).' } }
    const map = input.map.trim().slice(0, PROJECT_MAP_MAX_CHARS)
    if (!map) return { data: { error: 'Empty map — nothing recorded.' } }
    await remember(ctx.cwd, map) // best-effort by contract (§4.5): a store failure logs + no-ops, never throws
    return { data: { chars: map.length } }
  },
  mapResult: (out: { chars?: number; error?: string }, toolUseId) => {
    if (out.error) return textResult(toolUseId, out.error, true)
    return textResult(toolUseId, `Project map recorded (${out.chars} chars). Future runs on this folder start from it — they are told to verify it, so keep it factual and move on.`)
  },
})
