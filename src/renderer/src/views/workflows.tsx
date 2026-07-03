/* ============================================================
   NicoSoft AI Studio — Workflows (docs/workflow-design.md · UI 原型 v4.2)
   A workflow = a SAVED multi-expert orchestration script: agent(prompt, { role })
   steps over the shared script engine. Three surfaces in this view:
     list   — rows + source badges + draft gate + .nsw import (security-scanned)
     editor — fields ⇄ meta two-way sync, params table, script + lint row, DAG projection
     run    — live panel (workflow:run:event) + read-only replay of past runs
   Runs live in HIDDEN conversations (kind='workflow') — replay reads
   conversations:messages + agent:transcript; nothing here touches the chat store.
   ============================================================ */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Avatar, Switch } from '@/components/primitives'
import { Modal } from '@/components/modal'
import { RowMenu } from '@/views/extensions'
import { useAllExperts } from '@/lib/all-experts'
import { roleRunsAgentLoop } from '@/stores/chat'
import { toast } from '@/stores/toast'
import { useT } from '@/stores/locale'

type WorkflowDto = Awaited<ReturnType<typeof window.api.workflows.list>>[number]
type RunDto = Awaited<ReturnType<typeof window.api.workflows.runs>>[number]
type LintDto = Awaited<ReturnType<typeof window.api.workflows.lint>>
type RunEvent = Parameters<Parameters<typeof window.api.workflows.onRunEvent>[0]>[0]
type FlowNode = LintDto['nodes'][number]
type ParamDef = LintDto['params'][number]
type MessageDto = Awaited<ReturnType<typeof window.api.conversations.messages>>[number]

const AUTO_ACTIVATE_KEY = 'workflows.autoActivateDistilled'

const NEW_SCRIPT = `export const meta = {
  name: 'my-workflow',
  description: '',
  params: [],
  nsw: 1,
}
phase('Work')
const result = await agent(\`describe the first step here\`, { role: 'generalist' })
return result
`

/* ── formatting helpers ─────────────────────────────────────── */

