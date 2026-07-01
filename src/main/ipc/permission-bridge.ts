// Shared pending-approval bookkeeping for the streaming handlers (agent + coordinator): the pending Map, the
// per-stream id set, the delete-guarded settle (a renderer response and an abort can race without double-
// resolving), the abort→deny wiring, and the terminal sweep. This was duplicated near-verbatim in both handlers
// (the CB-4 unification audit). ONE copy here; both handlers construct their own instance.
//
// The EVENT emission (channel name, roleId on the request, the cancel event) stays the CALLER's — that part
// genuinely differs per handler (agent:* vs coordinator:*, coordinator carries roleId) — so request() takes
// emit/emitCancel callbacks. AskUserQuestion (askUser) machinery stays in agent.handler: it is solo-only
// (collab has no askUser), so folding it here would add a dead branch to the coordinator side.

import { ulid } from '../db/id'
import type { PermissionDecision } from '../agent/context'

export class PermissionBridge {
  private pending = new Map<string, (d: PermissionDecision) => void>()
  private byStream = new Map<string, Set<string>>()

  // Begin tracking a run's approvals — call when the stream opens.
  open(streamId: string): void {
    this.byStream.set(streamId, new Set())
  }

  // Register one approval request. `emit(id)` sends the ask to the renderer (channel/shape is the caller's);
  // `emitCancel(id)` drops the now-moot dialog when the run aborts before an answer. Any aborted signal denies.
  // The returned Promise resolves EXACTLY once (delete-guarded), whether by the renderer's answer or an abort.
  request(
    streamId: string,
    signals: Array<AbortSignal | undefined>,
    emit: (permissionId: string) => void,
    emitCancel: (permissionId: string) => void,
  ): Promise<PermissionDecision> {
    return new Promise<PermissionDecision>((resolve) => {
      const permissionId = ulid()
      const settle = (d: PermissionDecision, fromAbort = false): void => {
        this.byStream.get(streamId)?.delete(permissionId)
        if (this.pending.delete(permissionId)) {
          if (fromAbort) emitCancel(permissionId)
          resolve(d)
        }
      }
      this.pending.set(permissionId, (d) => settle(d))
      this.byStream.get(streamId)?.add(permissionId)
      const onAbort = (): void => settle({ allow: false }, true)
      for (const s of signals) s?.addEventListener('abort', onAbort, { once: true })
      emit(permissionId)
    })
  }

  // The renderer answered — resolve the matching pending request (a no-op if already settled or swept).
  respond(permissionId: string, decision: PermissionDecision): void {
    this.pending.get(permissionId)?.(decision)
  }

  // Deny + clear every still-pending approval for a run — call on any terminal event so a prompt the renderer
  // never answered can't linger in the maps forever.
  sweep(streamId: string): void {
    const ids = this.byStream.get(streamId)
    if (ids) {
      for (const id of ids) this.pending.get(id)?.({ allow: false })
      this.byStream.delete(streamId)
    }
  }
}
