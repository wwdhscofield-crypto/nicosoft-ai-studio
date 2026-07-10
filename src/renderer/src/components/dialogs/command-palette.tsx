/* — Command palette (⌘K). Deliberately NOT on the Modal shell: it renders .overlay.top > .cmdk
   (search field + grouped results + footer), a different DOM family from the standard dialog. — */
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Icons, type IconName } from '@/components/icons'
import { Avatar } from '@/components/primitives'
import { STUDIO_DATA } from '@/data/studio-data'
import { useAllExperts } from '@/lib/all-experts'
import { useRoles } from '@/stores/roles'
import { useChat } from '@/stores/chat'
import { useT } from '@/stores/locale'
import type { Expert } from '@/types'

type CmdkRow = {
  group?: string
  type?: 'conv' | 'expert' | 'settings' | 'action'
  id?: string
  label?: string
  expert?: string
  hint?: string
  avatar?: Expert
  icon?: IconName
}

export function CommandPalette({
  onClose,
  onSelectConv,
  onSelectExpert,
  onSettings,
  onStudio,
  onNewRole
}: {
  onClose: () => void
  onSelectConv: (id: string) => void
  onSelectExpert: (id: string) => void
  onSettings: (tab: string) => void
  onStudio: () => void
  onNewRole: () => void
}): ReactElement {
  const { EXPERTS } = STUDIO_DATA
  const { byId: EXPERT_BY_ID } = useAllExperts() // conv rows can belong to custom roles — resolve their color
  const t = useT()
  const chat = useChat()
  const roles = useRoles()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current && inputRef.current.focus() }, [])

  const recents = chat.conversations.slice(0, 4)
  const activeExperts = EXPERTS.filter((e) => !roles.isDeleted(e.id) && !roles.isDisabled(e.id))
  const rows: CmdkRow[] = []
  rows.push({ group: t('cmdk.recentConversations') })
  recents.forEach((c) => rows.push({ type: 'conv', id: c.id, label: c.title ?? t('cmdk.untitled'), expert: c.primaryRoleId ?? 'generalist' }))
  rows.push({ group: t('cmdk.roles') })
  activeExperts.forEach((e) => rows.push({ type: 'expert', id: e.id, label: e.name, hint: e.specialty, avatar: e }))
  rows.push({ group: t('cmdk.settings') })
  ;([['endpoints', t('cmdk.navEndpoints'), 'plug'], ['roles', t('cmdk.navRoles'), 'users'], ['memory', t('cmdk.navMemory'), 'box'], ['profile', t('cmdk.navProfile'), 'user']] as const)
    .forEach(([tab, label, icon]) => rows.push({ type: 'settings', id: tab, label, icon }))
  rows.push({ group: t('cmdk.actions') })
  rows.push({ type: 'action', id: 'studio', label: t('cmdk.goOverview'), icon: 'layoutGrid' })
  rows.push({ type: 'action', id: 'new', label: t('cmdk.newConversation'), icon: 'plusCircle' })
  rows.push({ type: 'action', id: 'export', label: t('cmdk.exportConversation'), icon: 'download' })
  rows.push({ type: 'action', id: 'newrole', label: t('cmdk.newRole'), icon: 'plus' })

  const selectable = rows.filter((r) => !r.group)
  const filtered = q
    ? selectable.filter((r) => r.label!.toLowerCase().includes(q.toLowerCase()))
    : null
  const navList = filtered || selectable

  const pick = (r?: CmdkRow): void => {
    if (!r) return
    if (r.type === 'conv') onSelectConv(r.id!)
    else if (r.type === 'expert') onSelectExpert(r.id!)
    else if (r.type === 'settings') onSettings(r.id!)
    else if (r.id === 'studio') onStudio()
    else if (r.id === 'newrole') onNewRole()
    else onClose()
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, navList.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(navList[active]) }
  }

  let runningIndex = -1
  const renderRow = (r: CmdkRow, key: number): ReactElement => {
    if (r.group) return <div className="cmdk-group-label" key={key}>{r.group}</div>
    runningIndex++
    const idx = runningIndex
    const I = r.icon ? Icons[r.icon] : null
    const convExpert = r.type === 'conv' ? EXPERT_BY_ID[r.expert!] : null
    return (
      <div key={key} className={'cmdk-row' + (idx === active ? ' active' : '')}
        onMouseEnter={() => setActive(idx)} onMouseDown={() => pick(r)}>
        <span className="cr-icon">
          {r.avatar ? <Avatar expert={r.avatar} size={20} />
            : convExpert ? <span className="cr-dot" style={{ background: convExpert.color }} />
            : I ? <I size={16} /> : null}
        </span>
        <span className="cr-label">{r.label}</span>
        {r.hint && <span className="cr-hint">{r.hint}</span>}
      </div>
    )
  }

  return (
    <div className="overlay top" onMouseDown={onClose}>
      <div className="cmdk" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmdk-search">
          <Icons.search size={17} style={{ color: 'var(--text-3)' }} />
          <input ref={inputRef} placeholder={t('cmdk.searchPlaceholder')}
            value={q} onChange={(e) => { setQ(e.target.value); setActive(0) }} onKeyDown={onKey} />
          <kbd style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-4)', background: 'var(--bg-3)', borderRadius: 4, padding: '2px 6px' }}>ESC</kbd>
        </div>
        <div className="cmdk-results">
          {filtered
            ? (filtered.length ? filtered.map((r, i) => renderRow(r, i)) : <div className="cmdk-group-label">{t('cmdk.noResults')}</div>)
            : rows.map((r, i) => renderRow(r, i))}
        </div>
        <div className="cmdk-foot">
          <span><kbd>↑</kbd> <kbd>↓</kbd> {t('cmdk.navigate')}</span>
          <span><kbd>↵</kbd> {t('cmdk.open')}</span>
          <span><kbd>esc</kbd> {t('cmdk.close')}</span>
        </div>
      </div>
    </div>
  )
}