const kTok = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))
const fmtDur = (ms: number): string => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 100) / 10)}s`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}
const ago = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

/* ── live-run state (workflow:run:event reducer) ────────────── */

interface ToolRow {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  summary?: string
  startedAt: number
  endedAt?: number
}
interface LiveStep {
  index: number
  role: string
  phase: string | null
  hint: string
  status: 'running' | 'ok' | 'error'
  text: string
  reasoning: string
  inTok: number
  outTok: number
  startedAt: number
  endedAt?: number
  tools: ToolRow[]
  notes: string[] // approval + stall notes shown inside the card
  error?: string
}
interface LiveRun {
  runId: string
  workflowId: string
  status: RunDto['status']
  failReason?: string
  failDetail?: string
  inTokens: number
  outTokens: number
  startedAt: number
  phase: string | null
  steps: LiveStep[]
  logs: string[]
}
type LiveMap = Record<string, LiveRun>

const MAX_STEP_TEXT = 40_000 // streaming body cap — the persisted message holds the full text for replay

function runReducer(state: LiveMap, ev: RunEvent): LiveMap {
  const run: LiveRun = state[ev.runId] ?? {
    runId: ev.runId,
    workflowId: ev.kind === 'status' ? ev.workflowId : '',
    status: 'running',
    inTokens: 0,
    outTokens: 0,
    startedAt: Date.now(),
    phase: null,
    steps: [],
    logs: [],
  }
  const next = { ...run, steps: [...run.steps] }
  const step = (i: number): LiveStep | undefined => next.steps[i]
  const putStep = (i: number, patch: Partial<LiveStep>): void => {
    const cur = step(i)
    if (cur) next.steps[i] = { ...cur, ...patch }
  }
  switch (ev.kind) {
    case 'status':
      next.workflowId = ev.workflowId
      next.status = ev.status
      next.failReason = ev.failReason
      next.failDetail = ev.failDetail
      if (ev.inTokens) next.inTokens = ev.inTokens
      if (ev.outTokens) next.outTokens = ev.outTokens
      break
    case 'phase':
      next.phase = ev.title
      break
    case 'log':
      next.logs = [...next.logs, ev.message].slice(-50)
      break
    case 'step-start':
      next.steps[ev.stepIndex] = {
        index: ev.stepIndex,
        role: ev.role,
        phase: ev.phase,
        hint: ev.hint,
        status: 'running',
        text: '',
        reasoning: '',
        inTok: 0,
        outTok: 0,
        startedAt: Date.now(),
        tools: [],
        notes: [],
      }
      break
    case 'step-delta': {
      const cur = step(ev.stepIndex)
      if (cur) putStep(ev.stepIndex, { text: (cur.text + ev.text).slice(-MAX_STEP_TEXT) })
      break
    }
    case 'step-reasoning': {
      const cur = step(ev.stepIndex)
      if (cur) putStep(ev.stepIndex, { reasoning: (cur.reasoning + ev.text).slice(-8000) })
      break
    }
    case 'step-usage':
      putStep(ev.stepIndex, { inTok: ev.inTokens, ...(ev.outTokens !== undefined ? { outTok: ev.outTokens } : {}) })
      break
    case 'step-tool-start': {
      const cur = step(ev.stepIndex)
      if (cur) putStep(ev.stepIndex, { tools: [...cur.tools, { id: ev.toolId, name: ev.name, status: 'running', startedAt: Date.now() }] })
      break
    }
    case 'step-tool-done': {
      const cur = step(ev.stepIndex)
      if (cur) {
        const tools = cur.tools.some((t) => t.id === ev.toolId)
          ? cur.tools.map((t) => (t.id === ev.toolId ? { ...t, status: (ev.isError ? 'error' : 'done') as ToolRow['status'], summary: ev.summary, endedAt: Date.now() } : t))
          : [...cur.tools, { id: ev.toolId, name: ev.name, status: (ev.isError ? 'error' : 'done') as ToolRow['status'], summary: ev.summary, startedAt: Date.now(), endedAt: Date.now() }]
        putStep(ev.stepIndex, { tools })
      }
      break
    }
    case 'step-approval': {
      const cur = step(ev.stepIndex)
      if (cur) {
        const note = ev.zone === 'red' ? `⏸ ${ev.toolName} denied (red zone) — recorded for approval: ${ev.reason}` : `✓ ${ev.toolName} auto-approved (yellow): ${ev.reason}`
        putStep(ev.stepIndex, { notes: [...cur.notes, note] })
      }
      break
    }
    case 'step-done':
      putStep(ev.stepIndex, { status: ev.ok ? 'ok' : 'error', endedAt: Date.now(), ...(ev.outTokens ? { outTok: ev.outTokens } : {}), error: ev.error })
      break
  }
  return { ...state, [ev.runId]: next }
}

/* ── root ───────────────────────────────────────────────────── */

type Sub = { kind: 'list' } | { kind: 'edit'; id: string | null } | { kind: 'run'; workflowId: string; runId: string }

export function WorkflowsView(): ReactElement {
  const [sub, setSub] = useState<Sub>({ kind: 'list' })
  const [items, setItems] = useState<WorkflowDto[]>([])
  const [live, dispatch] = useReducer(runReducer, {})
  const reload = (): void => {
    void window.api.workflows.list().then(setItems).catch(() => {})
  }
  useEffect(reload, [])
  useEffect(
    () =>
      window.api.workflows.onRunEvent((ev) => {
        dispatch(ev)
        if (ev.kind === 'status' && ev.status !== 'running') reload()
      }),
    []
  )

  const openRun = (workflowId: string, runId: string): void => setSub({ kind: 'run', workflowId, runId })

  if (sub.kind === 'edit') {
    const editing = sub.id ? items.find((w) => w.id === sub.id) ?? null : null
    return (
      <WorkflowEditor
        workflow={editing}
        onBack={() => { reload(); setSub({ kind: 'list' }) }}
        onRun={(w, runId) => { reload(); openRun(w.id, runId) }}
      />
    )
  }
  if (sub.kind === 'run') {
    const w = items.find((x) => x.id === sub.workflowId)
    if (w) {
      return (
        <RunPanel
          workflow={w}
          runId={sub.runId}
          live={live}
          onBack={() => { reload(); setSub({ kind: 'list' }) }}
          onOpenRun={(runId) => openRun(w.id, runId)}
        />
      )
    }
  }
  return (
    <WorkflowList
      items={items}
      live={live}
      reload={reload}
      onNew={() => setSub({ kind: 'edit', id: null })}
      onEdit={(id) => setSub({ kind: 'edit', id })}
      onOpenRun={openRun}
    />
  )
}

/* ── list page ──────────────────────────────────────────────── */

function sourceBadge(w: WorkflowDto, expertName: (id: string) => string): ReactElement {
  if (w.source === 'imported') return <span className="wf-src imported">imported</span>
  if (w.source === 'distilled') return <span className="wf-src distilled">distilled{w.originRole ? ` · ${expertName(w.originRole)}` : ''}</span>
  return <span className="wf-src">user</span>
}

function WorkflowList({
  items,
  live,
  reload,
  onNew,
  onEdit,
  onOpenRun,
}: {
  items: WorkflowDto[]
  live: LiveMap
  reload: () => void
  onNew: () => void
  onEdit: (id: string) => void
  onOpenRun: (workflowId: string, runId: string) => void
}): ReactElement {
  const t = useT()
  const { byId } = useAllExperts()
  const expertName = (id: string): string => byId[id]?.name ?? id
  const [importPreview, setImportPreview] = useState<{ script: string; lint: LintDto } | null>(null)
  const [runForm, setRunForm] = useState<WorkflowDto | null>(null)
  const [autoActivate, setAutoActivate] = useState(false)
  useEffect(() => {
    void window.api.settings.get<boolean>(AUTO_ACTIVATE_KEY).then((v) => { if (v !== null) setAutoActivate(v) })
  }, [])
  const toggleAutoActivate = (): void => {
    const next = !autoActivate
    setAutoActivate(next)
    void window.api.settings.set(AUTO_ACTIVATE_KEY, next)
  }

  const draftCount = items.filter((w) => !w.enabled && w.source !== 'user').length
  const liveByWorkflow = (id: string): LiveRun | undefined =>
    Object.values(live).find((r) => r.workflowId === id && r.status === 'running')

  const startRun = (w: WorkflowDto, params: Record<string, string | number | boolean>): void => {
    window.api.workflows
      .run(w.id, params)
      .then(({ runId }) => onOpenRun(w.id, runId))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'run failed'))
  }
  const onRunClick = (w: WorkflowDto): void => {
    const running = liveByWorkflow(w.id)
    if (running) return onOpenRun(w.id, running.runId)
    if (w.params.length > 0) return setRunForm(w)
    startRun(w, {})
  }
  const onToggle = (w: WorkflowDto): void => {
    window.api.workflows
      .setEnabled(w.id, !w.enabled)
      .then(reload)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'update failed'))
  }
  const onDuplicate = (w: WorkflowDto): void => {
    void (async () => {
      for (let n = 0; n < 6; n++) {
        const name = `${w.name}-copy${n ? `-${n + 1}` : ''}`
        try {
          const script = await window.api.workflows.rewriteMeta(w.script, { name })
          await window.api.workflows.save({ script })
          reload()
          return
        } catch { /* name clash — try the next suffix */ }
      }
      toast.error('could not duplicate (name conflicts)')
    })()
  }
  const onExport = (w: WorkflowDto): void => {
    window.api.workflows
      .export(w.id)
      .then((path) => { if (path) toast.success(`exported ${w.name}.nsw`) })
      .catch(() => toast.error('export failed'))
  }
  const onDelete = (w: WorkflowDto): void => {
    window.api.workflows
      .remove(w.id)
      .then(() => { reload(); toast.success('workflow deleted') })
      .catch(() => toast.error('delete failed'))
  }
  // the chip / menu entry into the panel for a SETTLED workflow: latest run id resolved on demand
  // (the list DTO carries only {status, startedAt} — one runs() call at click time keeps the DTO light)
  const openLatestRun = (w: WorkflowDto): void => {
    const running = liveByWorkflow(w.id)
    if (running) return onOpenRun(w.id, running.runId)
    void window.api.workflows.runs(w.id).then((rs) => {
      if (rs[0]) onOpenRun(w.id, rs[0].id)
      else toast.error('no runs yet')
    })
  }
  const onImport = (): void => {
    window.api.workflows
      .importPick()
      .then((r) => { if (r) setImportPreview(r) })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'could not read the file'))
  }

  return (
    <div className="main-col">
      <div className="conv-header">
        <span className="conv-title">{t('sidebar.workflows')}</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
          <button className="btn ghost sm" onClick={onImport}><Icons.download size={13} /> Import</button>
          <button className="btn sm" onClick={onNew}><Icons.plus size={13} /> New workflow</button>
        </span>
      </div>
      <div className="ext-body">
        <div className="ext-inner">
          <p className="wf-help">Saved multi-expert procedures — run them by hand; /workflow, schedules and Danny routing arrive next.</p>
          <div className="ext-note">
            {draftCount > 0 ? (
              <span className="ext-drafts"><Icons.zap size={12} /> {draftCount} draft{draftCount > 1 ? 's' : ''} — review and activate below</span>
            ) : (
              <span />
            )}
            <span className="ext-note-set">
              Auto-activate distilled workflows
              <Switch on={autoActivate} onClick={toggleAutoActivate} />
            </span>
          </div>
          <div className="ext-list">
            {items.length === 0 ? (
              <div className="ext-empty">No workflows yet — create one, or import a .nsw file.</div>
            ) : (
              items.map((w) => {
                const running = liveByWorkflow(w.id)
                const doneSteps = running ? running.steps.filter((s) => s.status !== 'running').length : 0
                return (
                  <div key={w.id} className={'ext-row' + (w.enabled ? '' : ' off')}>
                    <span className="wf-ico"><Icons.workflow size={16} /></span>
                    <div className="ext-main wf-main">
                      <div className="wf-l1">
                        <span className="ext-name mono">{w.name}</span>
                        {sourceBadge(w, expertName)}
                      </div>
                      <div className="wf-l2">
                        {w.description ? (
                          w.description
                        ) : (
                          <>
                            <span className="wf-auto">{w.roles.map(expertName).join(' → ') || '—'}</span> · auto-generated — no description yet
                          </>
                        )}
                      </div>
                    </div>
                    <div className="wf-meta">
                      <span>{w.params.length} param{w.params.length === 1 ? '' : 's'}</span>
                      {running ? (
                        <button className="wf-last" title="Open the run panel" onClick={() => onOpenRun(w.id, running.runId)}>
                          <span className="wf-dot run" />running{running.phase ? ` · ${running.phase}` : ''} {doneSteps}/{Math.max(w.steps, running.steps.length)}
                          <span className="wf-arr">›</span>
                        </button>
                      ) : w.lastRun ? (
                        <button className="wf-last" title="Open the last run" onClick={() => openLatestRun(w)}>
                          <span className={'wf-dot' + (w.lastRun.status === 'failed' ? ' err' : w.lastRun.status === 'stopped' ? ' stop' : '')} />
                          {w.lastRun.status === 'ok' ? `ran ${ago(w.lastRun.startedAt)}` : `${w.lastRun.status} · ${ago(w.lastRun.startedAt)}`}
                          <span className="wf-arr">›</span>
                        </button>
                      ) : (
                        <span className="wf-last">{w.enabled ? 'never run' : 'draft — never run'}</span>
                      )}
                      <button className="btn ghost sm" onClick={() => (w.enabled ? onRunClick(w) : onEdit(w.id))}>
                        {running ? 'View' : w.enabled ? 'Run' : 'Review'}
                      </button>
                      <Switch on={w.enabled} onClick={() => onToggle(w)} />
                      <RowMenu
                        items={[
                          { label: 'Runs', disabled: !running && !w.lastRun, onClick: () => openLatestRun(w) },
                          { label: 'Edit', onClick: () => onEdit(w.id) },
                          { label: 'Duplicate', onClick: () => onDuplicate(w) },
                          { label: 'Export', onClick: () => onExport(w) },
                          { label: 'Delete', danger: true, onClick: () => onDelete(w) },
                        ]}
                      />
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>
      {importPreview && (
        <ImportDialog
          preview={importPreview}
          expertName={expertName}
          onClose={() => setImportPreview(null)}
          onImported={() => { setImportPreview(null); reload() }}
        />
      )}
      {runForm && (
        <RunFormDialog
          workflow={runForm}
          onClose={() => setRunForm(null)}
          onRun={(params) => { const w = runForm; setRunForm(null); startRun(w, params) }}
        />
      )}
    </div>
  )
}

/* ── import dialog (.nsw preview + security scan card) ──────── */

function ImportDialog({
  preview,
  expertName,
  onClose,
  onImported,
}: {
  preview: { script: string; lint: LintDto }
  expertName: (id: string) => string
  onClose: () => void
  onImported: () => void
}): ReactElement {
  const { lint } = preview
  const scanOk = lint.scan?.ok === true
  const canImport = scanOk && lint.name !== null
  const [busy, setBusy] = useState(false)
  const confirm = (): void => {
    setBusy(true)
    window.api.workflows
      .importConfirm(preview.script)
      .then(() => { toast.success('imported as a draft — review, then enable'); onImported() })
      .catch((e) => { setBusy(false); toast.error(e instanceof Error ? e.message : 'import failed') })
  }
  return (
    <Modal
      title="Import workflow"
      onClose={onClose}
      foot={
        <>
          <button className="btn ghost sm" onClick={onClose}>Cancel</button>
          <button className="btn sm" disabled={!canImport || busy} onClick={confirm}>Import</button>
        </>
      }
    >
      <p className="wf-sub">A .nsw file is the workflow script itself — it is scanned before anything is saved.</p>
      <div className="wf-pv">
        <div className="nm">{lint.name ?? '(unparseable)'} <span className="wf-src imported">imported</span></div>
        {lint.name !== null && (
          <>
            <div className="row"><span className="chain">{lint.roles.map(expertName).join(' → ') || '—'}</span><span>· {lint.steps} step{lint.steps === 1 ? '' : 's'} · {lint.params.length} param{lint.params.length === 1 ? '' : 's'}</span></div>
            {lint.description && <div className="row">{lint.description}</div>}
            {lint.cwd && <div className="row">working folder: <code>{lint.cwd}</code></div>}
          </>
        )}
        {lint.error && !scanOk && lint.name === null && <div className="row wf-red">{lint.error}</div>}
      </div>
      {lint.scan &&
        (scanOk ? (
          <div className="wf-scan ok">
            <div className="t"><Icons.check size={13} /> Security scan passed</div>
            <ul>
              <li>No dynamic code — Function / eval / import / require absent</li>
              <li>No prototype-chain access — __proto__ / prototype / constructor absent</li>
              <li>No host identifiers — process / globalThis / this-escape absent</li>
              <li>Allow-listed calls only — agent · parallel · pipeline · phase · log</li>
            </ul>
            <div className="lim">runtime: dynamic concurrency (queued) · per-step stall watchdog · runaway backstop</div>
          </div>
        ) : (
          <div className="wf-scan bad">
            <div className="t"><Icons.x size={13} /> Security scan failed — import blocked</div>
            <ul>
              {lint.scan.violations.slice(0, 8).map((v, i) => (
                <li key={i}>line {v.line} — {v.message}</li>
              ))}
              {lint.scan.violations.length > 8 && <li>… {lint.scan.violations.length - 8} more</li>}
            </ul>
          </div>
        ))}
      {lint.cwdWarning === 'missing' && (
        <div className="wf-warn">⚠ <span>working folder not found on this machine — it will be cleared (the script text is kept; set a folder when you review)</span></div>
      )}
      {lint.cwdWarning === 'sensitive' && (
        <div className="wf-warn">⚠ <span>the working folder is a sensitive location (home / system root) — confirm the confine surface when you review</span></div>
      )}
      {lint.unknownRoles.length > 0 && (
        <div className="wf-warn">⚠ <span>unknown or disabled role(s): {lint.unknownRoles.join(', ')} — fix in Review before enabling</span></div>
      )}
      <div className="wf-warn">⚠ <span>Imports start <b>disabled</b> even after a clean scan — the script&apos;s prompts will drive your experts; review, then enable.</span></div>
    </Modal>
  )
}

/* ── run-params form ────────────────────────────────────────── */

function RunFormDialog({
  workflow,
  onClose,
  onRun,
}: {
  workflow: WorkflowDto
  onClose: () => void
  onRun: (params: Record<string, string | number | boolean>) => void
}): ReactElement {
  const [values, setValues] = useState<Record<string, string | number | boolean>>(() => {
    const v: Record<string, string | number | boolean> = {}
    for (const p of workflow.params) if (p.default !== undefined) v[p.name] = p.default
    return v
  })
  const set = (name: string, v: string | number | boolean): void => setValues((s) => ({ ...s, [name]: v }))
  return (
    <Modal
      title={`Run ${workflow.name}`}
      onClose={onClose}
      foot={
        <>
          <button className="btn ghost sm" onClick={onClose}>Cancel</button>
          <button className="btn sm" onClick={() => onRun(values)}>Run</button>
        </>
      }
    >
      <div className="wf-form">
        {workflow.params.map((p) => (
          <label key={p.name} className="wf-field">
            <span className="wf-lab">{p.label ?? p.name}</span>
            {p.type === 'boolean' ? (
              <Switch on={values[p.name] === true} onClick={() => set(p.name, values[p.name] !== true)} />
            ) : p.type === 'folder' ? (
              <span className="wf-folder">
                <input className="wf-input" value={String(values[p.name] ?? '')} onChange={(e) => set(p.name, e.target.value)} placeholder="working folder (overrides the workflow default)" />
                <button
                  className="btn ghost sm"
                  onClick={() => void window.api.workflows.pickDir().then((d) => { if (d) set(p.name, d) })}
                >Browse…</button>
              </span>
            ) : (
              <input
                className="wf-input"
                type={p.type === 'number' ? 'number' : 'text'}
                value={String(values[p.name] ?? '')}
                onChange={(e) => set(p.name, p.type === 'number' ? Number(e.target.value) : e.target.value)}
              />
            )}
          </label>
        ))}
      </div>
    </Modal>
  )
}

/* ── editor ─────────────────────────────────────────────────── */

// Tiny display-only tokenizer for the script pane (v1 textarea + highlight; Monaco is a ledger item).
function highlight(src: string): string {
  const esc = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc
    .replace(/(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g, '<span class="s">$1</span>')
    .replace(/(\/\/[^\n]*)/g, '<span class="c">$1</span>')
    .replace(/\b(const|let|await|return|if|else|for|of|while|function|try|catch|throw|new|export)\b/g, '<span class="k">$1</span>')
    .replace(/\b(agent|parallel|pipeline|phase|log)(?=\()/g, '<span class="f">$1</span>')
    .replace(/\b(role)(?=:)/g, '<span class="r">$1</span>')
}

function WorkflowEditor({
  workflow,
  onBack,
  onRun,
}: {
  workflow: WorkflowDto | null
  onBack: () => void
  onRun: (w: WorkflowDto, runId: string) => void
}): ReactElement {
  const { byId } = useAllExperts()
  const [script, setScript] = useState<string>(workflow?.script ?? NEW_SCRIPT)
  const [savedId, setSavedId] = useState<string | null>(workflow?.id ?? null)
  const [lint, setLint] = useState<LintDto | null>(null)
  const [dirty, setDirty] = useState(false)
  const [cursorLine, setCursorLine] = useState(1)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)

  // Debounced lint — the editor's single derived truth (fields, params, DAG, lint row all read it).
  useEffect(() => {
    const h = setTimeout(() => { void window.api.workflows.lint(script).then(setLint).catch(() => {}) }, 250)
    return () => clearTimeout(h)
  }, [script])

  const commitMeta = (patch: { name?: string; description?: string; cwd?: string | null; params?: ParamDef[] }): void => {
    void window.api.workflows.rewriteMeta(script, patch).then((next) => { if (next !== script) { setScript(next); setDirty(true) } })
  }
  const edit = (next: string): void => { setScript(next); setDirty(true) }

  const insertAtCursor = (snippet: string): void => {
    const ta = taRef.current
    if (!ta) return edit(script + snippet)
    const pos = ta.selectionEnd ?? script.length
    // insert on a fresh line after the cursor's line
    const lineEnd = script.indexOf('\n', pos)
    const at = lineEnd === -1 ? script.length : lineEnd
    edit(script.slice(0, at) + '\n' + snippet + script.slice(at))
  }

  const roleChips = useMemo(
    () => Object.values(byId).filter((e) => roleRunsAgentLoop(e.id) && !e.coordinator),
    [byId]
  )

  const save = async (): Promise<WorkflowDto | null> => {
    try {
      const saved = await window.api.workflows.save({ id: savedId ?? undefined, script })
      setSavedId(saved.id)
      setDirty(false)
      toast.success('saved')
      return saved
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'save failed')
      return null
    }
  }
  const testRun = (): void => {
    void (async () => {
      const saved = await save()
      if (!saved) return
      try {
        const { runId } = await window.api.workflows.run(saved.id, {})
        onRun(saved, runId)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'run failed')
      }
    })()
  }
  const exportNsw = (): void => {
    if (!savedId) return
    void window.api.workflows.export(savedId).then((p) => { if (p) toast.success('exported') })
  }

  // cursor line ↔ DAG node highlight (both directions)
  const syncCursor = (): void => {
    const ta = taRef.current
    if (!ta) return
    setCursorLine(script.slice(0, ta.selectionStart ?? 0).split('\n').length)
  }
  const jumpToLine = (line: number): void => {
    const ta = taRef.current
    if (!ta) return
    const lines = script.split('\n')
    const start = lines.slice(0, line - 1).join('\n').length + (line > 1 ? 1 : 0)
    const end = start + (lines[line - 1]?.length ?? 0)
    ta.focus()
    ta.setSelectionRange(start, end)
    setCursorLine(line)
    const lh = 19 // matches .wf-code line-height
    ta.scrollTop = Math.max(0, (line - 4) * lh)
    if (preRef.current) preRef.current.scrollTop = ta.scrollTop
  }

  const parses = lint !== null && lint.name !== null
  const scanOk = lint?.scan?.ok === true

  return (
    <div className="main-col">
      <div className="conv-header">
        <button className="chat-crumb" onClick={onBack}><Icons.chevronLeft size={14} /> Workflows</button>
        <span className="conv-title mono-title">{lint?.name ?? workflow?.name ?? 'new workflow'}</span>
        {workflow && sourceBadge(workflow, (id) => byId[id]?.name ?? id)}
        {dirty && <span className="conv-sub">· unsaved</span>}
      </div>
      <div className="wf-edit">
        <div className="wf-edit-l">
          <div className="wf-fields">
            <label className="wf-field">
              <span className="wf-lab">Name</span>
              <input className="wf-input mono" defaultValue={lint?.name ?? ''} key={`n-${lint?.name ?? ''}`} onBlur={(e) => { if (e.target.value !== lint?.name) commitMeta({ name: e.target.value }) }} />
            </label>
            <label className="wf-field">
              <span className="wf-lab">Description <span className="hint">hand-written; empty → the list shows the role chain</span></span>
              <input className="wf-input" defaultValue={lint?.description ?? ''} key={`d-${lint?.description ?? ''}`} onBlur={(e) => { if (e.target.value !== lint?.description) commitMeta({ description: e.target.value }) }} />
            </label>
            <label className="wf-field">
              <span className="wf-lab">Working folder <span className="hint">default cwd for every run; a folder param overrides per run</span></span>
              <span className="wf-folder">
                <input className="wf-input mono" value={lint?.cwd ?? ''} readOnly placeholder="none — steps run without a confined folder" />
                <button className="btn ghost sm" onClick={() => void window.api.workflows.pickDir().then((d) => { if (d) commitMeta({ cwd: d }) })}>Browse…</button>
                {lint?.cwd && <button className="btn ghost sm" onClick={() => commitMeta({ cwd: null })}>×</button>}
              </span>
            </label>
            {lint?.cwdWarning === 'missing' && <div className="wf-warn">⚠ <span>this folder does not exist on this machine</span></div>}
            {lint?.cwdWarning === 'sensitive' && <div className="wf-warn">⚠ <span>sensitive location — every step&apos;s file tools confine here</span></div>}
          </div>

          <ParamsTable params={lint?.params ?? []} onCommit={(params) => commitMeta({ params })} />

          <div className="wf-roles">
            <span className="wf-lab">Insert a step</span>
            <div className="wf-chips">
              {roleChips.map((e) => (
                <button key={e.id} className="wf-chip" onClick={() => insertAtCursor(`const step = await agent(\`describe the task for ${e.name}\`, { role: '${e.id}' })`)}>
                  <Avatar expert={e} size={15} /> {e.name}
                </button>
              ))}
            </div>
          </div>

          <div className="wf-script">
            <span className="wf-lab">Script</span>
            <div className="wf-code-wrap">
              <pre ref={preRef} className="wf-code wf-code-hl" aria-hidden dangerouslySetInnerHTML={{ __html: highlight(script) + '\n' }} />
              <textarea
                ref={taRef}
                className="wf-code wf-code-input"
                value={script}
                spellCheck={false}
                onChange={(e) => edit(e.target.value)}
                onKeyUp={syncCursor}
                onClick={syncCursor}
                onScroll={(e) => { if (preRef.current) { preRef.current.scrollTop = e.currentTarget.scrollTop; preRef.current.scrollLeft = e.currentTarget.scrollLeft } }}
              />
            </div>
            <div className="wf-lint">
              <span className={parses ? 'okc' : 'errc'}>{parses ? '✓ parses' : '✗ parses'}</span>
              <span className={scanOk ? 'okc' : 'errc'}>{scanOk ? '✓ security scan' : '✗ security scan'}</span>
              {lint && parses && <span>{lint.steps} step{lint.steps === 1 ? '' : 's'} · {lint.roles.length} role{lint.roles.length === 1 ? '' : 's'}</span>}
              {lint?.error && <span className="errc wf-lint-err" title={lint.error}>{lint.error}</span>}
              {!lint?.error && !scanOk && lint?.scan?.violations[0] && (
                <span className="errc wf-lint-err" title={lint.scan.violations.map((v) => `line ${v.line}: ${v.message}`).join('\n')}>
                  line {lint.scan.violations[0].line}: {lint.scan.violations[0].message}
                </span>
              )}
              <span className="wf-spacer" />
              <button className="btn ghost sm" disabled={!savedId || dirty} onClick={exportNsw}>⤒ Export</button>
              <button className="btn ghost sm" disabled={!lint?.ok} onClick={testRun}>Test run</button>
              <button className="btn sm" disabled={!lint?.ok || !dirty} onClick={() => void save()}>Save</button>
            </div>
          </div>
        </div>
        <div className="wf-edit-r">
          <span className="wf-lab">Preview — generated from the script</span>
          <FlowProjection nodes={lint?.nodes ?? []} params={lint?.params ?? []} byId={byId} cursorLine={cursorLine} onNode={jumpToLine} />
        </div>
      </div>
    </div>
  )
}

