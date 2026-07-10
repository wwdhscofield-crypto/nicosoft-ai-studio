/* ============================================================
   NicoSoft AI Studio — Studio Home (Overview)
   Tab "Activity": live ASSIGNMENTS (work items a role received —
   docs/assignments-design.md §6) + today's finished ones + collaboration
   projects, else a "team ready" strip. Tab "Stats": local analytics.
   All real — no mock data. Plain chat never appears here: the ledger
   only holds 接活 (build/fix/change/handle), judged at dispatch.
   ============================================================ */
import { Fragment, useEffect, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Avatar, AvatarStack, Segmented, SelectMenu } from '@/components/primitives'
import { STUDIO_DATA } from '@/data/studio-data'
import { useAllExperts, useExpertMeta } from '@/lib/all-experts'
import { fmtTokens } from '@/lib/format'
import { useRoles } from '@/stores/roles'
import { useAssignments } from '@/stores/assignments'
import type { AssignmentDto } from '@/stores/assignments'
import { useT } from '@/stores/locale'
import { StatsPage } from '@/views/analytics'
import type { AnalyticsSummary } from '@/lib/api'

type ProjectDto = Awaited<ReturnType<typeof window.api.project.list>>[number]

const fmtElapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}
const fmtClock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const fmtDay = (ms: number): string => new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })
const startOfToday = (): number => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/* — One dispatch batch of assignments: a collaboration = one card with a row per expert; a solo job is a
   single-row batch and renders without the group shell. Settled siblings of a still-live batch ride inside
   its card (Flynn ✓ while Turing still builds); fully settled batches move to "Done today". — */
interface AssignmentBatch {
  batchId: string
  title: string
  convId: string
  projectId: string | null
  rows: AssignmentDto[]
  startedAt: number
  endedAt: number // max ended_at across rows (0 while anything is still live)
  live: boolean
}

const STATUS_GLYPH: Record<'done' | 'failed' | 'stopped', string> = { done: '✓', failed: '✗', stopped: '■' }

function groupBatches(rows: AssignmentDto[]): AssignmentBatch[] {
  const byBatch = new Map<string, AssignmentDto[]>()
  for (const r of rows) {
    const list = byBatch.get(r.batchId)
    if (list) list.push(r)
    else byBatch.set(r.batchId, [r])
  }
  return [...byBatch.values()].map((list) => ({
    batchId: list[0].batchId,
    title: list[0].batchTitle,
    convId: list[0].convId,
    projectId: list.find((r) => r.projectId)?.projectId ?? null,
    rows: list,
    startedAt: Math.min(...list.map((r) => Date.parse(r.startedAt))),
    endedAt: Math.max(0, ...list.map((r) => (r.endedAt ? Date.parse(r.endedAt) : 0))),
    live: list.some((r) => r.status === 'in_progress'),
  }))
}

// Aggregate glyph for a settled batch — the honest worst-of: any failure beats a stop beats done.
function batchGlyph(b: AssignmentBatch): 'done' | 'failed' | 'stopped' {
  if (b.rows.some((r) => r.status === 'failed')) return 'failed'
  if (b.rows.some((r) => r.status === 'stopped')) return 'stopped'
  return 'done'
}

/* — Project badge: the batch was work on a Studio project — click jumps to its Workbench. — */
function ProjectBadge({ projectId, title, onOpenProject }: { projectId: string | null; title: string | null; onOpenProject: (id: string) => void }): ReactElement | null {
  if (!projectId || !title) return null
  return (
    <span
      className="asg-proj"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onOpenProject(projectId)
      }}
    >
      <Icons.box size={11} />
      <span className="asg-proj-name">{title}</span>
    </span>
  )
}

