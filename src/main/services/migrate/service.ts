// Studio migrate — the RUN LIFECYCLE behind the `/migrate <instruction>` command. Sibling of research/design
// services: the direct-script path (handler → runScript), NOT the workflow system. One durable artifact — a
// 'migrate-launch' CARD row — carries the whole run: appended 'running', updated IN PLACE (updateMessageContent)
// as phases/logs arrive and once the reviewable patch lands, re-broadcast over the shared conv:card channel.
//
// RED-ZONE but SAFE: the transform sub-agents write code, but each runs in its own throwaway git worktree
// (agent-migrate.ts), so the conversation's real working tree is never touched and nothing is committed or
// applied — the card shows a patch for the user to review + apply by hand. Sub-agents run under a picked agent
// expert. The migration needs the conversation's cwd to be a git repository (createAgentWorktree throws
// otherwise → the run fails cleanly with that message).

import { ulid } from '../../db/id'
import * as convService from '../conversation.service'
import * as convRepo from '../../repos/conversation.repo'
import * as rolesService from '../roles.service'
import { broadcastConvCard } from '../../ipc/usage-broadcast'
import { registerLiveRun } from '../../agent/live-runs'
import { gitRoot } from '../workspace/git'
import { runMigrateScript } from './agent-migrate'
import { formatMigration } from './report'
import type { RunStepOptions } from '../coordinator/step'
import type { CoordinatorCallbacks } from '../coordinator/types'
import type { MessageDto } from '../../ipc/contracts'

export type MigrateStatus = 'running' | 'done' | 'failed' | 'stopped'

// The migrate card payload (segmentKind='migrate-launch', content = this JSON). `report` (markdown incl. the
// ```diff patch) lands on 'done'; `error` on 'failed'.
export interface MigrateCardPayload {
  v: 1
  runId: string
  instruction: string
  status: MigrateStatus
  roleId?: string
  phase?: string
  note?: string
  report?: string
  error?: string
}

interface LiveRun {
  controller: AbortController
  convId: string
  cardId: string
}
const live = new Map<string, LiveRun>()

export function isRunning(runId: string): boolean {
  return live.has(runId)
}

export function stop(runId: string): boolean {
  const r = live.get(runId)
  if (!r) return false
  r.controller.abort()
  return true
}

export function abortAllMigrateRuns(): void {
  for (const r of live.values()) r.controller.abort()
}

// Boot reconciliation (mirrors research / design / assignment / workflow): any 'running' migrate-launch card at
// startup is a crash/quit orphan — settle it to 'stopped'. DB-only; returns the count swept.
export function sweepInterruptedRuns(): number {
  let n = 0
  for (const row of convRepo.listBySegmentKind('migrate-launch')) {
    let payload: MigrateCardPayload
    try {
      payload = JSON.parse(row.content) as MigrateCardPayload
    } catch {
      continue
    }
    if (payload.status !== 'running') continue
    const settled: MigrateCardPayload = { ...payload, status: 'stopped', phase: undefined, note: undefined }
    if (convRepo.updateMessageContent(row.id, JSON.stringify(settled))) n++
  }
  return n
}

// Pick the expert the migration sub-agents run under: dispatch-ready + agent-loop capable (it must call write
// tools). The write kit is forced regardless of the role's default; a code-capable expert gives the best result.
function pickMigrateRole(): string | null {
  const ready = rolesService
    .listBindings()
    .filter((b) => b.endpointId && rolesService.isDispatchReady(b.roleId) && rolesService.runsAgentLoop(b.roleId))
  return ready.length > 0 ? ready[0].roleId : null
}

function noopCallbacks(): CoordinatorCallbacks {
  return {
    onDispatch: () => {},
    onStepStart: () => {},
    onDelta: () => {},
    onStepDone: () => {},
    requestPermission: async () => ({ allow: false }),
  }
}

function patchCard(convId: string, card: MessageDto, payload: MigrateCardPayload, next: Partial<MigrateCardPayload>): MigrateCardPayload {
  const merged = { ...payload, ...next }
  const content = JSON.stringify(merged)
  if (convRepo.updateMessageContent(card.id, content)) {
    broadcastConvCard(convId, { ...card, content })
  }
  return merged
}

export interface RunMigrateInput {
  convId: string
  instruction: string
}

export async function run(input: RunMigrateInput): Promise<{ ok: true; runId: string } | { ok: false; error: string }> {
  const instruction = input.instruction.trim()
  if (!instruction) return { ok: false, error: 'A migration instruction is required — e.g. /migrate replace the deprecated foo() calls with bar()' }
  const conv = convService.get(input.convId)
  if (!conv) return { ok: false, error: 'conversation not found' }
  if (!conv.cwd) return { ok: false, error: 'Migration needs a working folder that is a git repository — open this conversation on a repo (the worktree isolation branches off it).' }
  // Fail fast if the folder is not actually a git repo — else the (billed) discover agent runs, then every
  // transform's createAgentWorktree throws and the run settles to a misleading "done / no file needed changing".
  if (!(await gitRoot(conv.cwd))) {
    return { ok: false, error: "Migration needs the working folder to be a git repository — this conversation's folder is not one (the worktree isolation branches off it)." }
  }
  const roleId = pickMigrateRole()
  if (!roleId) return { ok: false, error: 'No migration-capable expert is configured. Bind an agent expert to an enabled endpoint and retry.' }

  const runId = ulid()
  const initial: MigrateCardPayload = { v: 1, runId, instruction, status: 'running', roleId, phase: 'Discover' }
  const card = convService.append(input.convId, { author: 'expert', expertId: roleId, content: JSON.stringify(initial), segmentKind: 'migrate-launch' })
  broadcastConvCard(input.convId, card)

  const controller = new AbortController()
  const unregister = registerLiveRun(input.convId, () => controller.abort())
  live.set(runId, { controller, convId: input.convId, cardId: card.id })
  void executeMigrate({ convId: input.convId, card, instruction, roleId, convCwd: conv.cwd, controller, payload: initial }).finally(() => {
    live.delete(runId)
    unregister()
  })
  return { ok: true, runId }
}

async function executeMigrate(ctx: {
  convId: string
  card: MessageDto
  instruction: string
  roleId: string
  convCwd: string
  controller: AbortController
  payload: MigrateCardPayload
}): Promise<void> {
  const { convId, card, instruction, roleId, convCwd, controller } = ctx
  const signal = controller.signal
  let payload = ctx.payload

  const opts: RunStepOptions = {
    convId,
    roleId,
    prompt: '',
    dispatch: null,
    cb: noopCallbacks(),
    signal,
    cwd: convCwd,
    permissionMode: 'default',
    includeHistory: false,
  }

  try {
    const result = await runMigrateScript({
      opts,
      roleId,
      convCwd,
      instruction,
      onPhase: (title) => {
        payload = patchCard(convId, card, payload, { phase: title })
      },
      onLog: (message) => {
        payload = patchCard(convId, card, payload, { note: message })
      },
    })

    if (signal.aborted) {
      patchCard(convId, card, payload, { status: 'stopped', phase: undefined, note: undefined })
      return
    }
    if (!result.ok) {
      patchCard(convId, card, payload, { status: 'failed', error: result.error, phase: undefined, note: undefined })
      return
    }
    patchCard(convId, card, payload, { status: 'done', report: formatMigration(result.value), phase: undefined, note: undefined })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    patchCard(convId, card, payload, {
      status: signal.aborted ? 'stopped' : 'failed',
      error: signal.aborted ? undefined : message,
      phase: undefined,
      note: undefined,
    })
  }
}
