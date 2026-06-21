/* ============================================================
   Workspace · Tasks panel (live + services + history + clear).
   Live = the active conversation's current TodoWrite list (pushed mid-turn via conv:todos; transcript-
   derived fallback restores it on reopen). Once every item is completed the Live section collapses to an
   empty state — the finished checklist lives only in History.
   Services = the conversation's live background services started via start_service (pushed via conv:services;
   only active starting/ready ones — exited services move to History). Single chat lists them flat; a group
   chat groups them by the expert that started them. Each card can expand its logs inline and be stopped.
   History = completed-phase snapshots + panel_examine verdicts + exited services, read from SQLite (never
   re-derived from the transcript) and refreshed on tasks:historyChanged. Clear hides history.
   ============================================================ */
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { useChat } from '@/stores/chat'
import { PanelCard } from '@/components/panel-card'
import { useT } from '@/stores/locale'
import { useConvTodos } from '@/stores/conv-todos'
import { useConvServices } from '@/stores/conv-services'
import { useAllExperts } from '@/lib/all-experts'
import type { ToolCall } from '@/stores/chat'
import type { WorkspaceTaskHistory, WorkspacePhase, WorkspaceExamine, WorkspaceService, ServiceInfo } from '@/lib/api'

const TASK: Record<string, { cls: string; labelKey: string }> = {
  pending: { cls: 'todo', labelKey: 'tasks.statusTodo' },
  in_progress: { cls: 'doing', labelKey: 'tasks.statusDoing' },
  completed: { cls: 'done', labelKey: 'tasks.statusDone' }
}
interface WsTask {
  content: string
  status: string
}
const EMPTY: WorkspaceTaskHistory = { phases: [], examines: [], services: [] }

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

// Static run duration (start → end) for an EXITED service. Never used for a live service — a ticking
// duration would need a timer, and we avoid blind interval polling; live cards show PID + status instead.
function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

// Rebuild a PanelExamine ToolCall from a PERSISTED examine row so the SAME rich PanelCard renders a completed
// review after reload — the live card is a session-only sub-tool stream, this is its durable form. The verdict is
// mapped back to what PanelCard.subjectState reads: pass / false-positive ride input.verdict; a FAIL rides
// status:'error' (subjectState falls to status when input.verdict isn't one of its enum values). refuteTally
// drives the nested skeptic line. Synthetic, stable ids ('hist-pe-…') so React keys don't collide with live tools.
function examineToPanelTool(ex: WorkspaceExamine): ToolCall {
  const findings = ex.findings ?? []
  // ONE row per persisted finding (per-candidate, workflow-faithful). Multiple candidates share a lens (axis),
  // so the roster key must be UNIQUE per row (`${axis}#${i}`) or PanelCard's subjectsByKey would collapse them
  // into one; the row itself shows the candidate's title + severity + lens. (No findings → an empty card.)
  const rowKey = (f: WorkspaceExamine['findings'][number], i: number): string => `${f.axis}#${i}`
  return {
    id: 'hist-pe-' + ex.id,
    name: 'PanelExamine',
    status: 'done',
    input: { mode: ex.mode ?? 'review', subjects: findings.map((f, i) => rowKey(f, i)), findingsCard: true },
    subTools: findings.map((f, i) => ({
      id: `hist-pe-${ex.id}-${i}`,
      name: 'Subject',
      status: f.verdict === 'fail' ? 'error' : 'done',
      input: { subject: rowKey(f, i), lens: f.axis, title: f.title, severity: f.severity, file: f.file, verdict: f.verdict, refuted: f.refuted, refuteTally: f.refuteTally, why: f.why },
      result: f.feedback
    }))
  }
}

