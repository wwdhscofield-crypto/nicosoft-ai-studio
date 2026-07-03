// remember / forget / recall_memory — the agent-authored memory tools (auto-memory, CC "# Memory"
// parity; docs/auto-memory-design.md §3.2). CC has NO dedicated memory tools (the model Writes files);
// Studio's Write is cwd-confined, so the same write rules ride dedicated tools over the app DB instead.
// Prompts carry CC's write rules verbatim-adapted; WHEN to save is prompt-gated (the # Memory system
// section), not mechanical. Every role gets them incl. coordinator-direct (the remember_project_map
// tier); sub-agents are stripped in loop.ts. App-DB-only writes → isReadOnly:true: auto-allowed,
// usable in plan mode (remember_project_map precedent).

import { z } from 'zod'
import { buildTool } from '../tool'
import type { AgentContext } from '../context'
import type { ToolResultBlock } from '../types'
import * as agentMemory from '../../services/memory/agent-memory'

const NO_FOLDER = 'unavailable here (no project folder open — memories are keyed by project).'

function textResult(toolUseId: string, text: string, isError = false): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }
}

const rememberSchema = z.object({
  name: z
    .string()
    .describe('short-kebab-case-slug — the memory\'s stable id. Reusing an existing name UPDATES that memory (check the # Memory index first: update over duplicate).'),
  description: z
    .string()
    .describe('one-line summary — used to decide relevance during recall, so be specific. Keep it under ~200 chars; move detail into the content.'),
  type: z
    .enum(['user', 'feedback', 'project', 'reference'])
    .describe('user — who the user is (role, expertise, preferences). feedback — guidance the user has given on how you should work; include the why. project — ongoing work, goals, or constraints not derivable from the code or git history. reference — pointers to external resources (URLs, dashboards, tickets).'),
  content: z
    .string()
    .describe('the fact — ONE fact per memory. For feedback/project, follow with **Why:** and **How to apply:** lines. Convert relative dates to absolute. Link related memories with [[their-name]].'),
  reason: z
    .string()
    .optional()
    .describe('one short line for the audit trail: why this write — e.g. "user corrected my approach", "updating stale entry"'),
})

export const rememberTool = buildTool({
  name: 'remember',
  inputSchema: rememberSchema,
  prompt: () =>
    'Save one durable fact to your persistent project memory — it is carried across sessions and shared ' +
    'by every agent role on this project. One fact per memory. Before saving, check the # Memory index ' +
    'for an existing entry that already covers it — call remember with that SAME name to update it ' +
    "rather than creating a duplicate. Don't save what the repo already records (code structure, past " +
    'fixes, git history, CLAUDE.md) or what only matters to this conversation. Convert relative dates ' +
    'to absolute. Delete memories that turn out to be wrong with the forget tool.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (input, ctx: AgentContext) => {
    if (!ctx.cwd) return { data: { error: `remember is ${NO_FOLDER}` } }
    const outcome = await agentMemory.remember(ctx.cwd, {
      name: input.name,
      description: input.description,
      type: input.type,
      content: input.content,
      originRole: ctx.roleId ?? null,
      originConvId: ctx.convId || null,
    })
    if (!outcome) return { data: { error: 'Nothing saved — name, description and content must be non-empty (and the store must be reachable).' } }
    return { data: outcome }
  },
  mapResult: (out: { name?: string; updated?: boolean; error?: string }, toolUseId) => {
    if (out.error) return textResult(toolUseId, out.error, true)
    return textResult(
      toolUseId,
      out.updated
        ? `Memory "${out.name}" updated. The resident index refreshes next run.`
        : `Memory "${out.name}" saved. It appears in the # Memory index from the next run on this project.`,
    )
  },
})

const forgetSchema = z.object({
  name: z.string().describe('the memory\'s name (from the # Memory index) to delete'),
  reason: z
    .string()
    .optional()
    .describe('one short line for the audit trail: why it no longer holds — e.g. "stale: the module was removed", "wrong: verified against the code"'),
})

export const forgetTool = buildTool({
  name: 'forget',
  inputSchema: forgetSchema,
  prompt: () =>
    'Delete one memory from your persistent project memory by name — for memories that turn out to be ' +
    'wrong, stale (the code moved on, the preference changed), or duplicates of a better entry. ' +
    'Prefer updating (remember with the same name) when the fact merely evolved; forget when it no ' +
    'longer holds at all.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (input, ctx: AgentContext) => {
    if (!ctx.cwd) return { data: { error: `forget is ${NO_FOLDER}` } }
    const removed = await agentMemory.forget(ctx.cwd, input.name)
    if (removed === null) return { data: { error: 'Forget failed — the store was unreachable. The memory may still exist.' } }
    return { data: { name: input.name, removed } }
  },
  mapResult: (out: { name?: string; removed?: boolean; error?: string }, toolUseId) => {
    if (out.error) return textResult(toolUseId, out.error, true)
    return textResult(
      toolUseId,
      out.removed ? `Memory "${out.name}" deleted.` : `No memory named "${out.name}" exists for this project — nothing deleted.`,
      !out.removed,
    )
  },
})

const recallSchema = z.object({
  name: z.string().describe('the memory\'s name (from the # Memory index) to read in full'),
})

export const recallMemoryTool = buildTool({
  name: 'recall_memory',
  inputSchema: recallSchema,
  prompt: () =>
    'Read one memory\'s full content by name — the deep-read behind the one-line # Memory index. Use it ' +
    'when an index entry looks relevant to the work at hand, or when the user asks you to check or ' +
    'recall something. Memories reflect what was true when written: verify any file, function, or flag ' +
    'they name still exists before relying on it.',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (input, ctx: AgentContext) => {
    if (!ctx.cwd) return { data: { error: `recall_memory is ${NO_FOLDER}` } }
    const row = await agentMemory.getMemory(ctx.cwd, input.name)
    if (!row) return { data: { error: `No memory named "${input.name}" exists for this project. Check the # Memory index for the exact name.` } }
    return { data: { name: row.name, description: row.description, type: row.type, content: row.content, updatedAt: row.updatedAt } }
  },
  mapResult: (out: { name?: string; description?: string; type?: string; content?: string; updatedAt?: string; error?: string }, toolUseId) => {
    if (out.error) return textResult(toolUseId, out.error, true)
    return textResult(
      toolUseId,
      `# ${out.name} (${out.type}) — ${out.description}\nLast updated: ${out.updatedAt}\n\n${out.content}\n\n(Reflects what was true when written — verify against the live code before relying on it.)`,
    )
  },
})
