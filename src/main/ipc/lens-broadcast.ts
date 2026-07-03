// lens-broadcast.ts — conv-level broadcast of studio_lens panel progress (solo lens display fix).
//
// WHY a dedicated conv channel instead of the caller's turn stream: a SOLO lens runs ASYNC — the studio_lens
// tool launches the panel in the background, then the caller await_asyncs and PARKS the turn. Parking ends the
// turn, so its agent stream FINISHES (agent:done → the stream registry's guarded send becomes a no-op) and the
// renderer drops that streamId's meta. Any lens sub_tool event routed through that finished turn stream is then
// silently lost — the Tasks-panel LensCard freezes at "creating · 0 agents", even though the reviewers ran and
// the verdict reached the agent via the (separate, still-live) session-bus resume. This channel rides the SAME
// all-windows, convId-keyed broadcast as conv:services / conv:todos — which likewise fire OUTSIDE any single
// turn stream — so reviewers + verdict reach the panel live regardless of the caller's turn lifecycle.
//
// SOLO ONLY. Collab lens builds its handle in agent-collab.ts with onStream = onExpertStream (the persistent,
// roleId-tagged coordinator stream that a park never finishes) and never routes here — its display path is
// untouched. roleId = the calling run's roleId (agent-dispatch passes loop.roleId): the renderer anchors the
// lens card to that role's segment with the SAME roleId anchoring every other stream event uses.
import { BrowserWindow } from 'electron'
import type { AgentLlmEvent } from '../agent/llm/anthropic'
import type { ConvLens } from './contracts'

export function broadcastConvLens(convId: string, roleId: string, event: AgentLlmEvent): void {
  const ev: ConvLens = { convId, roleId, event }
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('conv:lens', ev)
}