// One owner's panel_examine cards (shared by the live "Panel reviews" section and the History section). Owner
// header shown whenever a real expert owns it — even a single owner in a collab — so attribution is never lost
// ("不要串"); solo (no expertId) renders headerless.
function PanelGroup({ owner, panelTools, expertsById }: { owner: string; panelTools: ToolCall[]; expertsById: ReturnType<typeof useAllExperts>['byId'] }): ReactElement {
  return (
    <div className="ws-panel-group">
      {owner ? (
        <div className="ws-svc-owner">
          <span className="ws-svc-owner-dot" style={{ background: expertsById[owner]?.color ?? 'var(--text-3)' }} />
          <span className="ws-svc-owner-name">{expertsById[owner]?.name ?? owner}</span>
        </div>
      ) : null}
      {panelTools.map((tl) => (
        <PanelCard key={tl.id} tool={tl} />
      ))}
    </div>
  )
}

export function WorkspaceTasks({ activeConv, onHasHistory }: { activeConv: string | null; onHasHistory?: (has: boolean) => void }): ReactElement {
  const t = useT()
  // — Live tasks — read from the app-lifetime conv:todos subscription (stores/conv-todos), which keeps
  // caching every conversation's latest TodoWrite list even while this panel is closed. That's the fix
  // for "open the panel mid-run and it's empty / stale": a component-mounted onConvTodos subscription only
  // started listening once the panel was expanded, so every push before that was lost and the transcript
  // fallback couldn't recover in-flight state (the transcript hasn't settled mid-turn). Reading the cache
  // shows current items (completed / in-progress / pending) immediately. Only a conversation with no live
  // push this session (e.g. reopening an old chat) falls back to the transcript-derived list below.
  const liveByRole = useConvTodos((s) => (activeConv ? s.byConv[activeConv] : undefined))
  const flatLive = liveByRole ? Object.values(liveByRole).flat() : undefined
  const [fallbackTasks, setFallbackTasks] = useState<WsTask[]>([])
  // Reset the transcript fallback SYNCHRONOUSLY when the conversation switches, so a frame of the previous
  // conv's list never paints (the post-paint effect below would clear it one frame late — cross-conv dirty
  // frame). The guarded set-during-render is the React-sanctioned "adjust state on prop change" pattern.
  const prevConvRef = useRef(activeConv)
  if (prevConvRef.current !== activeConv) {
    prevConvRef.current = activeConv
    if (fallbackTasks.length) setFallbackTasks([])
  }
  const [history, setHistory] = useState<WorkspaceTaskHistory>(EMPTY)
  const msgCount = useChat((s) => (activeConv ? (s.byConversation[activeConv]?.length ?? 0) : 0))
  const streaming = useChat((s) => (activeConv ? !!s.streaming[activeConv] : false))
  const tasks: WsTask[] = flatLive ?? fallbackTasks
  // A completed list leaves Live ONLY once its phase has been archived to History — so the Live→History handoff is
  // ATOMIC (it leaves Live in the SAME render that History gains it). Without this, the 1.5s real-time-archive
  // debounce left a window where a finished list was in NEITHER section and the panel flashed ("消失闪一下"). Match
  // a live list to its archived phase by owner + item contents.
  const inHistory = (roleId: string, ts: WsTask[]): boolean =>
    history.phases.some((p) => (p.owner ?? '') === (roleId ?? '') && p.items.length === ts.length && p.items.every((it, i) => it.content === ts[i].content))
  // Collapse the Live section only when there is nothing active to show: every (non-empty) list is complete AND
  // already archived. A just-completed list keeps showing until its phase lands in History (no flash); a mixed
  // list (a pending / in-progress item remains) always renders in full. Fallback (transcript-derived solo list,
  // no role) collapses on plain all-complete.
  const allDone = tasks.length > 0 && (liveByRole
    ? Object.entries(liveByRole).filter(([, ts]) => ts.length > 0).every(([roleId, ts]) => ts.every((tk) => tk.status === 'completed') && inHistory(roleId, ts))
    : tasks.every((tk) => tk.status === 'completed'))

  // — Live background services — same app-lifetime cache pattern as todos (stores/conv-services), so the
  // panel shows the current set the moment it opens. Only active (starting/ready) services are here.
  const liveServices = useConvServices((s) => (activeConv ? s.byConv[activeConv] : undefined)) ?? []
  // Group chats (conversation.kind === 'multi') group services by the expert that started them; single
  // chats list them flat. Owner → display name/color comes from the merged experts map.
  const isGroup = useChat((s) => s.conversations.find((c) => c.id === activeConv)?.kind === 'multi')
  const { byId: expertsById } = useAllExperts()
  const groups = groupByOwner(liveServices)
  // Collab: per-role todo groups for the ACTIVE roles. A role whose list is all-complete has moved to History
  // (real-time archival), so it's filtered out of Live. isCollab = more than one role ever wrote todos here.
  const isCollab = liveByRole ? Object.keys(liveByRole).length > 1 : false
  const todoGroups: [string, WsTask[]][] = liveByRole
    ? Object.entries(liveByRole).filter(([roleId, ts]) => ts.length > 0 && (!ts.every((tk) => tk.status === 'completed') || !inHistory(roleId, ts)))
    : []

  // — Panel reviews (panel_examine) — moved OUT of the chat segment (its tall body overflowed the folded 160px
  // window and swallowed the expert's history) into here, grouped by the expert that OWNS it — like the per-role
  // todos, never mixed across experts ("不要串"). TWO sources, handed off at completion exactly like todos
  // (live → history):
  //   • RUNNING: the live sub-tool stream from the chat store (real-time subjects/verdicts). Keyed on a STABLE
  //     SIGNATURE (panel id + per-subtool status) so the Tasks panel re-renders only when a panel actually
  //     appears / advances / finishes, NOT on every text token of the turn (perf).
  //   • DONE: rebuilt from the PERSISTED history examine rows (examineToPanelTool) so the rich card SURVIVES
  //     RELOAD — its durable home. A completed panel leaves RUNNING and reappears from history → no double-show.
  const panelSig = useChat((s) => {
    const ms = activeConv ? s.byConversation[activeConv] : undefined
    let sig = ''
    for (const m of ms ?? []) {
      if (m.role !== 'assistant' || !m.tools) continue
      for (const tl of m.tools) {
        if (tl.name === 'PanelExamine') sig += `${m.expertId ?? ''}~${tl.id}~${tl.status}~${(tl.subTools ?? []).map((st) => st.status).join('')};`
      }
    }
    return sig
  })
  // panel_examine behaves EXACTLY like todos: a RUNNING review shows in the live "Panel reviews" section; once it
  // COMPLETES it moves to History. Both per-owner ("不要串").
  //   • RUNNING (live "Panel reviews"): chat-store PanelExamine tools with status:'running'.
  //   • DONE (History): in-session, the chat-store tool flips to status:'done' → it moves from one Map to the other
  //     in the SAME re-render (atomic, no flicker — no IPC round-trip). On RELOAD the chat store has no synthetic
  //     PanelExamine, so done panels are rebuilt from the PERSISTED examines instead (live XOR reloaded → never
  //     shown twice).
  const { runningPanels, donePanels } = useMemo<{ runningPanels: [string, ToolCall[]][]; donePanels: [string, ToolCall[]][] }>(() => {
    const running = new Map<string, ToolCall[]>()
    const done = new Map<string, ToolCall[]>()
    const push = (map: Map<string, ToolCall[]>, owner: string, tl: ToolCall): void => {
      const arr = map.get(owner)
      if (arr) arr.push(tl)
      else map.set(owner, [tl])
    }
    const ms = activeConv ? useChat.getState().byConversation[activeConv] : undefined
    let live = 0
    for (const m of ms ?? []) {
      if (m.role !== 'assistant' || !m.tools) continue
      for (const tl of m.tools) {
        if (tl.name !== 'PanelExamine') continue
        live++
        push(tl.status === 'running' ? running : done, m.expertId ?? '', tl)
      }
    }
    if (live === 0) {
      for (const ex of [...history.examines].sort((a, b) => (b.examinedAt || b.createdAt) - (a.examinedAt || a.createdAt))) {
        push(done, ex.owner ?? '', examineToPanelTool(ex))
      }
    }
    return { runningPanels: [...running], donePanels: [...done] }
  }, [panelSig, activeConv, history.examines])

  // Transcript-derived fallback — only when this session has no live push for the conv (liveTodos
  // undefined). Keyed on msgCount / streaming edges so reopening an old chat restores its last list. Once
  // a live push exists the effect clears the fallback and the cached live list wins.
  useEffect(() => {
    if (!activeConv || liveByRole) {
      setFallbackTasks([])
      return
    }
    let cancelled = false
    void (async () => {
      const transcript = await window.api.agent.transcript(activeConv)
      if (cancelled) return
      let latestTodos: WsTask[] | null = null
      for (const run of Object.values(transcript)) {
        for (const tool of run.tools) {
          if (tool.name === 'TodoWrite') {
            const todos = (tool.input as { todos?: WsTask[] } | null)?.todos
            if (Array.isArray(todos)) latestTodos = todos
          }
        }
      }
      if (!cancelled) setFallbackTasks(latestTodos ?? [])
    })()
    return () => {
      cancelled = true
    }
  }, [activeConv, msgCount, streaming, liveByRole])

  // — History (SQLite; refreshed when a phase/examine/service is archived) —
  const loadHistory = useRef<(() => void) | null>(null)
  useEffect(() => {
    if (!activeConv) {
      setHistory(EMPTY)
      return
    }
    let cancelled = false
    const load = (): void => {
      void window.api.tasks.history(activeConv).then((h) => {
        if (!cancelled) setHistory(h)
      })
    }
    loadHistory.current = load
    load()
    const off = window.api.onTasksHistoryChanged((d) => {
      if (d.convId === activeConv) load()
    })
    return () => {
      cancelled = true
      off()
    }
  }, [activeConv])

  const clearHistory = (): void => {
    if (!activeConv) return
    void window.api.tasks.clearHistory(activeConv).then(() => setHistory(EMPTY))
  }

  // Report History presence up to the drawer so it can relax the narrow fixed window when there's nothing
  // archived yet (current-todos-only view → show them in full, not cramped). Phases / examines / exited services.
  const hasHistory = history.phases.length > 0 || history.examines.length > 0 || history.services.length > 0
  useEffect(() => onHasHistory?.(hasHistory), [hasHistory, onHasHistory])

  // Merge phases + exited services into one newest-first timeline. panel_examine reviews are NOT here — they
  // render as their own rich PanelCard in the "Panel reviews" section above (rebuilt from these same persisted
  // examine rows), so a completed review shows ONCE (not also as a summary card here).
  const timeline: (
    | { kind: 'phase'; row: WorkspacePhase }
    | { kind: 'service'; row: WorkspaceService }
  )[] = [
    ...history.phases.map((p) => ({ kind: 'phase' as const, row: p })),
    ...history.services.map((s) => ({ kind: 'service' as const, row: s }))
  ].sort((a, b) => b.row.createdAt - a.row.createdAt)

  return (
    <div className="ws-panel">
      <div className="ws-panel-body">
        <div className="ws-sub-head">{t('tasks.live')}</div>
        {tasks.length === 0 ? (
          <div className="ws-empty">{t('tasks.empty')}</div>
        ) : allDone ? (
          <div className="ws-empty">{t('tasks.noActive')}</div>
        ) : isCollab && todoGroups.length > 0 ? (
          // Collab (more than one role wrote todos) → group the ACTIVE roles by owner so concurrent lists are
          // attributed to whoever wrote them instead of merged into one anonymous pile (a completed role has
          // moved to History and is filtered out). Keyed on role-COUNT, NOT conversation.kind: a coordinator
          // collab runs in a kind:'single' conv (isGroup=false), so the kind check missed it (verified by e2e).
          <div className="ws-tasks">
            {todoGroups.map(([owner, ts]) => (
              <div className="ws-todo-group" key={owner || 'unknown'}>
                <div className="ws-svc-owner">
                  <span className="ws-svc-owner-dot" style={{ background: expertsById[owner]?.color ?? 'var(--text-3)' }} />
                  <span className="ws-svc-owner-name">{expertsById[owner]?.name ?? owner ?? t('tasks.svcUnknownOwner')}</span>
                </div>
                {ts.map((tk, i) => (
                  <TaskRow key={i} tk={tk} t={t} />
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="ws-tasks">
            {tasks.map((tk, i) => (
              <TaskRow key={i} tk={tk} t={t} />
            ))}
          </div>
        )}

        {runningPanels.length > 0 && (
          <div className="ws-panels">
            <div className="ws-sub-head">{t('tasks.panels')}</div>
            {runningPanels.map(([owner, panelTools]) => (
              <PanelGroup key={'rp' + (owner || 'solo')} owner={owner} panelTools={panelTools} expertsById={expertsById} />
            ))}
          </div>
        )}

        {liveServices.length > 0 && activeConv && (
          <div className="ws-services">
            <div className="ws-sub-head">{t('tasks.services')}</div>
            {isGroup
              ? groups.map(([owner, svcs]) => (
                  <div className="ws-svc-group" key={owner || 'unknown'}>
                    <div className="ws-svc-owner">
                      <span className="ws-svc-owner-dot" style={{ background: expertsById[owner]?.color ?? 'var(--text-3)' }} />
                      <span className="ws-svc-owner-name">{expertsById[owner]?.name ?? owner ?? t('tasks.svcUnknownOwner')}</span>
                    </div>
                    {svcs.map((s) => (
                      <ServiceCard key={s.id} svc={s} convId={activeConv} t={t} />
                    ))}
                  </div>
                ))
              : liveServices.map((s) => <ServiceCard key={s.id} svc={s} convId={activeConv} t={t} />)}
          </div>
        )}

        {(timeline.length > 0 || donePanels.length > 0) && (
          <div className="ws-history">
            <div className="ws-sub-head ws-history-head">
              <span>{t('tasks.history')}</span>
              <button className="ws-clear" onClick={clearHistory} title={t('tasks.clear')}>
                <Icons.refresh size={12} /> {t('tasks.clear')}
              </button>
            </div>
            {/* Completed panel_examine reviews — the rich card moved here from the live "Panel reviews" section the
                moment it finished (like a todo phase), still grouped by owner. */}
            {donePanels.map(([owner, panelTools]) => (
              <PanelGroup key={'dp' + (owner || 'solo')} owner={owner} panelTools={panelTools} expertsById={expertsById} />
            ))}
            {timeline.map((it) =>
              it.kind === 'phase' ? (
                <PhaseCard key={'p' + it.row.id} phase={it.row} t={t} />
              ) : (
                <ServiceHistCard key={'s' + it.row.id} svc={it.row} t={t} />
              )
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// Group services by owner roleId, preserving first-seen order of both owners and services within an owner.
function groupByOwner(services: ServiceInfo[]): [string, ServiceInfo[]][] {
  const map = new Map<string, ServiceInfo[]>()
  for (const s of services) {
    const key = s.owner ?? ''
    const arr = map.get(key)
    if (arr) arr.push(s)
    else map.set(key, [s])
  }
  return [...map]
}

// One todo row (content + status pill). Shared by the flat (solo) and per-role grouped (collab) renders.
function TaskRow({ tk, t }: { tk: WsTask; t: ReturnType<typeof useT> }): ReactElement {
  const meta = TASK[tk.status] ?? TASK.pending
  return (
    <div className="ws-task">
      <span className={'ws-task-label' + (meta.cls === 'done' ? ' done' : '')}>{tk.content}</span>
      <span className={'task-status ' + meta.cls}>{t(meta.labelKey)}</span>
    </div>
  )
}

// A live (active) background service. Logs expand inline into a fixed-height, scrollable pane that scrolls
// to the bottom; Stop tree-kills it. starting → amber "doing", ready → green "done".
function ServiceCard({ svc, convId, t }: { svc: ServiceInfo; convId: string; t: ReturnType<typeof useT> }): ReactElement {
  const [logs, setLogs] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)
  const starting = svc.status === 'starting'
  const cls = starting ? 'doing' : 'done'

  // Keep the log pane pinned to the bottom (latest output) whenever it opens or its content changes.
  useEffect(() => {
    if (open && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [open, logs])

  const toggleLogs = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    void window.api.services.logs(convId, svc.id).then((l) => {
      setLogs(l ?? '')
      setOpen(true)
    })
  }
  const stop = (): void => {
    void window.api.services.stop(convId, svc.id)
  }

  return (
    <div className="ws-svc">
      <div className="ws-svc-head">
        <span className={'ws-svc-dot ' + cls} />
        <span className="ws-svc-name">{svc.name}</span>
        <span className="ws-svc-badges">
          <span className={'task-status ' + cls}>{starting ? t('tasks.svcStarting') : t('tasks.svcRunning')}</span>
          {svc.port != null && (
            <a className="ws-svc-port" href={`http://localhost:${svc.port}`} target="_blank" rel="noreferrer" title={`http://localhost:${svc.port}`}>
              :{svc.port}
              <Icons.externalLink size={11} />
            </a>
          )}
        </span>
      </div>
      <div className="ws-svc-cmd" title={svc.command}>
        {svc.command}
        {starting && svc.port == null ? ` · ${t('tasks.svcWaitingPort')}` : ''}
      </div>
      <div className="ws-svc-foot">
        <span className="ws-svc-meta">PID {svc.pid}</span>
        <span className="ws-svc-actions">
          <button className="ws-svc-btn" onClick={toggleLogs}>
            <Icons.file size={12} /> {t('tasks.svcLogs')}
          </button>
          <button className="ws-svc-btn ws-svc-stop" onClick={stop}>
            <Icons.x size={12} /> {t('tasks.svcStop')}
          </button>
        </span>
      </div>
      {open && (
        <pre className="ws-svc-logs" ref={logRef}>
          {logs && logs.length ? logs : t('tasks.svcNoLogs')}
        </pre>
      )}
    </div>
  )
}

// An exited service in History — command + exit code (red when non-zero) + run duration.
function ServiceHistCard({ svc, t }: { svc: WorkspaceService; t: ReturnType<typeof useT> }): ReactElement {
  const ok = svc.exitCode === 0 || svc.exitCode == null
  return (
    <div className="ws-hist-card">
      <div className="ws-hist-head">
        <Icons.box size={13} />
        <span className="ws-hist-title">{svc.name}</span>
        <span className={'task-status ' + (ok ? 'todo' : 'fail')}>
          {t('tasks.svcExited')} · {svc.exitCode ?? '—'}
        </span>
        <span className="ws-hist-time">{fmtDur(svc.exitedAt - svc.startedAt)}</span>
      </div>
      <div className="ws-svc-cmd ws-hist-cmd" title={svc.command}>{svc.command}</div>
    </div>
  )
}

function PhaseCard({ phase, t }: { phase: WorkspacePhase; t: ReturnType<typeof useT> }): ReactElement {
  const done = phase.items.filter((i) => i.status === 'completed').length
  return (
    <div className="ws-hist-card">
      <div className="ws-hist-head">
        <Icons.listChecks size={13} />
        <span className="ws-hist-title">{t('tasks.phaseSummary', { done, total: phase.items.length })}</span>
        <span className="ws-hist-time">{fmtTime(phase.completedAt || phase.createdAt)}</span>
      </div>
      <div className="ws-hist-items">
        {phase.items.map((i, idx) => (
          <div className="ws-hist-item" key={idx}>
            <span className={'ws-hist-dot ' + (i.status === 'completed' ? 'done' : i.status === 'in_progress' ? 'doing' : 'todo')} />
            <span className={i.status === 'completed' ? 'ws-hist-strike' : ''}>{i.content}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

