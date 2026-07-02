// Typewriter reveal hook (docs/streaming-render-alignment §3.3) — the React half; the pure cadence
// functions live in typewriter.ts. Two-layer decoupling, exactly like Claude Desktop's stepper: the
// store may update on every coalesced IPC batch (16ms), but REACT re-renders are driven by this hook's
// reveal steps (25–150ms adaptive) — a rAF loop advances `revealed` toward a holdBack ceiling at
// interval = clamp(12000/backlog, 25, 150). While the document is hidden the loop idles; on return we
// jump straight to the ceiling (no invisible animation). When `active` drops (done), the full text
// returns immediately — no tail animation after the stream settled.
import { useEffect, useMemo, useRef, useState } from 'react'
import { holdBackCeiling } from './holdback'
import { stepInterval, nextRevealPoint } from './typewriter'

export function useTypewriter(fullText: string, active: boolean): { visible: string; marks: readonly number[] } {
  const [state, setState] = useState<{ revealed: number; marks: readonly number[] }>({ revealed: 0, marks: [] })
  const revealedRef = useRef(0)
  const ceiling = useMemo(() => (active ? holdBackCeiling(fullText) : fullText.length), [fullText, active])
  const dataRef = useRef({ text: fullText, ceiling })
  dataRef.current = { text: fullText, ceiling }

  // Leading step DURING render (Desktop does the same): the very first delta becomes visible in the
  // same commit it arrived in, not a frame later. Idempotent under StrictMode's double render — the
  // second pass sees revealedRef already advanced.
  if (active && state.revealed === 0 && revealedRef.current === 0 && ceiling > 0) {
    const first = nextRevealPoint(fullText, 0, ceiling)
    if (first > 0) {
      revealedRef.current = first
      setState({ revealed: first, marks: [first] })
    }
  }

  useEffect(() => {
    if (!active) return
    let raf = 0
    let last = performance.now()
    const step = (now: number): void => {
      raf = requestAnimationFrame(step)
      const { text, ceiling } = dataRef.current
      const backlog = ceiling - revealedRef.current
      if (backlog <= 0) {
        last = now
        return
      }
      if (now - last < stepInterval(backlog)) return
      last = now
      const next = nextRevealPoint(text, revealedRef.current, ceiling)
      if (next > revealedRef.current) {
        revealedRef.current = next
        setState((s) => ({ revealed: next, marks: s.marks[s.marks.length - 1] === next ? s.marks : [...s.marks, next] }))
      }
    }
    raf = requestAnimationFrame(step)
    const onVis = (): void => {
      if (document.hidden) return // hidden: the loop idles; nothing to do
      const c = dataRef.current.ceiling
      if (c > revealedRef.current) {
        revealedRef.current = c
        setState((s) => ({ revealed: c, marks: [...s.marks, c] })) // back to foreground → jump to the ceiling
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVis)
      // Reset the reveal (a future re-activation starts from 0) but KEEP marks — on done the spans they
      // produced must stay where they are, so the settled text renders with the same fade structure and
      // nothing re-animates or jumps.
      revealedRef.current = 0
      setState((s) => (s.revealed === 0 ? s : { revealed: 0, marks: s.marks }))
    }
  }, [active])

  const visible = active ? fullText.slice(0, Math.min(state.revealed, ceiling)) : fullText
  return { visible, marks: state.marks }
}
