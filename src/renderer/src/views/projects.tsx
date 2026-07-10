/* ============================================================
   NicoSoft AI Studio — Projects
   List + live Workbench detail, backed by the real project
   service/DB (phase 5d, doc 19 §1/§13). The detail page is a
   real-time multi-expert orchestration view; its lanes + tests
   render from the persisted plan/tests now, and the live streams
   (services / approvals / consult arrows / Danny dock) wire up in
   phase 5c.
   ============================================================ */
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Icons, toolIconName } from '@/components/icons'
import { Avatar, AvatarStack } from '@/components/primitives'
import { STUDIO_DATA, PHASES, PHASE_INDEX } from '@/data/studio-data'
import { useAllExperts } from '@/lib/all-experts'
import type { Expert } from '@/types'
import { toast } from '@/stores/toast'
import { useT } from '@/stores/locale'
import { Modal } from '@/components/modal'
import { ConfirmDialog } from '@/components/dialogs/confirm-dialog'
import { RowMenu } from '@/views/extensions'

// DTOs derived from the IPC surface — the renderer never imports main-process modules.
type ProjectDto = Awaited<ReturnType<typeof window.api.project.list>>[number]
type TaskDto = ProjectDto['plan'][number]
type TestDto = ProjectDto['tests'][number]

// project.phase is stored lowercase (planning|executing|testing|done); the chip + rail label in TitleCase.
const PHASE_LABEL: Record<string, string> = { planning: 'Planning', executing: 'Executing', testing: 'Testing', done: 'Done' }
const phaseTitle = (p: string): string => PHASE_LABEL[p] ?? 'Planning'

// Role display name for the Workbench: built-ins + LIVING custom roles resolve via useAllExperts' byId; a
// role that no longer exists (deleted custom) degrades to a short id, full id on :title via callers.
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/
const nameOf = (byId: Record<string, Expert>, id: string): string => byId[id]?.name ?? (ULID_RE.test(id) ? id.slice(0, 6) + '…' : id)

