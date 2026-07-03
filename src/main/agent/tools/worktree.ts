import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ActiveWorktreeSession } from '../context'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import * as git from '../../services/workspace/git'
import { createAgentWorktree, removeAgentWorktree, type ManagedWorktree } from '../../services/workspace/worktree'
import { semanticBoolean } from './semantic'

const enterSchema = z
  .strictObject({
    name: z.string().optional().describe('Optional new worktree name. Mutually exclusive with path. If omitted, Studio generates one.'),
    path: z.string().optional().describe('Optional path to an existing git worktree listed by git worktree list. Mutually exclusive with name.'),
  })
  .refine((v) => !(v.name && v.path), { message: 'name and path are mutually exclusive' })

const exitSchema = z.strictObject({
  action: z.enum(['keep', 'remove']).describe('keep leaves the worktree on disk; remove removes a Studio-created worktree when safe.'),
  discard_changes: semanticBoolean(z.boolean().optional()).describe('Required to remove a Studio-created worktree that has dirty files or commits ahead of its base.'),
})

interface EnterResult {
  path: string
  created: boolean
  existed: boolean
  previousCwd: string
  name: string
}

interface ExitResult {
  action: 'keep' | 'remove'
  path?: string
  returnedTo?: string
  removed?: boolean
  keptReason?: string
  dirty?: boolean
  ahead?: number
}

const ADJECTIVES = ['amber', 'brisk', 'calm', 'clear', 'quiet', 'rapid', 'steady', 'tidy']
const NOUNS = ['branch', 'field', 'forge', 'grove', 'harbor', 'ridge', 'studio', 'trail']

function randomName(): string {
  const b = randomBytes(3)
  return `${ADJECTIVES[b[0] % ADJECTIVES.length]}-${NOUNS[b[1] % NOUNS.length]}-${b[2].toString(16).padStart(2, '0')}`
}

function toManaged(session: ActiveWorktreeSession): ManagedWorktree {
  return {
    name: session.name,
    slug: session.slug,
    root: session.root,
    path: session.path,
    branch: session.branch,
    baseCommit: session.baseCommit,
    baseFile: session.baseFile,
    existed: false,
    createdByStudio: session.createdByStudio,
    hookManaged: session.hookManaged,
  }
}

async function findListedWorktree(cwd: string, inputPath: string): Promise<{ root: string; path: string; branch?: string } | null> {
  const target = resolve(cwd, inputPath)
  const root = (await git.gitRoot(cwd)) ?? (await git.gitRoot(target))
  if (!root) return null
  const listed = await git.worktreeList(root).catch(() => [])
  const entry = listed.find((w) => resolve(w.path) === target)
  return entry ? { root, path: entry.path, branch: entry.branch } : null
}

function setCwd(ctx: { cwd: string; cwdRoot?: string; setCwd?: (cwd: string) => void }, cwd: string, root?: string): void {
  ctx.cwd = cwd
  if (root !== undefined) ctx.cwdRoot = root
  ctx.setCwd?.(cwd)
}

export const enterWorktreeTool = buildTool<typeof enterSchema, EnterResult>({
  name: 'EnterWorktree',
  inputSchema: enterSchema,
  prompt: () =>
    'Enter a git worktree only when the user or project instructions explicitly ask for it. Pass `name` to ' +
    'create a new Studio-managed worktree, pass `path` to enter an existing git worktree, or omit both to ' +
    'create a generated name. Do not use this proactively.',
  shouldDefer: true,
  checkPermissions: async (input) => ({ behavior: 'ask', message: input.path ? `Enter existing worktree ${input.path}` : `Create and enter worktree ${input.name ?? '(generated)'}` }),
  async call(input, ctx) {
    if (ctx.isSubAgent && !input.path) throw new Error('Sub-agents cannot create a new process-level worktree; use isolation:"worktree" or enter an existing path instead.')
    const previousCwd = ctx.cwd
    const previousCwdRoot = ctx.cwdRoot
    let session: ActiveWorktreeSession
    let created = false
    let existed = false

    if (input.path) {
      const found = await findListedWorktree(ctx.cwd, input.path)
      if (!found) throw new Error(`Path is not a registered git worktree: ${input.path}`)
      const name = found.branch?.replace(/^worktree-/, '') || 'existing'
      session = { name, slug: name, root: found.root, path: found.path, branch: found.branch, previousCwd, previousCwdRoot, createdByStudio: false }
    } else {
      const wt = await createAgentWorktree(ctx, input.name?.trim() || randomName())
      created = !wt.existed
      existed = wt.existed
      session = { ...wt, previousCwd, previousCwdRoot, createdByStudio: true }
    }

    ctx.activeWorktree = session
    ctx.isWorktreeIsolated = true
    setCwd(ctx, session.path, session.path)
    return { data: { path: session.path, created, existed, previousCwd, name: session.name } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: `${out.created ? 'Created and entered' : 'Entered'} worktree ${out.name} at ${out.path} (previous cwd: ${out.previousCwd})` }
  },
})

