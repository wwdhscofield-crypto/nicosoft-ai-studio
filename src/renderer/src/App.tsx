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
import { HexAgentView } from '@/views/hex'
import { WorkspaceDrawer } from '@/views/workspace'
import { useChat } from '@/stores/chat'

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
  const { EXPERT_BY_ID } = STUDIO_DATA
  const chat = useChat()
  const persisted = loadState()

  const [view, setView] = useState<string>(persisted.view || 'onboarding')
  const [activeExpert, setActiveExpert] = useState<string>(persisted.activeExpert || 'hex')
  const [settingsTab, setSettingsTab] = useState<string>(persisted.settingsTab || 'endpoints')
  const [cmdk, setCmdk] = useState(false)
  const [roleDialog, setRoleDialog] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState<boolean>(persisted.drawerOpen || false)
  const [activeProject, setActiveProject] = useState<string | null>(persisted.activeProject || null)

  useEffect(() => {
    saveState({ view, activeExpert, settingsTab, drawerOpen, activeProject })
  }, [view, activeExpert, settingsTab, drawerOpen, activeProject])

  // Load the persisted conversation history once on mount.
  useEffect(() => {
    void chat.loadConversations()
  }, [chat.loadConversations])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmdk((c) => !c)
      } else if (e.key === 'Escape') {
        setCmdk(false)
        setRoleDialog(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const selectExpert = (id: string): void => {
    setActiveExpert(id)
    chat.newConversation()
    setView('app')
    setCmdk(false)
  }
  const selectConv = (id: string): void => {
    const conv = chat.conversations.find((c) => c.id === id)
    void chat.openConversation(id)
    if (conv?.primaryRoleId) setActiveExpert(conv.primaryRoleId)
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

  const expert = EXPERT_BY_ID[activeExpert] || EXPERT_BY_ID.iris
  const navView = ['studio', 'extensions', 'projects', 'scheduled'].includes(view)

  if (view === 'onboarding') {
    return (
      <div className="window">
        <Onboarding
          onFinish={() => {
            setView('studio')
            chat.newConversation()
            setActiveExpert('iris')
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
            onNewRole={() => setRoleDialog(true)}
            onNewConversation={() => {
              chat.newConversation()
              setActiveExpert('iris')
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
              onNewRole={() => setRoleDialog(true)}
            />
          ) : view === 'extensions' ? (
            <ExtensionsView />
          ) : view === 'projects' ? (
            <ProjectsView
              activeProject={activeProject}
              onSelect={(id: string | null) => setActiveProject(id)}
              onOpenExpert={openProfile}
            />
          ) : view === 'scheduled' ? (
            <ScheduledView />
          ) : view === 'expert' ? (
            <ExpertDetail
              expertId={activeExpert}
              onChat={selectExpert}
              onOpenConv={selectConv}
              onOpenEndpoint={openEndpointsSettings}
              onDeleted={openStudio}
            />
          ) : expert.id === 'hex' ? (
            <HexAgentView expert={expert} onOpenSettings={openEndpointsSettings} />
          ) : (
            <ChatView expert={expert} onOpenSettings={openEndpointsSettings} />
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
            setRoleDialog(true)
          }}
        />
      )}
      {roleDialog && <RoleEditorDialog onClose={() => setRoleDialog(false)} />}
    </div>
  )
}
