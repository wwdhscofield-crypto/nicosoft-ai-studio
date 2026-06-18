/* ============================================================
   Workspace · Terminal sessions (renderer side, design §4).
   Sessions are bound to the GLOBAL workspace, not a conversation — switching chats (or hiding the panel)
   must NOT kill them. So the live xterm instances + their detached host elements live in a module-level
   Map (survives React remounts); the panel re-parents the hosts back into its mount on mount. Only the
   reactive metadata (id list + active) goes through zustand. Sessions are session-only: killed on app
   quit (main) / explicit close, never persisted.
   ============================================================ */
import { create } from 'zustand'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface Instance {
  host: HTMLDivElement
  term: Terminal
  fit: FitAddon
  offData: () => void
  offExit: () => void
  offTitle: () => void
}
// Non-reactive: the actual xterm instances + their (possibly detached) DOM hosts, keyed by pty id.
const instances = new Map<string, Instance>()

export interface TermSessionMeta {
  id: string
  exited: boolean
  title: string // live foreground-process name (zsh/node/npm...) pushed from main; '' until first known
}
interface TermStore {
  sessions: TermSessionMeta[]
  activeId: string | null
  setActive: (id: string) => void
  createSession: (cwd: string | null) => Promise<void>
  /** Idempotent first-session open — safe to call on every panel mount (survives remounts; race-safe). */
  autoOpen: (cwd: string | null) => Promise<void>
  closeSession: (id: string) => void
}

// Module-level (survive React remounts): guard the ONE automatic first-session open. The panel truly
// unmounts/remounts when you switch drawer panels, so a component-local ref would reset and — during the
// async create round-trip — let a fast panel toggle spawn a second pty. These live for the app session.
let autoOpening = false
let everAutoOpened = false

const THEME = {
  background: '#0c0c10',
  foreground: '#d4d4d8',
  cursor: '#e4e4e7',
  selectionBackground: '#3b3b46',
  black: '#18181b',
  brightBlack: '#52525b'
}

export const useTerminals = create<TermStore>((set, get) => ({
  sessions: [],
  activeId: null,
  setActive: (id) => set({ activeId: id }),

  createSession: async (cwd) => {
    const host = document.createElement('div')
    host.className = 'xterm-host'
    const term = new Terminal({
      fontSize: 12,
      fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    let id: string
    try {
      const r = await window.api.terminal.create({ cwd: cwd ?? undefined, cols: term.cols || 80, rows: term.rows || 24 })
      id = r.id
    } catch (e) {
      term.dispose()
      throw e instanceof Error ? e : new Error('terminal-unavailable')
    }

    const offData = window.api.onTerminalData((d) => {
      if (d.id === id) term.write(d.data)
    })
    const offExit = window.api.onTerminalExit((d) => {
      if (d.id !== id) return
      term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, exited: true } : x)) }))
    })
    const offTitle = window.api.onTerminalTitle((d) => {
      if (d.id !== id) return
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, title: d.title } : x)) }))
    })
    term.onData((data) => void window.api.terminal.write(id, data))
    term.onResize(({ cols, rows }) => void window.api.terminal.resize(id, cols, rows))

    instances.set(id, { host, term, fit, offData, offExit, offTitle })
    set((s) => ({ sessions: [...s.sessions, { id, exited: false, title: '' }], activeId: id }))
  },

  autoOpen: async (cwd) => {
    if (everAutoOpened || autoOpening || get().sessions.length > 0) return
    everAutoOpened = true // open the first session at most once per app run (don't re-open after the user closes all)
    autoOpening = true
    try {
      await get().createSession(cwd)
    } finally {
      autoOpening = false
    }
  },

  closeSession: (id) => {
    const inst = instances.get(id)
    if (inst) {
      inst.offData()
      inst.offExit()
      inst.offTitle()
      void window.api.terminal.kill(id)
      inst.term.dispose()
      inst.host.remove()
      instances.delete(id)
    }
    set((s) => {
      const sessions = s.sessions.filter((x) => x.id !== id)
      const activeId = s.activeId === id ? (sessions[sessions.length - 1]?.id ?? null) : s.activeId
      return { sessions, activeId }
    })
  }
}))

export function hostOf(id: string): HTMLDivElement | undefined {
  return instances.get(id)?.host
}
export function fitSession(id: string): void {
  try {
    instances.get(id)?.fit.fit()
  } catch {
    /* fit can throw mid-teardown — ignore */
  }
}
