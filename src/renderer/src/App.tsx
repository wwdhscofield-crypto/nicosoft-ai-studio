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
    void chat.loadConversations()
    void useRoles.getState().load()
    void useCustomRoles.getState().load()
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
      // Switching to a different expert: don't blank out an IN-FLIGHT run. If this expert has a streaming
      // conversation, restore it (tabbing away and back used to drop you on an empty screen while the run
      // kept going invisibly); otherwise start fresh as before.
      const running = chat.conversations.find((c) => c.primaryRoleId === id && chat.streaming[c.id])
      if (running) void chat.openConversation(running.id)
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
            <ScheduledView />
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
            {view === 'app' && drawerOpen && <WorkspaceDrawer onClose={() => setDrawerOpen(false)} />}
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
    </div>
  )
}
