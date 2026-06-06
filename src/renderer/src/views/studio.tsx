/* ============================================================
   NicoSoft AI Studio — Studio Home (Overview)
   Tab "Activity": live work (streaming conversations) + collaboration
   projects (real), else a "team ready" strip. Tab "Stats": local
   analytics. All real — no mock data.
   ============================================================ */
import { Fragment, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Avatar, AvatarStack } from '@/components/primitives'
import { STUDIO_DATA } from '@/data/studio-data'
import { useRoles } from '@/stores/roles'
import { useChat } from '@/stores/chat'
import { StatsPage } from '@/views/analytics'
import type { AnalyticsSummary, ConversationDto } from '@/lib/api'

type ProjectDto = Awaited<ReturnType<typeof window.api.project.list>>[number]

const expertMeta = (id: string): { name: string; color: string } => {
  const e = STUDIO_DATA.EXPERT_BY_ID[id]
  return e ? { name: e.name, color: e.color } : { name: id || '—', color: 'var(--text-3)' }
}
const fmtTokens = (n: number): string => (n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1_000 ? Math.round(n / 1_000) + 'k' : String(n))
const fmtElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/* — A conversation streaming right now — turns so far + live elapsed, like the prototype's
   "3 turns · 2m". `now` ticks once a second from the parent so the elapsed updates live. */
function InProgressRow({ conv, now, onOpenConv }: { conv: ConversationDto; now: number; onOpenConv: (convId: string) => void }): ReactElement {
  const id = conv.primaryRoleId ?? ''
  const e = STUDIO_DATA.EXPERT_BY_ID[id]
  const m = expertMeta(id)
  const turns = useChat((s) => (s.byConversation[conv.id] ?? []).filter((x) => x.role === 'user').length)
  const startedAt = useChat((s) => s.streamStartedAt[conv.id])
  const activity = startedAt
    ? `${turns > 0 ? `${turns} ${turns === 1 ? 'turn' : 'turns'} · ` : ''}${fmtElapsed(now - startedAt)}`
    : 'streaming…'
  return (
    <div className="tl-row" onClick={() => onOpenConv(conv.id)} style={{ '--ws-color': m.color } as CSSProperties}>
      <Avatar expert={e ?? null} size={30} />
      <div className="tl-main">
        <div className="tl-row-top">
          <span className="tl-name">{m.name}</span>
          <span className="tl-live"><span className="tl-dot working" style={{ background: m.color }} />live</span>
        </div>
        <div className="tl-title">{conv.title || 'Untitled'}</div>
      </div>
      <div className="tl-meta">
        <span className="tl-activity">{activity}</span>
        <span className="tl-model">{e?.model ?? ''}</span>
      </div>
    </div>
  )
}

/* — A real collaboration project — opens the Project detail — */
function ProjectRow({ project, onOpenProject }: { project: ProjectDto; onOpenProject: (id: string) => void }): ReactElement {
  // Prototype shows "2 of 4 steps". Derive from the plan's done tasks; fall back to the phase word
  // for a project that has no plan yet (still planning).
  const total = project.plan.length
  const done = project.plan.filter((t) => t.status === 'done').length
  const status = total > 0 ? `${done} of ${total} steps` : project.phase
  return (
    <div className="tl-project">
      <div className="tl-row project" onClick={() => onOpenProject(project.id)}>
        <AvatarStack ids={project.experts} />
        <div className="tl-main">
          <div className="tl-name">{project.title}</div>
          <div className="tl-chain">
            {project.experts.map((id, i) => {
              const m = expertMeta(id)
              return (
                <Fragment key={id}>
                  {i > 0 && <span className="tl-chain-sep">›</span>}
                  <span className="tl-chain-node"><span className="tl-chain-dot" style={{ background: m.color }} />{m.name}</span>
                </Fragment>
              )
            })}
          </div>
        </div>
        <div className="tl-meta">
          <span className="tl-status">{status}</span>
          <span className="tl-chevron"><Icons.chevronRight size={15} /></span>
        </div>
      </div>
    </div>
  )
}

