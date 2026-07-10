/* ============================================================
   NicoSoft AI Studio — Memory (per-expert + global)
   Three layers: SHARED · ROLE · COLLAB. All local to this device.
   ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Avatar, Segmented, Switch } from '@/components/primitives'
import { STUDIO_DATA } from '@/data/studio-data'
import { useAllExperts } from '@/lib/all-experts'
import { Dropdown } from '@/views/profile'
import { Pagination } from '@/components/pagination'
import { useMemoryCloud } from '@/stores/memory-cloud'
import { useMemory } from '@/stores/memory'
import { toast } from '@/stores/toast'
import { useT } from '@/stores/locale'
import type { MemoryItem as MemoryItemData } from '@/types'

const MEM_PAGE_SIZE = 10
import type { MemoryDto } from '@/lib/api'

type LayerKey = 'SHARED' | 'ROLE' | 'COLLAB'

interface LayerMetaEntry {
  label: string
  hint: string
  color: string
}

const LAYER_META: Record<LayerKey, LayerMetaEntry> = {
  SHARED: { label: 'Shared', hint: 'About you · all experts', color: 'var(--exp-translator)' },
  ROLE: { label: 'Role', hint: 'What this expert knows', color: 'var(--accent)' },
  COLLAB: { label: 'Collab', hint: 'Learned across hand-offs', color: 'var(--exp-analyst)' }
}

interface FlatEntry {
  uid: string
  scope: string
  layer: LayerKey
  text: string
  sourceConvId: string | null // provenance — jump back to the conversation this was learned from
}

/* — one editable memory item — */
function MemoryItem({
  item,
  layer,
  onEdit,
  onDelete
}: {
  item: MemoryItemData
  layer: LayerKey
  onEdit?: (text: string) => void
  onDelete?: () => void
}): ReactElement {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(item.text)
  return (
    <div className="mem-item">
      <span className={'mem-layer-dot ' + layer.toLowerCase()} title={LAYER_META[layer].label} />
      {editing ? (
        <input
          className="input mem-edit"
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            setEditing(false)
            onEdit && onEdit(text)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              setEditing(false)
              onEdit && onEdit(text)
            }
          }}
        />
      ) : (
        <span className="mem-text">{text}</span>
      )}
      <div className="mem-actions">
        <button className="icon-btn sm" title={t('mem.edit')} onClick={() => setEditing(true)}>
          <Icons.edit size={13} />
        </button>
        <button className="icon-btn sm" title={t('mem.delete')} onClick={onDelete}>
          <Icons.trash size={13} />
        </button>
      </div>
    </div>
  )
}

/* — a labelled layer group of memory items — */
export function MemoryLayer({
  layer,
  items,
  onEdit,
  onDelete
}: {
  layer: LayerKey
  items: MemoryItemData[]
  onEdit?: (id: string, text: string) => void
  onDelete?: (id: string) => void
}): ReactElement | null {
  const meta = LAYER_META[layer]
  if (!items || items.length === 0) return null
  return (
    <div className="mem-layer">
      <div className="mem-layer-head">
        <span className={'mem-layer-tag ' + layer.toLowerCase()}>{layer}</span>
        <span className="mem-layer-hint">{meta.hint}</span>
        <span className="mem-layer-count">{items.length}</span>
      </div>
      <div className="mem-list">
        {items.map((it) => (
          <MemoryItem
            key={it.id}
            item={it}
            layer={layer}
            onEdit={(t) => onEdit && onEdit(it.id, t)}
            onDelete={() => onDelete && onDelete(it.id)}
          />
        ))}
      </div>
    </div>
  )
}


// Flatten the backend memory list into UI rows. shared → SHARED (scope 'shared'); role → ROLE (scope =
// roleId); collab → COLLAB. uid is the real memory id, used directly for update/remove.
function toEntries(memories: MemoryDto[]): FlatEntry[] {
  return memories.map((m) => ({
    uid: m.id,
    scope: m.layer === 'shared' ? 'shared' : (m.roleId ?? 'shared'),
    layer: m.layer === 'shared' ? 'SHARED' : m.layer === 'collab' ? 'COLLAB' : 'ROLE',
    text: m.content,
    sourceConvId: m.sourceConvId ?? null
  }))
}

/* — one row in the global memory list (shows which expert it belongs to) — */
function GlobalMemRow({
  entry,
  onEdit,
  onDelete
}: {
  entry: FlatEntry
  onEdit: (text: string) => void
  onDelete: () => void
}): ReactElement {
  // useAllExperts: a custom role's scoped memory must show that role, not fall through to "Shared".
  const { byId } = useAllExperts()
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(entry.text)
  const e = entry.scope === 'shared' ? null : byId[entry.scope]
  return (
    <div className="mem-item">
      <span className={'mem-layer-dot ' + entry.layer.toLowerCase()} title={entry.layer} />
      <span className="gm-scope">
        {e ? (
          <>
            <Avatar expert={e} size={18} /> {e.name}
          </>
        ) : (
          <>
            <Icons.users size={13} /> {t('mem.shared')}
          </>
        )}
      </span>
      {editing ? (
        <input
          className="input mem-edit"
          value={text}
          autoFocus
          onChange={(ev) => setText(ev.target.value)}
          onBlur={() => {
            setEditing(false)
            onEdit(text)
          }}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') {
              setEditing(false)
              onEdit(text)
            }
          }}
        />
      ) : (
        <span className="mem-text">{text}</span>
      )}
      <div className="mem-actions">
        {entry.sourceConvId ? (
          // Provenance: jump to the conversation this memory was learned from (spot-check what
          // self-learning picked up). App.tsx listens for the event and routes via selectConv.
          <button
            className="icon-btn sm"
            title={t('mem.source')}
            onClick={() => window.dispatchEvent(new CustomEvent('nsai:open-conversation', { detail: { convId: entry.sourceConvId } }))}
          >
            <Icons.arrowRight size={13} />
          </button>
        ) : null}
        <button className="icon-btn sm" title={t('mem.edit')} onClick={() => setEditing(true)}>
          <Icons.edit size={13} />
        </button>
        <button className="icon-btn sm" title={t('mem.delete')} onClick={onDelete}>
          <Icons.trash size={13} />
        </button>
      </div>
    </div>
  )
}

