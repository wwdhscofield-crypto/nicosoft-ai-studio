/* ============================================================
   NicoSoft AI Studio — migrate launch card (script-orchestration-alignment §4.3)
   A `/migrate <instruction>` run leaves this ONE card in the conversation and it carries the whole run: appended
   'running' and updated IN PLACE (over the conv:card channel) as phases/logs arrive and once the reviewable
   patch lands. The card is a PURE function of its persisted JSON content — live progress and a reload both render
   from the same payload. The report body (per-site notes + the aggregated ```diff patch) uses the app's unified
   ChunkedMarkdown. Nothing is ever applied or committed — the patch is for review + apply-by-hand.
   ============================================================ */
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { ChunkedMarkdown } from '@/components/markdown'
import { useT } from '@/stores/locale'

type MigrateStatus = 'running' | 'done' | 'failed' | 'stopped'

interface MigratePayload {
  v?: number
  runId?: string
  instruction?: string
  status?: MigrateStatus
  phase?: string
  note?: string
  report?: string
  error?: string
}

function parsePayload(content: string): MigratePayload | null {
  try {
    return JSON.parse(content) as MigratePayload
  } catch {
    return null
  }
}

export function MigrateLaunchCard({ content }: { content: string }): ReactElement {
  const t = useT()
  const p = parsePayload(content)
  if (!p) return <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{content}</p>
  const status: MigrateStatus = p.status ?? 'running'
  const dotCls = status === 'running' ? ' run' : status === 'failed' ? ' err' : status === 'stopped' ? ' stop' : ''
  const stop = (): void => {
    if (p.runId) void window.api.migrate.stop(p.runId)
  }
  return (
    <div className="migrate-card">
      <div className="migrate-head">
        <span className="migrate-icon">
          <Icons.zap size={14} />
        </span>
        <span className="migrate-q">{p.instruction ?? ''}</span>
        <span className="migrate-status">
          <span className={'wf-dot' + dotCls} />
          {t(`migrate.status.${status}`)}
        </span>
        {status === 'running' && (
          <button className="migrate-stop" onClick={stop}>
            {t('migrate.stop')}
          </button>
        )}
      </div>
      {status === 'running' && (p.phase || p.note) ? (
        <div className="migrate-progress">
          {p.phase ? <span className="wf-chip-mono">{p.phase}</span> : null}
          {p.note ? <span className="migrate-note">{p.note}</span> : null}
        </div>
      ) : null}
      {status === 'done' && p.report ? (
        <div className="migrate-report">
          <ChunkedMarkdown text={p.report} live={false} />
        </div>
      ) : null}
      {status === 'failed' ? <div className="migrate-err">{p.error ?? t('migrate.failedNote')}</div> : null}
      {status === 'stopped' ? <div className="migrate-note">{t('migrate.stoppedNote')}</div> : null}
    </div>
  )
}
