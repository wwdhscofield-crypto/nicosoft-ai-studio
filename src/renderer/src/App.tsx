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
import { ConversationView, EmptyState, Composer } from '@/views/conversation'
import { WorkspaceDrawer } from '@/views/workspace'

const LS_KEY = 'nicosoft-studio-state-v1'

interface PersistedState {
  view?: string
  activeConv?: string | null
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
  const { CONVERSATIONS, EXPERT_BY_ID } = STUDIO_DATA
  const persisted = loadState()

  const [view, setView] = useState<string>(persisted.view || 'onboarding')
  const [activeConv, setActiveConv] = useState<string | null>(persisted.activeConv ?? 'oauth')
  const [activeExpert, setActiveExpert] = useState<string>(persisted.activeExpert || 'hex')
  const [settingsTab, setSettingsTab] = useState<string>(persisted.settingsTab || 'endpoints')
  const [cmdk, setCmdk] = useState(false)
  const [roleDialog, setRoleDialog] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState<boolean>(persisted.drawerOpen || false)
  const [activeProject, setActiveProject] = useState<string | null>(persisted.activeProject || null)

  useEffect(() => {
    saveState({ view, activeConv, activeExpert, settingsTab, drawerOpen, activeProject })
  }, [view, activeConv, activeExpert, settingsTab, drawerOpen, activeProject])

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
    setActiveConv(null)
    setView('app')
    setCmdk(false)
  }
  const selectConv = (id: string): void => {
    const c = CONVERSATIONS[id]
    if (!c) return
    setActiveConv(id)
    setActiveExpert(c.expert)
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
    setActiveConv(null)
    setView('expert')
    setCmdk(false)
  }
  const openEndpointsSettings = (): void => {
    setSettingsTab('endpoints')
    setView('settings')
  }

  const conv = activeConv ? CONVERSATIONS[activeConv] : null
  const expert = EXPERT_BY_ID[activeExpert] || EXPERT_BY_ID.iris
  const navView = ['studio', 'extensions', 'projects', 'scheduled'].includes(view)

  if (view === 'onboarding') {
    return (
      <div className="window">
        <Onboarding
          onFinish={() => {
            setView('studio')
            setActiveConv(null)
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
            activeConv={navView ? null : activeConv}
            onSelectExpert={selectExpert}
            onOpenProfile={openProfile}
            onSelectConv={selectConv}
            onNewRole={() => setRoleDialog(true)}
            onNewConversation={() => {
              setActiveConv(null)
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
          ) : conv ? (
            <ConversationView conv={conv} onOpenSettings={openSettings} />
          ) : (
            <div className="main-col">
              <EmptyState expert={expert} onChip={() => {}} />
              <Composer
                expert={expert}
                noEndpoint={expert.unconfigured}
                onMention={(id: string) => selectExpert(id)}
                onOpenSettings={openEndpointsSettings}
              />
            </div>
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
