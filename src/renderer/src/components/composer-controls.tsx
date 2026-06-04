// Shared composer controls — model picker (with a search box when the list is long) + dynamic
// thinking-depth picker. Both menus open UPWARD (the composer sits at the bottom of the pane). Used by
// the regular conversation composer and the Engineer agent composer so every role's footer is consistent.

import { useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Icons } from '@/components/icons'
import { useAnchoredMenu } from '@/lib/use-anchored-menu'
import type { Family } from '@/types'
import { getThinkingCapability, supportedDepths, THINKING_OPTIONS, type ThinkingDepth } from '@/lib/thinking'
import { imageModelLabel } from '@/lib/image-models'
import { MODE_OPTIONS, type AgentMode } from '@/lib/agent-mode'

// Model dropdown. `models` is the bound endpoint's configured slug list; a search box appears once the
// list is long enough to be worth filtering.
export function ModelPicker({
  models,
  value,
  onChange,
  disabled
}: {
  models: string[]
  value: string
  onChange: (m: string) => void
  disabled?: boolean
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const close = (): void => {
    setOpen(false)
    setQuery('')
  }
  const showSearch = models.length > 8
  const filtered = query ? models.filter((m) => m.toLowerCase().includes(query.toLowerCase())) : models
  return (
    <div className="cmp-model" onClick={() => !disabled && setOpen((s) => !s)}>
      <Icons.sparkle size={13} />
      <span className="cmp-model-id">{value || 'no model'}</span>
      <Icons.chevronDown size={12} />
      {open && (
        <>
          <div className="menu-backdrop" onClick={(e) => { e.stopPropagation(); close() }} />
          <div className="row-menu up cc-model-menu" onClick={(e) => e.stopPropagation()}>
            {showSearch ? (
              <input
                className="cc-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models…"
                spellCheck={false}
                autoComplete="off"
                autoFocus
              />
            ) : null}
            <div className="cc-options">
              {filtered.length === 0 ? (
                <div className="rm-empty">No match</div>
              ) : (
                filtered.map((m) => (
                  <div
                    key={m}
                    className={'rm-item' + (m === value ? ' active' : '')}
                    onClick={() => { onChange(m); close() }}
                  >
                    <span className="cmp-mono">{m}</span>
                    {m === value ? <Icons.check size={13} /> : null}
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

// Dynamic thinking-depth dropdown. Renders nothing when (family, model) can't think; otherwise lists
// only the depths that model supports. Opens upward.
export function ThinkingPicker({
  family,
  model,
  depth,
  onChange,
  disabled
}: {
  family: Family
  model: string
  depth: ThinkingDepth
  onChange: (d: ThinkingDepth) => void
  disabled?: boolean
}): ReactElement | null {
  const [open, setOpen] = useState(false)
  const cap = getThinkingCapability(family, model)
  const depths = supportedDepths(cap)
  if (depths.length === 0) return null
  // Guard against a stale depth not in this model's tiers (would otherwise show e.g. "Max" while the
  // backend clamps to High). Fall back to a supported tier for the label.
  const shown = depths.includes(depth) ? depth : depths.includes('medium') ? 'medium' : depths[depths.length - 1]
  const label = THINKING_OPTIONS.find((t) => t.value === shown)?.label ?? 'Medium'
  return (
    <div className="cmp-model cmp-thinking" onClick={() => !disabled && setOpen((s) => !s)}>
      <span className="cmp-model-id">Thinking · {label}</span>
      <Icons.chevronDown size={12} />
      {open && (
        <>
          <div className="menu-backdrop" onClick={(e) => { e.stopPropagation(); setOpen(false) }} />
          <div className="row-menu up" onClick={(e) => e.stopPropagation()}>
            {THINKING_OPTIONS.filter((t) => depths.includes(t.value)).map((t) => (
              <div
                key={t.value}
                className={'rm-item' + (t.value === depth ? ' active' : '')}
                onClick={() => { onChange(t.value); setOpen(false) }}
              >
                <span>{t.label}</span>
                {t.value === depth ? <Icons.check size={13} /> : null}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// Agent permission-mode dropdown — Ask (approve mutations) / Plan (read-only, plan first) / Auto
// (no prompts). Shown only for agent roles; sets the run's initial mode (the model can still flip it
// at runtime via EnterPlanMode / ExitPlanMode). Opens upward like the other composer menus.
export function ModePicker({
  value,
  onChange,
  disabled
}: {
  value: AgentMode
  onChange: (m: AgentMode) => void
  disabled?: boolean
}): ReactElement {
  const [open, setOpen] = useState(false)
  const cur = MODE_OPTIONS.find((o) => o.value === value) ?? MODE_OPTIONS[0]
  return (
    <div className={'cmp-model cmp-mode mode-' + cur.value} onClick={() => !disabled && setOpen((s) => !s)}>
      <Icons.shield size={13} />
      <span className="cmp-model-id">{cur.label}</span>
      <Icons.chevronDown size={12} />
      {open && (
        <>
          <div className="menu-backdrop" onClick={(e) => { e.stopPropagation(); setOpen(false) }} />
          <div className="row-menu up cc-mode-menu" onClick={(e) => e.stopPropagation()}>
            {MODE_OPTIONS.map((o) => (
              <div
                key={o.value}
                className={'rm-item' + (o.value === value ? ' active' : '')}
                onClick={() => { onChange(o.value); setOpen(false) }}
              >
                <div className="cc-mode-opt">
                  <span>{o.label}</span>
                  <span className="cc-mode-hint">{o.hint}</span>
                </div>
                {o.value === value ? <Icons.check size={13} /> : null}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// Image-backend dropdown for the designer composer (B7). Lists the Gemini image models (Nano Banana /
// Imagen) the designer's ns_generate_image tool can target. Opens upward like the other composer menus.
export function ImageModelPicker({
  models,
  value,
  onChange,
  disabled
}: {
  models: string[]
  value: string
  onChange: (m: string) => void
  disabled?: boolean
}): ReactElement {
  const [open, setOpen] = useState(false)
  // Used both in the composer footer AND in the Extensions › Tools card, whose .ext-list/.ext-body
  // overflow would clip an absolutely-positioned menu — so portal it to <body> with fixed positioning.
  const triggerRef = useRef<HTMLDivElement>(null)
  const { menuRef, style } = useAnchoredMenu(open, triggerRef, 'up')
  return (
    <div ref={triggerRef} className="cmp-model" onClick={() => !disabled && setOpen((s) => !s)}>
      <Icons.image size={13} />
      <span className="cmp-model-id">{imageModelLabel(value)}</span>
      <Icons.chevronDown size={12} />
      {open
        ? createPortal(
            <>
              <div className="menu-backdrop" onClick={(e) => { e.stopPropagation(); setOpen(false) }} />
              <div ref={menuRef} className="row-menu up" style={style} onClick={(e) => e.stopPropagation()}>
                {models.map((m) => (
                  <div
                    key={m}
                    className={'rm-item' + (m === value ? ' active' : '')}
                    onClick={() => { onChange(m); setOpen(false) }}
                  >
                    <span>{imageModelLabel(m)}</span>
                    {m === value ? <Icons.check size={13} /> : null}
                  </div>
                ))}
              </div>
            </>,
            document.body
          )
        : null}
    </div>
  )
}
