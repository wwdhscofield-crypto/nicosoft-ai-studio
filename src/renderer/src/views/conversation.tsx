/* ============================================================
   NicoSoft AI Studio — conversation pane + composer + states
   ============================================================ */
import { useState, useEffect, useRef } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { STUDIO_DATA } from '@/data/studio-data'
import { useRoles } from '@/stores/roles'
import { Avatar, Segment, DispatchBadge } from '@/components/primitives'
import type { Conversation, Expert } from '@/types'

/* — Models that expose a reasoning / thinking-depth control — */
const REASONING_MODELS = new Set(["claude-sonnet-4.6", "claude-opus-4", "gpt-5", "gpt-5-pro"])
const COMPOSER_MODELS: Record<string, string[]> = {
  anthropic: ["claude-haiku-4", "claude-sonnet-4.6", "claude-opus-4"],
  openai: ["gpt-5-mini", "gpt-5", "gpt-5-pro"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "imagen-4"],
}

interface Attachment {
  type: 'image' | 'file'
  name: string
}

/* — Composer (nsai-style stacked layout, Studio's own dark tokens) — */
function Composer({
  expert,
  onMention,
  noEndpoint,
  onOpenSettings,
  streaming,
  onStop
}: {
  expert: Expert
  onMention?: (id: string) => void
  noEndpoint?: boolean
  onOpenSettings?: () => void
  streaming?: boolean
  onStop?: () => void
}): ReactElement {
  const { EXPERTS } = STUDIO_DATA
  const roles = useRoles()
  const [focused, setFocused] = useState(false)
  const [value, setValue] = useState("")
  const [showMention, setShowMention] = useState(false)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [model, setModel] = useState(expert.model || "")
  const [modelMenu, setModelMenu] = useState(false)
  const [reasoning, setReasoning] = useState("Medium")
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { setModel(expert.model || ""); setAttachments([]); setValue(""); }, [expert.id])

  const supportsReasoning = REASONING_MODELS.has(model)
  const modelOpts = (expert.family ? COMPOSER_MODELS[expert.family] : undefined) || []

  // token counter (mock) — amber past ~85%
  const usedK = 32.1, maxK = 200
  const tokenPct = usedK / maxK
  const tokenAmber = tokenPct > 0.85

  const grow = (): void => {
    const ta = taRef.current
    if (ta) { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; }
  }
  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setValue(e.target.value)
    setShowMention(e.target.value.endsWith("@"))
    grow()
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (value.trim() || attachments.length) { setValue(""); setAttachments([]); setTimeout(grow, 0); }
    }
  }
  const pickMention = (id: string): void => { setShowMention(false); setValue(""); onMention && onMention(id); }
  const addAttachment = (): void => {
    const isImg = attachments.length % 2 === 0
    setAttachments((p) => [...p, isImg
      ? { type: "image", name: "screenshot.png" }
      : { type: "file", name: "design-brief.pdf" }])
  }
  const removeAttachment = (i: number): void => setAttachments((p) => p.filter((_, j) => j !== i))

  const disabled = noEndpoint
  const canSend = !disabled && (value.trim() || attachments.length)

  return (
    <div className="input-dock">
      <div className="input-dock-inner">
        {noEndpoint && (
          <div className="dock-banner">
            <Icons.plug size={15} style={{ color: "var(--text-3)" }} />
            <span>Add an AI endpoint to start chatting</span>
            <span className="db-arrow" onClick={onOpenSettings}>Open settings <Icons.arrowRight size={13} /></span>
          </div>
        )}
        <div className={"composer2" + (focused ? " focused" : "") + (disabled ? " disabled" : "")}>
          {/* mention popover */}
          {showMention && !disabled && (
            <div className="mention-pop">
              <div className="mp-head">Mention an expert</div>
              {EXPERTS.filter((e) => !e.coordinator && !roles.isDisabled(e.id) && !roles.isDeleted(e.id)).map((e) => (
                <div className="mention-row" key={e.id} onMouseDown={() => pickMention(e.id)}>
                  <Avatar expert={e} size={24} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="mr-name">{e.name}</div>
                    <div className="mr-spec">{e.specialty}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* TOP TOOLBAR */}
          <div className="cmp-toolbar">
            <div className="cmp-model" onClick={() => !disabled && setModelMenu((s) => !s)}>
              <Icons.sparkle size={13} />
              <span className="cmp-model-id">{model || "no model"}</span>
              <Icons.chevronDown size={12} />
              {modelMenu && (
                <>
                  <div className="menu-backdrop" onClick={(e) => { e.stopPropagation(); setModelMenu(false); }} />
                  <div className="row-menu cmp-model-menu" onClick={(e) => e.stopPropagation()}>
                    {modelOpts.map((m) => (
                      <div key={m} className={"rm-item" + (m === model ? " active" : "")} onClick={() => { setModel(m); setModelMenu(false); }}>
                        <span className="cmp-mono">{m}</span>{m === model && <Icons.check size={13} />}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            {supportsReasoning && (
              <div className="cmp-reasoning">
                <span className="cmp-reason-label">Thinking</span>
                <div className="segmented sm">
                  {["Low", "Medium", "High"].map((r) => (
                    <button key={r} className={reasoning === r ? "active" : ""} onClick={() => setReasoning(r)}>{r}</button>
                  ))}
                </div>
              </div>
            )}

            <span className={"cmp-tokens" + (tokenAmber ? " amber" : "")}>
              {usedK}K / {maxK}K tokens
            </span>
          </div>

          {/* ATTACHMENT STRIP */}
          {attachments.length > 0 && (
            <div className="cmp-attach-strip">
              {attachments.map((a, i) => (
                a.type === "image" ? (
                  <div className="cmp-att-img" key={i}>
                    <div className="cmp-att-thumb"><Icons.image size={18} /></div>
                    <button className="cmp-att-x" onClick={() => removeAttachment(i)}><Icons.x size={11} /></button>
                  </div>
                ) : (
                  <div className="cmp-att-file" key={i}>
                    <Icons.file size={14} style={{ color: "var(--text-3)" }} />
                    <span className="cmp-att-name">{a.name}</span>
                    <button className="cmp-att-x inline" onClick={() => removeAttachment(i)}><Icons.x size={11} /></button>
                  </div>
                )
              ))}
            </div>
          )}

          {/* TEXTAREA */}
          <textarea ref={taRef} className="cmp-textarea" rows={1} value={value} disabled={disabled}
            placeholder={`Ask ${expert.name} — Enter to send, Shift+Enter for newline`}
            onChange={onChange} onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); setShowMention(false); }} />

          {/* BOTTOM ROW */}
          <div className="cmp-bottom">
            <button className="icon-btn" title="Attach" disabled={disabled} onClick={addAttachment}>
              <Icons.paperclip size={16} />
            </button>
            <div className="tb-spacer" />
            {streaming ? (
              <button className="cmp-stop" onClick={onStop}><span className="stop-sq" /> Stop</button>
            ) : (
              <button className="cmp-send" disabled={!canSend}>Send <Icons.arrowUp size={14} /></button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/* — Empty / new-conversation state — */
function EmptyState({ expert, onChip }: { expert: Expert; onChip?: (c: string) => void }): ReactElement {
  const { GREETINGS } = STUDIO_DATA
  const g = GREETINGS[expert.id] || GREETINGS.iris
  return (
    <div className="empty-state">
      <div className="empty-inner">
        <div className="big-avatar"><Avatar expert={expert} size={48} /></div>
        <div className="es-name">{expert.name}</div>
        <div className="es-greet">{g.greeting}</div>
        <div className="example-chips">
          {g.chips.map((c, i) => (
            <button className="example-chip" key={i} onClick={() => onChip && onChip(c)}>{c}</button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* — Loading skeleton (message-segment shaped) — */
function SkeletonSegment(): ReactElement {
  return (
    <div className="segment" style={{ "--seg-color": "var(--border-2)" } as CSSProperties}>
      <div className="seg-head">
        <div className="avatar" style={{ width: 28, height: 28, animation: "skel 1.4s ease-in-out infinite" }} />
        <div className="skel-line" style={{ width: 90, marginBottom: 0 }} />
      </div>
      <div className="seg-body">
        <div className="skel-line" style={{ width: "94%" }} />
        <div className="skel-line" style={{ width: "88%" }} />
        <div className="skel-line" style={{ width: "60%" }} />
      </div>
    </div>
  )
}

/* — The full conversation view — */
function ConversationView({
  conv,
  onOpenSettings
}: {
  conv: Conversation
  onOpenSettings?: () => void
}): ReactElement {
  const { EXPERT_BY_ID } = STUDIO_DATA
  const expert = EXPERT_BY_ID[conv.expert]
  const listRef = useRef<HTMLDivElement>(null)
  const streaming = conv.loading || conv.segments.some((s) => s.streaming)

  return (
    <div className="main-col">
      <div className="msg-list" ref={listRef}>
        <div className="msg-inner">
          {conv.collab && conv.dispatch && <DispatchBadge chain={conv.dispatch} />}
          {conv.segments.map((seg, i) => <Segment key={i} seg={seg} />)}
          {conv.loading && <SkeletonSegment />}
          {conv.notice && (
            <div className="inline-notice">
              <span className="n-icon"><Icons.alert size={17} /></span>
              <span className="n-text"><strong>Your API key for Anthropic is invalid (401).</strong> Requests to {expert.name} will fail until you update it.</span>
              <button className="btn sm secondary" onClick={onOpenSettings}>Open settings</button>
            </div>
          )}
        </div>
      </div>
      <Composer expert={expert} noEndpoint={expert.unconfigured} streaming={streaming} onStop={() => {}} onOpenSettings={onOpenSettings} />
    </div>
  )
}

export { ConversationView, Composer, EmptyState, SkeletonSegment }
