/* ============================================================
   NicoSoft AI Studio — app shell: Topbar + Sidebar
   ============================================================ */
import { Fragment, useRef, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { Icons } from '@/components/icons'
import { useAnchoredMenu } from '@/lib/use-anchored-menu'
import { Avatar } from '@/components/primitives'
import { ConfirmDialog } from '@/components/dialogs/confirm-dialog'
import { PromptDialog } from '@/components/dialogs/prompt-dialog'
import { useRoles } from '@/stores/roles'
import { useAllExperts } from '@/lib/all-experts'
import { useChat } from '@/stores/chat'
import { useUpdate } from '@/stores/update'
import { toast } from '@/stores/toast'
import { useT } from '@/stores/locale'
import type { Expert } from '@/types'
import type { ConversationDto } from '@/lib/api'

/* — Top bar: quiet right-aligned icon cluster, no border, no endpoint pills, no title.
   View-aware: a conversation view passes `workspace` to surface the panel toggle + actions. — */
export function Topbar({
  onCommand,
  onSettings,
  workspace,
  sidebar
}: {
  onCommand: () => void
  onSettings: () => void
  workspace?: { open: boolean; onToggle: () => void } | null
  sidebar?: { collapsed: boolean; onToggle: () => void } | null
}): ReactElement {
  const chat = useChat()
  const cid = chat.activeConv
  const curTitle = chat.conversations.find((c) => c.id === cid)?.title ?? ''
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const { menuRef, style } = useAnchoredMenu(menu, btnRef, 'right')
  const t = useT()
  // App update button (doc 56 §6.1): first item in the cluster (left of the sidebar toggle), rendered ONLY
  // while an update is in play; idle / up-to-date render nothing at all (no placeholder). Click reopens the card.
  const update = useUpdate()
  const showUpdate =
    update.status === 'available' || update.status === 'downloading' || update.status === 'downloaded'
  const updateTip =
    update.status === 'downloading'
      ? t('update.btn.downloading', { percent: update.progress ?? 0 })
      : update.status === 'downloaded'
        ? t('update.btn.downloaded', { version: update.version ?? '' })
        : t('update.btn.available', { version: update.version ?? '' })
  const doExport = (fmt: 'md' | 'json'): void => {
    setMenu(false)
    // export opens a native save dialog: a truthy path = exported, a falsy value = the user cancelled
    // (stay silent), a thrown error = a real failure.
    if (cid)
      void window.api.conversations
        .export(cid, fmt)
        .then((path) => { if (path) toast.success(t('topbar.exported')) })
        .catch(() => toast.error(t('topbar.exportFailed')))
  }
  return (
    <div className={'topbar' + (sidebar?.collapsed ? ' nav-collapsed' : '')}>
      {workspace && cid ? (
        <div className="topbar-title" title={curTitle || t('sidebar.untitled')}>
          <span className="tt-name">{curTitle || t('sidebar.untitled')}</span>
        </div>
      ) : (
        <div className="spacer" />
      )}
      <div className="top-actions">
        {showUpdate && (
          <button
            className={`icon-btn update-btn update-${update.status}`}
            title={updateTip}
            aria-label={updateTip}
            onClick={update.openModal}
          >
            {update.status === 'downloading' ? (
              <Icons.loader size={17} className="spin" />
            ) : update.status === 'downloaded' ? (
              <Icons.restart size={17} />
            ) : (
              <Icons.cloudDownload size={17} />
            )}
            {update.status === 'available' && <span className="update-dot" aria-hidden="true" />}
          </button>
        )}
        {sidebar && (
          <button
            className="icon-btn"
            title={t('topbar.sidebar')}
            onClick={sidebar.onToggle}
          >
            <Icons.panelLeft size={17} />
          </button>
        )}
        {workspace && (
          <>
            <button
              className="icon-btn"
              title={t('topbar.workspace')}
              onClick={workspace.onToggle}
            >
              <Icons.panelRight size={17} />
            </button>
            <div className="conv-menu-wrap">
              <button ref={btnRef} className="icon-btn" title={t('topbar.actions')} onClick={() => setMenu((s) => !s)}>
                <Icons.more size={17} />
              </button>
              {menu && createPortal(
                <>
                  <div className="menu-backdrop" onClick={() => setMenu(false)} />
                  <div ref={menuRef} className="row-menu right" style={style}>
                    <div className="rm-item" onClick={() => { setMenu(false); setRenaming(true) }}><Icons.edit size={14} /> {t('topbar.rename')}</div>
                    <div className="rm-item" onClick={() => doExport('md')}><Icons.download size={14} /> {t('topbar.exportMarkdown')}</div>
                    <div className="rm-item" onClick={() => doExport('json')}><Icons.download size={14} /> {t('topbar.exportJson')}</div>
                    <div className="rm-item danger" onClick={() => { setMenu(false); setConfirmDel(true) }}><Icons.trash size={14} /> {t('topbar.delete')}</div>
                  </div>
                </>,
                document.body
              )}
            </div>
          </>
        )}
        <button className="kbd-hint" onClick={onCommand}>
          <Icons.search size={14} />
          <kbd>⌘K</kbd>
        </button>
        <button className="icon-btn" onClick={onSettings} title={t('topbar.settings')}>
          <Icons.settings size={17} />
        </button>
      </div>
      {renaming && cid && (
        <PromptDialog
          title={t('topbar.renameConversation')}
          initial={curTitle}
          confirmLabel={t('topbar.renameAction')}
          onConfirm={(v) => void chat.rename(cid, v).catch(() => toast.error(t('topbar.renameFailed')))}
          onClose={() => setRenaming(false)}
        />
      )}
      {confirmDel && cid && (
        <ConfirmDialog
          title={t('topbar.deleteConversation')}
          body={t('topbar.deleteBody')}
          confirmLabel={t('topbar.deleteAction')}
          danger
          onConfirm={() =>
            void chat
              .removeConversation(cid)
              .then(() => toast.success(t('topbar.conversationDeleted')))
              .catch(() => toast.error(t('topbar.deleteFailed')))
          }
          onClose={() => setConfirmDel(false)}
        />
      )}
    </div>
  )
}

function RoleRow({
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
  const t = useT()
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const canToggle = !expert.coordinator
  const btnRef = useRef<HTMLButtonElement>(null)
  const { menuRef, style } = useAnchoredMenu(menu, btnRef, 'down')
  return (
    <div className={"role-row" + (active ? " active" : "")} style={{ "--row-color": expert.color } as CSSProperties}>
      {expert.coordinator
        ? <span className="lead-caret"><Icons.chevronRight size={13} /></span>
        : <span className="lead-caret" />}
      <span className="role-av" onClick={onProfile} title={t('sidebar.openProfileTitle')}><Avatar expert={expert} size={26} /></span>
      <div className="role-meta" onClick={onChat} title={t('sidebar.startConversationTitle')}>
        <span className="role-name">{expert.name}{expert.coordinator && <span className="primary-tag">{t('sidebar.primary')}</span>}</span>
        <span className="role-sub">{expert.specialty}</span>
      </div>
      {active && <span className="active-dot" />}
      <button ref={btnRef} className="role-more" onClick={(e) => { e.stopPropagation(); setMenu((s) => !s); }}>
        <Icons.more size={15} />
      </button>
      {menu && createPortal(
        <>
          <div className="menu-backdrop" onClick={(e) => { e.stopPropagation(); setMenu(false); }} />
          <div ref={menuRef} className="row-menu" style={style} onClick={(e) => e.stopPropagation()}>
            <div className="rm-item" onClick={() => { setMenu(false); onProfile(); }}><Icons.user size={14} /> {t('sidebar.openProfile')}</div>
            <div className="rm-item" onClick={() => { setMenu(false); onChat(); }}><Icons.message size={14} /> {t('sidebar.startConversation')}</div>
            {canToggle
              ? <div className="rm-item warn" onClick={() => { setMenu(false); roles.disable(expert.id); }}><Icons.eyeOff size={14} /> {t('sidebar.disableRole')}</div>
              : <div className="rm-note">{t('sidebar.primaryAlwaysOn')}</div>}
            {expert.custom && <div className="rm-item danger" onClick={() => { setMenu(false); setConfirm(true); }}><Icons.trash size={14} /> {t('sidebar.deleteRole')}</div>}
          </div>
        </>,
        document.body
      )}
      {confirm && (
        <ConfirmDialog title={t('role.deleteTitle', { name: expert.name })}
          body={t('role.deleteBody', { name: expert.name })}
          confirmLabel={t('sidebar.deleteRole')} danger
          onConfirm={() => roles.remove(expert.id)} onClose={() => setConfirm(false)} />
      )}
    </div>
  )
}

function DisabledRow({ expert, onProfile }: { expert: Expert; onProfile: () => void }): ReactElement {
  const roles = useRoles()
  const t = useT()
  return (
    <div className="role-row disabled-role">
      <span className="lead-caret" />
      <span className="role-av" onClick={onProfile} title={t('sidebar.openProfileTitle')}><Avatar expert={expert} size={26} /></span>
      <div className="role-meta" onClick={onProfile}>
        <span className="role-name">{expert.name}</span>
      </div>
      <button className="role-enable" onClick={() => roles.enable(expert.id)}>{t('sidebar.enable')}</button>
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
  const t = useT()
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const moreRef = useRef<HTMLButtonElement>(null)
  const { menuRef, style } = useAnchoredMenu(menu, moreRef, 'right')
  return (
    <div className={'hist-row' + (active ? ' active' : '')} onClick={() => onSelect(conv.id)}>
      <span className="hist-dot" style={{ background: expert?.color ?? 'var(--text-4)' }} />
      <span className="hist-title">{conv.title || t('sidebar.untitled')}</span>
      <button ref={moreRef} className="hist-more" title={t('topbar.actions')} onClick={(e) => { e.stopPropagation(); setMenu((s) => !s) }}>
        <Icons.more size={14} />
      </button>
      {menu && createPortal(
        <>
          <div className="menu-backdrop" onClick={(e) => { e.stopPropagation(); setMenu(false) }} />
          <div ref={menuRef} className="row-menu right" style={style} onClick={(e) => e.stopPropagation()}>
            <div className="rm-item" onClick={() => { setMenu(false); void chat.setPinned(conv.id, !conv.pinned).catch(() => toast.error(t('topbar.updateFailed'))) }}>
              <Icons.pin size={14} /> {conv.pinned ? t('sidebar.unpin') : t('sidebar.pin')}
            </div>
            <div className="rm-item" onClick={() => { setMenu(false); setRenaming(true) }}>
              <Icons.edit size={14} /> {t('sidebar.rename')}
            </div>
            <div className="rm-item" onClick={() => { setMenu(false); void chat.setArchived(conv.id, !conv.archived).catch(() => toast.error(t('topbar.archiveFailed'))) }}>
              <Icons.archive size={14} /> {conv.archived ? t('sidebar.unarchive') : t('sidebar.archive')}
            </div>
            <div className="rm-item danger" onClick={() => { setMenu(false); setConfirmDel(true) }}>
              <Icons.trash size={14} /> {t('sidebar.delete')}
            </div>
          </div>
        </>,
        document.body
      )}
      {renaming && (
        <PromptDialog
          title={t('topbar.renameConversation')}
          initial={conv.title || ''}
          confirmLabel={t('topbar.renameAction')}
          onConfirm={(v) => void chat.rename(conv.id, v).catch(() => toast.error(t('topbar.renameFailed')))}
          onClose={() => setRenaming(false)}
        />
      )}
      {confirmDel && (
        <ConfirmDialog
          title={t('topbar.deleteConversation')}
          body={t('topbar.deleteBody')}
          confirmLabel={t('topbar.deleteAction')}
          danger
          onConfirm={() =>
            void chat
              .removeConversation(conv.id)
              .then(() => toast.success(t('topbar.conversationDeleted')))
              .catch(() => toast.error(t('topbar.deleteFailed')))
          }
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
  workflowsActive,
  projectsActive,
  scheduledActive,
  onStudio,
  onExtensions,
  onWorkflows,
  onProjects,
  onScheduled,
  onSelectExpert,
  onOpenProfile,
  onSelectConv,
  onNewRole,
  onNewConversation,
  collapsed
}: {
  activeExpert?: string | null
  activeConv?: string | null
  conversations: ConversationDto[]
  studioActive?: boolean
  extensionsActive?: boolean
  workflowsActive?: boolean
  projectsActive?: boolean
  scheduledActive?: boolean
  onStudio: () => void
  onExtensions: () => void
  onWorkflows: () => void
  onProjects: () => void
  onScheduled: () => void
  onSelectExpert: (id: string) => void
  onOpenProfile: (id: string) => void
  onSelectConv: (id: string) => void
  onNewRole: () => void
  onNewConversation: () => void
  collapsed?: boolean
}): ReactElement {
  const { experts: EXPERTS, byId: EXPERT_BY_ID } = useAllExperts()
  const roles = useRoles()
  const t = useT()
  const histGroupKey: Record<'Today' | 'Yesterday' | 'Earlier', string> = {
    Today: 'sidebar.today',
    Yesterday: 'sidebar.yesterday',
    Earlier: 'sidebar.earlier'
  }
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
    <div className={'sidebar' + (collapsed ? ' collapsed' : '')}>
      <div className="sidebar-header">
        <button className="sidebar-new" title={t('sidebar.newConversation')} onClick={onNewConversation}>
          <Icons.edit size={17} />
        </button>
      </div>
      <div className="sidebar-scroll">
        <div className={"studio-nav-row" + (studioActive ? " active" : "")} onClick={onStudio}>
          <span className="sn-grid"><Icons.layoutGrid size={16} /></span>
          {t('sidebar.overview')}
        </div>
        <div className={"studio-nav-row" + (projectsActive ? " active" : "")} onClick={onProjects}>
          <span className="sn-grid"><Icons.kanban size={16} /></span>
          {t('sidebar.projects')}
        </div>
        <div className={"studio-nav-row" + (workflowsActive ? " active" : "")} onClick={onWorkflows}>
          <span className="sn-grid"><Icons.workflow size={16} /></span>
          {t('sidebar.workflows')}
        </div>
        <div className={"studio-nav-row" + (scheduledActive ? " active" : "")} onClick={onScheduled}>
          <span className="sn-grid"><Icons.calendarClock size={16} /></span>
          {t('sidebar.scheduled')}
        </div>
        <div className={"studio-nav-row" + (extensionsActive ? " active" : "")} onClick={onExtensions}>
          <span className="sn-grid"><Icons.puzzle size={16} /></span>
          {t('sidebar.extensions')}
        </div>

        <SideSectionHead label={t('sidebar.roles')} count={1 + enabledRest.length} collapsed={!rolesOpen} onToggle={() => setRolesOpen((s) => !s)} />
        {rolesOpen && (
          <>
            {coordinator && <RoleRow expert={coordinator} active={activeExpert === "coordinator"} onChat={() => onSelectExpert("coordinator")} onProfile={() => onOpenProfile("coordinator")} />}
            {enabledRest.map((e) => (
              <RoleRow key={e.id} expert={e} active={activeExpert === e.id}
                onChat={() => onSelectExpert(e.id)} onProfile={() => onOpenProfile(e.id)} />
            ))}
            <div className="new-role-row" onClick={onNewRole}>
              <span className="nr-icon"><Icons.plus size={15} /></span>
              {t('sidebar.newRole')}
            </div>
            {disabledList.length > 0 && (
              <>
                <div className="disabled-head" onClick={() => setDisabledOpen((s) => !s)}>
                  <span className={"ssh-chev" + (disabledOpen ? "" : " collapsed")}><Icons.chevronDown size={12} /></span>
                  {t('sidebar.disabled')} <span className="count">({disabledList.length})</span>
                </div>
                {disabledOpen && disabledList.map((e) => (
                  <DisabledRow key={e.id} expert={e} onProfile={() => onOpenProfile(e.id)} />
                ))}
              </>
            )}
          </>
        )}

        <div className="side-divider" />

        <SideSectionHead label={t('sidebar.history')} collapsed={!histOpen} onToggle={() => setHistOpen((s) => !s)} />
        {histOpen &&
          (conversations.length === 0 ? (
            <div className="empty-history">{t('sidebar.emptyHistory')}</div>
          ) : (
            <>
              {pinnedConvs.length > 0 && (
                <>
                  <div className="hist-group-head"><Icons.pin size={11} /> {t('sidebar.pinned')}</div>
                  {pinnedConvs.map((c) => (
                    <HistRow key={c.id} conv={c} active={activeConv === c.id} expert={histExpert(c)} onSelect={onSelectConv} />
                  ))}
                </>
              )}
              {dateGroups.map((g) => (
                <Fragment key={g.label}>
                  <div className="hist-group-head">{t(histGroupKey[g.label])}</div>
                  {g.items.map((c) => (
                    <HistRow key={c.id} conv={c} active={activeConv === c.id} expert={histExpert(c)} onSelect={onSelectConv} />
                  ))}
                </Fragment>
              ))}
              {archivedConvs.length > 0 && (
                <>
                  <div className="hist-group-head clickable" onClick={() => setArchivedOpen((s) => !s)}>
                    <span className={'ssh-chev' + (archivedOpen ? '' : ' collapsed')}><Icons.chevronDown size={11} /></span>
                    {t('sidebar.archived')} <span className="count">{archivedConvs.length}</span>
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
