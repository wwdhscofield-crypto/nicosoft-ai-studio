// studio_migrate — the agent-driven codebase-migration tool (research-role-driven-redesign §4.1), RED ZONE.
// Sibling of studio_research / studio_design, but WRITE-gated: only DEV_ROLES (write-permission agent roles) carry
// it in their kit (agent-tools). It discovers the sites a change touches, transforms each in an ISOLATED throwaway
// git worktree (write agents), and aggregates a reviewable PATCH — nothing is applied or committed. The fan-out
// lives behind ctx.migrate (services/migrate/migrate-handle). Async-launch + await_async like its siblings, so the
// progress card lives in the Tasks panel and the role reports the patch. It NEVER applies the patch.

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import type { StudioMigrateResult } from '../context'

const inputSchema = z.object({
  instruction: z.string().min(1).describe('The migration instruction — a concrete, repo-wide change to apply across the sites it touches (e.g. "rename API X to Y everywhere", "migrate callers from lib A to lib B").')
})

export const studioMigrateTool = buildTool<typeof inputSchema, StudioMigrateResult>({
  name: 'studio_migrate',
  inputSchema,
  prompt: () =>
    'Run a repo-wide CODE MIGRATION and get back a REVIEWABLE PATCH — it discovers the sites a change touches, ' +
    'transforms each one in its OWN isolated throwaway git worktree (parallel write agents), and aggregates the ' +
    'result into a single patch. It NEVER applies or commits anything — the patch is for you + the user to review. ' +
    'Reach for it on a mechanical, wide-reaching change across many files (a rename, an API/lib migration, a ' +
    'codemod-style sweep) where doing each edit by hand would be slow and error-prone.\n' +
    'A user message of the form `/migrate <instruction>` is a DIRECT command to run this — call studio_migrate with ' +
    'that exact instruction immediately: do NOT answer from memory, do NOT ask to confirm, do NOT do other work ' +
    'first. It needs the conversation to have a working folder that is a git repo.\n' +
    'RED ZONE — the patch is FOR REVIEW, never auto-applied. After the tool returns the patch, RELAY it to the ' +
    'user and STOP: do NOT apply it, do NOT `git apply` / `patch` it, do NOT re-make the edits yourself with ' +
    'Edit/Write/Bash, do NOT commit. The whole point is a reviewable diff the USER decides on — present it and let ' +
    'them apply it (you may apply it later ONLY if they explicitly ask). Applying it yourself defeats the safety.\n' +
    'INPUT: the migration instruction. OUTPUT: a reviewable patch (diff), which you relay to the user in your own ' +
    'message. The tool writes ONLY inside disposable worktrees and applies NOTHING to the working tree.',
  isReadOnly: () => false,
  async call(input, ctx) {
    if (!ctx.migrate) {
      return { data: { ok: false, message: 'studio_migrate is not available here — it needs a write-permission role (e.g. Flynn/Shuri) and cannot run from inside a sub-agent.' } }
    }
    const instruction = (input.instruction ?? '').trim()
    if (!instruction) return { data: { ok: false, message: 'studio_migrate needs an instruction — pass `instruction`.' } }
    if (ctx.async) {
      const label = `migrate: ${instruction.slice(0, 80)}${instruction.length > 80 ? '…' : ''}`
      const handle = ctx.async.launch('migrate', label, (signal, id) => ctx.migrate!.run({ instruction, signal, asyncHandleId: id }))
      return {
        data: {
          ok: true,
          message:
            `Migration launched: "${instruction}". In your user-facing message, say the migration started + what it ` +
            `covers (and that it produces a REVIEWABLE PATCH, nothing applied), and do NOT print, quote, or mention ` +
            `the handle id ANYWHERE. Then (separately) call await_async with ["${handle.id}"] exactly ONCE to pick up ` +
            `the patch — that suspends you until it lands; do NOT call await_async repeatedly.`
        }
      }
    }
    return { data: await ctx.migrate.run({ instruction }) }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: out.message || '(studio_migrate returned no result)', is_error: !out.ok }
  }
})
