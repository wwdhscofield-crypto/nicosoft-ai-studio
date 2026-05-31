// HexAgentView — the real coding-agent conversation. Wires the Composer to window.api.agent (via the
// useHex store), renders the streamed messages as Segments with ToolBubbles, and shows the
// ApprovalDialog when a tool needs permission. Reuses the existing studio shell classes (segment /
// composer2 / input-dock) so it matches the other conversation view; the agent-specific pieces
// (tool bubble, diff, approval, cwd bar) live in styles/agent.css.

import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { ApprovalDialog } from '@/components/approval-dialog'
import { Icons } from '@/components/icons'
import { Avatar, NameChip } from '@/components/primitives'
import { ToolBubble } from '@/components/tool-bubble'
import { useHex, type HexMessage } from '@/stores/hex'
import type { Expert } from '@/types'

// Project-path selector — Claude-style chip row (Local · folder · branch) above the composer. No
// icon / divider / worktree (per the design). Clicking opens a native folder picker.
function PathBar(): ReactElement {
  const cwd = useHex((s) => s.cwd)
  const setCwd = useHex((s) => s.setCwd)
  const [branch, setBranch] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (!cwd) {
      setBranch(null)
      return
    }
    void window.api.project.branch(cwd).then((b) => {
      if (alive) setBranch(b)
    })
    return () => {
      alive = false
    }
  }, [cwd])
  const pick = async (): Promise<void> => {
    const dir = await window.api.project.pick()
    if (dir) setCwd(dir)
  }
  const name = cwd ? (cwd.split('/').filter(Boolean).pop() ?? cwd) : null
  return (
    <button className="path-bar" onClick={() => void pick()} title={cwd || 'Choose a project folder'}>
      {name ? (
        <>
          <span className="path-chip">Local</span>
          <span className="path-chip">{name}</span>
          {branch ? <span className="path-chip">{branch}</span> : null}
        </>
      ) : (
        <span className="path-chip muted">Choose a project folder…</span>
      )}
    </button>
  )
}

function HexSegment({ msg, expert }: { msg: HexMessage; expert: Expert }): ReactElement {
  const isUser = msg.role === 'user'
  return (
    <div className={'segment' + (isUser ? ' user' : '')} style={{ '--seg-color': isUser ? 'var(--border-2)' : expert.color } as CSSProperties}>
      <div className="seg-head">
        <Avatar expert={isUser ? null : expert} you={isUser} size={28} streaming={msg.streaming} />
        <div className="seg-meta">
          <NameChip expert={isUser ? null : expert} neutral={isUser} />
        </div>
      </div>
      <div className={'seg-body' + (isUser ? ' primary' : '')}>
        {msg.text ? <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{msg.text}</p> : null}
        {msg.tools.map((t) => (
          <ToolBubble key={t.id} tool={t} />
        ))}
        {msg.streaming ? <span className="caret" /> : null}
      </div>
    </div>
  )
}

export function HexAgentView({ expert, onOpenSettings }: { expert: Expert; onOpenSettings?: () => void }): ReactElement {
  const hex = useHex()
  const listRef = useRef<HTMLDivElement>(null)
  const [value, setValue] = useState('')
  const [endpoint, setEndpoint] = useState<{ id: string; model: string } | null>(null)
  const [noEndpoint, setNoEndpoint] = useState(false)

  // Hex's loop speaks the Anthropic protocol — resolve the first enabled, keyed Anthropic endpoint.
  useEffect(() => {
    let alive = true
    void window.api.endpoints.list().then((eps) => {
      if (!alive) return
      // Hex's loop speaks the Anthropic Messages protocol — pick the first enabled, keyed endpoint on
      // that protocol (any provider's Anthropic-compatible endpoint, e.g. a gateway) and use its
      // configured model. The model itself can be anything the endpoint serves.
      const ep = eps.find((e) => e.enabled && e.hasKey && e.protocol === 'anthropic')
      const model = ep?.defaultModel || ep?.availableModels?.[0]
      if (ep && model) setEndpoint({ id: ep.id, model })
      else setNoEndpoint(true)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [hex.messages, hex.streaming])

  const send = (): void => {
    const prompt = value.trim()
    if (!prompt || !endpoint || hex.streaming) return
    setValue('')
    void hex.run({ endpointId: endpoint.id, model: endpoint.model, prompt })
  }

  return (
    <div className="main-col">
      <div className="msg-list" ref={listRef}>
        <div className="msg-inner">
          {hex.messages.map((m) => (
            <HexSegment key={m.id} msg={m} expert={expert} />
          ))}
          {hex.error ? (
            <div className="inline-notice">
              <span className="n-icon">
                <Icons.alert size={17} />
              </span>
              <span className="n-text">
                <strong>{hex.error}</strong>
              </span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="input-dock">
        <div className="input-dock-inner">
          {noEndpoint ? (
            <div className="dock-banner">
              <Icons.plug size={15} style={{ color: 'var(--text-3)' }} />
              <span>Configure an endpoint and model to run Hex</span>
              <span className="db-arrow" onClick={onOpenSettings}>
                Open settings <Icons.arrowRight size={13} />
              </span>
            </div>
          ) : null}
          <PathBar />
          <div className="composer2">
            <textarea
              className="cmp-textarea"
              rows={1}
              value={value}
              placeholder={`Ask ${expert.name} to build, fix, or investigate — Enter to send`}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter newlines; never submit mid-IME-composition (CJK candidate
                // selection) — nativeEvent.isComposing / keyCode 229 (older Firefox) flag it.
                const native = e.nativeEvent as KeyboardEvent
                if (e.key === 'Enter' && !e.shiftKey && !native.isComposing && native.keyCode !== 229) {
                  e.preventDefault()
                  send()
                }
              }}
              disabled={noEndpoint}
            />
            <div className="cmp-bottom">
              <div className="tb-spacer" />
              {hex.streaming ? (
                <button className="cmp-stop" onClick={hex.stop}>
                  <span className="stop-sq" /> Stop
                </button>
              ) : (
                <button className="cmp-send" disabled={!value.trim() || noEndpoint || !endpoint} onClick={send}>
                  Send <Icons.arrowUp size={14} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {hex.permission ? (
        <ApprovalDialog
          prompt={hex.permission}
          onAllow={() => hex.respondPermission(true)}
          onDeny={() => hex.respondPermission(false)}
        />
      ) : null}
    </div>
  )
}
