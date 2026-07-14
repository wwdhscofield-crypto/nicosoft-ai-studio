// createMigrateHandle — the agent-tool bridge for studio_migrate (research-role-driven-redesign §4.1, RED ZONE).
// Card/phase/abort/opts wiring lives in the shared runScriptHandle; this supplies the migrate-specific config: the
// migrate-panel script (which transforms each site in an ISOLATED throwaway git worktree and aggregates a
// reviewable PATCH — nothing applied), the patch formatter, and the RED-ZONE precondition that the run needs the
// conversation's cwd (a git repo) — threaded to the script as convCwd. requiresCwd makes runScriptHandle reject
// early with a clear reason when there's no working folder. The tool NEVER applies the patch (see studio-migrate.ts).
import { runScriptHandle, type ScriptHandleDeps, type ScriptHandleConfig } from '../script/script-handle'
import { runMigrateScript } from './agent-migrate'
import { formatMigration } from './report'
import type { MigrateHandle } from '../../agent/context'

const MIGRATE_CONFIG: ScriptHandleConfig = {
  cardName: 'StudioMigrate',
  toolName: 'studio_migrate',
  inputKey: 'instruction',
  readyLabel: 'patch ready',
  resultNoun: 'patch',
  requiresCwd: true,
  cwdError: 'studio_migrate needs the conversation to have a working folder (a git repo) — set one, then retry.',
  // Red-zone: the migrate script isolates worktrees under the conversation repo, so thread cwd through as convCwd.
  run: ({ opts, roleId, cwd, value, onPhase, onLog }) => runMigrateScript({ opts, roleId, convCwd: cwd, instruction: value, onPhase, onLog }),
  format: formatMigration
}

export function createMigrateHandle(deps: ScriptHandleDeps): MigrateHandle {
  return {
    run: (input) => runScriptHandle(deps, { value: input.instruction, signal: input.signal, asyncHandleId: input.asyncHandleId }, MIGRATE_CONFIG)
  }
}
