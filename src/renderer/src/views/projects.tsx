/* ============================================================
   NicoSoft AI Studio — Projects
   List + live Workbench detail, backed by the real project
   service/DB (phase 5d, doc 19 §1/§13). The detail page is a
   real-time multi-expert orchestration view; its lanes + tests
   render from the persisted plan/tests now, and the live streams
   (services / approvals / consult arrows / Danny dock) wire up in
   phase 5c.
   ============================================================ */
import { Fragment, useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Avatar, AvatarStack } from '@/components/primitives'
import { STUDIO_DATA, PHASES, PHASE_INDEX } from '@/data/studio-data'

// DTOs derived from the IPC surface — the renderer never imports main-process modules.
type ProjectDto = Awaited<ReturnType<typeof window.api.project.list>>[number]
type TaskDto = ProjectDto['plan'][number]
type TestDto = ProjectDto['tests'][number]

// project.phase is stored lowercase (planning|executing|testing|done); the chip + rail label in TitleCase.
const PHASE_LABEL: Record<string, string> = { planning: 'Planning', executing: 'Executing', testing: 'Testing', done: 'Done' }
const phaseTitle = (p: string): string => PHASE_LABEL[p] ?? 'Planning'

// A doer lane's status, derived from its tasks: all done → done, any in-flight → working, else watching.
function laneStatus(tasks: TaskDto[]): string {
  if (tasks.length > 0 && tasks.every((t) => t.status === 'done')) return 'done'
  if (tasks.some((t) => t.status === 'doing')) return 'working'
  return 'watching'
}

function PhaseChip({ phase }: { phase: string }): ReactElement {
  const label = phaseTitle(phase)
  return <span className={'phase-chip ' + label.toLowerCase()}>{label}</span>
}

function ProgressBar({ value }: { value: number }): ReactElement {
  return (
    <span className="proj-progress">
      <span className="proj-progress-fill" style={{ width: Math.round(value * 100) + '%' }} />
    </span>
  )
}

/* — Phase rail: Plan → Execute → Test → Done — */
function PhaseRail({ phase }: { phase: string }): ReactElement {
  const cur = PHASE_INDEX[phaseTitle(phase)] ?? 0
  return (
    <div className="phase-rail">
      {PHASES.map((ph, i) => (
        <Fragment key={ph}>
          <div className={'pr-step' + (i < cur ? ' past' : i === cur ? ' current' : '')}>
            <span className="pr-dot">{i < cur ? <Icons.check size={12} /> : i + 1}</span>
            <span className="pr-label">{ph}</span>
          </div>
          {i < PHASES.length - 1 && <span className={'pr-line' + (i < cur ? ' past' : '')} />}
        </Fragment>
      ))}
    </div>
  )
}

