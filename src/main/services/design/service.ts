// Studio design — the RUN LIFECYCLE behind the `/design <problem>` command. Sibling of research/service.ts: the
// direct-script path (handler → runScript), NOT the workflow system. One durable artifact — a 'design-launch'
// CARD row — carries the whole run: appended in a 'running' state, updated IN PLACE (updateMessageContent) as
// phases/logs arrive and once the scored synthesis lands, and re-broadcast each time over the shared conv:card
// channel. The renderer card is a PURE function of that content, so live progress and a reload both render from
// the one persisted payload.
//
// Sub-agents run QUIET in the ORIGIN conversation under a picked agent expert (dispatch-ready + agent-loop
// capable); usage is attributed there, no loose bubbles persist. Design uses a read-only kit (no web), so — unlike
// research — it has no endpoint-protocol preference: any dispatch-ready agent role works.
//
// NB (§9 / rule of three): this duplicates research/service.ts's lifecycle deliberately — with design as the
// SECOND example the real variation points (kit, role pick, card kind, result shape) are now clear; the shared
// `script-command` service is the P4 migration prerequisite, extracted once a third consumer confirms the shape.

import { ulid } from '../../db/id'
import * as convService from '../conversation.service'
import * as convRepo from '../../repos/conversation.repo'
import * as rolesService from '../roles.service'
import { broadcastConvCard } from '../../ipc/usage-broadcast'
import { registerLiveRun } from '../../agent/live-runs'
import { runDesignScript } from './agent-design'
import { formatDesign } from './report'
import type { RunStepOptions } from '../coordinator/step'
import type { CoordinatorCallbacks } from '../coordinator/types'
import type { MessageDto } from '../../ipc/contracts'

export type DesignStatus = 'running' | 'done' | 'failed' | 'stopped'

// The design card payload (segmentKind='design-launch', content = this JSON). `v` versions the shape; the
// renderer tolerates a missing field. `report` (markdown) lands on 'done'; `error` on 'failed'.
export interface DesignCardPayload {
  v: 1
  runId: string
  problem: string
  status: DesignStatus
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

export function abortAllDesignRuns(): void {
  for (const r of live.values()) r.controller.abort()
}

// Boot reconciliation (mirrors research / assignment / workflow): nothing is live at startup, so any
// design-launch card still 'running' is a crash/quit orphan — settle it to 'stopped' (honest, never a fake
// 'done') so the card doesn't render a perpetual spinner + dead Stop button. DB-only; returns the count swept.
export function sweepInterruptedRuns(): number {
  let n = 0
  for (const row of convRepo.listBySegmentKind('design-launch')) {
    let payload: DesignCardPayload
    try {
      payload = JSON.parse(row.content) as DesignCardPayload
    } catch {
      continue
    }
    if (payload.status !== 'running') continue
    const settled: DesignCardPayload = { ...payload, status: 'stopped', phase: undefined, note: undefined }
    if (convRepo.updateMessageContent(row.id, JSON.stringify(settled))) n++
  }
  return n
}

// Pick the expert the judge/attempt sub-agents run under: dispatch-ready (bound + endpoint enabled) AND
// agent-loop capable (it may call read tools). No protocol preference (design's kit is read-only, no WebFetch).
function pickDesignRole(): string | null {
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

function patchCard(convId: string, card: MessageDto, payload: DesignCardPayload, next: Partial<DesignCardPayload>): DesignCardPayload {
  const merged = { ...payload, ...next }
  const content = JSON.stringify(merged)
  if (convRepo.updateMessageContent(card.id, content)) {
    broadcastConvCard(convId, { ...card, content })
  }
  return merged
}

export interface RunDesignInput {
  convId: string
  problem: string
}

export function run(input: RunDesignInput): { ok: true; runId: string } | { ok: false; error: string } {
  const problem = input.problem.trim()
  if (!problem) return { ok: false, error: 'A design problem is required — e.g. /design how should we cache the roster lookups?' }
  if (!convService.get(input.convId)) return { ok: false, error: 'conversation not found' }
  const roleId = pickDesignRole()
  if (!roleId) return { ok: false, error: 'No design-capable expert is configured. Bind an agent expert to an enabled endpoint and retry.' }

  const runId = ulid()
  const initial: DesignCardPayload = { v: 1, runId, problem, status: 'running', roleId, phase: 'Attempt' }
  const card = convService.append(input.convId, { author: 'expert', expertId: roleId, content: JSON.stringify(initial), segmentKind: 'design-launch' })
  broadcastConvCard(input.convId, card)

  const controller = new AbortController()
  // Register in the shared live-runs registry so deleting the origin conversation / 停删-ing its project aborts
  // this run instead of leaving it burning tokens (design streams into the user's real conversation).
  const unregister = registerLiveRun(input.convId, () => controller.abort())
  live.set(runId, { controller, convId: input.convId, cardId: card.id })
  void executeDesign({ convId: input.convId, card, problem, roleId, controller, payload: initial }).finally(() => {
    live.delete(runId)
    unregister()
  })
  return { ok: true, runId }
}

async function executeDesign(ctx: {
  convId: string
  card: MessageDto
  problem: string
  roleId: string
  controller: AbortController
  payload: DesignCardPayload
}): Promise<void> {
  const { convId, card, problem, roleId, controller } = ctx
  const signal = controller.signal
  let payload = ctx.payload

  const opts: RunStepOptions = {
    convId,
    roleId,
    prompt: '',
    dispatch: null,
    cb: noopCallbacks(),
    signal,
    cwd: convService.get(convId)?.cwd ?? '',
    permissionMode: 'default',
    includeHistory: false,
  }

  try {
    const result = await runDesignScript({
      opts,
      roleId,
      problem,
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
    patchCard(convId, card, payload, { status: 'done', report: formatDesign(result.value), phase: undefined, note: undefined })
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
