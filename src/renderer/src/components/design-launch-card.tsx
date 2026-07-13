/* ============================================================
   NicoSoft AI Studio — design launch card (script-orchestration-alignment §4.2)
   A `/design <problem>` judge-panel run leaves this ONE card in the conversation and it carries the whole run:
   appended in a 'running' state and updated IN PLACE (over the conv:card channel) as phases/logs arrive and once
   the scored synthesis lands. The card is a PURE function of its persisted JSON content — live progress and a
   reload both render from the same payload. The synthesis body uses the app's unified ChunkedMarkdown; the shell
   mirrors the workflow / research card language (.wf-dot, mono chips).
   ============================================================ */
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { ChunkedMarkdown } from '@/components/markdown'
import { useT } from '@/stores/locale'

type DesignStatus = 'running' | 'done' | 'failed' | 'stopped'

interface DesignPayload {
  v?: number
  runId?: string
  problem?: string
  status?: DesignStatus
  phase?: string
  note?: string
  report?: string
  error?: string
}

function parsePayload(content: string): DesignPayload | null {
  try {
    return JSON.parse(content) as DesignPayload
  } catch {
    return null
  }
}

export function DesignLaunchCard({ content }: { content: string }): ReactElement {
  const t = useT()
  const p = parsePayload(content)
  if (!p) return <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{content}</p>
  const status: DesignStatus = p.status ?? 'running'
  const dotCls = status === 'running' ? ' run' : status === 'failed' ? ' err' : status === 'stopped' ? ' stop' : ''
  const stop = (): void => {
    if (p.runId) void window.api.design.stop(p.runId)
  }
  return (
    <div className="design-card">
      <div className="design-head">
        <span className="design-icon">
          <Icons.compass size={14} />
        </span>
        <span className="design-q">{p.problem ?? ''}</span>
        <span className="design-status">
          <span className={'wf-dot' + dotCls} />
          {t(`design.status.${status}`)}
        </span>
        {status === 'running' && (
          <button className="design-stop" onClick={stop}>
            {t('design.stop')}
          </button>
        )}
      </div>
      {status === 'running' && (p.phase || p.note) ? (
        <div className="design-progress">
          {p.phase ? <span className="wf-chip-mono">{p.phase}</span> : null}
          {p.note ? <span className="design-note">{p.note}</span> : null}
        </div>
      ) : null}
      {status === 'done' && p.report ? (
        <div className="design-report">
          <ChunkedMarkdown text={p.report} live={false} />
        </div>
      ) : null}
      {status === 'failed' ? <div className="design-err">{p.error ?? t('design.failedNote')}</div> : null}
      {status === 'stopped' ? <div className="design-note">{t('design.stoppedNote')}</div> : null}
    </div>
  )
}
