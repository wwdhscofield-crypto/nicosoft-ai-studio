/* ============================================================
   NicoSoft AI Studio — Projects
   List + live Workbench detail. The detail page is a real-time
   multi-expert orchestration view (swimlane timeline + consult
   arrows + 3-tier approvals + test strip + Danny dock). MOCK data
   for now (Coordinator 2.0, doc 19) — wiring to real services/DB
   is a later stage.
   ============================================================ */
import { Fragment } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Avatar, AvatarStack } from '@/components/primitives'
import { STUDIO_DATA, PHASES, PHASE_INDEX } from '@/data/studio-data'
import type { Project } from '@/types'

const PHASE_CHIP: Record<string, { cls: string; label: string }> = {
  Planning: { cls: 'planning', label: 'Planning' },
  Executing: { cls: 'executing', label: 'Executing' },
  Testing: { cls: 'testing', label: 'Testing' },
  Done: { cls: 'done', label: 'Done' }
}

function PhaseChip({ phase }: { phase: string }): ReactElement {
  const m = PHASE_CHIP[phase] || PHASE_CHIP.Planning
  return <span className={'phase-chip ' + m.cls}>{m.label}</span>
}

function ProgressBar({ value }: { value: number }): ReactElement {
  return (
    <span className="proj-progress">
      <span className="proj-progress-fill" style={{ width: Math.round(value * 100) + '%' }} />
    </span>
  )
}

