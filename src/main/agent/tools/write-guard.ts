import type { AgentContext } from '../context'
import { getWorktreeSettings } from '../../services/workspace/worktree'

const BG_ISOLATION_MESSAGE = "Background sub-agents may not write to the main checkout. Re-spawn with isolation:'worktree' or call EnterWorktree before using write tools."

export function bgIsolationWriteBlock(ctx: AgentContext): string | null {
  if (!ctx.isBackgroundSubAgent) return null
  if (ctx.isWorktreeIsolated) return null
  return getWorktreeSettings().bgIsolation === 'worktree' ? BG_ISOLATION_MESSAGE : null
}

export function assertBgIsolationWriteAllowed(ctx: AgentContext): void {
  const block = bgIsolationWriteBlock(ctx)
  if (block) throw new Error(block)
}