export const exitWorktreeTool = buildTool<typeof exitSchema, ExitResult>({
  name: 'ExitWorktree',
  inputSchema: exitSchema,
  prompt: () =>
    'Exit the active worktree only when explicitly instructed. `keep` leaves it on disk; `remove` deletes a ' +
    'Studio-created worktree only when unchanged, or when discard_changes is true for dirty/ahead work.',
  shouldDefer: true,
  checkPermissions: async (input) => ({ behavior: 'ask', message: `Exit worktree with action ${input.action}` }),
  async call(input, ctx) {
    const session = ctx.activeWorktree
    if (!session) return { data: { action: input.action, keptReason: 'no_active_worktree' } }

    setCwd(ctx, session.previousCwd, session.previousCwdRoot ?? session.previousCwd)
    ctx.activeWorktree = undefined
    ctx.isWorktreeIsolated = false

    if (input.action === 'keep') {
      return { data: { action: 'keep', path: session.path, returnedTo: session.previousCwd, removed: false, keptReason: 'kept_by_request' } }
    }

    if (!session.createdByStudio && !session.hookManaged) {
      return { data: { action: 'remove', path: session.path, returnedTo: session.previousCwd, removed: false, keptReason: 'existing_path_entered' } }
    }

    if (session.baseCommit) {
      const changes = await git.worktreeChanges(session.path, session.baseCommit).catch(() => null)
      if (changes && (changes.dirty || changes.ahead > 0) && input.discard_changes !== true) {
        ctx.activeWorktree = session
        ctx.isWorktreeIsolated = true
        setCwd(ctx, session.path, session.path)
        return { data: { action: 'remove', path: session.path, returnedTo: session.previousCwd, removed: false, keptReason: 'discard_changes_required', dirty: changes.dirty, ahead: changes.ahead } }
      }
    }

    const removed = await removeAgentWorktree(toManaged(session), 'exit_tool', input.discard_changes === true, ctx)
    return { data: { action: 'remove', path: session.path, returnedTo: session.previousCwd, removed: removed.status === 'removed', keptReason: removed.status === 'kept' ? removed.reason : undefined, dirty: removed.dirty, ahead: removed.ahead } }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    if (!out.path) return { type: 'tool_result', tool_use_id: toolUseId, content: 'No active worktree.' }
    if (out.action === 'keep') return { type: 'tool_result', tool_use_id: toolUseId, content: `Exited worktree and kept it at ${out.path}. Current cwd: ${out.returnedTo}` }
    if (out.removed) return { type: 'tool_result', tool_use_id: toolUseId, content: `Exited and removed worktree ${out.path}. Current cwd: ${out.returnedTo}` }
    const suffix = out.keptReason === 'discard_changes_required' ? ` (dirty: ${out.dirty}, ahead commits: ${out.ahead}; pass discard_changes:true to remove)` : out.keptReason ? ` (${out.keptReason})` : ''
    return { type: 'tool_result', tool_use_id: toolUseId, content: `Exited worktree but kept ${out.path}${suffix}. Current cwd: ${out.returnedTo}` }
  },
})
