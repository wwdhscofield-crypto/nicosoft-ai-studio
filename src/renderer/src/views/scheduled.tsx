/* ============================================================
   NicoSoft AI Studio — Scheduled
   Timed tasks that fire an orchestrated step chain (doc 28).
   Backed by window.api.scheduled.* — the engine fires due tasks
   in the background. Email always routes through an email MCP /
   draft — Studio never sends mail itself.
   ============================================================ */
import { Fragment, useCallback, useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { STUDIO_DATA } from '@/data/studio-data'
import { Avatar } from '@/components/primitives'
import { Icons } from '@/components/icons'
import { Dropdown } from '@/views/profile'
import { MemToggle } from '@/views/memory'
import { toast } from '@/stores/toast'

// DTO from the preload bridge — same shape as the scheduler's model (ipc/contracts), no mapping layer.
type TaskDto = Awaited<ReturnType<typeof window.api.scheduled.list>>[number]
type StepDto = TaskDto['steps'][number]
type StepKind = StepDto['kind']
type TriggerType = 'once' | 'interval' | 'daily' | 'weekly' | 'cron'

const TRIGGER_TYPES: { v: TriggerType; l: string }[] = [
  { v: 'once', l: 'Once' },
  { v: 'interval', l: 'Interval' },
  { v: 'daily', l: 'Daily' },
  { v: 'weekly', l: 'Weekly' },
  { v: 'cron', l: 'Cron' },
]
const STEP_KINDS: { v: StepKind; l: string }[] = [
  { v: 'expert', l: 'Expert' },
  { v: 'tool', l: 'Tool / MCP' },
  { v: 'email', l: 'Send email' },
  { v: 'project', l: 'Project' },
]
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DOW_OPTS = DOW.map((l, i) => ({ v: String(i), l }))
const PROJECT_ACTIONS = [
  { v: 'create', l: 'Create' },
  { v: 'advance', l: 'Advance' },
]

const pad = (n: number): string => String(n).padStart(2, '0')

// ── schedule <-> trigger form mapping ────────────────────────────────────────────────────────────────
// The engine speaks one "schedule" string (interval | one-shot ISO | 5-field cron). The editor exposes the
// friendlier Once/Daily/Weekly/Cron; these two helpers convert between them. Daily/Weekly are just cron
// shapes, so editing one round-trips through cron parsing.
interface TriggerForm {
  type: TriggerType
  datetime: string // once: <input type=datetime-local> value (YYYY-MM-DDTHH:MM)
  interval: string // interval: "5m" / "2h" / "1d"
  time: string // daily/weekly: HH:MM
  dow: string // weekly: 0..6
  cron: string // cron: raw 5-field expr
}

function buildSchedule(f: TriggerForm): string {
  if (f.type === 'once') return f.datetime
  if (f.type === 'interval') return f.interval.trim()
  if (f.type === 'cron') return f.cron.trim()
  const [h, m] = (f.time || '09:00').split(':')
  const hh = parseInt(h, 10) || 0
  const mm = parseInt(m, 10) || 0
  if (f.type === 'daily') return `${mm} ${hh} * * *`
  return `${mm} ${hh} * * ${f.dow}` // weekly
}

function toLocalInput(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// An interval (5m/2h/1d) is stored as a cron shape (*/5 * * * *, 0 */2 * * *, 0 0 */1 * *) by the engine —
// reverse that to "5m"/"2h"/"1d" so editing round-trips. Returns null when the cron isn't an interval shape.
function cronToInterval(cron: string): string | null {
  const p = cron.split(/\s+/)
  if (p.length !== 5) return null
  const [m, h, dom, mon, dow] = p
  if (mon !== '*' || dow !== '*') return null
  let mm: RegExpMatchArray | null
  if (h === '*' && dom === '*' && (mm = m.match(/^\*\/(\d+)$/))) return `${mm[1]}m`
  if (m === '0' && dom === '*' && (mm = h.match(/^\*\/(\d+)$/))) return `${mm[1]}h`
  if (m === '0' && h === '0' && (mm = dom.match(/^\*\/(\d+)$/))) return `${mm[1]}d`
  return null
}

// Reverse a stored task back into the editor form. A null cron is a one-shot; an interval-shaped cron opens as
// Interval; a daily/weekly-shaped cron opens as Daily/Weekly; otherwise raw Cron.
function formFromTask(t: TaskDto | null): TriggerForm {
  const base: TriggerForm = { type: 'weekly', datetime: '', interval: '1d', time: '09:00', dow: '1', cron: '0 9 * * 1' }
  if (!t) return base
  if (!t.cron) return { ...base, type: 'once', datetime: toLocalInput(t.nextRunAt) }
  const iv = cronToInterval(t.cron)
  if (iv) return { ...base, type: 'interval', interval: iv, cron: t.cron }
  const p = t.cron.split(/\s+/)
  if (p.length === 5) {
    const [m, h, dom, mon, dowf] = p
    const time = `${pad(parseInt(h, 10) || 0)}:${pad(parseInt(m, 10) || 0)}`
    if (dom === '*' && mon === '*' && dowf === '*') return { ...base, type: 'daily', time, cron: t.cron }
    if (dom === '*' && mon === '*' && /^[0-6]$/.test(dowf)) return { ...base, type: 'weekly', time, dow: dowf, cron: t.cron }
  }
  return { ...base, type: 'cron', cron: t.cron }
}

function triggerLabel(t: TaskDto): string {
  if (!t.cron) return 'Once'
  const f = formFromTask(t)
  if (f.type === 'interval') return `Every ${f.interval}`
  if (f.type === 'daily') return `Daily ${f.time}`
  if (f.type === 'weekly') return `${DOW[parseInt(f.dow, 10)]} ${f.time}`
  return t.cron
}

function fmtTime(ms?: number): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

function stepLabel(s: StepDto): string {
  return s.kind === 'expert' ? (s.roleId ?? 'expert') : s.kind
}

function StepChip({ step }: { step: StepDto }): ReactElement {
  const { EXPERT_BY_ID } = STUDIO_DATA
  if (step.kind === 'expert') {
    const e = step.roleId ? EXPERT_BY_ID[step.roleId] : undefined
    return e ? (
      <span className="step-chip">
        <Avatar expert={e} size={18} /> {e.name}
      </span>
    ) : (
      <span className="step-chip">{step.roleId ?? 'expert'}</span>
    )
  }
  if (step.kind === 'email')
    return (
      <span className="step-chip">
        <Icons.mail size={13} /> Email MCP
      </span>
    )
  if (step.kind === 'project')
    return (
      <span className="step-chip">
        <Icons.kanban size={13} /> Project
      </span>
    )
  return (
    <span className="step-chip">
      <Icons.puzzle size={13} /> Tool
    </span>
  )
}

// The Last cell: the most recent run's result (ok/error) + time, and — on success — a click-through to the
// conversation the chain ran in. On error it surfaces the failure reason (title) so a background failure isn't
// silent. Idle state until the task has fired.
function LastRun({ task, onOpenConversation }: { task: TaskDto; onOpenConversation?: (id: string) => void }): ReactElement {
  const last = task.runs?.[0]
  const cls = !last ? 'sched-last idle' : last.result === 'error' ? 'sched-last error' : 'sched-last ok'
  const clickable = !!(last?.result === 'ok' && last.convId && onOpenConversation)
  return (
    <span
      className={cls + (clickable ? ' link' : '')}
      title={last?.result === 'error' ? `Failed: ${last.error ?? 'unknown error'}` : clickable ? 'Open the conversation' : undefined}
      onClick={clickable ? (e) => { e.stopPropagation(); onOpenConversation!(last!.convId!) } : undefined}
    >
      <span className="sl-dot" /> Last · {fmtTime(last?.firedAt ?? task.lastFiredAt)}
      {last?.result === 'error' ? ' · failed' : ''}
    </span>
  )
}

/* — Scheduled list — */
function ScheduledList({
  tasks,
  onToggle,
  onEdit,
  onNew,
  onOpenConversation,
}: {
  tasks: TaskDto[]
  onToggle: (t: TaskDto) => void
  onEdit: (id: string) => void
  onNew: () => void
  onOpenConversation?: (id: string) => void
}): ReactElement {
  return (
    <div className="main-col">
      <div className="conv-header">
        <span className="conv-title">Scheduled</span>
        <button className="btn secondary sm" style={{ marginLeft: 'auto' }} onClick={onNew}>
          <Icons.plus size={14} /> New task
        </button>
      </div>
      <div className="sched-body">
        <div className="sched-inner">
          <div className="sched-note">
            Timed tasks fire an orchestrated step chain. Email always goes through an email MCP or a Scheduler draft —
            Studio never sends mail itself.
          </div>
          {tasks.length === 0 && <div className="sched-empty">No scheduled tasks yet. Create one with “New task”.</div>}
          <div className="sched-list">
            {tasks.map((t) => (
              <div className={'sched-row' + (t.enabled ? '' : ' off')} key={t.id}>
                <span className="sched-trig-ic">{t.recurring ? <Icons.repeat size={16} /> : <Icons.clock size={16} />}</span>
                <div className="sched-main" onClick={() => onEdit(t.id)}>
                  <div className="sched-name-line">
                    <span className="sched-name">{t.name}</span>
                    <span className="sched-trigger">{triggerLabel(t)}</span>
                  </div>
                  <div className="sched-chain">
                    {t.steps.map((s, i) => (
                      <Fragment key={i}>
                        {i > 0 && (
                          <span className="sched-arrow">
                            <Icons.arrowRight size={12} />
                          </span>
                        )}
                        <StepChip step={s} />
                      </Fragment>
                    ))}
                  </div>
                </div>
                <div className="sched-meta">
                  <span className="sched-next">Next · {fmtTime(t.nextRunAt)}</span>
                  <LastRun task={t} onOpenConversation={onOpenConversation} />
                </div>
                <MemToggle on={t.enabled} onClick={() => onToggle(t)} />
                <button className="icon-btn" title="Edit" onClick={() => onEdit(t.id)}>
                  <Icons.edit size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/* — Create / edit a scheduled task — */
function ScheduledEditor({
  task,
  onBack,
  onSaved,
}: {
  task: TaskDto | null
  onBack: () => void
  onSaved: () => void
}): ReactElement {
  const { EXPERTS } = STUDIO_DATA
  const [name, setName] = useState(task ? task.name : 'New scheduled task')
  const [tf, setTf] = useState<TriggerForm>(() => formFromTask(task))
  const [cwd, setCwd] = useState(task?.cwd ?? '')
  const [steps, setSteps] = useState<StepDto[]>(
    task ? task.steps : [{ kind: 'expert', roleId: 'analyst', prompt: "Analyze last week's metrics." }]
  )
  const [saving, setSaving] = useState(false)
  const expertOpts = EXPERTS.filter((e) => !e.unconfigured).map((e) => ({ v: e.id, l: e.name }))
  const [projects, setProjects] = useState<{ v: string; l: string }[]>([]) // for the project-step "advance" picker
  useEffect(() => {
    void window.api.project.list().then((ps) => setProjects(ps.map((p) => ({ v: p.id, l: p.title }))))
  }, [])

  const setTrig = (patch: Partial<TriggerForm>): void => setTf((p) => ({ ...p, ...patch }))
  const setStep = (i: number, patch: Partial<StepDto>): void => setSteps((p) => p.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const addStep = (): void => setSteps((p) => [...p, { kind: 'expert', roleId: 'generalist', prompt: '' }])
  const removeStep = (i: number): void => setSteps((p) => p.filter((_, j) => j !== i))
  const move = (i: number, dir: number): void =>
    setSteps((p) => {
      const j = i + dir
      if (j < 0 || j >= p.length) return p
      const n = [...p]
      const tmp = n[i]
      n[i] = n[j]
      n[j] = tmp
      return n
    })

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const payload = { name: name.trim() || 'Untitled task', schedule: buildSchedule(tf), steps, durable: true, cwd: cwd.trim() || undefined }
      if (task) await window.api.scheduled.update(task.id, payload)
      else await window.api.scheduled.create(payload)
      toast.success(task ? 'Task updated' : 'Task scheduled')
      onSaved()
    } catch {
      toast.error(task ? 'Couldn’t update task' : 'Couldn’t schedule task')
    } finally {
      setSaving(false)
    }
  }

  const del = async (): Promise<void> => {
    try {
      if (task) await window.api.scheduled.remove(task.id)
      toast.success('Task deleted')
      onSaved()
    } catch {
      toast.error('Couldn’t delete task')
    }
  }

  return (
    <div className="main-col">
      <div className="conv-header">
        <button className="btn ghost sm" onClick={onBack}>
          <Icons.chevronLeft size={15} /> Scheduled
        </button>
        <span className="conv-title" style={{ marginLeft: 6 }}>
          {task ? 'Edit task' : 'New task'}
        </span>
        {task && (
          <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={del} title="Delete task">
            <Icons.trash size={15} /> Delete
          </button>
        )}
      </div>
      <div className="sched-body">
        <div className="sched-inner editor">
          <div className="pf-field">
            <label className="field-label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="pf-grid">
            <div className="pf-field">
              <label className="field-label">Trigger</label>
              <div className="segmented">
                {TRIGGER_TYPES.map((tt) => (
                  <button key={tt.v} className={tf.type === tt.v ? 'active' : ''} onClick={() => setTrig({ type: tt.v })}>
                    {tt.l}
                  </button>
                ))}
              </div>
            </div>
            <div className="pf-field">
              <label className="field-label">{tf.type === 'cron' ? 'Cron expression' : 'When'}</label>
              {tf.type === 'once' && (
                <input className="input" type="datetime-local" value={tf.datetime} onChange={(e) => setTrig({ datetime: e.target.value })} />
              )}
              {tf.type === 'interval' && (
                <input className="input mono" value={tf.interval} onChange={(e) => setTrig({ interval: e.target.value })} placeholder="2h  ·  5m / 2h / 1d" />
              )}
              {tf.type === 'daily' && (
                <input className="input" type="time" value={tf.time} onChange={(e) => setTrig({ time: e.target.value })} />
              )}
              {tf.type === 'weekly' && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <div style={{ width: 110 }}>
                    <Dropdown options={DOW_OPTS} value={tf.dow} onChange={(v) => setTrig({ dow: v })} />
                  </div>
                  <input className="input" type="time" value={tf.time} onChange={(e) => setTrig({ time: e.target.value })} />
                </div>
              )}
              {tf.type === 'cron' && (
                <input className="input mono" value={tf.cron} onChange={(e) => setTrig({ cron: e.target.value })} placeholder="0 9 * * 1" />
              )}
            </div>
          </div>

          <div className="pf-field">
            <label className="field-label">Working directory (optional — steps get full permission inside it)</label>
            <input className="input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project" />
          </div>

          <div className="pf-field">
            <label className="field-label">Orchestration · ordered steps</label>
            <div className="step-editor">
              {steps.map((s, i) => (
                <div className="step-edit-row" key={i}>
                  <span className="se-num">{i + 1}</span>
                  <div className="se-body">
                    <div className="se-top">
                      <div style={{ width: 130 }}>
                        <Dropdown options={STEP_KINDS} value={s.kind} onChange={(v) => setStep(i, { kind: v as StepKind })} />
                      </div>
                      {s.kind === 'expert' && (
                        <div style={{ width: 130 }}>
                          <Dropdown options={expertOpts} value={s.roleId || 'generalist'} onChange={(v) => setStep(i, { roleId: v })} />
                        </div>
                      )}
                      {s.kind === 'project' && (
                        <div style={{ width: 120 }}>
                          <Dropdown options={PROJECT_ACTIONS} value={s.action || 'create'} onChange={(v) => setStep(i, { action: v as 'create' | 'advance' })} />
                        </div>
                      )}
                      <div className="se-reorder">
                        <button className="icon-btn sm" onClick={() => move(i, -1)} disabled={i === 0}>
                          <Icons.chevronDown size={13} style={{ transform: 'rotate(180deg)' }} />
                        </button>
                        <button className="icon-btn sm" onClick={() => move(i, 1)} disabled={i === steps.length - 1}>
                          <Icons.chevronDown size={13} />
                        </button>
                        <button className="icon-btn sm" onClick={() => removeStep(i)}>
                          <Icons.x size={13} />
                        </button>
                      </div>
                    </div>

                    {s.kind === 'email' && (
                      <div className="se-fields">
                        <input className="input se-instr" value={s.to ?? ''} onChange={(e) => setStep(i, { to: e.target.value })} placeholder="Recipient (to)…" />
                        <input className="input se-instr" value={s.subject ?? ''} onChange={(e) => setStep(i, { subject: e.target.value })} placeholder="Subject…" />
                      </div>
                    )}
                    {s.kind === 'project' &&
                      s.action === 'advance' &&
                      (projects.length > 0 ? (
                        <div style={{ marginTop: 6, maxWidth: 280 }}>
                          <Dropdown options={projects} value={s.projectId || projects[0].v} onChange={(v) => setStep(i, { projectId: v })} />
                        </div>
                      ) : (
                        <input className="input se-instr mono" value={s.projectId ?? ''} onChange={(e) => setStep(i, { projectId: e.target.value })} placeholder="No projects yet — paste a project id" />
                      ))}

                    <input
                      className="input se-instr"
                      value={s.prompt}
                      onChange={(e) => setStep(i, { prompt: e.target.value })}
                      placeholder={
                        s.kind === 'expert'
                          ? 'Instruction for the expert…'
                          : s.kind === 'tool'
                            ? 'What to do with your MCP tools…'
                            : s.kind === 'email'
                              ? 'Email body / what to write…'
                              : 'Project goal…'
                      }
                    />
                    {s.kind === 'email' && (
                      <div className="se-note">
                        <Icons.mail size={13} /> Sent via the email MCP (Extensions); if none is connected the step leaves a draft — Studio never sends mail itself.
                      </div>
                    )}
                    {s.kind === 'tool' && (
                      <div className="se-note">
                        <Icons.puzzle size={13} /> Runs as an agent turn that calls your connected MCP tools.
                      </div>
                    )}
                  </div>
                </div>
              ))}
              <button className="add-step" onClick={addStep}>
                <Icons.plus size={14} /> Add step
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 9, marginTop: 4 }}>
            <button className="btn primary sm" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : task ? 'Save task' : 'Create task'}
            </button>
            <button className="btn ghost sm" onClick={onBack}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function ScheduledView({ onOpenConversation }: { onOpenConversation?: (id: string) => void }): ReactElement {
  const [tasks, setTasks] = useState<TaskDto[]>([])
  const [editing, setEditing] = useState<{ id: string | null } | null>(null) // {id} edit | {id:null} new | null list

  const reload = useCallback(async (): Promise<void> => {
    setTasks(await window.api.scheduled.list())
  }, [])
  useEffect(() => {
    void reload()
    // Live-refresh: engine fired a task (Next/Last) OR any task mutation (e.g. a tool created/deleted one).
    const offFired = window.api.scheduled.onFired(() => void reload())
    const offChanged = window.api.scheduled.onChanged(() => void reload())
    return () => {
      offFired()
      offChanged()
    }
  }, [reload])

  const toggle = async (t: TaskDto): Promise<void> => {
    try {
      await window.api.scheduled.setEnabled(t.id, !t.enabled)
      void reload()
    } catch {
      toast.error('Couldn’t update task')
    }
  }
  const onSaved = (): void => {
    setEditing(null)
    void reload()
  }

  if (editing) {
    const task = editing.id ? tasks.find((t) => t.id === editing.id) ?? null : null
    return <ScheduledEditor task={task} onBack={() => setEditing(null)} onSaved={onSaved} />
  }
  return <ScheduledList tasks={tasks} onToggle={(t) => void toggle(t)} onEdit={(id) => setEditing({ id })} onNew={() => setEditing({ id: null })} onOpenConversation={onOpenConversation} />
}