// First non-empty line of the goal, trimmed — the list card's one-line summary.
function goalSummary(goal: string | null): string {
  const first =
    (goal ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  if (!first) return 'No description yet'
  return first.length > 80 ? first.slice(0, 77) + '…' : first
}

/* — Projects list — */
function ProjectsList({
  projects,
  onOpen,
  onNew
}: {
  projects: ProjectDto[]
  onOpen: (id: string) => void
  onNew: () => void
}): ReactElement {
  return (
    <div className="main-col">
      <div className="conv-header">
        <span className="conv-title">Projects</span>
        <button className="btn primary sm" style={{ marginLeft: 'auto' }} onClick={onNew}>
          <Icons.plus size={14} /> New Project
        </button>
      </div>
      <div className="proj-list-body">
        {projects.length === 0 ? (
          <div className="proj-empty">
            No projects yet. Start one with <strong>New Project</strong>, or just ask the team to build something in chat —
            a collaboration lands here automatically.
          </div>
        ) : (
          <div className="proj-list">
            {projects.map((p) => (
              <div className="proj-card" key={p.id} onClick={() => onOpen(p.id)}>
                <div className="pc-top">
                  <span className="pc-title">{p.title}</span>
                  <PhaseChip phase={p.phase} />
                </div>
                <div className="pc-goal">{goalSummary(p.goal)}</div>
                <div className="pc-foot">
                  <AvatarStack ids={p.experts} size={24} />
                  <ProgressBar value={p.progress} />
                  <span className="pc-pct">{Math.round(p.progress * 100)}%</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* — New Project dialog: a folder + a goal; the name is optional (blank → generated from the goal). — */
function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }): ReactElement {
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [cwd, setCwd] = useState('')
  const [busy, setBusy] = useState(false)

  const pick = async (): Promise<void> => {
    const dir = await window.api.project.pick()
    if (dir) setCwd(dir)
  }
  const create = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const p = await window.api.project.create({
        title: name.trim(),
        goal: goal.trim() || null,
        cwd: cwd.trim() || null
      })
      onCreated(p.id)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span className="dh-title">New Project</span>
          <button className="icon-btn" onClick={onClose}>
            <Icons.x size={16} />
          </button>
        </div>
        <div className="dialog-body">
          <div>
            <label className="field-label">Project folder</label>
            <div className="np-path">
              <input className="input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/your/project" />
              <button className="btn ghost np-browse" onClick={pick} aria-label="Browse for a folder" title="Browse for a folder">
                <Icons.folder size={16} />
              </button>
            </div>
          </div>
          <div>
            <label className="field-label">
              What should the team build? <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>· goal</span>
            </label>
            <textarea
              className="input np-goal"
              rows={4}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="Describe the project — goal, structure, constraints, anything the team should know…"
            />
          </div>
          <div>
            <label className="field-label">
              Name <span style={{ color: 'var(--text-4)', fontWeight: 400 }}>· optional — generated from the goal if blank</span>
            </label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Leave blank to auto-generate" />
          </div>
        </div>
        <div className="dialog-foot">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={create} disabled={busy || (!goal.trim() && !name.trim())}>
            {busy ? 'Creating…' : 'Create project'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* — One task card on a doer's lane — */
function ProjectTaskCard({ task }: { task: TaskDto }): ReactElement {
  return (
    <div className={'wb-card ' + task.status}>
      <div className="wb-card-head">
        <span className="wb-kind">{task.status}</span>
      </div>
      <div className="wb-card-title">{task.title}</div>
      {task.output && <div className="wb-card-sub">{task.output}</div>}
    </div>
  )
}

/* — One swimlane per expert: coordinator is a compact ribbon, doers show their task cards. — */
function ProjectLane({
  roleId,
  tasks,
  isChair,
  planCount,
  phase,
  onOpenExpert
}: {
  roleId: string
  tasks: TaskDto[]
  isChair?: boolean
  planCount?: number
  phase?: string
  onOpenExpert: (id: string) => void
}): ReactElement {
  const e = STUDIO_DATA.EXPERT_BY_ID[roleId]
  const status = isChair ? 'watching' : laneStatus(tasks)
  return (
    <div className={'wb-lane ' + status} data-role={roleId} style={{ '--lane-color': e?.color ?? 'var(--exp-coordinator)' } as CSSProperties}>
      <div className="wb-gutter" onClick={() => onOpenExpert(roleId)}>
        {e ? <Avatar expert={e} size={26} /> : <span className="wb-avatar-fallback">{roleId[0]?.toUpperCase()}</span>}
        <div className="wb-who">
          <span className="wb-name">{e?.name ?? roleId}</span>
          <span className="wb-role">{e?.specialty?.split('—')[0]?.trim() ?? roleId}</span>
        </div>
        <span className={'wb-status ' + status}>{status}</span>
      </div>
      <div className="wb-track">
        {isChair ? (
          <div className="wb-ribbon">
            {[`PLAN ${planCount ?? 0} tasks`, `DISPATCH team`, `PHASE ${phaseTitle(phase ?? 'planning')}`].map((pill, i) => (
              <Fragment key={pill}>
                {i > 0 && <Icons.chevronRight size={12} />}
                <span className="wb-pill">{pill}</span>
              </Fragment>
            ))}
          </div>
        ) : tasks.length === 0 ? (
          <span className="wb-lane-empty">no tasks yet</span>
        ) : (
          tasks.map((t) => <ProjectTaskCard key={t.id} task={t} />)
        )}
      </div>
    </div>
  )
}

/* — Test & review strip — */
function ProjectTests({ tests }: { tests: TestDto[] }): ReactElement {
  const counts = tests.reduce((a, t) => ((a[t.status] = (a[t.status] ?? 0) + 1), a), {} as Record<string, number>)
  return (
    <div className="wb-tests">
      <div className="wb-tests-head">
        <span className="wb-section-label">
          <Icons.check size={14} /> Test &amp; review
        </span>
        <span className="wb-section-sub">self-tested as the team builds</span>
        <span className="wb-tests-legend">
          <span className="wbl pass">{counts.pass ?? 0} passed</span>
          <span className="wbl fail">{counts.fail ?? 0} failed</span>
          <span className="wbl pending">{counts.pending ?? 0} pending</span>
        </span>
      </div>
      <div className="wb-tests-strip">
        {tests.map((t) => (
          <div className={'wb-test ' + t.status} key={t.id}>
            <span className={'wb-test-icon ' + t.status}>
              {t.status === 'pass' && <Icons.check size={12} />}
              {t.status === 'fail' && <Icons.x size={12} />}
              {t.status === 'pending' && <span className="wb-test-dot" />}
            </span>
            <span className="wb-test-title">{t.title}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

type ConsultDto = ProjectDto['consults'][number]
type PendingDto = Awaited<ReturnType<typeof window.api.approval.list>>[number]

// The Bash command (or tool name) a deferred red-zone action would run — shown in the approval bar.
function pendingCommand(p: PendingDto): string {
  return (p.toolInput as { command?: string })?.command ?? p.toolName
}

// SVG overlay: a curved arrow per consult edge (from→to expert), anchored to live lane geometry. The
// arrows sit inside .wb-lanes but are absolutely positioned + pointer-events:none; lane gutters are
// measured from .wb-lanes itself (never the SVG) so the SVG's own box can't feed back into the
// measurement (doc 19 §13 pitfall). Re-measures on any size change via ResizeObserver.
function ConsultArrows({ consults, lanesEl }: { consults: ConsultDto[]; lanesEl: HTMLDivElement | null }): ReactElement | null {
  const [edges, setEdges] = useState<{ x: number; y1: number; y2: number; label: string }[]>([])
  useLayoutEffect(() => {
    if (!lanesEl || consults.length === 0) {
      setEdges([])
      return
    }
    const measure = (): void => {
      const box = lanesEl.getBoundingClientRect()
      const center = new Map<string, { x: number; y: number }>()
      lanesEl.querySelectorAll('.wb-lane[data-role]').forEach((el) => {
        const rid = el.getAttribute('data-role')
        const g = el.querySelector('.wb-gutter')
        if (!rid || !g) return
        const r = g.getBoundingClientRect()
        center.set(rid, { x: r.right - box.left, y: r.top + r.height / 2 - box.top })
      })
      const next: { x: number; y1: number; y2: number; label: string }[] = []
      for (const c of consults) {
        const a = center.get(c.from)
        const b = center.get(c.to)
        if (!a || !b) continue
        next.push({ x: a.x, y1: a.y, y2: b.y, label: c.text ?? '' })
      }
      setEdges(next)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(lanesEl)
    return () => ro.disconnect()
  }, [consults, lanesEl])

  if (edges.length === 0) return null
  return (
    <svg className="wb-consult" aria-hidden>
      {edges.map((e, i) => (
        <Fragment key={i}>
          <path className="wb-consult-path" d={`M ${e.x} ${e.y1} C ${e.x + 30} ${e.y1}, ${e.x + 30} ${e.y2}, ${e.x} ${e.y2}`} />
          <circle className="wb-consult-dot" cx={e.x} cy={e.y1} r={3} />
          {e.label ? (
            <text className="wb-consult-label" x={e.x + 36} y={(e.y1 + e.y2) / 2}>
              {e.label.length > 22 ? e.label.slice(0, 20) + '…' : e.label}
            </text>
          ) : null}
        </Fragment>
      ))}
    </svg>
  )
}

/* — Project detail = live workbench (lanes + tests from the plan; live streams in phase 5c) — */
function ProjectDetail({
  project,
  onBack,
  onOpenExpert
}: {
  project: ProjectDto
  onBack: () => void
  onOpenExpert: (id: string) => void
}): ReactElement {
  const doers = project.experts.filter((id) => id !== 'coordinator')
  const [lanesEl, setLanesEl] = useState<HTMLDivElement | null>(null)
  const [pending, setPending] = useState<PendingDto[]>([])
  const [convId, setConvId] = useState<string | null>(null)
  const [dannyReply, setDannyReply] = useState('')
  const [running, setRunning] = useState(false)
  const [draft, setDraft] = useState('')
  const [services, setServices] = useState<{ name: string; port: number | null; status: string }[]>([])

  // phase 5c-C3: live dev services the collaboration started, pushed while it runs (cleared on teardown).
  useEffect(() => {
    return window.api.project.onService(({ projectId, services: svcs }) => {
      if (projectId === project.id) setServices(svcs)
    })
  }, [project.id])

  // phase 5c-C: bind to the project's conversation (conversation.projectId) — its latest coordinator message
  // is Danny's report (dock), its pending records are the red-zone bar (doc 19 §8). Reloads pending on a
  // red-zone push so the bar appears live; the dock's own coordinator:done reload (in send) refreshes Danny.
  useEffect(() => {
    let live = true
    void (async () => {
      const convs = await window.api.conversations.list()
      const conv = convs.find((c) => c.projectId === project.id)
      if (!live) return
      setConvId(conv?.id ?? null)
      if (!conv) return
      const [msgs, ps] = await Promise.all([window.api.conversations.messages(conv.id), window.api.approval.list(conv.id)])
      if (!live) return
      setDannyReply([...msgs].reverse().find((m) => m.author !== 'user')?.content ?? '')
      setPending(ps)
    })()
    const off = window.api.coordinator.onApproval(async () => {
      const convs = await window.api.conversations.list()
      const conv = convs.find((c) => c.projectId === project.id)
      if (conv) setPending(await window.api.approval.list(conv.id))
    })
    return () => {
      live = false
      off()
    }
  }, [project.id])

  // Dock: send a new instruction to the team from inside the project. Persists the user turn (chat-path
  // style), runs the coordinator on the project's conversation with project.cwd as every doer's cwd, and
  // refreshes Danny's reply on done. The run's tool activity streams to chat; lanes/arrows update here live
  // via 5c-A/B (project:updated).
  const send = async (): Promise<void> => {
    const prompt = draft.trim()
    if (!convId || !prompt || running) return
    setDraft('')
    setRunning(true)
    await window.api.conversations.append(convId, { author: 'user', content: prompt })
    const cwdByRole = project.cwd ? Object.fromEntries(doers.map((r) => [r, project.cwd as string])) : undefined
    const { streamId } = await window.api.coordinator.run({ convId, prompt, cwdByRole })
    const off = window.api.coordinator.onDone(async (d) => {
      if (d.streamId !== streamId) return
      off()
      setRunning(false)
      const msgs = await window.api.conversations.messages(convId)
      setDannyReply([...msgs].reverse().find((m) => m.author !== 'user')?.content ?? '')
    })
  }

  const resolve = async (id: string, ok: boolean): Promise<void> => {
    if (ok) await window.api.approval.approve(id)
    else await window.api.approval.reject(id)
    setPending((ps) => ps.filter((p) => p.id !== id))
  }

  return (
    <div className="main-col wb-col">
      <div className="conv-header">
        <button className="btn ghost sm" onClick={onBack}>
          <Icons.chevronLeft size={15} /> Projects
        </button>
        <span className="conv-title" style={{ marginLeft: 6 }}>
          {project.title}
        </span>
        <PhaseChip phase={project.phase} />
      </div>

      <div className="wb-body">
        <div className="wb-top">
          <PhaseRail phase={project.phase} />
          {services.length > 0 && (
            <span className="wb-services">
              {services.map((s) => (
                <span className={'wb-svc ' + s.status} key={s.name}>
                  <span className="wb-svc-dot" />
                  {s.name} {s.port ? <span className="wb-svc-port">:{s.port}</span> : null} {s.status}
                </span>
              ))}
            </span>
          )}
        </div>

        <div className="wb-goalrow">
          <span className="wb-goal">{project.goal || 'No description yet'}</span>
          <span className="wb-team">
            <AvatarStack ids={project.experts} size={22} />
          </span>
        </div>

        {pending.length > 0 && (
          <div className="wb-approval">
            <Icons.alert size={15} />
            <span className="wb-approval-text">
              <strong>
                {pending.length} approval{pending.length > 1 ? 's' : ''} needed
              </strong>{' '}
              — {STUDIO_DATA.EXPERT_BY_ID[pending[0].roleId]?.name ?? pending[0].roleId} wants to run a destructive command{' '}
              <code>{pendingCommand(pending[0])}</code>.
            </span>
            <button className="btn ghost sm" onClick={() => void resolve(pending[0].id, false)}>
              Reject
            </button>
            <button className="wb-approval-btn" onClick={() => void resolve(pending[0].id, true)}>
              Approve
            </button>
          </div>
        )}

        <div className="wb-orch">
          <div className="wb-orch-head">
            <span className="wb-section-label">
              <Icons.kanban size={14} /> Orchestration
            </span>
            <span className="wb-section-sub">work across the team</span>
            <span className="wb-orch-legend">
              <span className="wbl running">working</span>
              <span className="wbl done">done</span>
            </span>
          </div>
          <div className="wb-lanes" ref={setLanesEl}>
            <ProjectLane
              roleId="coordinator"
              tasks={project.plan}
              isChair
              planCount={project.plan.length}
              phase={project.phase}
              onOpenExpert={onOpenExpert}
            />
            {doers.map((rid) => (
              <ProjectLane
                key={rid}
                roleId={rid}
                tasks={project.plan.filter((t) => t.assigneeRoleId === rid)}
                phase={project.phase}
                onOpenExpert={onOpenExpert}
              />
            ))}
            <ConsultArrows consults={project.consults} lanesEl={lanesEl} />
          </div>
        </div>

        {project.tests.length > 0 && <ProjectTests tests={project.tests} />}
      </div>

      {/* Dock — Danny's latest report + send the team a new instruction from inside the project (5c-C2) */}
      <div className="wb-dock">
        {dannyReply ? (
          <div className="wb-dock-msg">
            <Avatar expert={STUDIO_DATA.EXPERT_BY_ID.coordinator} size={22} />
            <div className="wb-dock-body">
              <div className="wb-dock-who">
                Danny <span className="wb-dock-at">@you</span>
              </div>
              <div className="wb-dock-text">{running ? 'Working on it…' : dannyReply}</div>
            </div>
          </div>
        ) : null}
        <div className="wb-dock-input">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={convId ? 'Reply to Danny, or send the team a new instruction…' : 'No conversation linked to this project yet'}
            disabled={!convId || running}
          />
          <button className="wb-dock-send" onClick={() => void send()} disabled={!convId || running || !draft.trim()}>
            <Icons.arrowUp size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}

export function ProjectsView({
  activeProject,
  onSelect,
  onOpenExpert
}: {
  activeProject: string | null
  onSelect: (id: string | null) => void
  onOpenExpert: (id: string) => void
}): ReactElement {
  const [projects, setProjects] = useState<ProjectDto[]>([])
  const [detail, setDetail] = useState<ProjectDto | null>(null)
  const [newOpen, setNewOpen] = useState(false)

  const reload = useCallback(async (): Promise<void> => {
    setProjects(await window.api.project.list())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // Load the active project's full detail (plan + tests) whenever the selection changes.
  useEffect(() => {
    if (!activeProject) {
      setDetail(null)
      return
    }
    let live = true
    void window.api.project.get(activeProject).then((p) => {
      if (live) setDetail(p)
    })
    return () => {
      live = false
    }
  }, [activeProject])

  // phase 5c: a live collab event changed a project (tasks doing→done, phase) — refetch the list + an
  // open detail so the workbench updates in real time.
  useEffect(() => {
    return window.api.project.onUpdated(({ projectId }) => {
      void reload()
      if (projectId === activeProject) void window.api.project.get(projectId).then((p) => setDetail(p))
    })
  }, [activeProject, reload])

  if (activeProject && detail) {
    return <ProjectDetail project={detail} onBack={() => onSelect(null)} onOpenExpert={onOpenExpert} />
  }
  return (
    <>
      <ProjectsList projects={projects} onOpen={onSelect} onNew={() => setNewOpen(true)} />
      {newOpen && (
        <NewProjectDialog
          onClose={() => setNewOpen(false)}
          onCreated={(id) => {
            setNewOpen(false)
            void reload()
            onSelect(id)
          }}
        />
      )}
    </>
  )
}
