// App root — recreated from the prototype's app.jsx.
// The prototype simulated a desktop + scaled fixed window in the browser; here the Electron
// BrowserWindow IS the window, so the .desktop/.stage/scale/width-switch wrappers are dropped.
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Topbar, Sidebar } from '@/components/shell'
import { WindowControls } from '@/components/window-controls'
import { CommandPalette } from '@/components/dialogs/command-palette'
import { RoleEditorDialog } from '@/components/dialogs/role-editor-dialog'
import { RolePickerDialog } from '@/components/dialogs/role-picker-dialog'
import { Onboarding } from '@/views/onboarding'
import { SettingsView } from '@/views/settings'
import { StudioHome } from '@/views/studio'
import { ExtensionsView } from '@/views/extensions'
import { ProjectsView } from '@/views/projects'
import { ScheduledView } from '@/views/scheduled'
import { ExpertDetail } from '@/views/expert'
import { ChatView } from '@/views/conversation'
import { WorkspaceDrawer, type WorkspacePanel } from '@/views/workspace'
import { MemoryLive } from '@/views/memory-live'
import { useChat } from '@/stores/chat'
import { useRoles } from '@/stores/roles'
import { useCustomRoles } from '@/stores/custom-roles'
import { useMemoryCloud } from '@/stores/memory-cloud'
import { useAllExperts } from '@/lib/all-experts'
import { Toaster } from '@/components/toaster'
import { UpdatePrompt } from '@/components/update-prompt'

const LS_KEY = 'nicosoft-studio-state-v1'

interface PersistedState {
  view?: string
  activeExpert?: string
  settingsTab?: string
  drawerOpen?: boolean
  sidebarCollapsed?: boolean
  activeProject?: string | null
  workspacePanel?: WorkspacePanel
  drawerWidth?: number
}

function loadState(): PersistedState {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}') as PersistedState
  } catch {
    return {}
  }
}
function saveState(s: PersistedState): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