/* — One expert's own slice inside a multi-expert card: name + slice title + live dot / settle glyph. — */
function AssignmentRoleRow({ row }: { row: AssignmentDto }): ReactElement {
  // useExpertMeta/useAllExperts (not the static roster): assignment rows carry custom agents' ulids.
  const meta = useExpertMeta()
  const { byId } = useAllExperts()
  const m = meta(row.roleId)
  const e = byId[row.roleId]
  return (
    <div className="asg-role-row">
      <Avatar expert={e ?? null} size={20} />
      <span className="asg-role-name">{m.name}</span>
      <span className="asg-role-title">{row.title}</span>
      {row.status === 'in_progress' ? (
        <span className="tl-dot working" style={{ background: m.color }} />
      ) : (
        <span className={`asg-glyph ${row.status}`}>{STATUS_GLYPH[row.status]}</span>
      )}
    </div>
  )
}

/* — An in-progress work item. Solo (single-row batch) renders as one flat row; a multi-expert batch gets
   the group card: batch title + avatar stack + elapsed, then a row per expert settling live. — */
function AssignmentCard({
  batch,
  now,
  projectTitle,
  onOpenConv,
  onOpenProject
}: {
  batch: AssignmentBatch
  now: number
  projectTitle: string | null
  onOpenConv: (convId: string) => void
  onOpenProject: (id: string) => void
}): ReactElement {
  const t = useT()
  const meta = useExpertMeta()
  const { byId } = useAllExperts()
  const elapsed = fmtElapsed(now - batch.startedAt)
  if (batch.rows.length === 1) {
    const row = batch.rows[0]
    const m = meta(row.roleId)
    const e = byId[row.roleId]
    return (
      <div className="tl-row" onClick={() => onOpenConv(batch.convId)} style={{ '--ws-color': m.color } as CSSProperties}>
        <Avatar expert={e ?? null} size={30} />
        <div className="tl-main">
          <div className="tl-row-top">
            <span className="tl-name">{m.name}</span>
            {batch.live && (
              <span className="tl-live">
                <span className="tl-dot working" style={{ background: m.color }} />
                {t('overview.live')}
              </span>
            )}
          </div>
          <div className="tl-title">{batch.title}</div>
        </div>
        <div className="tl-meta">
          <span className="tl-activity">{elapsed}</span>
          <ProjectBadge projectId={batch.projectId} title={projectTitle} onOpenProject={onOpenProject} />
        </div>
      </div>
    )
  }
  const roleIds = [...new Set(batch.rows.map((r) => r.roleId))]
  return (
    <div className="tl-row asg-card" onClick={() => onOpenConv(batch.convId)}>
      <div className="asg-card-head">
        <AvatarStack ids={roleIds} />
        <div className="tl-main">
          <div className="tl-row-top">
            <span className="tl-name">{batch.title}</span>
            {batch.live && (
              <span className="tl-live">
                <span className="tl-dot working" style={{ background: 'var(--accent)' }} />
                {t('overview.live')}
              </span>
            )}
          </div>
        </div>
        <div className="tl-meta">
          <span className="tl-activity">{elapsed}</span>
          <ProjectBadge projectId={batch.projectId} title={projectTitle} onOpenProject={onOpenProject} />
        </div>
      </div>
      <div className="asg-rows">
        {batch.rows.map((r) => (
          <AssignmentRoleRow key={r.id} row={r} />
        ))}
      </div>
    </div>
  )
}

/* — A finished work item (one row per batch): worst-of glyph + who + when; click jumps to the chat. — */
function DoneBatchRow({
  batch,
  projectTitle,
  onOpenConv,
  onOpenProject
}: {
  batch: AssignmentBatch
  projectTitle: string | null
  onOpenConv: (convId: string) => void
  onOpenProject: (id: string) => void
}): ReactElement {
  const t = useT()
  const glyph = batchGlyph(batch)
  const roleIds = [...new Set(batch.rows.map((r) => r.roleId))]
  const when = batch.endedAt ? (batch.endedAt >= startOfToday() ? fmtClock(batch.endedAt) : fmtDay(batch.endedAt)) : ''
  return (
    <div className="tl-row asg-done" onClick={() => onOpenConv(batch.convId)}>
      <span className={`asg-glyph big ${glyph}`} title={t(`overview.status.${glyph}`)}>
        {STATUS_GLYPH[glyph]}
      </span>
      <AvatarStack ids={roleIds} />
      <div className="tl-main">
        <div className="tl-title asg-done-title">{batch.title}</div>
      </div>
      <div className="tl-meta">
        <span className="tl-activity">{when}</span>
        <ProjectBadge projectId={batch.projectId} title={projectTitle} onOpenProject={onOpenProject} />
      </div>
    </div>
  )
}

