/* ============================================================
   NicoSoft AI Studio — right workspace drawer
   List → single-panel navigation (not tabs): a launcher lists Tasks / Files /
   Terminal; picking one swaps the drawer body to that panel. Width is
   user-draggable + persisted; the active panel is persisted too (App.tsx
   PersistedState), so reopening the drawer returns to where you were.
   ============================================================ */
import { useRef, useState, type ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { useChat } from '@/stores/chat'
import { useT } from '@/stores/locale'
import { WorkspaceTasks } from '@/views/workspace-tasks'
import { WorkspaceFiles } from '@/views/workspace-files'
import { WorkspaceTerminal } from '@/views/workspace-terminal'

export type WorkspacePanel = 'menu' | 'tasks' | 'files' | 'terminal'

const MIN_W = 290
// No-history Tasks: a comfortable floor so the current per-role todos show in full instead of wrapping in
// the narrow 290–360 column. Still draggable WIDER; only the small lower bound is relaxed. (.ws-panel-body is
// a scroll container, so true content-fit width can't propagate — a width floor is the robust equivalent.)
const COMFORT_W = 480
// max 60vw so the drawer can never crush the main chat area on a small window.
const maxW = (): number => Math.round(window.innerWidth * 0.6)

export function WorkspaceDrawer({
  onClose,
  activeConv,
  activeExpert,
  panel,
  onPanel,
  width,
  onWidth
}: {
  onClose: () => void
  activeConv: string | null
  activeExpert: string
  panel: WorkspacePanel
  onPanel: (p: WorkspacePanel) => void
  width: number
  onWidth: (w: number) => void
}): ReactElement {
  const t = useT()
  const conv = useChat((s) => s.conversations.find((c) => c.id === activeConv)) ?? null
  // Live drag width: track locally during the drag for smooth feedback, commit to the persisted
  // store (App) on mouseup only — avoids a saveState write per mousemove frame.
  const [dragW, setDragW] = useState<number | null>(null)
  const w = dragW ?? width
  // Whether the active conversation's Tasks panel has any History (phases / examines / exited services).
  // null = not yet known (Tasks not mounted / still loading) — treated as "has history" so a history
  // conversation never flashes wide-then-narrow on open; only an explicit `false` relaxes the small window.
  // Reset to null on conversation switch so the previous conv's value never leaks into the new one's layout.
  const [hasHistory, setHasHistory] = useState<boolean | null>(null)
  // Reset SYNCHRONOUSLY on conversation switch (React-sanctioned set-during-render) so the previous conv's
  // `false` can't leak one frame and flash the drawer wide before a post-paint effect would clear it.
  const prevConvRef = useRef(activeConv)
  if (prevConvRef.current !== activeConv) {
    prevConvRef.current = activeConv
    setHasHistory(null)
  }
  // No-history Tasks → don't lock the narrow window: floor the width to COMFORT_W (still draggable wider,
  // still capped at 60vw). Files / Terminal and history-bearing Tasks keep the compact draggable width.
  const expandNoHistory = panel === 'tasks' && hasHistory === false
  const effW = expandNoHistory ? Math.min(maxW(), Math.max(w, COMFORT_W)) : w

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    document.body.style.userSelect = 'none'
    const onMove = (ev: MouseEvent): void => {
      // Handle sits on the LEFT edge: dragging left (smaller clientX) widens the drawer.
      setDragW(Math.max(MIN_W, Math.min(maxW(), startW - (ev.clientX - startX))))
    }
    const onUp = (): void => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      setDragW((cur) => {
        if (cur != null) onWidth(cur)
        return null
      })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const titleKey: Record<WorkspacePanel, string> = {
    menu: 'topbar.workspace',
    tasks: 'workspace.tasks',
    files: 'workspace.files',
    terminal: 'workspace.terminal'
  }

  return (
    <div className="workspace-drawer" style={{ flex: `0 0 ${effW}px`, width: effW }}>
      <div className="ws-resize" onMouseDown={startDrag} title={t('workspace.resize')} />
      <div className="ws-header">
        {panel !== 'menu' && (
          <button className="icon-btn" title={t('workspace.back')} onClick={() => onPanel('menu')}>
            <Icons.chevronLeft size={17} />
          </button>
        )}
        <span className="ws-title">{t(titleKey[panel])}</span>
        <button className="icon-btn" title={t('topbar.workspace')} onClick={onClose} style={{ marginLeft: 'auto' }}>
          <Icons.panelRight size={16} />
        </button>
      </div>
      {panel === 'menu' ? (
        <Launcher onPick={onPanel} />
      ) : panel === 'tasks' ? (
        <WorkspaceTasks activeConv={activeConv} onHasHistory={setHasHistory} />
      ) : panel === 'files' ? (
        <WorkspaceFiles conv={conv} activeExpert={activeExpert} />
      ) : (
        <WorkspaceTerminal conv={conv} activeExpert={activeExpert} />
      )}
    </div>
  )
}

function Launcher({ onPick }: { onPick: (p: WorkspacePanel) => void }): ReactElement {
  const t = useT()
  const entries: { panel: WorkspacePanel; icon: (typeof Icons)[string]; label: string; kbd: string }[] = [
    { panel: 'tasks', icon: Icons.listChecks, label: t('workspace.tasks'), kbd: '⌘J' },
    { panel: 'files', icon: Icons.folder, label: t('workspace.files'), kbd: '⌘P' },
    { panel: 'terminal', icon: Icons.terminal, label: t('workspace.terminal'), kbd: '⌃`' }
  ]
  return (
    <div className="ws-launcher">
      {entries.map((e) => (
        <button key={e.panel} className="ws-launch-row" onClick={() => onPick(e.panel)}>
          <span className="ws-launch-ic">{e.icon({ size: 17 })}</span>
          <span className="ws-launch-name">{e.label}</span>
          <kbd className="ws-launch-kbd">{e.kbd}</kbd>
        </button>
      ))}
    </div>
  )
}
