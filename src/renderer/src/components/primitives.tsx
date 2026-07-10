// Shared primitives — recreated from the prototype's components.jsx.
import { Fragment, useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icons } from './icons'
import { STUDIO_DATA } from '@/data/studio-data'
import { useAllExperts } from '@/lib/all-experts'
import { useAnchoredMenu } from '@/lib/use-anchored-menu'
import type { Expert } from '@/types'

/* — Avatar: monogram in expert identity color — */
export function Avatar({
  expert,
  size = 28,
  you = false,
  streaming = false
}: {
  expert?: Expert | null
  size?: number
  you?: boolean
  streaming?: boolean
}): ReactElement {
  const fontSize = Math.round(size * 0.42)
  if (you) {
    const uname = (STUDIO_DATA.USER_PROFILE.name || '').trim()
    const label = uname ? uname[0].toUpperCase() : 'You'
    return (
      <div
        className={'avatar you' + (streaming ? ' streaming' : '')}
        style={{ width: size, height: size, fontSize: uname ? fontSize : Math.round(size * 0.3) }}
      >
        {label}
      </div>
    )
  }
  const letter = expert?.name[0] ?? '?'
  return (
    <div
      className={'avatar' + (streaming ? ' streaming' : '')}
      style={{ width: size, height: size, fontSize, '--av-color': expert?.color } as CSSProperties}
    >
      {letter}
    </div>
  )
}

/* — Avatar stack: overlapping expert monograms — */
export function AvatarStack({ ids, size = 26 }: { ids: string[]; size?: number }): ReactElement {
  // useAllExperts (not STUDIO_DATA): stacks routinely carry custom agents' ulids (assignments, projects).
  const { byId } = useAllExperts()
  return (
    <div className="avatar-stack" style={{ height: size }}>
      {ids.map((id, i) => (
        <span key={id} className="as-item" style={{ marginLeft: i === 0 ? 0 : -size * 0.34, zIndex: ids.length - i }}>
          <Avatar expert={byId[id] ?? null} size={size} />
        </span>
      ))}
    </div>
  )
}

/* — Name chip: expert color text on low-opacity fill — */
export function NameChip({ expert, neutral = false }: { expert?: Expert | null; neutral?: boolean }): ReactElement {
  if (neutral) {
    const uname = (STUDIO_DATA.USER_PROFILE.name || '').trim()
    return <span className="name-chip neutral">{uname || 'You'}</span>
  }
  return (
    <span className="name-chip" style={{ '--chip-color': expert?.color } as CSSProperties}>
      {expert?.name}
    </span>
  )
}

/* — Health dot — */
export function HealthDot({ status }: { status: string }): ReactElement {
  const cls = ({ healthy: 'healthy', degraded: 'degraded', failing: 'failing', off: 'off' } as Record<string, string>)[status] || 'off'
  return <span className={'health-dot ' + cls} />
}

/* — Syntax highlighter (lightweight, Python + TSX) — */
/* — Dispatch badge for collaboration — */
export function DispatchBadge({ chain }: { chain: string[] }): ReactElement {
  // useAllExperts (not STUDIO_DATA): a dispatched CUSTOM agent's chain node renders name + color instead
  // of being silently skipped (custom-agent-roles 批3 — Danny routes to custom roles now).
  const { byId } = useAllExperts()
  const coordinator = byId.coordinator
  return (
    <div className="dispatch">
      <span className="d-node d-lead">
        <span className="d-dot" style={{ background: coordinator.color }} /> {coordinator.name} · routing
      </span>
      {chain.map((id) => {
        const e = byId[id]
        if (!e) return null // skip non-expert ids in the chain (e.g. a tool like 'studio_lens') — a badge must never crash on a stray id
        return (
          <Fragment key={id}>
            <span className="d-arrow">
              <Icons.arrowRight size={13} />
            </span>
            <span className="d-node">
              <span className="d-dot" style={{ background: e.color }} /> {e.name}
            </span>
          </Fragment>
        )
      })}
    </div>
  )
}

/* — small flat switch (one source: previously memory.tsx MemToggle + extensions.tsx Toggle) — */
export function Switch({ on, onClick, disabled, ariaLabel }: { on: boolean; onClick: () => void; disabled?: boolean; ariaLabel?: string }): ReactElement {
  return (
    <button
      className={'switch' + (on ? ' on' : '') + (disabled ? ' disabled' : '')}
      onClick={disabled ? undefined : onClick}
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      <span className="knob" />
    </button>
  )
}

/* — segmented control (one source: previously hand-written <div className="segmented"> in 8 places) — */
export interface SegmentedOption {
  v: string
  l: ReactNode
  disabled?: boolean
}
export function Segmented({
  options,
  value,
  onChange,
  className
}: {
  options: Array<string | SegmentedOption>
  value: string
  onChange: (v: string) => void
  className?: string
}): ReactElement {
  return (
    <div className={className ? `${className} segmented` : 'segmented'}>
      {options.map((o) => {
        const opt: SegmentedOption = typeof o === 'string' ? { v: o, l: o } : o
        return (
          <button key={opt.v} className={value === opt.v ? 'active' : ''} disabled={opt.disabled} onClick={() => onChange(opt.v)}>
            {opt.l}
          </button>
        )
      })}
    </div>
  )
}

/* — custom select (one source, replaces every native <select>): a native select pops the OS menu —
   outside the app theme entirely (macOS blue highlight, light chrome in dark mode) — so select-like
   controls render the same portaled .row-menu the app's other dropdowns use (ModelPicker / context
   menu visuals: .rm-item rows + a check on the current value). The portal + useAnchoredMenu keep the
   menu out of overflow-clipping ancestors (dialogs, table rows); .sm-float lifts it above the dialog
   overlay (z 100 — the base .row-menu z 61 would sink under it). The trigger takes an existing skin
   class (input / wf-cell / asg-filter-sel), so each call site keeps its current look. — */