/* — A real collaboration project — opens the Project detail — */
function ProjectRow({ project, onOpenProject }: { project: ProjectDto; onOpenProject: (id: string) => void }): ReactElement {
  const meta = useExpertMeta()
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
              const m = meta(id)
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
  onOpenProject,
  onViewAll
}: {
  onOpenExpert: (id: string) => void
  onOpenConv: (convId: string) => void
  onOpenProject: (id: string) => void
  onViewAll: () => void
}): ReactElement {
  const t = useT()
  const active = useAssignments((s) => s.active)
  const settled = useAssignments((s) => s.settled)
  const [projects, setProjects] = useState<ProjectDto[]>([])
  const [now, setNow] = useState(() => Date.now())
  // Full list (not just open ones): settled assignments still badge their project by title. Refetch on
  // project:updated so a project auto-created by a live collaboration appears (and badges) without a
  // remount — the section used to be a one-shot fetch and went stale mid-run.
  useEffect(() => {
    const refetch = (): void => {
      void window.api.project.list().then(setProjects)
    }
    refetch()
    return window.api.project.onUpdated(refetch)
  }, [])

  const activeBatchIds = new Set(active.map((r) => r.batchId))
  const liveBatches = groupBatches([...active, ...settled.filter((r) => activeBatchIds.has(r.batchId))]).sort(
    (a, b) => b.startedAt - a.startedAt
  )
  const settledBatches = groupBatches(settled.filter((r) => !activeBatchIds.has(r.batchId))).sort((a, b) => b.endedAt - a.endedAt)
  const doneToday = settledBatches.filter((b) => b.endedAt >= startOfToday())
  // Empty today → fall back to the most recent finished items, with a "recent" tag on the section head.
  const recentFallback = doneToday.length === 0
  const doneList = recentFallback ? settledBatches.slice(0, 10) : doneToday

  // Archived projects leave the default list everywhere (批4) — the Overview section follows.
  const openProjects = projects.filter((x) => x.phase !== 'done' && !x.archived)
  const projTitle = (id: string | null): string | null => (id ? (projects.find((p) => p.id === id)?.title ?? null) : null)

  // Live elapsed clock for in-progress cards — ticks only while something is running.
  useEffect(() => {
    if (liveBatches.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [liveBatches.length])

  return (
    <div className="timeline-wrap">
      <div className="tl-scroll">
        {/* "In progress" is a permanent section — when no assignment is live it renders an empty state
            (count 0 + the ready team), it is never hidden. */}
        <div className="tl-group">
          <div className="tl-group-head">
            <span>{t('overview.inProgress')}</span>
            <span className="tl-count">{liveBatches.length}</span>
          </div>
          {liveBatches.length > 0 ? (
            <div className="tl-list">
              {liveBatches.map((b) => (
                <AssignmentCard key={b.batchId} batch={b} now={now} projectTitle={projTitle(b.projectId)} onOpenConv={onOpenConv} onOpenProject={onOpenProject} />
              ))}
            </div>
          ) : (
            <div className="tl-empty">
              <div className="tl-empty-line">{t('overview.nothingRunning')}</div>
              <TeamReady onOpenExpert={onOpenExpert} />
            </div>
          )}
        </div>

        {doneList.length > 0 && (
          <div className="tl-group">
            <div className="tl-group-head">
              <span>{t('overview.doneToday')}</span>
              {recentFallback && <span className="asg-recent-tag">{t('overview.recent')}</span>}
              <span className="tl-count">{doneList.length}</span>
              <button className="asg-viewall" onClick={onViewAll}>{t('overview.viewAll')} →</button>
            </div>
            <div className="tl-list">
              {doneList.map((b) => (
                <DoneBatchRow key={b.batchId} batch={b} projectTitle={projTitle(b.projectId)} onOpenConv={onOpenConv} onOpenProject={onOpenProject} />
              ))}
            </div>
          </div>
        )}

        {openProjects.length > 0 && (
          <div className="tl-group">
            <div className="tl-group-head">
              <span>{t('overview.collabProjects')}</span>
              <span className="tl-count">{openProjects.length}</span>
            </div>
            <div className="tl-list">{openProjects.map((p) => <ProjectRow key={p.id} project={p} onOpenProject={onOpenProject} />)}</div>
          </div>
        )}

        <div className="tl-foot">
          <span>{t('overview.foot')}</span>
        </div>
      </div>
    </div>
  )
}

/* — The permanent ledger (third tab): every assignment ever, grouped by START date, filterable by role /
   project / status. Batch-level filtering — a batch matches when any of its rows does (that's the item
   the user perceives); live batches render as cards, settled ones as done rows. — */
function AssignmentsPage({ onOpenConv, onOpenProject }: { onOpenConv: (convId: string) => void; onOpenProject: (id: string) => void }): ReactElement {
  const t = useT()
  const meta = useExpertMeta()
  const [rows, setRows] = useState<AssignmentDto[]>([])
  const [projects, setProjects] = useState<ProjectDto[]>([])
  const [roleFilter, setRoleFilter] = useState('all')
  const [projFilter, setProjFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [now, setNow] = useState(() => Date.now())
  // The tab owns its full-history fetch (the app-lifetime store only keeps the Overview's bounded views);
  // effect-scoped subscription so a closed tab stops refetching.
  useEffect(() => {
    const refetch = (): void => {
      void window.api.assignments.list({}).then(setRows)
    }
    refetch()
    return window.api.assignments.onChanged(refetch)
  }, [])
  useEffect(() => {
    const refetch = (): void => {
      void window.api.project.list().then(setProjects)
    }
    refetch()
    return window.api.project.onUpdated(refetch)
  }, [])

  const batches = groupBatches(rows).sort((a, b) => b.startedAt - a.startedAt)
  const visible = batches.filter(
    (b) =>
      (roleFilter === 'all' || b.rows.some((r) => r.roleId === roleFilter)) &&
      (projFilter === 'all' || b.projectId === projFilter) &&
      (statusFilter === 'all' || (statusFilter === 'in_progress' ? b.live : !b.live && batchGlyph(b) === statusFilter))
  )
  const anyLive = visible.some((b) => b.live)
  useEffect(() => {
    if (!anyLive) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [anyLive])

  // Filter option sets come from the data itself — only roles/projects that actually own assignments.
  const roleIds = [...new Set(rows.map((r) => r.roleId))]
  const projIds = [...new Set(rows.map((r) => r.projectId).filter((x): x is string => !!x))]
  const projTitle = (id: string | null): string | null => (id ? (projects.find((p) => p.id === id)?.title ?? null) : null)

  // Date groups by START day (a work item belongs to the day it was handed over), newest day first.
  const dayStart = startOfToday()
  const dayLabel = (ms: number): string => {
    if (ms >= dayStart) return t('overview.today')
    if (ms >= dayStart - 86_400_000) return t('overview.yesterday')
    return new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
  }
  const groups: { label: string; items: AssignmentBatch[] }[] = []
  for (const b of visible) {
    const label = dayLabel(b.startedAt)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(b)
    else groups.push({ label, items: [b] })
  }

  return (
    <div className="timeline-wrap">
      <div className="tl-scroll">
        <div className="asg-filters">
          <SelectMenu
            className="asg-filter-sel"
            value={roleFilter}
            onChange={setRoleFilter}
            options={[{ value: 'all', label: t('overview.filter.allRoles') }, ...roleIds.map((id) => ({ value: id, label: meta(id).name }))]}
          />
          <SelectMenu
            className="asg-filter-sel"
            value={projFilter}
            onChange={setProjFilter}
            options={[{ value: 'all', label: t('overview.filter.allProjects') }, ...projIds.map((id) => ({ value: id, label: projTitle(id) ?? id }))]}
          />
          <SelectMenu
            className="asg-filter-sel"
            value={statusFilter}
            onChange={setStatusFilter}
            options={[
              { value: 'all', label: t('overview.filter.allStatuses') },
              { value: 'in_progress', label: t('overview.status.in_progress') },
              { value: 'done', label: t('overview.status.done') },
              { value: 'failed', label: t('overview.status.failed') },
              { value: 'stopped', label: t('overview.status.stopped') }
            ]}
          />
        </div>

        {groups.length === 0 ? (
          <div className="tl-empty">
            <div className="tl-empty-line">{t('overview.empty')}</div>
          </div>
        ) : (
          groups.map((g) => (
            <div className="tl-group" key={g.label}>
              <div className="tl-group-head">
                <span>{g.label}</span>
                <span className="tl-count">{g.items.length}</span>
              </div>
              <div className="tl-list">
                {g.items.map((b) =>
                  b.live ? (
                    <AssignmentCard key={b.batchId} batch={b} now={now} projectTitle={projTitle(b.projectId)} onOpenConv={onOpenConv} onOpenProject={onOpenProject} />
                  ) : (
                    <DoneBatchRow key={b.batchId} batch={b} projectTitle={projTitle(b.projectId)} onOpenConv={onOpenConv} onOpenProject={onOpenProject} />
                  )
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function StudioStats(): ReactElement {
  const meta = useExpertMeta()
  const [a, setA] = useState<AnalyticsSummary | null>(null)
  // Assignments are the in-progress source of truth (docs/assignments-design.md §6): a dock- or
  // chat-launched work batch counts; plain chat doesn't. One BATCH = one work item the user perceives.
  const active = useAssignments((s) => s.active)
  useEffect(() => {
    void window.api.analytics.summary().then(setA)
  }, [])
  if (!a) return <div className="studio-stats" />

  const total = a.usage.conversationsTotal
  const inProgress = new Set(active.map((r) => r.batchId)).size
  const done = Math.max(0, total - Math.min(inProgress, total))
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
          <div className="st-cell"><div className="st-num">{done}</div><div className="st-lbl">done</div></div>
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
              const m = meta(r.id)
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
  const t = useT()
  const [tab, setTab] = useState('activity')
  return (
    <div className="main-col">
      <div className="conv-header">
        <span className="conv-title">Overview</span>
        <Segmented
          className="studio-tabs"
          options={[
            { v: 'activity', l: t('overview.tab.activity') },
            { v: 'assignments', l: t('overview.tab.assignments') },
            { v: 'stats', l: t('overview.tab.stats') }
          ]}
          value={tab}
          onChange={setTab}
        />
        <span className="conv-sub" style={{ marginLeft: 'auto' }}>
          {tab === 'activity' ? 'live work · right now' : tab === 'assignments' ? 'work items · all time' : 'local analytics · today'}
        </span>
      </div>
      {tab === 'activity' ? (
        <div className="studio-body">
          <ActivityTimeline onOpenExpert={onOpenExpert} onOpenConv={onOpenConv} onOpenProject={onOpenProject} onViewAll={() => setTab('assignments')} />
          <StudioStats />
        </div>
      ) : tab === 'assignments' ? (
        <div className="studio-body">
          <AssignmentsPage onOpenConv={onOpenConv} onOpenProject={onOpenProject} />
        </div>
      ) : (
        <StatsPage />
      )}
    </div>
  )
}
