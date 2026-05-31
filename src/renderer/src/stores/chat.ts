import { create } from 'zustand'
import { STUDIO_DATA } from '@/data/studio-data'
import type { EffortLevel } from '@/lib/thinking'

// Persisted per-conversation chat store (L3). A conversation is a real DB row (conversations table);
// messages are appended to the messages table. The store keeps the history list + the loaded messages
// per conversation + the active conversation id. Streaming deltas route by streamId → conversation.

type ConversationDto = Awaited<ReturnType<typeof window.api.conversations.list>>[number]

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  images?: { url: string; name: string }[]
  streaming?: boolean
}

interface SendOpts {
  expertId: string
  endpointId: string
  model: string
  thinking?: { effort?: EffortLevel; budgetTokens?: number }
  text: string
  images?: { dataUrl: string; mime: string; name: string }[]
}

interface ChatState {
  conversations: ConversationDto[]
  activeConv: string | null
  byConversation: Record<string, ChatMessage[]>
  streaming: Record<string, boolean>
  error: Record<string, string | null>
  loadConversations: () => Promise<void>
  openConversation: (convId: string) => Promise<void>
  newConversation: () => void
  send: (opts: SendOpts) => Promise<void>
  stop: () => void
  removeConversation: (convId: string) => Promise<void>
  rename: (convId: string, title: string) => Promise<void>
}

const uid = (): string => globalThis.crypto.randomUUID()
const streamMeta = new Map<string, { convId: string; expertId: string; endpointId: string; model: string }>()
let creating = false // sync guard: blocks a double-create when a fresh thread's first message fires twice fast
let listening = false

