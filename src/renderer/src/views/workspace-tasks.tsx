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
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { useChat } from '@/stores/chat'
import { useT } from '@/stores/locale'
import { useConvTodos } from '@/stores/conv-todos'
import { useConvServices } from '@/stores/conv-services'
import { useAllExperts } from '@/lib/all-experts'
import type { WorkspaceTaskHistory, WorkspacePhase, WorkspaceExamine, WorkspaceService, ServiceInfo } from '@/lib/api'

const TASK: Record<string, { cls: string; labelKey: string }> = {
  pending: { cls: 'todo', labelKey: 'tasks.statusTodo' },
  in_progress: { cls: 'doing', labelKey: 'tasks.statusDoing' },
  completed: { cls: 'done', labelKey: 'tasks.statusDone' }
}
const VERDICT: Record<string, string> = { pass: 'pass', fail: 'fail', 'false-positive': 'fp' }
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

export function WorkspaceTasks({ activeConv }: { activeConv: string | null }): ReactElement {
  const t = useT()
  // — Live tasks — read from the app-lifetime conv:todos subscription (stores/conv-todos), which keeps
  // caching every conversation's latest TodoWrite list even while this panel is closed. That's the fix
  // for "open the panel mid-run and it's empty / stale": a component-mounted onConvTodos subscription only
  // started listening once the panel was expanded, so every push before that was lost and the transcript
  // fallback couldn't recover in-flight state (the transcript hasn't settled mid-turn). Reading the cache
  // shows current items (completed / in-progress / pending) immediately. Only a conversation with no live
  // push this session (e.g. reopening an old chat) falls back to the transcript-derived list below.
  const liveTodos = useConvTodos((s) => (activeConv ? s.byConv[activeConv] : undefined))
  const [fallbackTasks, setFallbackTasks] = useState<WsTask[]>([])
  const [history, setHistory] = useState<WorkspaceTaskHistory>(EMPTY)
  const msgCount = useChat((s) => (activeConv ? (s.byConversation[activeConv]?.length ?? 0) : 0))
  const streaming = useChat((s) => (activeConv ? !!s.streaming[activeConv] : false))
  const tasks: WsTask[] = liveTodos ?? fallbackTasks
  // Once every item is completed the run is finished and the same list is archived into History below, so
  // collapse the Live section to an empty state rather than duplicating the finished checklist against the
  // History card. Any mixed list (a pending / in-progress item remains) still renders in full.
  const allDone = tasks.length > 0 && tasks.every((tk) => tk.status === 'completed')

  // — Live background services — same app-lifetime cache pattern as todos (stores/conv-services), so the
  // panel shows the current set the moment it opens. Only active (starting/ready) services are here.
  const liveServices = useConvServices((s) => (activeConv ? s.byConv[activeConv] : undefined)) ?? []
  // Group chats (conversation.kind === 'multi') group services by the expert that started them; single
  // chats list them flat. Owner → display name/color comes from the merged experts map.
  const isGroup = useChat((s) => s.conversations.find((c) => c.id === activeConv)?.kind === 'multi')
  const { byId: expertsById } = useAllExperts()
  const groups = groupByOwner(liveServices)

  // Transcript-derived fallback — only when this session has no live push for the conv (liveTodos
  // undefined). Keyed on msgCount / streaming edges so reopening an old chat restores its last list. Once
  // a live push exists the effect clears the fallback and the cached live list wins.
  useEffect(() => {
    if (!activeConv || liveTodos) {
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
  }, [activeConv, msgCount, streaming, liveTodos])

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

  // Merge phases + examines + exited services into one newest-first timeline.
  const timeline: (
    | { kind: 'phase'; row: WorkspacePhase }
    | { kind: 'examine'; row: WorkspaceExamine }
    | { kind: 'service'; row: WorkspaceService }
  )[] = [
    ...history.phases.map((p) => ({ kind: 'phase' as const, row: p })),
    ...history.examines.map((e) => ({ kind: 'examine' as const, row: e })),
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
        ) : (
          <div className="ws-tasks">
            {tasks.map((tk, i) => {
              const meta = TASK[tk.status] ?? TASK.pending
              return (
                <div className="ws-task" key={i}>
                  <span className={'ws-task-label' + (meta.cls === 'done' ? ' done' : '')}>{tk.content}</span>
                  <span className={'task-status ' + meta.cls}>{t(meta.labelKey)}</span>
                </div>
              )
            })}
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

        {timeline.length > 0 && (
          <div className="ws-history">
            <div className="ws-sub-head ws-history-head">
              <span>{t('tasks.history')}</span>
              <button className="ws-clear" onClick={clearHistory} title={t('tasks.clear')}>
                <Icons.refresh size={12} /> {t('tasks.clear')}
              </button>
            </div>
            {timeline.map((it) =>
              it.kind === 'phase' ? (
                <PhaseCard key={'p' + it.row.id} phase={it.row} t={t} />
              ) : it.kind === 'examine' ? (
                <ExamineCard key={'e' + it.row.id} examine={it.row} t={t} />
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

function ExamineCard({ examine, t }: { examine: WorkspaceExamine; t: ReturnType<typeof useT> }): ReactElement {
  return (
    <div className="ws-hist-card">
      <div className="ws-hist-head">
        <Icons.eye size={13} />
        <span className="ws-hist-title">{t('tasks.examineSummary')}</span>
        <span className="ws-hist-time">{fmtTime(examine.examinedAt || examine.createdAt)}</span>
      </div>
      {examine.subject && <div className="ws-hist-subject">{examine.subject}</div>}
      <div className="ws-hist-items">
        {examine.findings.map((f, idx) => (
          <div className="ws-hist-item" key={idx}>
            <span className={'ws-verdict ' + (VERDICT[f.verdict] ?? 'fp')}>{t('tasks.verdict.' + f.verdict)}</span>
            <span className="ws-hist-axis">{f.axis}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