export default function App(): ReactElement {
  const chat = useChat()
  const { experts, byId: EXPERT_BY_ID } = useAllExperts()
  const roles = useRoles()
  const memCloud = useMemoryCloud()
  const persisted = loadState()

  const [view, setView] = useState<string>(persisted.view || 'onboarding')
  const [activeExpert, setActiveExpert] = useState<string>(persisted.activeExpert || 'coordinator')
  const [settingsTab, setSettingsTab] = useState<string>(persisted.settingsTab || 'endpoints')
  const [cmdk, setCmdk] = useState(false)
  // "New conversation" role picker: a new conversation is a conversation WITH someone — the user picks
  // who (the old behavior hard-jumped to generalist). Opened by the sidebar's new-conversation button.
  const [rolePicker, setRolePicker] = useState(false)
  // null = closed, {} = create mode, {initialRole} = edit mode for an existing custom role.
  const [roleDialog, setRoleDialog] = useState<null | { initialRole?: { id: string; name: string; color: string | null; systemPrompt: string | null; greeting: string | null; tools: string[] } }>(null)
  const [drawerOpen, setDrawerOpen] = useState<boolean>(persisted.drawerOpen || false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(persisted.sidebarCollapsed || false)
  const [activeProject, setActiveProject] = useState<string | null>(persisted.activeProject || null)
  // Workspace drawer: which panel is showing (menu launcher / tasks / files / terminal) + the
  // user-dragged width. Both persisted alongside drawerOpen so the drawer reopens where it was.
  const [workspacePanel, setWorkspacePanel] = useState<WorkspacePanel>(persisted.workspacePanel || 'menu')
  const [drawerWidth, setDrawerWidth] = useState<number>(persisted.drawerWidth || 360)
  const [fromProject, setFromProject] = useState<string | null>(null) // project an expert chat was opened FROM (back-breadcrumb)

  useEffect(() => {
    saveState({ view, activeExpert, settingsTab, drawerOpen, sidebarCollapsed, activeProject, workspacePanel, drawerWidth })
  }, [view, activeExpert, settingsTab, drawerOpen, sidebarCollapsed, activeProject, workspacePanel, drawerWidth])

  // Load the persisted conversation history + role enable/disable states + user-defined custom roles
  // once on mount. Until each store's load() completes, the sidebar shows built-ins only; customs
  // appear once the list resolves (typically one frame).
  useEffect(() => {
    const startupExpert = persisted.activeExpert || 'coordinator'
    void chat.loadConversations().then(() => {
      // Land startup on the last chat's history, not the empty greeting. The persisted view restores the
      // active expert (e.g. Georgia) but not its conversation, so the chat opened on the greeting until
      // you re-clicked the role. Open that expert's most-recent conversation now (conversations are
      // updated_at-DESC → first match is the latest). No-op if the user already navigated or the expert
      // has no history. Mirrors selectExpert's in-session restore.
      const s = useChat.getState()
      if (s.activeConv) return
      const restore = s.conversations.find((c) => c.primaryRoleId === startupExpert)
      if (restore) void s.openConversation(restore.id)
    })
    void useRoles.getState().load()
    void useCustomRoles.getState().load()
    // Run-once startup loader: reads stores via getState() (not deps) on purpose — depending on them
    // would re-run the restore on every store identity change. Keyed only on the stable loadConversations.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.loadConversations])

  // First-run gate: when localStorage hasn't already chosen a view, honor the durable onboarded flag so
  // clearing localStorage doesn't replay onboarding once it's been completed.
  useEffect(() => {
    if (persisted.view) return
    void window.api.settings.get<boolean>('onboarded').then((done) => {
      if (done) setView('studio')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdk((c) => !c)
      } else if (e.key === 'Escape') {
        setCmdk(false)
        setRoleDialog(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Workspace panel shortcuts (Files ⌘P / Tasks ⌘J / Terminal ⌃`). Only in the conversation view (the
  // drawer lives there). Two guards (design §1):
  //  - Focus guard (P23): never hijack a key while focus is in an editable field (composer textarea,
  //    xterm's hidden textarea, any contentEditable) — `editable` short-circuits before we preventDefault.
  //  - ⌃` focus-aware (P29): when focus is inside the terminal, the editable guard already returns, so
  //    xterm receives Ctrl+` itself; the panel toggle only fires when the terminal is NOT focused.
  // Pressing the shortcut for the panel already showing toggles the drawer closed (VS Code-style).
  // Chosen keys don't collide with the default app menu or ⌘K cmdk (verified — see main/index.ts note).
  useEffect(() => {
    if (view !== 'app') return
    const togglePanel = (p: WorkspacePanel): void => {
      if (drawerOpen && workspacePanel === p) setDrawerOpen(false)
      else {
        setWorkspacePanel(p)
        setDrawerOpen(true)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement as HTMLElement | null
      const editable = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      // Terminal toggle: Ctrl+` (layout-independent via code). Yield to a focused terminal.
      if (e.ctrlKey && !e.metaKey && e.code === 'Backquote') {
        if (editable) return
        e.preventDefault()
        togglePanel('terminal')
        return
      }
      if (editable) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        togglePanel('files')
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        togglePanel('tasks')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, drawerOpen, workspacePanel])

  const selectExpert = (id: string, from: string | null = null): void => {
    setFromProject(from) // set only when coming from a project lane; cleared otherwise
    setActiveExpert(id)
    // Returning to the expert that owns the active conversation (e.g. collab → Projects → back to Danny)?
    // Keep it. Only start a fresh conversation when actually switching to a DIFFERENT expert — the old
    // unconditional newConversation() reset activeConv=null and lost the running collaboration.
    const cur = chat.conversations.find((c) => c.id === chat.activeConv)
    if (cur?.primaryRoleId !== id) {
      // Switching to a different expert: RESTORE its session rather than always blanking. Prefer an
      // in-flight run (never drop you on an empty screen while a run keeps going invisibly), else the
      // expert's most-recent conversation (conversations is updated_at-DESC, so the first match for this
      // role is its latest), else start fresh. "Switch back to Flynn → continue where I left off."
      const running = chat.conversations.find((c) => c.primaryRoleId === id && chat.streaming[c.id])
      const restore = running ?? chat.conversations.find((c) => c.primaryRoleId === id)
      if (restore) void chat.openConversation(restore.id)
      else chat.newConversation()
    }
    setView('app')
    setCmdk(false)
  }
  // Memory provenance jump (settings › memory "learned from" button) — the memory list lives deep in
  // the settings tree, so it dispatches a window event instead of threading a callback through every
  // layer. Re-subscribed each render so the handler always closes over the latest selectConv state.
  useEffect(() => {
    const h = (e: Event): void => {
      const convId = (e as CustomEvent<{ convId?: string }>).detail?.convId
      if (convId) selectConv(convId)
    }
    window.addEventListener('nsai:open-conversation', h)
    return () => window.removeEventListener('nsai:open-conversation', h)
  })

  const selectConv = (id: string): void => {
    const conv = chat.conversations.find((c) => c.id === id)
    void chat.openConversation(id)
    if (conv?.primaryRoleId) setActiveExpert(conv.primaryRoleId)
    setFromProject(null)
    setView('app')
    setCmdk(false)
  }
  const openSettings = (tab?: string): void => {
    if (typeof tab === 'string') setSettingsTab(tab)
    setView('settings')
    setCmdk(false)
  }
  const openStudio = (): void => {
    setView('studio')
    setCmdk(false)
  }
  const openExtensions = (): void => {
    setView('extensions')
    setCmdk(false)
  }
  const openProjects = (): void => {
    setActiveProject(null)
    setView('projects')
    setCmdk(false)
  }
  const openProject = (id: string): void => {
    setActiveProject(id)
    setFromProject(null)
    setView('projects')
    setCmdk(false)
  }
  const openScheduled = (): void => {
    setView('scheduled')
    setCmdk(false)
  }
  const openProfile = (id: string): void => {
    setActiveExpert(id)
    setView('expert')
    setCmdk(false)
  }
  const openEndpointsSettings = (): void => {
    setSettingsTab('endpoints')
    setView('settings')
  }

  const expert = EXPERT_BY_ID[activeExpert] || EXPERT_BY_ID.generalist
  const navView = ['studio', 'extensions', 'projects', 'scheduled'].includes(view)

  if (view === 'onboarding') {
    return (
      <div className="window">
        <Onboarding
          onFinish={() => {
            setView('studio')
            chat.newConversation()
            setActiveExpert('generalist')
          }}
        />
        <Toaster />
        <WindowControls />
      </div>
    )
  }

  return (
    <div className="window">
      {view === 'settings' ? (
        <SettingsView tab={settingsTab} onTab={setSettingsTab} onBack={() => setView('app')} />
      ) : (
        <div className="app-body">
          <Sidebar
            studioActive={view === 'studio'}
            extensionsActive={view === 'extensions'}
            projectsActive={view === 'projects'}
            scheduledActive={view === 'scheduled'}
            onStudio={openStudio}
            onExtensions={openExtensions}
            onProjects={openProjects}
            onScheduled={openScheduled}
            activeExpert={navView ? null : activeExpert}
            activeConv={navView ? null : chat.activeConv}
            conversations={chat.conversations}
            onSelectExpert={selectExpert}
            onOpenProfile={openProfile}
            onSelectConv={selectConv}
            onNewRole={() => setRoleDialog({})}
            onNewConversation={() => setRolePicker(true)}
            collapsed={sidebarCollapsed}
          />
          <div className="main-area">
            <Topbar
              onCommand={() => setCmdk(true)}
              onSettings={openSettings}
              workspace={view === 'app' ? { open: drawerOpen, onToggle: () => setDrawerOpen((s) => !s) } : null}
              sidebar={{ collapsed: sidebarCollapsed, onToggle: () => setSidebarCollapsed((s) => !s) }}
            />
            <div className="main-row">
            {view === 'studio' ? (
            <StudioHome
              onOpenExpert={selectExpert}
              onOpenConv={selectConv}
              onOpenProject={openProject}
              onNewRole={() => setRoleDialog({})}
            />
          ) : view === 'extensions' ? (
            <ExtensionsView />
          ) : view === 'projects' ? (
            <ProjectsView
              activeProject={activeProject}
              onSelect={(id: string | null) => setActiveProject(id)}
              onOpenExpert={(id: string) => selectExpert(id, activeProject)}
            />
          ) : view === 'scheduled' ? (
            <ScheduledView onOpenConversation={selectConv} />
          ) : view === 'expert' ? (
            <ExpertDetail
              expertId={activeExpert}
              onChat={selectExpert}
              onOpenConv={selectConv}
              onOpenEndpoint={openEndpointsSettings}
              onEdit={(initialRole) => setRoleDialog({ initialRole })}
              onDeleted={openStudio}
            />
          ) : (
            <ChatView expert={expert} onOpenSettings={openEndpointsSettings} onBackToProject={fromProject ? () => openProject(fromProject) : undefined} />
          )}
            {view === 'app' && drawerOpen && (
              <WorkspaceDrawer
                onClose={() => setDrawerOpen(false)}
                activeConv={chat.activeConv}
                activeExpert={activeExpert}
                panel={workspacePanel}
                onPanel={setWorkspacePanel}
                width={drawerWidth}
                onWidth={setDrawerWidth}
              />
            )}
          </div>
          </div>
        </div>
      )}

      {cmdk && (
        <CommandPalette
          onClose={() => setCmdk(false)}
          onSelectConv={selectConv}
          onSelectExpert={selectExpert}
          onSettings={openSettings}
          onStudio={openStudio}
          onNewRole={() => {
            setCmdk(false)
            setRoleDialog({})
          }}
        />
      )}
      {memCloud.open && <MemoryLive onClose={memCloud.hide} />}
      {roleDialog && <RoleEditorDialog initialRole={roleDialog.initialRole} onClose={() => setRoleDialog(null)} />}
      {rolePicker && (
        <RolePickerDialog
          // Same enabled-set the sidebar shows: until role states hydrate treat all as enabled (coordinator
          // is always enabled by the store's own rule).
          experts={roles.loaded ? experts.filter((e) => !roles.isDisabled(e.id)) : experts}
          currentId={activeExpert}
          onPick={(id) => {
            setRolePicker(false)
            chat.newConversation()
            setActiveExpert(id)
            setView('app')
          }}
          onClose={() => setRolePicker(false)}
        />
      )}
      <UpdatePrompt />
      <Toaster />
      <WindowControls />
    </div>
  )
}
