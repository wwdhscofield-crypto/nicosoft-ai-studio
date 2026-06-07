/* ============================================================
   NicoSoft AI Studio — Memory (per-expert + global)
   Three layers: SHARED · ROLE · COLLAB. All local to this device.
   ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { Avatar } from '@/components/primitives'
import { STUDIO_DATA } from '@/data/studio-data'
import { Dropdown } from '@/views/profile'
import { Pagination } from '@/components/pagination'
import { useMemory } from '@/stores/memory'
import type { MemoryItem as MemoryItemData } from '@/types'

const MEM_PAGE_SIZE = 10
import type { MemoryDto } from '@/lib/api'

type LayerKey = 'SHARED' | 'ROLE' | 'COLLAB'

interface LayerMetaEntry {
  label: string
  hint: string
  color: string
}

export const LAYER_META: Record<LayerKey, LayerMetaEntry> = {
  SHARED: { label: 'Shared', hint: 'About you · all experts', color: 'var(--exp-translator)' },
  ROLE: { label: 'Role', hint: 'What this expert knows', color: 'var(--accent)' },
  COLLAB: { label: 'Collab', hint: 'Learned across hand-offs', color: 'var(--exp-analyst)' }
}

interface FlatEntry {
  uid: string
  scope: string
  layer: LayerKey
  text: string
}

/* — one editable memory item — */
export function MemoryItem({
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
        <button className="icon-btn sm" title="Edit" onClick={() => setEditing(true)}>
          <Icons.edit size={13} />
        </button>
        <button className="icon-btn sm" title="Delete" onClick={onDelete}>
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

/* — small flat switch (local to memory module) — */
export function MemToggle({ on, onClick }: { on: boolean; onClick: () => void }): ReactElement {
  return (
    <button className={'switch' + (on ? ' on' : '')} onClick={onClick} role="switch" aria-checked={on}>
      <span className="knob" />
    </button>
  )
}

// Flatten the backend memory list into UI rows. shared → SHARED (scope 'shared'); role → ROLE (scope =
// roleId); collab → COLLAB. uid is the real memory id, used directly for update/remove.
function toEntries(memories: MemoryDto[]): FlatEntry[] {
  return memories.map((m) => ({
    uid: m.id,
    scope: m.layer === 'shared' ? 'shared' : (m.roleId ?? 'shared'),
    layer: m.layer === 'shared' ? 'SHARED' : m.layer === 'collab' ? 'COLLAB' : 'ROLE',
    text: m.content
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
  const { EXPERT_BY_ID } = STUDIO_DATA
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(entry.text)
  const e = entry.scope === 'shared' ? null : EXPERT_BY_ID[entry.scope]
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
            <Icons.users size={13} /> Shared
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
        <button className="icon-btn sm" title="Edit" onClick={() => setEditing(true)}>
          <Icons.edit size={13} />
        </button>
        <button className="icon-btn sm" title="Delete" onClick={onDelete}>
          <Icons.trash size={13} />
        </button>
      </div>
    </div>
  )
}

export function MemorySettings(): ReactElement {
  const { EXPERTS } = STUDIO_DATA
  const mem = useMemory()
  useEffect(() => {
    void mem.load()
  }, [mem.load])
  const entries = useMemo(() => toEntries(mem.memories), [mem.memories])
  const [fExpert, setFExpert] = useState('all')
  const [fLayer, setFLayer] = useState('all')
  const [page, setPage] = useState(0)
  // Reset to the first page whenever a filter narrows the set (else you can land past the last page).
  useEffect(() => setPage(0), [fExpert, fLayer])

  // Per-expert self-learning comes from role_states (default on when absent). Master is derived: on iff
  // every expert has it on; toggling master flips them all.
  const perExpert = mem.selfLearning
  const master = EXPERTS.every((e) => perExpert[e.id] !== false)
  const toggleMaster = (): void => {
    const next = !master
    EXPERTS.forEach((e) => void mem.setSelfLearning(e.id, next))
  }

  const expertOpts = [{ v: 'all', l: 'All experts' }, ...EXPERTS.map((e) => ({ v: e.id, l: e.name }))]
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
      <div className="settings-title">Memory</div>
      <div className="settings-desc">
        What your experts remember about you, across three layers — <strong>Shared</strong> (about you),
        <strong> Role</strong> (per-expert), and <strong>Collab</strong> (learned across hand-offs).
        Everything here is stored locally and never leaves this device.
      </div>

      {/* self-learning controls */}
      <div className="mem-self">
        <div className="mem-self-master">
          <div>
            <div className="mss-title">Self-learning</div>
            <div className="mss-sub">Let experts remember useful context from your conversations.</div>
          </div>
          <MemToggle on={master} onClick={toggleMaster} />
        </div>
        <div className="mem-self-grid">
          {EXPERTS.map((e) => (
            <div className="mse-row" key={e.id}>
              <Avatar expert={e} size={20} />
              <span className="mse-name">{e.name}</span>
              <MemToggle
                on={perExpert[e.id] !== false}
                onClick={() => void mem.setSelfLearning(e.id, perExpert[e.id] === false)}
              />
            </div>
          ))}
        </div>
      </div>

      {/* filters */}
      <div className="mem-filters">
        <div className="mf-group">
          <span className="mf-label">Expert</span>
          <div style={{ width: 170 }}>
            <Dropdown options={expertOpts} value={fExpert} onChange={setFExpert} />
          </div>
        </div>
        <div className="mf-group">
          <span className="mf-label">Layer</span>
          <div className="segmented">
            {layers.map((l) => (
              <button key={l} className={fLayer === l ? 'active' : ''} onClick={() => setFLayer(l)}>
                {l === 'all' ? 'All' : LAYER_META[l as LayerKey].label}
              </button>
            ))}
          </div>
        </div>
        <span className="mf-count">{filtered.length} memories</span>
      </div>

      {/* list — 10 per page */}
      <div className="mem-global-list">
        {filtered.length === 0 ? (
          <div className="mem-empty">No memories yet — they form as you chat.</div>
        ) : (
          paged.map((e) => (
            <GlobalMemRow
              key={e.uid}
              entry={e}
              onEdit={(t) => void mem.update(e.uid, t)}
              onDelete={() => void mem.remove(e.uid)}
            />
          ))
        )}
      </div>
      <Pagination page={safePage} pageCount={pageCount} onChange={setPage} />
    </div>
  )
}