export function MemorySettings(): ReactElement {
  const { EXPERTS } = STUDIO_DATA
  const t = useT()
  const mem = useMemory()
  useEffect(() => {
    void mem.load()
  }, [mem.load])
  const entries = useMemo(() => toEntries(mem.memories), [mem.memories])
  const [fExpert, setFExpert] = useState('all')
  const [fLayer, setFLayer] = useState('all')
  const [page, setPage] = useState(0)
  const showCloud = useMemoryCloud((s) => s.show) // opens the global Memory Live overlay (mounted by App)
  // Reset to the first page whenever a filter narrows the set (else you can land past the last page).
  useEffect(() => setPage(0), [fExpert, fLayer])

  // Per-expert self-learning comes from role_states (default on when absent). Master is derived: on iff
  // every expert has it on; toggling master flips them all.
  const perExpert = mem.selfLearning
  const master = EXPERTS.every((e) => perExpert[e.id] !== false)
  const toggleMaster = (): void => {
    const next = !master
    // Flip every expert at once; surface a single failure toast if any write rejects (the optimistic
    // switch flip is the success feedback).
    void Promise.all(EXPERTS.map((e) => mem.setSelfLearning(e.id, next))).catch(() =>
      toast.error(t('mem.updateSettingFailed'))
    )
  }

  const expertOpts = [{ v: 'all', l: t('mem.allExperts') }, ...EXPERTS.map((e) => ({ v: e.id, l: e.name }))]
  const layers = ['all', 'SHARED', 'ROLE', 'COLLAB']

  const filtered = entries.filter((e) => {
    if (fLayer !== 'all' && e.layer !== fLayer) return false
    if (fExpert !== 'all' && !(e.scope === fExpert || e.scope === 'shared')) return false
    return true
  })
  const pageCount = Math.max(1, Math.ceil(filtered.length / MEM_PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1) // stay in range if the set shrank (e.g. after a delete)
  const paged = filtered.slice(safePage * MEM_PAGE_SIZE, safePage * MEM_PAGE_SIZE + MEM_PAGE_SIZE)

  return (
    <div className="sc-wrap">
      <div className="settings-title">{t('mem.title')}</div>
      <div className="settings-desc">
        {t('mem.descBefore')}<strong>{t('mem.shared')}</strong>{t('mem.descShared')}
        <strong>{t('mem.role')}</strong>{t('mem.descRole')}<strong>{t('mem.collab')}</strong>
        {t('mem.descCollab')}
      </div>

      {/* self-learning controls */}
      <div className="mem-self">
        <div className="mem-self-master">
          <div>
            <div className="mss-title">{t('mem.selfLearning')}</div>
            <div className="mss-sub">{t('mem.selfLearningSub')}</div>
          </div>
          <Switch on={master} onClick={toggleMaster} />
        </div>
        <div className="mem-self-grid">
          {EXPERTS.map((e) => (
            <div className="mse-row" key={e.id}>
              <Avatar expert={e} size={20} />
              <span className="mse-name">{e.name}</span>
              <Switch
                on={perExpert[e.id] !== false}
                onClick={() => void mem.setSelfLearning(e.id, perExpert[e.id] === false).catch(() => toast.error(t('mem.updateSettingFailed')))}
              />
            </div>
          ))}
        </div>
      </div>

      {/* filters */}
      <div className="mem-filters">
        <div className="mf-group">
          <span className="mf-label">{t('mem.expert')}</span>
          <div style={{ width: 170 }}>
            <Dropdown options={expertOpts} value={fExpert} onChange={setFExpert} />
          </div>
        </div>
        <div className="mf-group">
          <span className="mf-label">{t('mem.layer')}</span>
          <Segmented options={layers.map((l) => ({ v: l, l: l === 'all' ? t('mem.all') : t('mem.' + l.toLowerCase()) }))} value={fLayer} onChange={(v) => setFLayer(v as typeof layers[number])} />
        </div>
        {/* trailing row actions: count + Memory Live entry ("Live" is a product name — not localized) */}
        <div className="mf-end">
          <span className="mf-count">{t('mem.count', { n: filtered.length })}</span>
          <button className="mem-live-btn" onClick={showCloud} title="Memory Live — 3D neural cloud">
            <span className="mem-live-dot" />
            Live
          </button>
        </div>
      </div>

      {/* list — 10 per page */}
      <div className="mem-global-list">
        {filtered.length === 0 ? (
          <div className="mem-empty">{t('mem.empty')}</div>
        ) : (
          paged.map((e) => (
            <GlobalMemRow
              key={e.uid}
              entry={e}
              onEdit={(txt) => void mem.update(e.uid, txt).then(() => toast.success(t('mem.updated'))).catch(() => toast.error(t('mem.updateFailed')))}
              onDelete={() => void mem.remove(e.uid).then(() => toast.success(t('mem.removed'))).catch(() => toast.error(t('mem.removeFailed')))}
            />
          ))
        )}
      </div>
      <Pagination page={safePage} pageCount={pageCount} total={filtered.length} pageSize={MEM_PAGE_SIZE} onChange={setPage} />
    </div>
  )
}
