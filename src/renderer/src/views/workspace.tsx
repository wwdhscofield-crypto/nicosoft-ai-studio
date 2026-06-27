/* ============================================================
   NicoSoft AI Studio — right workspace drawer
   List → single-panel navigation (not tabs): a launcher lists Tasks / Files /
   Terminal; picking one swaps the drawer body to that panel. Width is
   user-draggable + persisted; the active panel is persisted too (App.tsx
   PersistedState), so reopening the drawer returns to where you were.
   ============================================================ */
import { useEffect, useState, type ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { useChat } from '@/stores/chat'
import { useT } from '@/stores/locale'
import { WorkspaceTasks } from '@/views/workspace-tasks'
import { WorkspaceFiles } from '@/views/workspace-files'
import { WorkspaceTerminal } from '@/views/workspace-terminal'
import { WorkspacePreview } from '@/views/workspace-preview'
import type { PreviewOpenEvent } from '@/lib/preview-api'

export type WorkspacePanel = 'menu' | 'tasks' | 'files' | 'terminal' | 'preview'

const MIN_W = 290
// max 60vw so the drawer can never crush the main chat area on a small window.
const maxW = (): number => Math.round(window.innerWidth * 0.6)

export function WorkspaceDrawer({
  onClose,
  activeConv,
  activeExpert,
  panel,
  onPanel,
  width,
  onWidth,
  previewRequest
}: {
  onClose: () => void
  activeConv: string | null
  activeExpert: string
  panel: WorkspacePanel
  onPanel: (p: WorkspacePanel) => void
  width: number
  onWidth: (w: number) => void
  previewRequest: PreviewOpenEvent | null
}): ReactElement {
  const t = useT()
  const conv = useChat((s) => s.conversations.find((c) => c.id === activeConv)) ?? null
  // Live drag width: track locally during the drag for smooth feedback, commit to the persisted
  // store (App) on mouseup only — avoids a saveState write per mousemove frame.
  const [dragW, setDragW] = useState<number | null>(null)
  const w = dragW ?? width

  // Keep Preview mounted once opened: collapsing it (or switching to another panel) HIDES the <webview> rather
  // than unmounting it. The agent drives that webContents directly, so unmounting would tear down the live preview
  // session mid-flight. Lazily mount on first open; it then persists (hidden) as long as the drawer stays open.
  const [previewMounted, setPreviewMounted] = useState(panel === 'preview')
  useEffect(() => {
    if (panel === 'preview') setPreviewMounted(true)
  }, [panel])

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
    terminal: 'workspace.terminal',
    preview: 'workspace.preview'
  }

  return (
    <div className="workspace-drawer" style={{ flex: `0 0 ${w}px`, width: w }}>
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
        <WorkspaceTasks activeConv={activeConv} />
      ) : panel === 'files' ? (
        <WorkspaceFiles conv={conv} activeExpert={activeExpert} />
      ) : panel === 'terminal' ? (
        <WorkspaceTerminal conv={conv} activeExpert={activeExpert} />
      ) : null}
      {previewMounted && (
        <div className="ws-preview-host" hidden={panel !== 'preview'}>
          <WorkspacePreview
            activeConv={activeConv}
            openRequest={previewRequest}
            onCollapse={() => onPanel('menu')}
          />
        </div>
      )}
    </div>
  )
}

function Launcher({ onPick }: { onPick: (p: WorkspacePanel) => void }): ReactElement {
  const t = useT()
  const entries: { panel: WorkspacePanel; icon: (typeof Icons)[string]; label: string; kbd: string }[] = [
    { panel: 'tasks', icon: Icons.listChecks, label: t('workspace.tasks'), kbd: '⌘J' },
    { panel: 'files', icon: Icons.folder, label: t('workspace.files'), kbd: '⌘P' },
    { panel: 'terminal', icon: Icons.terminal, label: t('workspace.terminal'), kbd: '⌃`' },
    { panel: 'preview', icon: Icons.globe, label: t('workspace.preview'), kbd: '⌘⇧V' }
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