function ParamsTable({ params, onCommit }: { params: ParamDef[]; onCommit: (p: ParamDef[]) => void }): ReactElement {
  const [draft, setDraft] = useState<ParamDef[]>(params)
  useEffect(() => setDraft(params), [params])
  const set = (i: number, patch: Partial<ParamDef>): void => setDraft((d) => d.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  const commit = (next?: ParamDef[]): void => onCommit((next ?? draft).filter((p) => p.name.trim()))
  return (
    <div className="wf-params-wrap">
      <span className="wf-lab">Params <span className="hint">⇄ meta.params — the run form renders these</span></span>
      <div className="wf-params">
        <div className="hd"><span>name</span><span>type</span><span>default</span><span>label</span><span /></div>
        {draft.map((p, i) => (
          <div className="rw" key={i}>
            <input className="wf-cell" value={p.name} onChange={(e) => set(i, { name: e.target.value })} onBlur={() => commit()} />
            <select
              className="wf-cell"
              value={p.type}
              onChange={(e) => { const d = draft.map((x, j) => (j === i ? { ...x, type: e.target.value as ParamDef['type'] } : x)); setDraft(d); commit(d) }}
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
              <option value="folder">folder</option>
            </select>
            <input className="wf-cell" value={p.default === undefined ? '' : String(p.default)} placeholder="—"
              onChange={(e) => set(i, { default: p.type === 'number' ? Number(e.target.value) : p.type === 'boolean' ? e.target.value === 'true' : e.target.value })}
              onBlur={() => commit()} />
            <input className="wf-cell" value={p.label ?? ''} placeholder="—" onChange={(e) => set(i, { label: e.target.value })} onBlur={() => commit()} />
            <button className="wf-del" onClick={() => { const d = draft.filter((_, j) => j !== i); setDraft(d); commit(d) }}><Icons.x size={12} /></button>
          </div>
        ))}
        <button className="wf-param-add" onClick={() => setDraft((d) => [...d, { name: '', type: 'string' }])}>＋ param</button>
      </div>
    </div>
  )
}

/* ── DAG projection (read-only; node ⇄ script line) ─────────── */

function FlowProjection({
  nodes,
  params,
  byId,
  cursorLine,
  onNode,
}: {
  nodes: FlowNode[]
  params: ParamDef[]
  byId: Record<string, { id: string; name: string; color: string } & object>
  cursorLine: number
  onNode: (line: number) => void
}): ReactElement {
  // group agent nodes under their preceding phase; adjacent parallel agents share a row
  const groups: { title: string | null; line: number; rows: FlowNode[][] }[] = []
  let cur: { title: string | null; line: number; rows: FlowNode[][] } = { title: null, line: 0, rows: [] }
  for (const n of nodes) {
    if (n.kind === 'phase') {
      if (cur.rows.length || cur.title) groups.push(cur)
      cur = { title: n.title ?? '', line: n.line, rows: [] }
      continue
    }
    const lastRow = cur.rows[cur.rows.length - 1]
    if (n.parallel && lastRow && lastRow[lastRow.length - 1]?.parallel) lastRow.push(n)
    else cur.rows.push([n])
  }
  if (cur.rows.length || cur.title) groups.push(cur)
  const argsChip = params.length ? params.map((p) => `${p.name}${p.default !== undefined ? ` = ${p.default}` : ''}`).join(' · ') : 'no params'
  // the node whose line is closest at-or-before the cursor gets the selection ring
  const agentLines = nodes.filter((n) => n.kind === 'agent').map((n) => n.line)
  const selLine = agentLines.filter((l) => l <= cursorLine).pop() ?? -1

  return (
    <div className="wf-dag">
      <span className="wf-dag-start">▶ args: {argsChip}</span>
      {groups.map((g, gi) => (
        <div key={gi} className="wf-dag-seq">
          <span className="wf-dag-edge" />
          <div className={'wf-dag-phase' + (g.title === null ? ' bare' : '')}>
            {g.title !== null && <em>{(g.title || ' ').toUpperCase()}</em>}
            {g.rows.map((row, ri) => (
              <div key={ri} className="wf-dag-row">
                {row.map((n, ni) => {
                  const e = byId[n.role ?? '']
                  return (
                    <button key={ni} className={'wf-dag-node' + (n.line === selLine ? ' sel' : '')} onClick={() => onNode(n.line)}>
                      {e ? <Avatar expert={e as never} size={22} /> : <span className="wf-dag-q">?</span>}
                      <span className="wf-dag-body">
                        {e?.name ?? n.role}
                        {n.loop && <span className="wf-dag-loop" title="inside a loop">↻</span>}
                        <small>{n.hint || '…'}</small>
                      </span>
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      ))}
      <span className="wf-dag-edge" />
      <span className="wf-dag-start">return</span>
    </div>
  )
}

/* ── run panel ──────────────────────────────────────────────── */

interface ViewStep {
  index: number
  role: string
  phase: string | null
  hint: string
  status: 'running' | 'ok' | 'error' | 'wait'
  text: string
  inTok: number
  outTok: number
  durMs: number | null
  tools: { id: string; name: string; status: string; summary?: string; ms?: number }[]
  notes: string[]
  error?: string
}

function RunPanel({
  workflow,
  runId,
  live,
  onBack,
  onOpenRun,
}: {
  workflow: WorkflowDto
  runId: string
  live: LiveMap
  onBack: () => void
  onOpenRun: (runId: string) => void
}): ReactElement {
  const { byId } = useAllExperts()
  const [runs, setRuns] = useState<RunDto[]>([])
  const [replay, setReplay] = useState<{ run: RunDto; msgs: MessageDto[]; tools: Record<string, { id: string; name: string; status: string; result?: string }[]> } | null>(null)
  const [, setTick] = useState(0)
  const liveRun: LiveRun | undefined = live[runId]
  const running = liveRun?.status === 'running'

  const loadRuns = (): void => { void window.api.workflows.runs(workflow.id).then(setRuns) }
  useEffect(loadRuns, [workflow.id, liveRun?.status])
  useEffect(() => {
    if (running) {
      const h = setInterval(() => setTick((n) => n + 1), 1000)
      return () => clearInterval(h)
    }
    return undefined
  }, [running])

  // replay a settled run: run row + hidden-conv messages + transcript tool cards
  useEffect(() => {
    if (liveRun) { setReplay(null); return }
    void (async () => {
      const run = await window.api.workflows.runGet(runId)
      if (!run) return
      const msgs = await window.api.conversations.messages(run.convId)
      const transcript = await window.api.agent.transcript(run.convId)
      const tools: Record<string, { id: string; name: string; status: string; result?: string }[]> = {}
      for (const [rid, t] of Object.entries(transcript)) tools[rid] = t.tools.map((tc) => ({ id: tc.id, name: tc.name, status: tc.status, result: typeof tc.result === 'string' ? tc.result : undefined }))
      setReplay({ run, msgs, tools })
    })()
  }, [runId, liveRun === undefined])

  // static projection: phases per agent-step order (rail scaffold + replay phase labels) — phase nodes
  // precede their agents in source order, so thread the current phase onto each agent entry
  const [projection, setProjection] = useState<FlowNode[]>([])
  useEffect(() => { void window.api.workflows.lint(workflow.script).then((l) => setProjection(l.nodes)) }, [workflow.script])
  const projAgents = useMemo(() => {
    const out: { role: string; hint: string; phase: string | null }[] = []
    let phase: string | null = null
    for (const n of projection) {
      if (n.kind === 'phase') phase = n.title ?? null
      else out.push({ role: n.role ?? '?', hint: n.hint ?? '', phase })
    }
    return out
  }, [projection])

  const runRow = liveRun ? runs.find((r) => r.id === runId) : replay?.run
  const steps: ViewStep[] = liveRun
    ? liveRun.steps.filter(Boolean).map((s) => ({
        index: s.index,
        role: s.role,
        phase: s.phase,
        hint: s.hint,
        status: s.status,
        text: s.text,
        inTok: s.inTok,
        outTok: s.outTok,
        durMs: (s.endedAt ?? Date.now()) - s.startedAt,
        tools: s.tools.map((t) => ({ id: t.id, name: t.name, status: t.status, summary: t.summary, ms: t.endedAt ? t.endedAt - t.startedAt : undefined })),
        notes: s.notes,
        error: s.error,
      }))
    : (replay?.msgs ?? [])
        .filter((m) => m.author === 'expert')
        .map((m, i) => ({
          index: i,
          role: m.expertId ?? '?',
          phase: projAgents[i]?.phase ?? null,
          hint: projAgents[i]?.hint ?? '',
          status: 'ok' as const,
          text: m.content,
          inTok: m.sentTokens || m.inputTokens,
          outTok: m.outputTokens,
          durMs: null,
          tools: (m.runId && replay?.tools[m.runId]) || [],
          notes: [],
        }))
  // waiting placeholders from the projection beyond what has started
  const waiting: ViewStep[] = running
    ? projAgents.slice(steps.length).map((n, i) => ({
        index: steps.length + i,
        role: n.role ?? '?',
        phase: n.phase ?? null,
        hint: n.hint ?? '',
        status: 'wait' as const,
        text: '',
        inTok: 0,
        outTok: 0,
        durMs: null,
        tools: [],
        notes: [],
      }))
    : []
  const all = [...steps, ...waiting]

  const sigma = liveRun && running ? null : runRow // settled Σ from the run row (turn-final aggregate)
  const runNo = runs.length ? runs.length - runs.findIndex((r) => r.id === runId) : null
  const paramChips = Object.entries(runRow?.params ?? {}).map(([k, v]) => `${k}=${String(v)}`)
  const elapsed = liveRun ? fmtDur(Date.now() - liveRun.startedAt) : runRow?.finishedAt ? fmtDur(new Date(runRow.finishedAt).getTime() - new Date(runRow.startedAt).getTime()) : ''
  const doneCount = steps.filter((s) => s.status === 'ok').length

  const stop = (): void => { void window.api.workflows.stop(runId) }

  return (
    <div className="main-col">
      <div className="wf-run-head">
        <button className="chat-crumb" onClick={onBack}><Icons.chevronLeft size={14} /> Workflows</button>
        <span className="wf-ico sm"><Icons.workflow size={13} /></span>
        <span className="wf-run-title mono-title">{workflow.name}</span>
        {runNo !== null && <span className="wf-chip-mono">run #{runNo}</span>}
        {paramChips.map((c) => (
          <span key={c} className="wf-chip-mono">{c}</span>
        ))}
        <span className="wf-chip-mono tok">Σ ↑{kTok(liveRun && !running ? liveRun.inTokens : (sigma?.inTokens ?? liveRun?.inTokens ?? 0))} ↓{kTok(liveRun && !running ? liveRun.outTokens : (sigma?.outTokens ?? liveRun?.outTokens ?? 0))}</span>
        <span className={'wf-run-stat' + (runRow?.status === 'failed' || liveRun?.status === 'failed' ? ' err' : '')}>
          {running ? (
            <><span className="wf-dot run" />{liveRun?.phase ? `${liveRun.phase} · ` : ''}{doneCount}/{Math.max(workflow.steps, all.length)} · {elapsed}
              <button className="btn sm danger" onClick={stop}>■ Stop</button></>
          ) : (
            <>
              <span className={'wf-dot' + ((liveRun?.status ?? runRow?.status) === 'failed' ? ' err' : (liveRun?.status ?? runRow?.status) === 'stopped' ? ' stop' : '')} />
              {(liveRun?.status ?? runRow?.status ?? '')}{(liveRun?.failReason ?? runRow?.failReason) ? ` · ${liveRun?.failReason ?? runRow?.failReason}` : ''}{elapsed ? ` · ${elapsed}` : ''}
            </>
          )}
        </span>
      </div>
      {(liveRun?.failDetail ?? runRow?.failDetail) && (
        <div className="wf-fail-line">✗ {liveRun?.failDetail ?? runRow?.failDetail}</div>
      )}
      <div className="wf-run-body">
        <div className="wf-rail">
          {all.map((s, i) => {
            const e = byId[s.role]
            const prevPhase = i > 0 ? all[i - 1].phase : null
            return (
              <div key={i}>
                {s.phase && s.phase !== prevPhase && <div className="wf-rail-ph">{s.phase}</div>}
                <div className={'wf-rail-node ' + (s.status === 'ok' ? 'done' : s.status === 'running' ? 'running' : s.status === 'error' ? 'err' : 'wait')}>
                  <span className="st">{s.status === 'ok' ? '✓' : s.status === 'running' ? '●' : s.status === 'error' ? '✗' : ''}</span>
                  {e && <Avatar expert={e} size={15} />}
                  <span className="wf-rail-hint">{s.hint || s.role}</span>
                  <small>{s.status === 'wait' ? '—' : `${s.durMs !== null ? fmtDur(s.durMs) : ''}${s.outTok ? ` · ${kTok(s.outTok)}` : ''}${s.status === 'running' ? '…' : ''}`}</small>
                </div>
              </div>
            )
          })}
        </div>
        <div className="wf-steps">
          {all.map((s, i) => {
            const e = byId[s.role]
            if (s.status === 'wait') {
              return (
                <div key={i} className="wf-card wait">
                  <div className="hd">{e && <Avatar expert={e} size={18} />}<span>{e?.name ?? s.role} · {s.hint || '…'}</span><small>· {s.phase ?? ''} · waiting</small></div>
                </div>
              )
            }
            return (
              <div key={i} className={'wf-card' + (s.status === 'running' ? ' live' : s.status === 'error' ? ' err' : '')}>
                <div className="hd">
                  {e && <Avatar expert={e} size={18} />}
                  <span>{e?.name ?? s.role}{s.hint ? ` · ${s.hint.slice(0, 60)}` : ''}</span>
                  <small>{s.phase ? `· ${s.phase} ` : ''}· {s.status === 'running' ? 'streaming' : s.status === 'error' ? 'failed' : 'done'}{s.durMs !== null ? ` · ${fmtDur(s.durMs)}` : ''}</small>
                  <span className="r">↑{kTok(s.inTok)} ↓{kTok(s.outTok)}{s.status === 'running' ? '…' : ''}</span>
                </div>
                {s.notes.length > 0 && (
                  <div className="wf-card-notes">{s.notes.map((n, j) => <div key={j}>{n}</div>)}</div>
                )}
                {(s.text || s.error) && (
                  <div className="bd">
                    {s.error ? <p className="wf-red">{s.error}</p> : <p>{s.text}{s.status === 'running' && <span className="wf-cursor" />}</p>}
                  </div>
                )}
                {s.tools.length > 0 && (
                  <div className="wf-tools">
                    <div className="t">Tools · {s.tools.length} call{s.tools.length === 1 ? '' : 's'}{s.tools.some((t) => t.status === 'running') ? ' · running' : ''}</div>
                    <div className="list">
                      {s.tools.map((t) => (
                        <div key={t.id} className="wf-tcall">
                          <span className="nm">{t.name}</span>
                          <span className="io">{t.summary ?? (t.status === 'running' ? 'running…' : '')}</span>
                          <span className="ms">{t.ms !== undefined ? fmtDur(t.ms) : t.status === 'running' ? '…' : ''}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
          {liveRun && liveRun.logs.length > 0 && (
            <div className="wf-log">{liveRun.logs.map((l, i) => <div key={i}>· {l}</div>)}</div>
          )}
        </div>
      </div>
      <div className="wf-runs">
        <div className="hd">Runs</div>
        {runs.map((r, i) => {
          const no = runs.length - i
          const dot = r.status === 'running' ? 'run' : r.status === 'failed' ? 'err' : r.status === 'stopped' ? 'stop' : ''
          return (
            <div key={r.id} className="wf-runrow">
              <span className={'wf-dot ' + dot} />
              <span>#{no} · {r.status === 'failed' ? `failed${r.failReason ? ` (${r.failReason})` : ''}` : r.status}</span>
              <small>
                · {ago(r.startedAt)}{r.finishedAt ? ` · ${fmtDur(new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime())}` : ''} · via {r.trigger} · ↑{kTok(r.inTokens)} ↓{kTok(r.outTokens)}
                {r.failDetail ? ` · ${r.failDetail.slice(0, 80)}` : ''}
              </small>
              <span className="wf-spacer" />
              {r.id !== runId && <button className="btn ghost sm" onClick={() => onOpenRun(r.id)}>Open</button>}
            </div>
          )
        })}
        {runs.length === 0 && <div className="wf-runrow"><small>no runs yet</small></div>}
      </div>
    </div>
  )
}
