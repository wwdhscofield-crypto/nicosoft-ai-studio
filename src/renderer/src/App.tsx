// App root — recreated from the prototype's app.jsx.
// The prototype simulated a desktop + scaled fixed window in the browser; here the Electron
// BrowserWindow IS the window, so the .desktop/.stage/scale/width-switch wrappers are dropped.
import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { STUDIO_DATA } from '@/data/studio-data'
import { Topbar, Sidebar } from '@/components/shell'
import { CommandPalette, RoleEditorDialog } from '@/components/dialogs'
import { Onboarding } from '@/views/onboarding'
import { SettingsView } from '@/views/settings'
import { StudioHome } from '@/views/studio'
import { ExtensionsView } from '@/views/extensions'
import { ProjectsView } from '@/views/projects'
import { ScheduledView } from '@/views/scheduled'
import { ExpertDetail } from '@/views/expert'
import { ChatView } from '@/views/conversation'
import { WorkspaceDrawer } from '@/views/workspace'
import { useChat } from '@/stores/chat'
import { useRoles } from '@/stores/roles'
import { useCustomRoles } from '@/stores/custom-roles'
import { useAllExperts } from '@/lib/all-experts'
import { Toaster } from '@/components/toaster'

const LS_KEY = 'nicosoft-studio-state-v1'

interface PersistedState {
  view?: string
  activeExpert?: string
  settingsTab?: string
  drawerOpen?: boolean
  activeProject?: string | null
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
  const { byId: EXPERT_BY_ID } = useAllExperts()
  const persisted = loadState()

  const [view, setView] = useState<string>(persisted.view || 'onboarding')
  const [activeExpert, setActiveExpert] = useState<string>(persisted.activeExpert || 'engineer')
  const [settingsTab, setSettingsTab] = useState<string>(persisted.settingsTab || 'endpoints')
  const [cmdk, setCmdk] = useState(false)
  // null = closed, {} = create mode, {initialRole} = edit mode for an existing custom role.
  const [roleDialog, setRoleDialog] = useState<null | { initialRole?: { id: string; name: string; color: string | null; systemPrompt: string | null; greeting: string | null; tools: string[] } }>(null)
  const [drawerOpen, setDrawerOpen] = useState<boolean>(persisted.drawerOpen || false)
  const [activeProject, setActiveProject] = useState<string | null>(persisted.activeProject || null)
  const [fromProject, setFromProject] = useState<string | null>(null) // project an expert chat was opened FROM (back-breadcrumb)

  useEffect(() => {
    saveState({ view, activeExpert, settingsTab, drawerOpen, activeProject })
  }, [view, activeExpert, settingsTab, drawerOpen, activeProject])

  // Load the persisted conversation history + role enable/disable states + user-defined custom roles
  // once on mount. Until each store's load() completes, the sidebar shows built-ins only; customs
  // appear once the list resolves (typically one frame).
  useEffect(() => {
    const startupExpert = persisted.activeExpert || 'engineer'
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
            onNewConversation={() => {
              chat.newConversation()
              setActiveExpert('generalist')
              setView('app')
            }}
          />
          <div className="main-area">
            <Topbar
              onCommand={() => setCmdk(true)}
              onSettings={openSettings}
              workspace={view === 'app' ? { open: drawerOpen, onToggle: () => setDrawerOpen((s) => !s) } : null}
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
            {view === 'app' && drawerOpen && <WorkspaceDrawer onClose={() => setDrawerOpen(false)} activeConv={chat.activeConv} />}
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
      {roleDialog && <RoleEditorDialog initialRole={roleDialog.initialRole} onClose={() => setRoleDialog(null)} />}
      <Toaster />
    </div>
  )
}
