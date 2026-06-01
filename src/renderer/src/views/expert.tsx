/* ============================================================
   NicoSoft AI Studio — Expert detail page
   Profile · model binding · memory (3 layers) · equipped · recents
   ============================================================ */
import { useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'
import { STUDIO_DATA } from '@/data/studio-data'
import { useMemory } from '@/stores/memory'
import { useChat } from '@/stores/chat'
import type { Expert, MemoryItem } from '@/types'
import type { MemoryDto } from '@/lib/api'
import { Icons } from '@/components/icons'
import { useRoles } from '@/stores/roles'
import { Avatar } from '@/components/primitives'
import { Dropdown } from '@/views/profile'
import { ConfirmDialog } from '@/components/dialogs'
import { MemToggle, MemoryLayer } from '@/views/memory'
import { THINKING_OPTIONS } from '@/lib/thinking'
import { useRoleBinding, FAMILY_LABEL } from '@/lib/use-role-binding'

// Best-effort relative timestamp for the "Recent conversations" list — matches the spirit of the
// sidebar's HISTORY grouping ("Today" / "Yesterday" / "Earlier") without overengineering. Same input
// format we get from conversation.updatedAt (ISO string).
function relativeWhen(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.floor(hr / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return new Date(iso).toLocaleDateString()
}

interface EquippedItem {
  type: 'mcp' | 'skill'
  name: string
  all?: boolean
}

// Model binding for a role — endpoints + persisted RoleBinding via useRoleBinding (shared with the
// Roles settings table). endpoint/model come from the bound endpoint; the default thinking depth is
// dynamic by (family, model). Every change persists through roles:binding:set inside the hook.
function InlineBinding({ expert, onOpenEndpoint }: { expert: Expert; onOpenEndpoint: () => void }): ReactElement {
  const b = useRoleBinding(expert)

  if (expert.unconfigured) {
    return (
      <div className="detail-card unconfigured">
        <div className="rb-needs"><Icons.alert size={15} /> No endpoint bound — this role can't run yet.</div>
        <button className="btn primary sm" onClick={onOpenEndpoint}><Icons.plus size={14} /> Add endpoint</button>
      </div>
    )
  }
  if (!b.loaded) return <div className="detail-card binding-card" style={{ minHeight: 48 }} />
  if (b.endpoints.length === 0) {
    return (
      <div className="detail-card unconfigured">
        <div className="rb-needs"><Icons.alert size={15} /> No endpoint configured — add one to bind this role.</div>
        <button className="btn primary sm" onClick={onOpenEndpoint}><Icons.plus size={14} /> Add endpoint</button>
      </div>
    )
  }
  return (
    <div className="detail-card binding-card">
      <span className={'proto-chip ' + (b.family ?? 'openai')}><span className="pc-dot" /> {FAMILY_LABEL[b.family ?? 'openai']}</span>
      <div className="bind-selects">
        <div style={{ width: 200 }}>
          <Dropdown options={b.endpoints.map((e) => ({ v: e.id, l: e.name }))} value={b.endpointId} onChange={b.onEndpoint} icon="plug" />
        </div>
        <div style={{ width: 200 }}>
          <Dropdown
            options={(b.models.length ? b.models : ['']).map((m) => ({ v: m, l: m || '— no models —' }))}
            value={b.model}
            onChange={b.onModel}
            icon="sparkle"
          />
        </div>
        {b.depths.length > 0 && (
          <div style={{ width: 174 }}>
            <Dropdown
              options={[
                { v: '', l: 'Default thinking' },
                ...THINKING_OPTIONS.filter((t) => b.depths.includes(t.value)).map((t) => ({ v: t.value, l: t.label }))
              ]}
              value={b.depth}
              onChange={b.onDepth}
              icon="zap"
            />
          </div>
        )}
      </div>
    </div>
  )
}

function EquippedSection({ expertId }: { expertId: string }): ReactElement {
  const { EXTENSIONS } = STUDIO_DATA
  const initial: EquippedItem[] = [
    ...EXTENSIONS.mcp.filter((m) => m.scope === "all" || (Array.isArray(m.scope) && m.scope.includes(expertId)))
      .map((m) => ({ type: "mcp" as const, name: m.name, all: m.scope === "all" })),
    ...EXTENSIONS.skills.filter((s) => s.enabled && (s.scope === "all" || (Array.isArray(s.scope) && s.scope.includes(expertId))))
      .map((s) => ({ type: "skill" as const, name: s.name, all: s.scope === "all" })),
  ];
  const [equipped, setEquipped] = useState<EquippedItem[]>(initial);
  const [menu, setMenu] = useState(false);

  const all: EquippedItem[] = [
    ...EXTENSIONS.mcp.map((m) => ({ type: "mcp" as const, name: m.name })),
    ...EXTENSIONS.skills.map((s) => ({ type: "skill" as const, name: s.name })),
  ];
  const available = all.filter((a) => !equipped.some((q) => q.type === a.type && q.name === a.name));
  const remove = (item: EquippedItem): void => setEquipped((p) => p.filter((q) => !(q.type === item.type && q.name === item.name)));
  const add = (item: EquippedItem): void => { setEquipped((p) => [...p, { ...item, all: false }]); setMenu(false); };

  return (
    <div className="detail-section">
      <div className="ds-head">
        <span className="ds-title">Equipped capabilities</span>
        <div className="ds-add">
          <button className="btn ghost sm" onClick={() => setMenu((s) => !s)}><Icons.plus size={14} /> Equip</button>
          {menu && (
            <>
              <div className="menu-backdrop" onClick={() => setMenu(false)} />
              <div className="row-menu right">
                {available.length === 0 ? <div className="rm-empty">Everything is equipped</div>
                  : available.map((a) => (
                    <div className="rm-item" key={a.type + a.name} onClick={() => add(a)}>
                      <Icons.plus size={13} /> <span className="rm-type">{a.type === "mcp" ? "MCP" : "Skill"}</span> {a.name}
                    </div>
                  ))}
              </div>
            </>
          )}
        </div>
      </div>
      {equipped.length === 0 ? (
        <div className="detail-empty">No tools or skills equipped yet.</div>
      ) : (
        <div className="equip-list">
          {equipped.map((q) => {
            const I = q.type === "mcp" ? Icons.terminal : Icons.zap;
            return (
              <div className="equip-chip" key={q.type + q.name}>
                <span className="eq-ic"><I size={13} /></span>
                <span className="eq-type">{q.type === "mcp" ? "MCP" : "Skill"}</span>
                <span className="eq-name">{q.name}</span>
                {q.all && <span className="eq-all">all experts</span>}
                <button className="eq-x" onClick={() => remove(q)} title="Remove"><Icons.x size={12} /></button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const toMemItem = (m: MemoryDto): MemoryItem => ({ id: m.id, text: m.content })

function MemorySection({ expertId }: { expertId: string }): ReactElement {
  const mem = useMemory()
  useEffect(() => {
    void mem.load()
  }, [mem.load])
  const shared = useMemo(() => mem.memories.filter((m) => m.layer === 'shared').map(toMemItem), [mem.memories])
  const role = useMemo(
    () => mem.memories.filter((m) => m.layer === 'role' && m.roleId === expertId).map(toMemItem),
    [mem.memories, expertId]
  )
  const learning = mem.selfLearning[expertId] !== false
  const empty = shared.length + role.length === 0

  return (
    <div className="detail-section">
      <div className="ds-head">
        <span className="ds-title">Memory <span className="ds-sub">— what this expert remembers about you</span></span>
        <label className="learn-toggle">
          <span>Self-learning</span>
          <MemToggle on={learning} onClick={() => void mem.setSelfLearning(expertId, !learning)} />
        </label>
      </div>
      {empty ? (
        <div className="detail-empty">Nothing remembered yet — memories form as you chat.</div>
      ) : (
        <div className="mem-layers">
          <MemoryLayer layer="SHARED" items={shared} onEdit={(id, t) => void mem.update(id, t)} onDelete={(id) => void mem.remove(id)} />
          <MemoryLayer layer="ROLE" items={role} onEdit={(id, t) => void mem.update(id, t)} onDelete={(id) => void mem.remove(id)} />
        </div>
      )}
    </div>
  )
}

export function ExpertDetail({
  expertId,
  onChat,
  onOpenConv,
  onOpenEndpoint,
  onDeleted
}: {
  expertId: string
  onChat: (id: string) => void
  onOpenConv: (id: string) => void
  onOpenEndpoint: () => void
  onDeleted?: () => void
}): ReactElement {
  const { EXPERT_BY_ID } = STUDIO_DATA
  const roles = useRoles();
  const conversations = useChat((s) => s.conversations)
  const [confirm, setConfirm] = useState(false);
  const e = EXPERT_BY_ID[expertId];
  // Real conversations owned by this role (primary_role_id = expertId). For Atlas this surfaces every
  // routed conversation; for individual experts it's the direct-chat history. Most-recent-first; cap
  // to a sensible display count so the panel doesn't become a scroll trap.
  const recents = useMemo(
    () =>
      conversations
        .filter((c) => c.primaryRoleId === expertId)
        .slice(0, 12)
        .map((c) => ({ id: c.id, title: c.title || 'Untitled', when: relativeWhen(c.updatedAt) })),
    [conversations, expertId]
  )
  const roleDisabled = roles.isDisabled(expertId);

  return (
    <div className="main-col">
      <div className="conv-header">
        <span className="conv-title">Profile</span>
        <button className="btn secondary sm" style={{ marginLeft: "auto" }} onClick={() => onChat(expertId)}>
          <Icons.message size={14} /> Start a conversation
        </button>
      </div>
      <div className="detail-body">
        <div className="detail-inner">
          {/* hero */}
          <div className="detail-hero">
            <Avatar expert={e} size={56} />
            <div className="dh-meta">
              <div className="dh-name">
                {e.name}
                {e.coordinator && <span className="dh-badge">coordinator</span>}
                {e.custom && <span className="dh-badge custom">custom</span>}
              </div>
              <div className="dh-spec">{e.specialty}</div>
              <div className="dh-personality">{e.personality}.</div>
            </div>
            {e.coordinator ? (
              <div className="role-enable-pill primary"><Icons.shield size={14} /> Primary role · always on</div>
            ) : (
              <div className="role-enable-pill">
                <span>{roleDisabled ? "Role disabled" : "Role enabled"}</span>
                <MemToggle on={!roleDisabled} onClick={() => roles.toggle(expertId)} />
              </div>
            )}
          </div>

          {/* model binding */}
          <div className="detail-section">
            <div className="ds-head"><span className="ds-title">Model</span><span className="ds-hint">endpoint &amp; model this role runs on</span></div>
            <InlineBinding expert={e} onOpenEndpoint={onOpenEndpoint} />
          </div>

          {/* memory */}
          <MemorySection expertId={expertId} />

          {/* equipped */}
          <EquippedSection expertId={expertId} />

          {/* recents — filtered by primary_role_id, so this lists DIRECT conversations with this
              expert. Pipeline turns where another role (Atlas, etc.) routed work to this expert show
              up under that primary role's detail page instead. */}
          <div className="detail-section">
            <div className="ds-head">
              <span className="ds-title">Recent conversations</span>
              {!e.coordinator && <span className="ds-hint">direct chats with {e.name}</span>}
            </div>
            {recents.length === 0 ? (
              <div className="detail-empty">No conversations with {e.name} yet.</div>
            ) : (
              <div className="recent-list">
                {recents.map((r) => (
                  <div className="recent-row" key={r.id} onClick={() => onOpenConv(r.id)}>
                    <span className="hist-dot" style={{ background: e.color }} />
                    <span className="recent-title">{r.title}</span>
                    <span className="recent-when">{r.when}</span>
                    <Icons.chevronRight size={14} />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* danger zone — custom roles only */}
          {e.custom && (
            <div className="detail-section">
              <div className="ds-head"><span className="ds-title">Danger zone</span></div>
              <div className="detail-card" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 }}>
                <span style={{ fontSize: 13, color: "var(--text-3)" }}>Delete this custom role, its conversations, and its role memory. Shared memory is kept.</span>
                <button className="btn danger sm" onClick={() => setConfirm(true)}><Icons.trash size={14} /> Delete role</button>
              </div>
            </div>
          )}
        </div>
      </div>
      {confirm && (
        <ConfirmDialog title={`Delete ${e.name}?`}
          body={`This removes ${e.name}, its conversations, and what it learned about you. Shared memory is kept. This can't be undone.`}
          confirmLabel="Delete role" danger
          onConfirm={() => { roles.remove(expertId); onDeleted && onDeleted(); }} onClose={() => setConfirm(false)} />
      )}
    </div>
  );
}