/* — Projects list — */
function ProjectsList({ onOpen }: { onOpen: (id: string) => void }): ReactElement {
  const { PROJECTS } = STUDIO_DATA
  return (
    <div className="main-col">
      <div className="conv-header">
        <span className="conv-title">Projects</span>
        <span className="conv-sub" style={{ marginLeft: 'auto' }}>
          {PROJECTS.length} active
        </span>
      </div>
      <div className="proj-list-body">
        <div className="proj-list">
          {PROJECTS.map((p) => (
            <div className="proj-card" key={p.id} onClick={() => onOpen(p.id)}>
              <div className="pc-top">
                <span className="pc-title">{p.title}</span>
                <PhaseChip phase={p.phase} />
              </div>
              <div className="pc-goal">{p.summary}</div>
              <div className="pc-foot">
                <AvatarStack ids={p.experts} size={24} />
                <ProgressBar value={p.progress} />
                <span className="pc-pct">{Math.round(p.progress * 100)}%</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* — Phase rail: Plan → Execute → Test → Done — */
function PhaseRail({ phase }: { phase: string }): ReactElement {
  const cur = PHASE_INDEX[phase] ?? 0
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

/* ============================================================
   Live Workbench — MOCK (snake game, Executing)
   ============================================================ */
type WBStep = {
  kind: string
  title: string
  sub?: string
  time: string
  badge?: string // 🟡 yellow-tier: auto-approved + logged
  live?: boolean // a started service
  consult?: boolean // emits a consult to a peer
}
type WBLane = {
  id: string
  name: string
  role: string
  color: string
  status: 'watching' | 'working' | 'blocked' | 'done'
  ribbon?: string[] // coordinator: compact one-line orchestration pills
  steps?: WBStep[] // doers: tool-call timeline
}

const WB = {
  title: 'Snake game',
  goal: 'Browser Snake game with a server-backed leaderboard.',
  phase: 'Executing',
  runningFor: 'running unattended · 11 min',
  services: [
    { label: 'api', port: 3001, status: 'running' },
    { label: 'web', port: 5173, status: 'ready' }
  ],
  team: ['danny', 'shuri', 'flynn'],
  approval: { who: 'Flynn', command: 'rm -rf node_modules', where: 'in the backend lane' },
  lanes: [
    {
      id: 'danny',
      name: 'Danny',
      role: 'Orchestrator',
      color: 'var(--exp-coordinator)',
      status: 'watching',
      ribbon: ['PLAN 5 tasks', 'DISPATCH Shuri + Flynn', 'WATCH for green tests']
    },
    {
      id: 'shuri',
      name: 'Shuri',
      role: 'Frontend',
      color: 'var(--exp-designer)',
      status: 'working',
      steps: [
        { kind: 'READ', title: 'index.html', time: '14:04' },
        { kind: 'WRITE', title: 'src/game.js', sub: 'render loop + keyboard input', time: '14:06' },
        { kind: 'BASH', title: 'npm i', sub: 'canvas-confetti', time: '14:07', badge: 'auto-approved' },
        { kind: 'EDIT', title: 'src/api.js', sub: 'wire leaderboard fetch', time: '14:18', consult: true }
      ]
    },
    {
      id: 'flynn',
      name: 'Flynn',
      role: 'Backend',
      color: 'var(--exp-engineer)',
      status: 'blocked',
      steps: [
        { kind: 'READ', title: 'server.js', time: '14:04' },
        { kind: 'SEARCH', title: 'express rate-limit', sub: '3 sources', time: '14:05' },
        { kind: 'WRITE', title: 'routes/scores.js', sub: 'POST /scores · 5 req/s cap', time: '14:07' },
        { kind: 'SERVE', title: 'node server.js', sub: 'api up on :3001', time: '14:08', live: true },
        { kind: 'WRITE', title: 'routes/users.js', sub: 'GET /users → nickname', time: '14:11' }
      ]
    }
  ] as WBLane[],
  consult: { label: 'GET /users' }, // Shuri → Flynn
  tests: [
    { title: 'Snake moves, grows, and dies on collision', status: 'pass' as const, note: '' },
    { title: 'POST /scores persists to the database', status: 'pass' as const, note: '' },
    { title: 'Server boots cleanly in CI', status: 'fail' as const, note: 'rebuild 0.21 vs 0.19 conflict in node_modules' },
    { title: 'Leaderboard renders top 10 with avatars', status: 'pending' as const, note: 'waiting on GET /users wiring (Shuri)' }
  ],
  chat: {
    who: 'Danny',
    text: 'Both services are up and core gameplay passes. One call needs you: Flynn wants to wipe node_modules to clear the CI dependency conflict — low risk. Approve?'
  }
}

/* — One tool-call card on a doer's lane track — */
function WBToolCard({ step }: { step: WBStep }): ReactElement {
  return (
    <div className={'wb-card' + (step.consult ? ' consult' : '')}>
      <div className="wb-card-head">
        <span className="wb-kind">{step.kind}</span>
        <span className="wb-time">{step.time}</span>
      </div>
      <div className="wb-card-title">{step.title}</div>
      {step.sub && <div className="wb-card-sub">{step.sub}</div>}
      {step.badge && (
        <span className="wb-badge yellow">
          <Icons.shield size={10} /> {step.badge}
        </span>
      )}
      {step.live && (
        <span className="wb-badge live">
          <span className="wb-live-dot" /> live
        </span>
      )}
    </div>
  )
}

/* — One swimlane: a gutter (who) + a track (ribbon or tool cards) — */
function WBLaneRow({ lane, onOpenExpert }: { lane: WBLane; onOpenExpert: (id: string) => void }): ReactElement {
  const e = STUDIO_DATA.EXPERT_BY_ID[lane.id]
  return (
    <div className={'wb-lane ' + lane.status} style={{ '--lane-color': lane.color } as CSSProperties}>
      <div className="wb-gutter" onClick={() => onOpenExpert(lane.id)}>
        {e ? <Avatar expert={e} size={26} /> : <span className="wb-avatar-fallback">{lane.name[0]}</span>}
        <div className="wb-who">
          <span className="wb-name">{lane.name}</span>
          <span className="wb-role">{lane.role}</span>
        </div>
        <span className={'wb-status ' + lane.status}>{lane.status}</span>
      </div>
      <div className="wb-track">
        {lane.ribbon ? (
          <div className="wb-ribbon">
            {lane.ribbon.map((pill, i) => (
              <Fragment key={pill}>
                {i > 0 && <Icons.chevronRight size={12} />}
                <span className="wb-pill">{pill}</span>
              </Fragment>
            ))}
          </div>
        ) : (
          lane.steps?.map((s, i) => <WBToolCard key={i} step={s} />)
        )}
      </div>
    </div>
  )
}

/* — Test & review strip — */
function WBTests(): ReactElement {
  const counts = WB.tests.reduce(
    (a, t) => ((a[t.status] = (a[t.status] ?? 0) + 1), a),
    {} as Record<string, number>
  )
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
        {WB.tests.map((t, i) => (
          <div className={'wb-test ' + t.status} key={i}>
            <span className={'wb-test-icon ' + t.status}>
              {t.status === 'pass' && <Icons.check size={12} />}
              {t.status === 'fail' && <Icons.x size={12} />}
              {t.status === 'pending' && <span className="wb-test-dot" />}
            </span>
            <span className="wb-test-title">{t.title}</span>
            {t.note && <span className="wb-test-note">{t.note}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

/* — Project detail = live workbench — */
function ProjectDetail({ onBack, onOpenExpert }: { project: Project; onBack: () => void; onOpenExpert: (id: string) => void }): ReactElement {
  return (
    <div className="main-col wb-col">
      <div className="conv-header">
        <button className="btn ghost sm" onClick={onBack}>
          <Icons.chevronLeft size={15} /> Projects
        </button>
        <span className="conv-title" style={{ marginLeft: 6 }}>
          {WB.title}
        </span>
        <PhaseChip phase={WB.phase} />
      </div>

      <div className="wb-body">
        {/* Top: phase rail + run meta + services */}
        <div className="wb-top">
          <PhaseRail phase={WB.phase} />
          <span className="wb-running">{WB.runningFor}</span>
          <span className="wb-services">
            {WB.services.map((s) => (
              <span className={'wb-svc ' + s.status} key={s.label}>
                <span className="wb-svc-dot" />
                {s.label} <span className="wb-svc-port">:{s.port}</span> {s.status}
              </span>
            ))}
          </span>
        </div>

        {/* Goal + team */}
        <div className="wb-goalrow">
          <span className="wb-goal">{WB.goal}</span>
          <span className="wb-team">
            <AvatarStack ids={WB.team} size={22} />
          </span>
        </div>

        {/* 🔴 Red-tier approval — deferred, doesn't block the team */}
        <div className="wb-approval">
          <Icons.alert size={15} />
          <span className="wb-approval-text">
            <strong>1 approval needed</strong> — {WB.approval.who} wants to run a destructive command{' '}
            <code>{WB.approval.command}</code> {WB.approval.where}.
          </span>
          <button className="wb-approval-btn">Review</button>
        </div>

        {/* Orchestration — swimlanes (scrolls internally) */}
        <div className="wb-orch">
          <div className="wb-orch-head">
            <span className="wb-section-label">
              <Icons.kanban size={14} /> Orchestration
            </span>
            <span className="wb-section-sub">live, parallel work across the team</span>
            <span className="wb-orch-legend">
              <span className="wbl running">running</span>
              <span className="wbl done">done</span>
              <span className="wbl approval">needs approval</span>
            </span>
          </div>
          <div className="wb-lanes">
            {WB.lanes.map((lane) => (
              <WBLaneRow key={lane.id} lane={lane} onOpenExpert={onOpenExpert} />
            ))}
            {/* consult arrow: Shuri → Flynn, mock fixed anchors (real version measures DOM) */}
            <svg className="wb-consult" aria-hidden>
              <path className="wb-consult-path" d="M 470 96 C 470 128, 360 128, 360 160" />
              <circle className="wb-consult-dot" cx="470" cy="96" r="3" />
              <text className="wb-consult-label" x="372" y="142">
                {WB.consult.label}
              </text>
            </svg>
          </div>
        </div>

        {/* Test & review */}
        <WBTests />
      </div>

      {/* Dock — talk to Danny */}
      <div className="wb-dock">
        <div className="wb-dock-msg">
          <Avatar expert={STUDIO_DATA.EXPERT_BY_ID.coordinator} size={22} />
          <div className="wb-dock-body">
            <div className="wb-dock-who">
              {WB.chat.who} <span className="wb-dock-at">@you</span>
            </div>
            <div className="wb-dock-text">{WB.chat.text}</div>
          </div>
        </div>
        <div className="wb-dock-input">
          <input placeholder="Reply to Danny, or send the team a new instruction…" readOnly />
          <button className="wb-dock-send">
            <Icons.arrowUp size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}

export function ProjectsView({ activeProject, onSelect, onOpenExpert }: { activeProject: string | null; onSelect: (id: string | null) => void; onOpenExpert: (id: string) => void }): ReactElement {
  const { PROJECTS } = STUDIO_DATA
  const project = activeProject ? PROJECTS.find((p) => p.id === activeProject) : null
  if (project) return <ProjectDetail project={project} onBack={() => onSelect(null)} onOpenExpert={onOpenExpert} />
  return <ProjectsList onOpen={onSelect} />
}