/* — Idle state: a light "team ready" strip — */
function TeamReady({ onOpenExpert }: { onOpenExpert: (id: string) => void }): ReactElement {
  const { EXPERTS } = STUDIO_DATA
  const roles = useRoles()
  const team = EXPERTS.filter((e) => !roles.isDisabled(e.id) && !roles.isDeleted(e.id))
  return (
    <div className="team-ready">
      <div className="tr-prompt">Your team is ready — start a conversation or <span className="tr-at">@mention</span> an expert.</div>
      <div className="tr-chips">
        {team.map((e) => (
          <div className="tr-chip" key={e.id} onClick={() => onOpenExpert(e.id)}>
            <Avatar expert={e} size={26} />
            <div className="trc-meta">
              <div className="trc-name">{e.name}</div>
              <div className="trc-spec">{e.specialty.split('—')[1] ? e.specialty.split('—')[1].trim() : e.specialty}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ActivityTimeline({
  onOpenExpert,
  onOpenConv,
  onOpenProject
}: {
  onOpenExpert: (id: string) => void
  onOpenConv: (convId: string) => void
  onOpenProject: (id: string) => void
}): ReactElement {
  const conversations = useChat((s) => s.conversations)
  const streaming = useChat((s) => s.streaming)
  const inProgress = conversations.filter((c) => streaming[c.id])
  const [projects, setProjects] = useState<ProjectDto[]>([])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    void window.api.project.list().then((p) => setProjects(p.filter((x) => x.phase !== 'done')))
  }, [])
  // Live elapsed clock for in-progress rows — ticks only while something is streaming.
  useEffect(() => {
    if (inProgress.length === 0) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [inProgress.length])

  return (
    <div className="timeline-wrap">
      <div className="tl-scroll">
        {/* "In progress" is a permanent section — when nothing is streaming it renders an empty state
            (count 0 + the ready team), it is never hidden. */}
        <div className="tl-group">
          <div className="tl-group-head">
            <span>In progress</span>
            <span className="tl-count">{inProgress.length}</span>
          </div>
          {inProgress.length > 0 ? (
            <div className="tl-list">{inProgress.map((c) => <InProgressRow key={c.id} conv={c} now={now} onOpenConv={onOpenConv} />)}</div>
          ) : (
            <div className="tl-empty">
              <div className="tl-empty-line">Nothing running right now.</div>
              <TeamReady onOpenExpert={onOpenExpert} />
            </div>
          )}
        </div>

        {projects.length > 0 && (
          <div className="tl-group">
            <div className="tl-group-head">
              <span>Collaboration projects</span>
              <span className="tl-count">{projects.length}</span>
            </div>
            <div className="tl-list">{projects.map((p) => <ProjectRow key={p.id} project={p} onOpenProject={onOpenProject} />)}</div>
          </div>
        )}

        <div className="tl-foot">
          <span>Live work only · finished conversations move to History</span>
        </div>
      </div>
    </div>
  )
}

function StudioStats(): ReactElement {
  const [a, setA] = useState<AnalyticsSummary | null>(null)
  const streamingCount = useChat((s) => Object.values(s.streaming).filter(Boolean).length)
  useEffect(() => {
    void window.api.analytics.summary().then(setA)
  }, [])
  if (!a) return <div className="studio-stats" />

  const total = a.usage.conversationsTotal
  const inProgress = Math.min(streamingCount, total)
  const top = a.usage.byExpert.slice(0, 5)
  const sum = a.usage.byExpert.reduce((s, r) => s + r.v, 0) || 1

  return (
    <div className="studio-stats">
      <div className="stats-section">
        <div className="stats-label">Today&apos;s usage</div>
        <div className="stat-big">{fmtTokens(a.usage.tokensToday)}<span> tokens</span></div>
        <div className="stat-sub">{fmtTokens(a.usage.tokensIn)} in · {fmtTokens(a.usage.tokensOut)} out</div>
      </div>

      <div className="stats-section">
        <div className="stats-label">Conversations</div>
        <div className="stat-triple">
          <div className="st-cell"><div className="st-num">{inProgress}</div><div className="st-lbl">in progress</div></div>
          <div className="st-cell"><div className="st-num">{total - inProgress}</div><div className="st-lbl">done</div></div>
          <div className="st-cell"><div className="st-num">{total}</div><div className="st-lbl">total</div></div>
        </div>
      </div>

      <div className="stats-section">
        <div className="stats-label">Share of use</div>
        <div className="share-list">
          {top.length === 0 ? (
            <div className="stat-sub">No usage yet.</div>
          ) : (
            top.map((r) => {
              const m = expertMeta(r.id)
              const pct = Math.round((r.v / sum) * 100)
              return (
                <div className="share-row" key={r.id}>
                  <span className="share-name">{m.name}</span>
                  <span className="share-track"><span className="share-fill" style={{ width: pct + '%', background: m.color }} /></span>
                  <span className="share-pct">{pct}%</span>
                </div>
              )
            })
          )}
        </div>
      </div>

      <div className="stats-foot">Local activity · stays on this device</div>
    </div>
  )
}

export function StudioHome({
  onOpenExpert,
  onOpenConv,
  onOpenProject
}: {
  onOpenExpert: (id: string) => void
  onOpenConv: (convId: string) => void
  onOpenProject: (id: string) => void
  onNewRole: () => void
}): ReactElement {
  const [tab, setTab] = useState('activity')
  return (
    <div className="main-col">
      <div className="conv-header">
        <span className="conv-title">Overview</span>
        <div className="studio-tabs segmented">
          <button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>Activity</button>
          <button className={tab === 'stats' ? 'active' : ''} onClick={() => setTab('stats')}>Stats</button>
        </div>
        <span className="conv-sub" style={{ marginLeft: 'auto' }}>
          {tab === 'activity' ? 'live work · right now' : 'local analytics · today'}
        </span>
      </div>
      {tab === 'activity' ? (
        <div className="studio-body">
          <ActivityTimeline onOpenExpert={onOpenExpert} onOpenConv={onOpenConv} onOpenProject={onOpenProject} />
          <StudioStats />
        </div>
      ) : (
        <StatsPage />
      )}
    </div>
  )
}