export interface SelectMenuOption {
  value: string
  label: string
  disabled?: boolean
}
export function SelectMenu({
  value,
  options,
  onChange,
  disabled,
  className,
  mono
}: {
  value: string
  options: SelectMenuOption[]
  onChange: (v: string) => void
  disabled?: boolean
  className?: string // the trigger's visual skin (e.g. "input", "wf-cell", "asg-filter-sel")
  mono?: boolean // mono face for the label + options (model ids, param types)
}): ReactElement {
  const [open, setOpen] = useState(false)
  // Keyboard cursor (aria-activedescendant pattern): focus stays on the listbox container; this index is the
  // highlighted option. Mouse hover moves it too, so pointer and keyboard never fight over two highlights.
  const [activeIdx, setActiveIdx] = useState(-1)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { menuRef, style } = useAnchoredMenu(open, triggerRef, 'down')
  const listId = useId()
  const current = options.find((o) => o.value === value)

  // Next enabled option from `from` in `dir`, wrapping — disabled rows are skipped, never landed on.
  const nextEnabled = (from: number, dir: 1 | -1): number => {
    const n = options.length
    let i = from
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n
      if (!options[i].disabled) return i
    }
    return -1
  }

  const openMenu = (): void => {
    const cur = options.findIndex((o) => o.value === value && !o.disabled)
    setActiveIdx(cur >= 0 ? cur : nextEnabled(-1, 1))
    setOpen(true)
  }
  const close = (refocusTrigger: boolean): void => {
    setOpen(false)
    if (refocusTrigger) triggerRef.current?.focus()
  }
  const commit = (idx: number): void => {
    const o = options[idx]
    if (!o || o.disabled) return
    onChange(o.value)
    close(true)
  }

  // The listbox takes focus while open (native-select parity: arrows/Enter/Escape work immediately); the
  // active row follows into view inside the .sm-menu scroll box. Depend on `style` and skip the measuring
  // pass: useAnchoredMenu first renders the menu visibility:hidden to size it, and its layout-effect
  // setStyle flushes pending passive effects BEFORE the placed re-render — a focus() fired then lands on a
  // hidden element and silently no-ops. The placed style (visibility unset) re-runs this effect.
  useEffect(() => {
    if (open && style.visibility !== 'hidden') menuRef.current?.focus()
  }, [open, style, menuRef])
  useEffect(() => {
    if (open && activeIdx >= 0) document.getElementById(`${listId}-o${activeIdx}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIdx, listId])

  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    // Enter/Space already click the button natively (→ onClick toggle); arrows open like a native select.
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      openMenu()
    }
  }

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const dir = e.key === 'ArrowDown' ? 1 : -1
      setActiveIdx((i) => {
        const next = nextEnabled(i, dir)
        return next >= 0 ? next : i
      })
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      setActiveIdx(e.key === 'Home' ? nextEnabled(-1, 1) : nextEnabled(0, -1))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      commit(activeIdx)
    } else if (e.key === 'Escape') {
      // Close ONLY the menu — stopPropagation keeps a host dialog's own Escape-to-close from firing (the
      // portal still bubbles through the React tree, so the dialog's onKeyDown would otherwise see this).
      e.preventDefault()
      e.stopPropagation()
      close(true)
    } else if (e.key === 'Tab') {
      // Native selects close on Tab and let focus move on — FROM THE SELECT. Refocus the trigger before
      // the default action runs (focus() is synchronous; the default Tab then advances from the trigger),
      // otherwise focus dies with the unmounting portal and Tab restarts from the document's first
      // tabbable — outside the host dialog. Covers Shift+Tab symmetrically.
      close(true)
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Single-char typeahead (native-select parity): jump to the next enabled option starting with the key.
      const ch = e.key.toLowerCase()
      const n = options.length
      for (let k = 1; k <= n; k++) {
        const i = (activeIdx + k + n) % n
        if (!options[i].disabled && options[i].label.toLowerCase().startsWith(ch)) {
          setActiveIdx(i)
          break
        }
      }
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={'sel-trigger' + (className ? ` ${className}` : '')}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={'sel-label' + (mono ? ' cmp-mono' : '')}>{current?.label ?? value}</span>
        <Icons.chevronDown size={12} />
      </button>
      {open
        ? createPortal(
            <>
              <div className="menu-backdrop sm-float-bg" onClick={() => close(false)} />
              <div
                ref={menuRef}
                id={listId}
                role="listbox"
                tabIndex={-1}
                aria-activedescendant={activeIdx >= 0 ? `${listId}-o${activeIdx}` : undefined}
                className="row-menu sm-menu sm-float"
                style={style}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={onMenuKeyDown}
              >
                {options.length === 0 ? <div className="rm-empty">—</div> : null}
                {options.map((o, i) => (
                  <div
                    key={o.value}
                    id={`${listId}-o${i}`}
                    role="option"
                    aria-selected={o.value === value}
                    aria-disabled={o.disabled || undefined}
                    className={'rm-item' + (o.value === value ? ' active' : '') + (o.disabled ? ' disabled' : '') + (i === activeIdx ? ' kb' : '')}
                    onMouseEnter={() => {
                      if (!o.disabled) setActiveIdx(i)
                    }}
                    onClick={() => {
                      if (o.disabled) return
                      onChange(o.value)
                      close(false)
                    }}
                  >
                    <span className={mono ? 'cmp-mono' : undefined}>{o.label}</span>
                    {o.value === value ? <Icons.check size={13} /> : null}
                  </div>
                ))}
              </div>
            </>,
            document.body
          )
        : null}
    </>
  )
}