// A doer lane's status, derived from its tasks: all done → done, any in-flight → working, any parked (collab
// wait/idle) → waiting, else watching. 'doing' outranks 'waiting' so a mid-work expert still reads as working.
function laneStatus(tasks: TaskDto[]): string {
  if (tasks.length > 0 && tasks.every((t) => t.status === 'done')) return 'done'
  if (tasks.some((t) => t.status === 'doing')) return 'working'
  if (tasks.some((t) => t.status === 'waiting')) return 'waiting'
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
  onNew,
  onArchive,
  onDelete
}: {
  projects: ProjectDto[]
  onOpen: (id: string) => void
  onNew: () => void
  onArchive: (p: ProjectDto, archived: boolean) => void
  onDelete: (p: ProjectDto) => void
}): ReactElement {
  const t = useT()
  const [showArchived, setShowArchived] = useState(false)
  const active = projects.filter((p) => !p.archived)
  const archived = projects.filter((p) => p.archived)

  const card = (p: ProjectDto): ReactElement => (
    <div className={'proj-card' + (p.archived ? ' archived' : '')} key={p.id} onClick={() => onOpen(p.id)}>
      <div className="pc-top">
        <span className="pc-title">{p.title}</span>
        <PhaseChip phase={p.phase} />
        {/* the whole card opens the project — the menu must not */}
        <span className="pc-menu" onClick={(e) => e.stopPropagation()}>
          <RowMenu
            items={[
              { label: p.archived ? t('projects.unarchiveAction') : t('projects.archiveAction'), onClick: () => onArchive(p, !p.archived) },
              { label: t('projects.deleteAction'), danger: true, onClick: () => onDelete(p) }
            ]}
          />
        </span>
      </div>
      <div className="pc-goal">{goalSummary(p.goal)}</div>
      <div className="pc-foot">
        <AvatarStack ids={p.experts} size={24} />
        <ProgressBar value={p.progress} />
        <span className="pc-pct">{Math.round(p.progress * 100)}%</span>
      </div>
    </div>
  )

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
          <>
            {active.length > 0 && <div className="proj-list">{active.map(card)}</div>}
            {archived.length > 0 && (
              <>
                <button className="proj-arch-toggle" onClick={() => setShowArchived((v) => !v)}>
                  <span className={'pat-chev' + (showArchived ? ' open' : '')}>
                    <Icons.chevronRight size={12} />
                  </span>
                  Archived ({archived.length})
                </button>
                {showArchived && <div className="proj-list">{archived.map(card)}</div>}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/* — New Project dialog: a folder + a goal; the name is optional (blank → generated from the goal).
     Doubles as the Workbench Edit dialog when `project` is set — same fields, project.update on save. — */
function NewProjectDialog({
  project = null,
  onClose,
  onCreated
}: {
  project?: ProjectDto | null // edit mode when set
  onClose: () => void
  onCreated: (id: string) => void
}): ReactElement {
  const t = useT()
  const isEdit = project !== null
  const [name, setName] = useState(project?.title ?? '')
  const [goal, setGoal] = useState(project?.goal ?? '')
  const [cwd, setCwd] = useState(project?.cwd ?? '')
  const [busy, setBusy] = useState(false)
  const cwdChanged = isEdit && cwd.trim() !== (project.cwd ?? '')

  const pick = async (): Promise<void> => {
    const dir = await window.api.project.pick()
    if (dir) setCwd(dir)
  }
  const create = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (isEdit) {
        const updated = await window.api.project.update(project.id, {
          title: name.trim(),
          goal: goal.trim() || null,
          cwd: cwd.trim() || null
        })
        if (!updated) throw new Error('project gone')
        toast.success(t('projects.updated'))
        onCreated(project.id)
      } else {
        const p = await window.api.project.create({
          title: name.trim(),
          goal: goal.trim() || null,
          cwd: cwd.trim() || null
        })
        toast.success(t('projects.created'))
        onCreated(p.id)
      }
    } catch {
      toast.error(t(isEdit ? 'projects.updateFailed' : 'projects.createFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={isEdit ? 'Edit project' : 'New Project'}
      onClose={onClose}
      className="wide"
      foot={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={create} disabled={busy || (!goal.trim() && !name.trim())}>
            {busy ? (isEdit ? 'Saving…' : 'Creating…') : isEdit ? 'Save changes' : 'Create project'}
          </button>
        </>
      }
    >
      <div>
        <label className="field-label">Project folder</label>
        <div className="np-path">
          <input className="input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/your/project" />
          <button className="btn ghost np-browse" onClick={pick} aria-label="Browse for a folder" title="Browse for a folder">
            <Icons.folder size={16} />
          </button>
        </div>
        {cwdChanged && (
          <div className="wf-warn">
            ⚠ <span>Changing the folder only affects <b>future</b> instructions — files the team already created stay where they are.</span>
          </div>
        )}
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
    </Modal>
  )
}

// HH:MM clock for a card footer.
function fmtClock(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

type LaneStatus = { state: string; label: string }
type LaneEvent = { id: string; toolName: string; target: string | null; zone?: string; mediaUrl?: string | null; createdAt?: string }

/* — one event card on a lane's timeline (READ / WRITE / BASH …); head(icon+tool) / target / thumb / foot — */
function EventCard({ ev, running, onClick }: { ev: LaneEvent; running?: boolean; onClick?: () => void }): ReactElement {
  const Ico = Icons[toolIconName(ev.toolName)]
  return (
    <div className={'wb-card' + (running ? ' running' : '') + (onClick ? ' clickable' : '')} data-ev={ev.id} onClick={onClick}>
      <div className="wb-card-head">
        <span className="wb-card-ic"><Ico size={13} /></span>
        <span className="wb-tool">{ev.toolName}</span>
        {running ? <span className="wb-run-dot" /> : null}
      </div>
      {ev.target ? <div className="wb-target" title={ev.target}>{ev.target}</div> : null}
      {/* rich artifact: an image the tool produced (computer-use screenshot / generated image) — nsai-media:// loads directly */}
      {ev.mediaUrl ? <img className="wb-card-thumb" src={ev.mediaUrl} alt="" loading="lazy" /> : null}
      <div className="wb-card-foot">
        {ev.createdAt ? <span className="wb-ts">{fmtClock(ev.createdAt)}</span> : null}
        {ev.zone === 'yellow' ? <span className="wb-tag auto"><Icons.shield size={9} /> auto-approved</span> : null}
        {ev.zone === 'red' ? <span className="wb-tag danger"><Icons.alert size={9} /> needs approval</span> : null}
      </div>
    </div>
  )
}

// Detail popover for one orchestration event — the full target (long commands/paths aren't truncated here)
// plus its tool + timestamp + zone. (We persist the call's target, not its full output, so that's what shows.)
function EventDetailModal({ ev, onClose }: { ev: LaneEvent; onClose: () => void }): ReactElement {
  const Ico = Icons[toolIconName(ev.toolName)]
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog ev-detail" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <span className="dh-title"><Ico size={15} />{ev.toolName}</span>
          {ev.createdAt ? <span className="ev-detail-ts">{fmtClock(ev.createdAt)}</span> : null}
          <button className="icon-btn" onClick={onClose}><Icons.x size={16} /></button>
        </div>
        {ev.target ? <pre className="ev-detail-target">{ev.target}</pre> : <div className="ev-detail-empty">No target recorded for this step.</div>}
        {ev.mediaUrl ? <img className="ev-detail-media" src={ev.mediaUrl} alt="tool output" /> : null}
        {ev.zone === 'yellow' ? <div className="ev-detail-zone auto"><Icons.shield size={11} /> auto-approved</div> : null}
        {ev.zone === 'red' ? <div className="ev-detail-zone danger"><Icons.alert size={11} /> needed approval</div> : null}
      </div>
    </div>
  )
}

/* — one swimlane: sticky gutter (id block + status line below) + a horizontal track of cards with a
     .wb-conn connector between them. The coordinator lane renders as a compact conductor ribbon.
     Consult interactions are NOT separate cards — their assign_task/send_message tool calls already sit
     on the track as event cards; the ConsultLayer anchors one arrow per interaction onto those cards. — */
function Lane({
  roleId,
  conductor,
  status,
  events,
  onOpenExpert,
  onSelectEvent
}: {
  roleId: string
  conductor?: boolean
  status: LaneStatus
  events: LaneEvent[]
  onOpenExpert: (id: string) => void
  onSelectEvent?: (ev: LaneEvent) => void
}): ReactElement {
  const { byId } = useAllExperts() // custom roles resolve too; a deleted role degrades to the short id
  const e = byId[roleId]
  const lastRunning = !conductor && status.state === 'running' ? events.length - 1 : -1
  return (
    <div className={'wb-lane' + (conductor ? ' conductor' : '')} data-role={roleId} style={{ '--lane': e?.color ?? 'var(--accent)' } as CSSProperties}>
      <div className="wb-gutter" onClick={() => onOpenExpert(roleId)}>
        <div className="wb-gutter-id">
          {e ? <Avatar expert={e} size={28} /> : <span className="wb-avatar-fallback">{roleId[0]?.toUpperCase()}</span>}
          <div className="wb-gutter-meta">
            <div className="wb-gutter-name" style={{ color: e?.color ?? 'var(--accent)' }} title={roleId}>{nameOf(byId, roleId)}</div>
            <div className="wb-gutter-role">{e?.specialty?.split('—')[0]?.trim() ?? (ULID_RE.test(roleId) ? 'deleted role' : roleId)}</div>
          </div>
        </div>
        <div className={'wb-lane-status ' + status.state}>
          <span className="wb-st-dot" /> {status.label}
        </div>
      </div>
      <div className="wb-track">
        {events.length === 0 ? (
          <span className="wb-lane-empty">no activity yet</span>
        ) : (
          events.map((ev, i) => (
            <Fragment key={ev.id}>
              {i > 0 && <span className="wb-conn" />}
              <EventCard ev={ev} running={i === lastRunning} onClick={onSelectEvent ? () => onSelectEvent(ev) : undefined} />
            </Fragment>
          ))
        )}
      </div>
    </div>
  )
}

// One arrow PER INTERACTION, anchored to the interaction's own cards: the tail sits on the sender's
// assign_task/send_message event card, the ARROWHEAD lands on the receiver's temporally-nearest card —
// so the line itself reads "who initiated → who received" for every exchange, not one deduped edge per
// pair. Resolved in ProjectDetail (it holds both the consult log and the tool events); missing anchors
// (projects predating tool-event capture) degrade to the lane track.
interface ConsultEdge {
  id: string
  from: string
  to: string
  kind: 'assign' | 'send'
  text: string | null
  fromEvId: string | null
  toEvId: string | null
}

/* — cross-lane consult arrows (doc 19): an SVG bezier PER INTERACTION, from the sender's own event card
     to the receiver's nearest card, drawn in the .wb-lanes coordinate space so it scrolls with the
     content. Measure card rects, retry across frames until layout settles, re-measure on resize. — */
function ConsultLayer({ lanesEl, edges }: { lanesEl: HTMLDivElement | null; edges: ConsultEdge[] }): ReactElement | null {
  const { byId } = useAllExperts()
  type Measured = { fx: number; fy: number; tx: number; ty: number; lx: number; ly: number; kind: 'assign' | 'send'; to: string; text: string | null }
  const [geo, setGeo] = useState<{ w: number; h: number; edges: Measured[] } | null>(null)
  useLayoutEffect(() => {
    if (!lanesEl || edges.length === 0) {
      setGeo(null)
      return
    }
    let raf = 0
    let tries = 0
    const anchorKey = (evId: string | null, roleId: string): string => evId ?? `lane:${roleId}`
    const anchorRect = (evId: string | null, roleId: string): DOMRect | null => {
      const el = (evId && lanesEl.querySelector(`[data-ev="${evId}"]`)) || lanesEl.querySelector(`.wb-lane[data-role="${roleId}"] .wb-track`)
      const r = el?.getBoundingClientRect()
      return r && r.width > 0 ? r : null
    }
    const measure = (): boolean => {
      const ir = lanesEl.getBoundingClientRect()
      // One x-slot registry per (anchor element × edge side): the tail wants the card center, the head
      // wants the tail's x VERTICALLY PROJECTED into the receiver card (clamped to it) — near-vertical
      // lines whose heads spread along the card instead of piling on its center. A wanted x that lands
      // within 14px of an already-claimed x on the same edge steps aside (left first, then right).
      const used = new Map<string, number[]>()
      const claimX = (key: string, rect: DOMRect, want: number): number => {
        const lo = rect.left - ir.left + 12
        const hi = rect.right - ir.left - 12
        const clamp = (v: number): number => Math.min(hi, Math.max(lo, v))
        const taken = used.get(key) ?? []
        const collides = (v: number): boolean => taken.some((u) => Math.abs(u - v) < 14)
        let x = clamp(want)
        while (collides(x) && x > lo) x = Math.max(lo, x - 14)
        if (collides(x)) {
          x = clamp(want)
          while (collides(x) && x < hi) x = Math.min(hi, x + 14)
        }
        taken.push(x)
        used.set(key, taken)
        return x
      }
      const out: Measured[] = []
      for (const e of edges) {
        const fr = anchorRect(e.fromEvId, e.from)
        const tr = anchorRect(e.toEvId, e.to)
        if (!fr || !tr) continue
        // Exit the sender card on the side FACING the receiver's lane (below → bottom edge, above → top
        // edge) and land the arrowhead on the receiver card's facing edge — the marker stays visible
        // instead of dying under the card.
        const downward = tr.top >= fr.bottom
        const fx = claimX(`${anchorKey(e.fromEvId, e.from)}:${downward ? 'b' : 't'}`, fr, fr.left - ir.left + fr.width / 2)
        const tx = claimX(`${anchorKey(e.toEvId, e.to)}:${downward ? 't' : 'b'}`, tr, fx)
        out.push({
          fx,
          fy: (downward ? fr.bottom : fr.top) - ir.top,
          tx,
          ty: (downward ? tr.top - 2 : tr.bottom + 2) - ir.top,
          lx: 0,
          ly: 0,
          kind: e.kind,
          to: nameOf(byId, e.to),
          text: e.text
        })
      }
      // Label positions: midpoint, then greedily pushed down while it would sit on an earlier label —
      // stacked chips instead of an unreadable pile when edges cross the same region.
      const placed: { x: number; y: number }[] = []
      for (const m of out) {
        let x = (m.fx + m.tx) / 2
        let y = (m.fy + m.ty) / 2
        while (placed.some((p) => Math.abs(p.x - x) < 110 && Math.abs(p.y - y) < 24)) y += 24
        placed.push({ x, y })
        m.lx = x
        m.ly = y
      }
      setGeo({ w: lanesEl.scrollWidth, h: lanesEl.offsetHeight, edges: out })
      return out.length > 0
    }
    const loop = (): void => {
      measure()
      if (++tries < 10) raf = requestAnimationFrame(loop)
    }
    loop()
    const ro = new ResizeObserver(measure)
    ro.observe(lanesEl)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [lanesEl, edges, byId])

  if (!geo || geo.edges.length === 0) return null
  return (
    <>
      <svg className="wb-consult-layer" width={geo.w} height={geo.h} viewBox={`0 0 ${geo.w} ${geo.h}`}>
        <defs>
          {/* filled head so the direction survives the dashed stroke; sized to the 1.5px stroke */}
          <marker id="wb-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0 0 L6 3 L0 6 Z" fill="var(--accent)" />
          </marker>
        </defs>
        {geo.edges.map((ed, i) => {
          const midY = (ed.fy + ed.ty) / 2
          return (
            <Fragment key={i}>
              <circle className="wb-consult-origin" cx={ed.fx} cy={ed.fy} r={3} />
              <path className="wb-consult-path" d={`M ${ed.fx} ${ed.fy} C ${ed.fx} ${midY}, ${ed.tx} ${midY}, ${ed.tx} ${ed.ty}`} markerEnd="url(#wb-arrow)" />
            </Fragment>
          )
        })}
      </svg>
      {geo.edges.map((ed, i) => (
        <div key={i} className="wb-consult-label" style={{ left: ed.lx, top: ed.ly }} title={ed.text ?? undefined}>
          <span className="wb-cl-ic">{ed.kind === 'assign' ? <Icons.kanban size={11} /> : <Icons.message size={11} />}</span>
          <span className="wb-cl-name">{ed.kind} → {ed.to}</span>
        </div>
      ))}
    </>
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

type FindingDto = ProjectDto['review'][number]

/* — Review (Lens) strip: defects the team's studio_lens runs surfaced & vetted on this project. Sits
   between the orchestration lanes and the Test & review strip; mirrors the ProjectTests strip. — */
function ProjectReview({ review }: { review: FindingDto[] }): ReactElement {
  const counts = review.reduce((a, f) => ((a[f.verdict] = (a[f.verdict] ?? 0) + 1), a), {} as Record<string, number>)
  return (
    <div className="wb-tests wb-review">
      <div className="wb-tests-head">
        <span className="wb-section-label">
          <Icons.compass size={14} /> Review (Lens)
        </span>
        <span className="wb-section-sub">defects Lens found &amp; vetted</span>
        <span className="wb-tests-legend">
          <span className="wbl fail">{counts.confirmed ?? 0} confirmed</span>
          <span className="wbl pending">{counts.refuted ?? 0} refuted</span>
          <span className="wbl pass">{counts.pass ?? 0} clean</span>
        </span>
      </div>
      <div className="wb-tests-strip">
        {review.map((f, i) => (
          <div className={'wb-test wb-finding ' + f.verdict} key={i} title={f.feedback}>
            <span className={'wb-test-icon ' + f.verdict}>
              {f.verdict === 'confirmed' && <Icons.alert size={12} />}
              {f.verdict === 'refuted' && <Icons.x size={12} />}
              {f.verdict === 'pass' && <Icons.check size={12} />}
            </span>
            <span className="wb-finding-top">
              {f.severity && <span className={'wb-sev ' + f.severity}>{f.severity}</span>}
              <span className="wb-test-title">{f.subject}</span>
            </span>
            {f.file && <span className="wb-finding-file">{f.file}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

type PendingDto = Awaited<ReturnType<typeof window.api.approval.list>>[number]

// The Bash command (or tool name) a deferred red-zone action would run — shown in the approval bar.
function pendingCommand(p: PendingDto): string {
  return (p.toolInput as { command?: string })?.command ?? p.toolName
}

/* — Project detail = live workbench (lanes + tests from the plan; live streams in phase 5c) — */
function ProjectDetail({
  project,
  onBack,
  onOpenExpert,
  onEdit,
  onArchive,
  onDelete
}: {
  project: ProjectDto
  onBack: () => void
  onOpenExpert: (id: string) => void
  onEdit: () => void
  onArchive: () => void
  onDelete: () => void
}): ReactElement {
  const t = useT()
  const { byId } = useAllExperts()
  const doers = project.experts.filter((id) => id !== 'coordinator')
  const [lanesEl, setLanesEl] = useState<HTMLDivElement | null>(null)
  // One edge PER consult interaction: tail = the sender's k-th assign_task/send_message event card (the
  // consult log and the tool-event log record the same calls in the same order, so pairing the k-th
  // consult of a (sender, kind) with the k-th matching event card is exact); head = the receiver's first
  // card at-or-after the interaction (where they picked it up), else their last card. Missing anchors
  // (pre-capture projects) leave the ids null — ConsultLayer degrades to the lane track.
  const consultEdges = useMemo<ConsultEdge[]>(() => {
    const CONSULT_TOOL: Record<string, string> = { assign: 'assign_task', send: 'send_message' }
    const used = new Map<string, number>()
    return project.consults.map((c) => {
      const key = `${c.from}:${c.kind}`
      const k = used.get(key) ?? 0
      used.set(key, k + 1)
      const fromEv = project.toolEvents.filter((ev) => ev.roleId === c.from && ev.toolName === CONSULT_TOOL[c.kind])[k] ?? null
      const toEvs = project.toolEvents.filter((ev) => ev.roleId === c.to)
      const toEv = toEvs.find((ev) => ev.createdAt >= c.createdAt) ?? toEvs[toEvs.length - 1] ?? null
      return { id: c.id, from: c.from, to: c.to, kind: c.kind, text: c.text, fromEvId: fromEv?.id ?? null, toEvId: toEv?.id ?? null }
    })
  }, [project.consults, project.toolEvents])
  const doerNames = doers.map((rid) => nameOf(byId, rid)).join(' + ')
  // Coordinator lane = a compact conductor ribbon (PLAN → DISPATCH → WATCH), synthesized from project state.
  const conductorEvents: LaneEvent[] = [
    { id: 'c-plan', toolName: 'Plan', target: `${project.plan.length} task${project.plan.length === 1 ? '' : 's'}` },
    { id: 'c-dispatch', toolName: 'Dispatch', target: doerNames || 'team' },
    { id: 'c-watch', toolName: 'Watch', target: project.phase === 'done' ? 'complete' : 'for green tests' }
  ]
  const laneStatusOf = (rid: string): LaneStatus => {
    const s = laneStatus(project.plan.filter((t) => t.assigneeRoleId === rid))
    return s === 'working' ? { state: 'running', label: 'working' } : { state: s, label: s }
  }
  const eventsOf = (rid: string): LaneEvent[] => {
    const tools = project.toolEvents.filter((t) => t.roleId === rid)
    if (tools.length > 0) return tools
    // fallback for projects predating tool-event capture: show the assigned tasks as cards
    return project.plan.filter((t) => t.assigneeRoleId === rid).map((t) => ({ id: t.id, toolName: 'Task', target: t.title, zone: 'green' }))
  }
  const [pending, setPending] = useState<PendingDto[]>([])
  const [convId, setConvId] = useState<string | null>(null)
  const [coordinatorReply, setCoordinatorReply] = useState('')
  const [dockExpanded, setDockExpanded] = useState(false)
  const [goalExpanded, setGoalExpanded] = useState(false)
  const [eventDetail, setEventDetail] = useState<LaneEvent | null>(null)
  const [running, setRunning] = useState(false)
  const [streamId, setStreamId] = useState('') // lifted from send()'s closure so the dock Stop button can abort the run
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
      setCoordinatorReply([...msgs].reverse().find((m) => m.author !== 'user')?.content ?? '')
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
    let sid = '' // the listeners filter on the closure value; the state copy is for the Stop button
    try {
      await window.api.conversations.append(convId, { author: 'user', content: prompt })
      ;({ streamId: sid } = await window.api.coordinator.run({ convId, prompt, cwd: project.cwd ?? null, origin: 'dock' }))
      setStreamId(sid)
    } catch (e) {
      // The run never started — unstick the dock instead of leaving `running` true forever.
      setRunning(false)
      toast.error(e instanceof Error ? e.message : t('projects.startFailed'))
      return
    }
    // BOTH terminal events must settle the dock: a run ending in coordinator:error never fires onDone —
    // listening to done alone leaked a listener per failed run and left the dock disabled until reopen.
    // A Stop lands here too: the abort rejects the run, coordinator:error carries the reason.
    const settle = (): void => {
      offDone()
      offErr()
      setRunning(false)
      setStreamId('')
    }
    const offDone = window.api.coordinator.onDone(async (d) => {
      if (d.streamId !== sid) return
      settle()
      const msgs = await window.api.conversations.messages(convId)
      setCoordinatorReply([...msgs].reverse().find((m) => m.author !== 'user')?.content ?? '')
    })
    const offErr = window.api.coordinator.onError((d) => {
      if (d.streamId !== sid) return
      settle()
      setCoordinatorReply(`⚠ ${d.message}`)
    })
  }

  const stopRun = (): void => {
    if (streamId) void window.api.coordinator.stop(streamId)
  }

  const resolve = async (id: string, ok: boolean): Promise<void> => {
    try {
      if (ok) await window.api.approval.approve(id)
      else await window.api.approval.reject(id)
      setPending((ps) => ps.filter((p) => p.id !== id))
      toast.success(ok ? t('projects.approved') : t('projects.rejected'))
    } catch {
      toast.error(ok ? t('projects.approveFailed') : t('projects.rejectFailed'))
    }
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
        {project.archived && <span className="proj-arch-badge">archived</span>}
        <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={onEdit} title={t('projects.editAction')}>
          <Icons.edit size={15} /> {t('projects.editAction')}
        </button>
        <button className="btn ghost sm" onClick={onArchive} title={project.archived ? t('projects.unarchiveAction') : t('projects.archiveAction')}>
          <Icons.box size={15} /> {project.archived ? t('projects.unarchiveAction') : t('projects.archiveAction')}
        </button>
        <button className="btn ghost sm" onClick={onDelete} title={t('projects.deleteAction')}>
          <Icons.trash size={15} /> {t('projects.deleteAction')}
        </button>
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
          <span
            className={'wb-goal ' + (goalExpanded ? 'expanded' : 'collapsed')}
            onClick={() => setGoalExpanded((v) => !v)}
            title={goalExpanded ? 'Click to collapse' : 'Click to expand'}
          >
            {project.goal || 'No description yet'}
          </span>
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
              — {nameOf(byId, pending[0].roleId)} wants to run a destructive command{' '}
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

        <div className="wb-orch-wrap">
          <div className="wb-block-head">
            <span className="wb-bh-ic"><Icons.kanban size={14} /></span>
            Orchestration
            <span className="wb-bh-sub">{project.phase === 'done' ? '— wrapped up' : '— live, parallel work across the team'}</span>
            <span className="wb-bh-spacer" />
            <span className="wb-legend">
              <span><i style={{ background: 'var(--accent)' }} /> running</span>
              <span><i style={{ background: 'var(--success)' }} /> done</span>
              <span><i style={{ background: 'var(--error)' }} /> needs approval</span>
            </span>
          </div>
          <div className="wb-orch">
            <div className="wb-orch-inner">
              <div className="wb-lanes" ref={setLanesEl}>
                <Lane
                  roleId="coordinator"
                  conductor
                  status={project.phase === 'done' ? { state: 'done', label: 'done' } : { state: 'watching', label: 'watching' }}
                  events={conductorEvents}
                  onOpenExpert={onOpenExpert}
                  onSelectEvent={setEventDetail}
                />
                {doers.map((rid) => (
                  <Lane
                    key={rid}
                    roleId={rid}
                    status={laneStatusOf(rid)}
                    events={eventsOf(rid)}
                    onOpenExpert={onOpenExpert}
                    onSelectEvent={setEventDetail}
                  />
                ))}
              </div>
              <ConsultLayer lanesEl={lanesEl} edges={consultEdges} />
            </div>
          </div>
        </div>

        {project.review.length > 0 && <ProjectReview review={project.review} />}
        {project.tests.length > 0 && <ProjectTests tests={project.tests} />}
      </div>

      {/* Dock — Danny's latest report + send the team a new instruction from inside the project (5c-C2) */}
      <div className="wb-dock">
        {coordinatorReply ? (
          <div className="wb-dock-msg">
            <Avatar expert={STUDIO_DATA.EXPERT_BY_ID.coordinator} size={22} />
            <div className="wb-dock-body">
              <div className="wb-dock-who">
                {STUDIO_DATA.EXPERT_BY_ID.coordinator?.name} <span className="wb-dock-at">@you</span>
                {!running ? (
                  <button className="wb-dock-toggle" onClick={() => setDockExpanded((v) => !v)}>
                    {dockExpanded ? 'Collapse' : 'Expand'}
                  </button>
                ) : null}
              </div>
              <div className={'wb-dock-text' + (dockExpanded ? '' : ' collapsed')}>{running ? 'Working on it…' : coordinatorReply}</div>
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
            placeholder={convId ? `Reply to ${STUDIO_DATA.EXPERT_BY_ID.coordinator?.name ?? 'the coordinator'}, or send the team a new instruction…` : 'No conversation linked to this project yet'}
            disabled={!convId || running}
          />
          {running ? (
            <button className="cmp-stop" onClick={stopRun} disabled={!streamId} title={t('conv.stop')}>
              <span className="stop-sq" /> {t('conv.stop')}
            </button>
          ) : (
            <button className="wb-dock-send" onClick={() => void send()} disabled={!convId || !draft.trim()}>
              <Icons.arrowUp size={16} />
            </button>
          )}
        </div>
      </div>
      {eventDetail && <EventDetailModal ev={eventDetail} onClose={() => setEventDetail(null)} />}
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
  const t = useT()
  const [projects, setProjects] = useState<ProjectDto[]>([])
  const [detail, setDetail] = useState<ProjectDto | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [toDelete, setToDelete] = useState<ProjectDto | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    setProjects(await window.api.project.list())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // Load the active project's full detail (plan + tests) whenever the selection changes. A null get()
  // means the persisted selection points at a deleted project — clear it so the stale id doesn't stick.
  useEffect(() => {
    if (!activeProject) {
      setDetail(null)
      return
    }
    let live = true
    void window.api.project.get(activeProject).then((p) => {
      if (!live) return
      if (!p) return onSelect(null)
      setDetail(p)
    })
    return () => {
      live = false
    }
  }, [activeProject, onSelect])

  // phase 5c: a live collab event changed a project (tasks doing→done, phase) — refetch the list + an
  // open detail so the workbench updates in real time.
  useEffect(() => {
    return window.api.project.onUpdated(({ projectId }) => {
      void reload()
      if (projectId === activeProject) void window.api.project.get(projectId).then((p) => (p ? setDetail(p) : onSelect(null)))
    })
  }, [activeProject, reload, onSelect])

  // Confirmed delete (list-card menu or Workbench header): the handler stops any in-flight run on the
  // project's conversations, then the service unlinks them (chats survive) and cascades the
  // plan/tests/timeline away.
  const doDelete = async (p: ProjectDto): Promise<void> => {
    try {
      await window.api.project.remove(p.id)
      toast.success(t('projects.deleted'))
      if (activeProject === p.id) onSelect(null)
      void reload()
    } catch {
      toast.error(t('projects.deleteFailed'))
    }
  }
  const doArchive = async (p: ProjectDto, archived: boolean): Promise<void> => {
    try {
      await window.api.project.archive(p.id, archived)
      toast.success(t(archived ? 'projects.archivedToast' : 'projects.unarchivedToast'))
      void reload() // the broadcast also refreshes an open detail
    } catch {
      toast.error(t('projects.archiveFailed'))
    }
  }
  const confirmDialog = toDelete && (
    <ConfirmDialog
      title={t('projects.deleteTitle')}
      body={t('projects.deleteBody', { title: toDelete.title })}
      confirmLabel={t('projects.deleteAction')}
      danger
      onConfirm={() => void doDelete(toDelete)}
      onClose={() => setToDelete(null)}
    />
  )

  if (activeProject && detail) {
    return (
      <>
        <ProjectDetail
          project={detail}
          onBack={() => onSelect(null)}
          onOpenExpert={onOpenExpert}
          onEdit={() => setEditOpen(true)}
          onArchive={() => void doArchive(detail, !detail.archived)}
          onDelete={() => setToDelete(detail)}
        />
        {editOpen && (
          // save closes the dialog; the handler's project:updated broadcast refreshes list + detail
          <NewProjectDialog project={detail} onClose={() => setEditOpen(false)} onCreated={() => setEditOpen(false)} />
        )}
        {confirmDialog}
      </>
    )
  }
  return (
    <>
      <ProjectsList
        projects={projects}
        onOpen={onSelect}
        onNew={() => setNewOpen(true)}
        onArchive={(p, archived) => void doArchive(p, archived)}
        onDelete={setToDelete}
      />
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
      {confirmDialog}
    </>
  )
}