export const useChat = create<ChatState>((set, get) => {
  // Wire the chat IPC listeners once. delta/done/error carry a streamId we map back to the conversation
  // it belongs to. On done we persist the assistant message + re-sort the history (updated_at changed).
  const ensureListeners = (): void => {
    if (listening) return
    listening = true
    const api = window.api.chat
    api.onDelta((d) => {
      const meta = streamMeta.get(d.streamId)
      if (!meta) return
      set((s) => {
        const msgs = (s.byConversation[meta.convId] ?? []).map((m) => ({ ...m }))
        const cur = msgs[msgs.length - 1]
        if (cur && cur.role === 'assistant' && cur.streaming) cur.text += d.text
        return { byConversation: { ...s.byConversation, [meta.convId]: msgs } }
      })
    })
    api.onDone((d) => {
      const meta = streamMeta.get(d.streamId)
      streamMeta.delete(d.streamId)
      if (!meta) return
      set((s) => {
        const msgs = (s.byConversation[meta.convId] ?? []).map((m) => ({ ...m }))
        const cur = msgs[msgs.length - 1]
        if (cur && cur.role === 'assistant') {
          cur.streaming = false
          cur.text = d.text // done is authoritative
        }
        return {
          byConversation: { ...s.byConversation, [meta.convId]: msgs },
          streaming: { ...s.streaming, [meta.convId]: false }
        }
      })
      void window.api.conversations
        .append(meta.convId, { author: 'expert', expertId: meta.expertId, model: meta.model, content: d.text })
        .then(() => get().loadConversations())
      // Post-turn memory trigger (post-turn cadence + explicit cue resolved in the backend).
      void window.api.memory.onTurn({
        convId: meta.convId,
        roleId: meta.expertId,
        endpointId: meta.endpointId,
        model: meta.model
      })
      // Post-turn compression check — folds older messages into a summary if the conversation crossed
      // 90% of the model's context window.
      void window.api.chat.compress({
        convId: meta.convId,
        roleId: meta.expertId,
        endpointId: meta.endpointId,
        model: meta.model
      })
    })
    api.onError((d) => {
      const meta = streamMeta.get(d.streamId)
      streamMeta.delete(d.streamId)
      if (!meta) return
      set((s) => {
        const msgs = (s.byConversation[meta.convId] ?? []).filter((m) => !(m.role === 'assistant' && m.streaming))
        return {
          byConversation: { ...s.byConversation, [meta.convId]: msgs },
          streaming: { ...s.streaming, [meta.convId]: false },
          error: { ...s.error, [meta.convId]: d.message }
        }
      })
    })
  }

  return {
    conversations: [],
    activeConv: null,
    byConversation: {},
    streaming: {},
    error: {},

    loadConversations: async () => {
      set({ conversations: await window.api.conversations.list() })
    },

    openConversation: async (convId) => {
      set({ activeConv: convId })
      if (get().byConversation[convId]) return // already loaded
      const rows = await window.api.conversations.messages(convId)
      const mapped: ChatMessage[] = rows.map((m) => ({
        id: m.id,
        role: m.author === 'user' ? 'user' : 'assistant',
        text: m.content,
        images: m.attachments.length ? m.attachments.map((a) => ({ url: a.url, name: a.name ?? 'image' })) : undefined
      }))
      set((s) => ({ byConversation: { ...s.byConversation, [convId]: mapped } }))
    },

    newConversation: () => set({ activeConv: null }),

    send: async ({ expertId, endpointId, model, thinking, text, images }) => {
      ensureListeners()
      // Create the conversation on the first message of a fresh thread.
      let convId = get().activeConv
      const isNew = !convId
      if (!convId) {
        if (creating) return // a create is already in flight for this fresh thread — drop the duplicate
        creating = true
        const title = text.trim().slice(0, 60) || 'New conversation'
        try {
          const conv = await window.api.conversations.create({ kind: 'single', primaryRoleId: expertId, title })
          convId = conv.id
          set((s) => ({ activeConv: conv.id, conversations: [conv, ...s.conversations] }))
        } catch {
          return // create failed; user can retry
        } finally {
          creating = false
        }
      }
      const cid = convId
      const userImages = (images ?? []).map((i) => ({ url: i.dataUrl, name: i.name }))

      // Optimistic render FIRST (no empty-state flash). Persisting the user turn + chat.send happen
      // below inside one try; the streaming assistant placeholder fills in via onDelta/onDone.
      set((s) => {
        const prev = s.byConversation[cid] ?? []
        return {
          byConversation: {
            ...s.byConversation,
            [cid]: [
              ...prev,
              { id: uid(), role: 'user', text, images: userImages.length ? userImages : undefined },
              { id: uid(), role: 'assistant', text: '', streaming: true }
            ]
          },
          streaming: { ...s.streaming, [cid]: true },
          error: { ...s.error, [cid]: null }
        }
      })
      // First message of a fresh thread → generate a real title (Haiku→Sonnet→main model, in the
      // backend) and patch it into the history list when it lands. Async, never blocks the reply.
      if (isNew) {
        void window.api.conversations
          .title({ convId: cid, firstMessage: text.slice(0, 1000), endpointId, model })
          .then((title) => {
            if (title)
              set((s) => ({ conversations: s.conversations.map((c) => (c.id === cid ? { ...c, title } : c)) }))
          })
          .catch(() => {})
      }

      const expert = STUDIO_DATA.EXPERT_BY_ID[expertId]
      const systemPrompt = expert
        ? `You are ${expert.name}, ${expert.specialty.toLowerCase()}. ${expert.personality}.`
        : ''

      try {
        // Persist the user turn first — the backend assembles context by reading this conversation's
        // messages from the DB, so it must be stored before chat.send. Both share this catch.
        await window.api.conversations.append(cid, {
          author: 'user',
          expertId,
          content: text,
          attachments: userImages.map((i) => ({ url: i.url, name: i.name }))
        })
        const { streamId } = await window.api.chat.send({
          convId: cid,
          roleId: expertId,
          endpointId,
          model,
          systemPrompt,
          thinking
        })
        streamMeta.set(streamId, { convId: cid, expertId, endpointId, model })
      } catch (e) {
        set((s) => {
          const msgs = (s.byConversation[cid] ?? []).filter((m) => !(m.role === 'assistant' && m.streaming))
          return {
            byConversation: { ...s.byConversation, [cid]: msgs },
            streaming: { ...s.streaming, [cid]: false },
            error: { ...s.error, [cid]: e instanceof Error ? e.message : String(e) }
          }
        })
      }
    },

    stop: () => {
      const cid = get().activeConv
      if (!cid) return
      for (const [sid, meta] of streamMeta) {
        if (meta.convId === cid) {
          void window.api.chat.stop(sid)
          streamMeta.delete(sid)
        }
      }
      set((s) => ({ streaming: { ...s.streaming, [cid]: false } }))
    },

    removeConversation: async (convId) => {
      await window.api.conversations.remove(convId)
      set((s) => {
        const byConv = { ...s.byConversation }
        delete byConv[convId]
        return {
          conversations: s.conversations.filter((c) => c.id !== convId),
          byConversation: byConv,
          activeConv: s.activeConv === convId ? null : s.activeConv
        }
      })
    },

    rename: async (convId, title) => {
      await window.api.conversations.rename(convId, title)
      set((s) => ({ conversations: s.conversations.map((c) => (c.id === convId ? { ...c, title } : c)) }))
    }
  }
})
