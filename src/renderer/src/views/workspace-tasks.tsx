/* ============================================================
   Workspace · Tasks panel (live + history + clear).
   Live = the active conversation's current TodoWrite list (pushed mid-turn via conv:todos; transcript-
   derived fallback restores it on reopen). History = completed-phase snapshots + panel_examine verdicts,
   read from SQLite (never re-derived from the transcript) and refreshed on tasks:historyChanged. Clear
   hides history but keeps the live list.
   ============================================================ */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { useChat } from '@/stores/chat'
import { useT } from '@/stores/locale'
import { useConvTodos } from '@/stores/conv-todos'
import type { WorkspaceTaskHistory, WorkspacePhase, WorkspaceExamine } from '@/lib/api'

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
const EMPTY: WorkspaceTaskHistory = { phases: [], examines: [] }

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
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

  // — History (SQLite; refreshed when a phase/examine is archived) —
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

  // Merge phases + examines into one newest-first timeline.
  const timeline: ({ kind: 'phase'; row: WorkspacePhase } | { kind: 'examine'; row: WorkspaceExamine })[] = [
    ...history.phases.map((p) => ({ kind: 'phase' as const, row: p })),
    ...history.examines.map((e) => ({ kind: 'examine' as const, row: e }))
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
              ) : (
                <ExamineCard key={'e' + it.row.id} examine={it.row} t={t} />
              )
            )}
          </div>
        )}
      </div>
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
