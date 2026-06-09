// E2E verification timeline — renders the Gate C verifier run for the active conversation in the
// conversation flow, so the ENTIRE e2e run is visible. The header shows the live retry round ("N/3" from
// verify:progress) and, once verify:done arrives, the verdict-colored final kind. Each row is one e2e action
// (launch/goto/click/fill/screenshot/assert/get/post); screenshot rows show a lazy thumbnail and assert rows
// are pass/fail colored from the parsed assertion verdict. Matches the ToolBubble visual language (styles/agent.css).
import { useState, type ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { VerifyScreenshot } from '@/components/verify-screenshot'
import { useVerify, type VerifyToolRow, type VerifyState } from '@/stores/verify'

// Short, human label for an e2e action's argument (URL, selector, text, …).
function rowSummary(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>
  switch (name) {
    case 'launch':
      return String(o.target ?? '')
    case 'goto':
    case 'get':
    case 'post':
      return String(o.url ?? o.path ?? '')
    case 'click':
    case 'fill':
    case 'assert':
      return String(o.selector ?? o.kind ?? '')
    case 'screenshot':
      return String(o.name ?? '')
    default:
      return ''
  }
}

function Row({ row }: { row: VerifyToolRow }): ReactElement {
  const [open, setOpen] = useState(false)
  const isAssert = row.name === 'assert'
  const isShot = row.name === 'screenshot'
  // A failed assertion returns { ok: true, pass: false } so isError is false — fold pass===false into `failed`
  // so the row is colored/iconed as a failure rather than a success.
  const assertPassed = isAssert && row.status === 'done' && row.pass === true
  const failed = row.status === 'done' && (row.isError === true || row.pass === false)
  const expandable = (row.status === 'done' && !!row.result) || (isShot && !!row.screenshotPath)
  const cls = `vt-row ${row.status}` + (failed ? ' error' : '') + (assertPassed ? ' pass' : '')
  return (
    <div className={cls}>
      <button className="vt-row-head" onClick={() => expandable && setOpen((o) => !o)} disabled={!expandable}>
        <span className="vt-status">
          {row.status === 'running' && <span className="tb-dot" />}
          {row.status === 'done' && (failed ? <Icons.x size={11} /> : <Icons.check size={11} />)}
        </span>
        <span className="vt-name">{row.name}</span>
        <span className="vt-summary">{rowSummary(row.name, row.input)}</span>
        {isAssert && row.status === 'done' && row.pass !== undefined && (
          <span className={'vt-assert' + (row.pass ? ' pass' : ' fail')}>{row.pass ? 'PASS' : 'FAIL'}</span>
        )}
        <span className="vt-round">r{row.round}</span>
        {expandable && (
          <span className={'tb-chevron' + (open ? ' open' : '')}>
            <Icons.chevronDown size={13} />
          </span>
        )}
      </button>
      {open && (
        <div className="vt-detail">
          {isShot && row.screenshotPath ? <VerifyScreenshot path={row.screenshotPath} /> : null}
          {row.result ? <pre className="tb-result">{row.result.slice(0, 4000)}</pre> : null}
        </div>
      )}
    </div>
  )
}

function Timeline({ state }: { state: VerifyState }): ReactElement {
  const v = state.verdict
  const kind = v?.kind
  const roundLabel = v ? `${v.rounds}/${v.maxRounds}` : state.maxRounds ? `${state.round}/${state.maxRounds}` : `${state.round}`
  const headCls = 'vt-head' + (kind ? ` verify-${kind.toLowerCase()}` : '')
  return (
    <div className="verify-timeline">
      <div className={headCls}>
        <span className="vt-head-ic"><Icons.target size={13} /></span>
        <span className="vt-head-title">E2E verification</span>
        {kind ? <span className="vt-head-kind">{kind}</span> : state.phase === 'fix' ? <span className="vt-head-phase">fixing</span> : null}
        <span className="vt-head-round">{roundLabel}</span>
      </div>
      <div className="vt-rows">
        {state.tools.map((r) => (
          <Row key={r.toolUseId} row={r} />
        ))}
      </div>
      {v?.detail ? <div className="vt-verdict-detail">{v.detail}</div> : null}
    </div>
  )
}

// Renders the timeline for one conversation, or nothing if that conversation has no e2e activity yet.
export function VerifyTimeline({ convId }: { convId: string }): ReactElement | null {
  const state = useVerify((s) => s.byConversation[convId])
  if (!state || (state.tools.length === 0 && !state.verdict && state.round === 0)) return null
  return <Timeline state={state} />
}
