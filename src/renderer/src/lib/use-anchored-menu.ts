import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'

export type MenuPlacement = 'right' | 'up' | 'down'

// Anchors a portaled .row-menu as position:fixed to its trigger so it escapes every overflow-clipping
// ancestor — the bug where a row's three-dot menu / model picker got cut off at the .ext-list card edge
// (.ext-list overflow:hidden, with .ext-body scroll behind it). The menu must be rendered through a portal
// to document.body; spread `style` onto the .row-menu and attach `menuRef`. Sizing uses offsetWidth/Height
// (layout size, transform-free) so the dialog-in scale(0.985) animation can't skew the measurement.
//
// Placement is the preferred side: 'right' opens below, right-aligned to the trigger; 'up' opens above
// (composer menus); 'down' opens below, left-aligned. Each auto-flips when its side lacks room, then the
// result is clamped into the viewport. Repositions on scroll/resize while open.
// right/bottom MUST be neutralized here: while hidden we measure the menu, and the base CSS (.row-menu.right
// sets right:0, .row-menu.up sets bottom:calc(100%+6px)) would otherwise stretch it edge-to-edge and yield a
// bogus offsetWidth/Height, throwing off the computed anchor.
const HIDDEN: CSSProperties = { position: 'fixed', top: 0, left: 0, right: 'auto', bottom: 'auto', visibility: 'hidden' }

export function useAnchoredMenu(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  placement: MenuPlacement
): { menuRef: RefObject<HTMLDivElement | null>; style: CSSProperties } {
  const menuRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>(HIDDEN)

  useLayoutEffect(() => {
    if (!open) {
      setStyle(HIDDEN)
      return
    }
    const place = (): void => {
      const t = triggerRef.current?.getBoundingClientRect()
      const menu = menuRef.current
      if (!t || !menu) return
      const mw = menu.offsetWidth
      const mh = menu.offsetHeight
      const gap = 6
      const margin = 8
      let top: number
      if (placement === 'up') {
        const above = t.top - mh - gap
        top = above >= margin ? above : t.bottom + 4 // flip down when there's no room above
      } else {
        const below = t.bottom + 4
        top = below + mh <= window.innerHeight - margin ? below : Math.max(margin, t.top - mh - gap) // flip up
      }
      // 'right' aligns the menu's right edge to the trigger's; the others align left edges.
      let left = placement === 'right' ? t.right - mw : t.left
      left = Math.max(margin, Math.min(left, window.innerWidth - mw - margin))
      top = Math.max(margin, Math.min(top, window.innerHeight - mh - margin))
      setStyle({ position: 'fixed', top, left, right: 'auto', bottom: 'auto' })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, placement, triggerRef])

  return { menuRef, style }
}
