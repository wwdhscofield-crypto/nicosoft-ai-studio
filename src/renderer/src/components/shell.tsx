/* ============================================================
   NicoSoft AI Studio — app shell: Topbar + Sidebar
   ============================================================ */
import { Fragment, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Avatar } from '@/components/primitives'
import { ConfirmDialog, PromptDialog } from '@/components/dialogs'
import { STUDIO_DATA } from '@/data/studio-data'
import { useRoles } from '@/stores/roles'
import { useAllExperts } from '@/lib/all-experts'
import { useChat } from '@/stores/chat'
import type { Expert } from '@/types'
import type { ConversationDto } from '@/lib/api'

/* — Top bar: quiet right-aligned icon cluster, no border, no endpoint pills, no title.
   View-aware: a conversation view passes `workspace` to surface the panel toggle + actions. — */
export function Topbar({
  onCommand,
  onSettings,
  workspace
}: {
  onCommand: () => void
  onSettings: () => void
  workspace?: { open: boolean; onToggle: () => void } | null
}): ReactElement {
  const chat = useChat()
  const cid = chat.activeConv
  const curTitle = chat.conversations.find((c) => c.id === cid)?.title ?? ''
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const doExport = (fmt: 'md' | 'json'): void => {
    setMenu(false)
    if (cid) void window.api.conversations.export(cid, fmt)
  }
  return (
    <div className="topbar">
      <div className="spacer" />
      <div className="top-actions">
        {workspace && (
          <>
            <button
              className={'icon-btn' + (workspace.open ? ' on' : '')}
              title="Workspace"
              onClick={workspace.onToggle}
            >
              <Icons.panelRight size={17} />
            </button>
            <div className="conv-menu-wrap">
              <button className="icon-btn" title="Actions" onClick={() => setMenu((s) => !s)}>
                <Icons.more size={17} />
              </button>
              {menu && (
                <>
                  <div className="menu-backdrop" onClick={() => setMenu(false)} />
                  <div className="row-menu right">
                    <div className="rm-item" onClick={() => { setMenu(false); setRenaming(true) }}><Icons.edit size={14} /> Rename</div>
                    <div className="rm-item" onClick={() => doExport('md')}><Icons.download size={14} /> Export Markdown</div>
                    <div className="rm-item" onClick={() => doExport('json')}><Icons.download size={14} /> Export JSON</div>
                    <div className="rm-item danger" onClick={() => { setMenu(false); setConfirmDel(true) }}><Icons.trash size={14} /> Delete</div>
                  </div>
                </>
              )}
            </div>
          </>
        )}
        <button className="kbd-hint" onClick={onCommand}>
          <Icons.search size={14} />
          <kbd>⌘K</kbd>
        </button>
        <button className="icon-btn" onClick={onSettings} title="Settings">
          <Icons.settings size={17} />
        </button>
      </div>
      {renaming && cid && (
        <PromptDialog
          title="Rename conversation"
          initial={curTitle}
          confirmLabel="Rename"
          onConfirm={(v) => void chat.rename(cid, v)}
          onClose={() => setRenaming(false)}
        />
      )}
      {confirmDel && cid && (
        <ConfirmDialog
          title="Delete conversation"
          body="This permanently deletes this conversation and its messages. This can't be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => void chat.removeConversation(cid)}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </div>
  )
}

export function RoleRow({
  expert,
  active,
  onChat,
  onProfile
}: {
  expert: Expert
  active: boolean
  onChat: () => void
  onProfile: () => void
}): ReactElement {
  const roles = useRoles()
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const canToggle = !expert.coordinator
  return (
    <div className={"role-row" + (active ? " active" : "")} style={{ "--row-color": expert.color } as CSSProperties}>
      {expert.coordinator
        ? <span className="lead-caret"><Icons.chevronRight size={13} /></span>
        : <span className="lead-caret" />}
      <span className="role-av" onClick={onProfile} title="Open profile"><Avatar expert={expert} size={26} /></span>
      <div className="role-meta" onClick={onChat} title="Start a conversation">
        <span className="role-name">{expert.name}{expert.coordinator && <span className="primary-tag">primary</span>}</span>
        <span className="role-sub">{expert.specialty}</span>
      </div>
      {active && <span className="active-dot" />}
      <button className="role-more" onClick={(e) => { e.stopPropagation(); setMenu((s) => !s); }}>
        <Icons.more size={15} />
      </button>
      {menu && (
        <>
          <div className="menu-backdrop" onClick={(e) => { e.stopPropagation(); setMenu(false); }} />
          <div className="row-menu" onClick={(e) => e.stopPropagation()}>
            <div className="rm-item" onClick={() => { setMenu(false); onProfile(); }}><Icons.user size={14} /> Open profile</div>
            <div className="rm-item" onClick={() => { setMenu(false); onChat(); }}><Icons.message size={14} /> Start a conversation</div>
            {canToggle
              ? <div className="rm-item" onClick={() => { setMenu(false); roles.disable(expert.id); }}><Icons.eyeOff size={14} /> Disable role</div>
              : <div className="rm-note">Primary role · always on</div>}
            {expert.custom && <div className="rm-item danger" onClick={() => { setMenu(false); setConfirm(true); }}><Icons.trash size={14} /> Delete role</div>}
          </div>
        </>
      )}
      {confirm && (
        <ConfirmDialog title={`Delete ${expert.name}?`}
          body={`This removes ${expert.name}, its conversations, and what it learned about you. Shared memory is kept. This can't be undone.`}
          confirmLabel="Delete role" danger
          onConfirm={() => roles.remove(expert.id)} onClose={() => setConfirm(false)} />
      )}
    </div>
  )
}

function DisabledRow({ expert, onProfile }: { expert: Expert; onProfile: () => void }): ReactElement {
  const roles = useRoles()
  return (
    <div className="role-row disabled-role">
      <span className="lead-caret" />
      <span className="role-av" onClick={onProfile} title="Open profile"><Avatar expert={expert} size={26} /></span>
      <div className="role-meta" onClick={onProfile}>
        <span className="role-name">{expert.name}</span>
      </div>
      <button className="role-enable" onClick={() => roles.enable(expert.id)}>Enable</button>
    </div>
  )
}

// One History row: select on click; a ⋯ menu for pin / rename / archive / delete.
function HistRow({
  conv,
  active,
  expert,
  onSelect
}: {
  conv: ConversationDto
  active: boolean
  expert: Expert | null
  onSelect: (id: string) => void
}): ReactElement {
  const chat = useChat()
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  return (
    <div className={'hist-row' + (active ? ' active' : '')} onClick={() => onSelect(conv.id)}>
      <span className="hist-dot" style={{ background: expert?.color ?? 'var(--text-4)' }} />
      <span className="hist-title">{conv.title || 'Untitled'}</span>
      <button className="hist-more" title="Actions" onClick={(e) => { e.stopPropagation(); setMenu((s) => !s) }}>
        <Icons.more size={14} />
      </button>
      {menu && (
        <>
          <div className="menu-backdrop" onClick={(e) => { e.stopPropagation(); setMenu(false) }} />
          <div className="row-menu right" onClick={(e) => e.stopPropagation()}>
            <div className="rm-item" onClick={() => { setMenu(false); void chat.setPinned(conv.id, !conv.pinned) }}>
              <Icons.pin size={14} /> {conv.pinned ? 'Unpin' : 'Pin'}
            </div>
            <div className="rm-item" onClick={() => { setMenu(false); setRenaming(true) }}>
              <Icons.edit size={14} /> Rename
            </div>
            <div className="rm-item" onClick={() => { setMenu(false); void chat.setArchived(conv.id, !conv.archived) }}>
              <Icons.archive size={14} /> {conv.archived ? 'Unarchive' : 'Archive'}
            </div>
            <div className="rm-item danger" onClick={() => { setMenu(false); setConfirmDel(true) }}>
              <Icons.trash size={14} /> Delete
            </div>
          </div>
        </>
      )}
      {renaming && (
        <PromptDialog
          title="Rename conversation"
          initial={conv.title || ''}
          confirmLabel="Rename"
          onConfirm={(v) => void chat.rename(conv.id, v)}
          onClose={() => setRenaming(false)}
        />
      )}
      {confirmDel && (
        <ConfirmDialog
          title="Delete conversation"
          body="This permanently deletes this conversation and its messages. This can't be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => void chat.removeConversation(conv.id)}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </div>
  )
}

// Bucket a conversation into a History date group by recency (updatedAt), local time.
function histGroup(iso: string): 'Today' | 'Yesterday' | 'Earlier' {
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const today = startOfDay(new Date())
  const day = startOfDay(new Date(iso))
  if (day >= today) return 'Today'
  if (day >= today - 86_400_000) return 'Yesterday'
  return 'Earlier'
}

function SideSectionHead({
  label,
  count,
  collapsed,
  onToggle
}: {
  label: string
  count?: number | null
  collapsed: boolean
  onToggle: () => void
}): ReactElement {
  return (
    <div className="side-section-head clickable" onClick={onToggle}>
      <span className="ssh-left">
        <span className={"ssh-chev" + (collapsed ? " collapsed" : "")}><Icons.chevronDown size={13} /></span>
        {label}
      </span>
      {count != null && <span className="count">{count}</span>}
    </div>
  )
}

export function Sidebar({
  activeExpert,
  activeConv,
  conversations,
  studioActive,
  extensionsActive,
  projectsActive,
  scheduledActive,
  onStudio,
  onExtensions,
  onProjects,
  onScheduled,
  onSelectExpert,
  onOpenProfile,
  onSelectConv,
  onNewRole,
  onNewConversation
}: {
  activeExpert?: string | null
  activeConv?: string | null
  conversations: ConversationDto[]
  studioActive?: boolean
  extensionsActive?: boolean
  projectsActive?: boolean
  scheduledActive?: boolean
  onStudio: () => void
  onExtensions: () => void
  onProjects: () => void
  onScheduled: () => void
  onSelectExpert: (id: string) => void
  onOpenProfile: (id: string) => void
  onSelectConv: (id: string) => void
  onNewRole: () => void
  onNewConversation: () => void
}): ReactElement {
  const { experts: EXPERTS, byId: EXPERT_BY_ID } = useAllExperts()
  const roles = useRoles()
  const coordinator = EXPERTS.find((e) => e.coordinator)
  const rest = EXPERTS.filter((e) => !e.coordinator && !roles.isDeleted(e.id))
  // Until useRoles.load() finishes, treat every role as enabled so we don't paint a disabled row that
  // would jump to enabled (or vice versa) once state hydrates. The Disabled section stays hidden in
  // this window — usually one frame.
  const enabledRest = roles.loaded ? rest.filter((e) => !roles.isDisabled(e.id)) : rest
  const disabledList = roles.loaded ? rest.filter((e) => roles.isDisabled(e.id)) : []
  const [rolesOpen, setRolesOpen] = useState(true)
  const [histOpen, setHistOpen] = useState(true)
  const [disabledOpen, setDisabledOpen] = useState(false)
  const [archivedOpen, setArchivedOpen] = useState(false)

  // History grouping: pinned first, then date buckets (Today / Yesterday / Earlier), archived last.
  // `conversations` is already updated_at-DESC, so each group stays recency-ordered.
  const pinnedConvs = conversations.filter((c) => c.pinned && !c.archived)
  const activeConvs = conversations.filter((c) => !c.pinned && !c.archived)
  const archivedConvs = conversations.filter((c) => c.archived)
  const dateGroups = (['Today', 'Yesterday', 'Earlier'] as const)
    .map((label) => ({ label, items: activeConvs.filter((c) => histGroup(c.updatedAt) === label) }))
    .filter((g) => g.items.length > 0)
  const histExpert = (c: ConversationDto): Expert | null => (c.primaryRoleId ? EXPERT_BY_ID[c.primaryRoleId] ?? null : null)

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <button className="sidebar-new" title="New conversation" onClick={onNewConversation}>
          <Icons.edit size={17} />
        </button>
      </div>
      <div className="sidebar-scroll">
        <div className={"studio-nav-row" + (studioActive ? " active" : "")} onClick={onStudio}>
          <span className="sn-grid"><Icons.layoutGrid size={16} /></span>
          Overview
        </div>
        <div className={"studio-nav-row" + (projectsActive ? " active" : "")} onClick={onProjects}>
          <span className="sn-grid"><Icons.kanban size={16} /></span>
          Projects
        </div>
        <div className={"studio-nav-row" + (scheduledActive ? " active" : "")} onClick={onScheduled}>
          <span className="sn-grid"><Icons.calendarClock size={16} /></span>
          Scheduled
        </div>
        <div className={"studio-nav-row" + (extensionsActive ? " active" : "")} onClick={onExtensions}>
          <span className="sn-grid"><Icons.puzzle size={16} /></span>
          Extensions
        </div>

        <SideSectionHead label="Roles" count={1 + enabledRest.length} collapsed={!rolesOpen} onToggle={() => setRolesOpen((s) => !s)} />
        {rolesOpen && (
          <>
            {coordinator && <RoleRow expert={coordinator} active={activeExpert === "coordinator"} onChat={() => onSelectExpert("coordinator")} onProfile={() => onOpenProfile("coordinator")} />}
            {enabledRest.map((e) => (
              <RoleRow key={e.id} expert={e} active={activeExpert === e.id}
                onChat={() => onSelectExpert(e.id)} onProfile={() => onOpenProfile(e.id)} />
            ))}
            <div className="new-role-row" onClick={onNewRole}>
              <span className="nr-icon"><Icons.plus size={15} /></span>
              New role
            </div>
            {disabledList.length > 0 && (
              <>
                <div className="disabled-head" onClick={() => setDisabledOpen((s) => !s)}>
                  <span className={"ssh-chev" + (disabledOpen ? "" : " collapsed")}><Icons.chevronDown size={12} /></span>
                  Disabled <span className="count">({disabledList.length})</span>
                </div>
                {disabledOpen && disabledList.map((e) => (
                  <DisabledRow key={e.id} expert={e} onProfile={() => onOpenProfile(e.id)} />
                ))}
              </>
            )}
          </>
        )}

        <div className="side-divider" />

        <SideSectionHead label="History" collapsed={!histOpen} onToggle={() => setHistOpen((s) => !s)} />
        {histOpen &&
          (conversations.length === 0 ? (
            <div className="empty-history">No conversations yet. Pick an expert above to start one.</div>
          ) : (
            <>
              {pinnedConvs.length > 0 && (
                <>
                  <div className="hist-group-head"><Icons.pin size={11} /> Pinned</div>
                  {pinnedConvs.map((c) => (
                    <HistRow key={c.id} conv={c} active={activeConv === c.id} expert={histExpert(c)} onSelect={onSelectConv} />
                  ))}
                </>
              )}
              {dateGroups.map((g) => (
                <Fragment key={g.label}>
                  <div className="hist-group-head">{g.label}</div>
                  {g.items.map((c) => (
                    <HistRow key={c.id} conv={c} active={activeConv === c.id} expert={histExpert(c)} onSelect={onSelectConv} />
                  ))}
                </Fragment>
              ))}
              {archivedConvs.length > 0 && (
                <>
                  <div className="hist-group-head clickable" onClick={() => setArchivedOpen((s) => !s)}>
                    <span className={'ssh-chev' + (archivedOpen ? '' : ' collapsed')}><Icons.chevronDown size={11} /></span>
                    Archived <span className="count">{archivedConvs.length}</span>
                  </div>
                  {archivedOpen &&
                    archivedConvs.map((c) => (
                      <HistRow key={c.id} conv={c} active={activeConv === c.id} expert={histExpert(c)} onSelect={onSelectConv} />
                    ))}
                </>
              )}
            </>
          ))}
      </div>
    </div>
  )
}
