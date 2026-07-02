/* ============================================================
   NicoSoft AI Studio — regular role conversation (real streaming via chat store)
   Composer (model + thinking + path + image attachments) · ChatView · EmptyState
   ============================================================ */
import { Fragment, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Icons } from '@/components/icons'
import { ImageViewer, type ViewerImage } from '@/components/image-viewer'
import { EmptyState } from '@/components/empty-state'
import { DispatchBadge } from '@/components/primitives'
import { useChat, roleHasImageGen } from '@/stores/chat'
import { ApprovalDialog } from '@/components/approval-dialog'
import { QuestionDialog } from '@/components/question-dialog'
import { ApprovalCards } from '@/components/approval-cards'
import { VerifyTimeline } from '@/components/verify-timeline'
import { useAllExperts } from '@/lib/all-experts'
import { toast } from '@/stores/toast'
import { useT } from '@/stores/locale'
import type { Expert } from '@/types'
import { Composer } from '@/views/composer'
import { ChatSegment, RetryReadout, PendingReadout, groupRuns, sameChain } from '@/views/chat-segment'

// Virtualized message list (streaming-render-alignment §3.6 — TanStack Virtual, the same library
// claude.ai ships): only the visible window of runs mounts, so a 200-message conversation costs what a
// screenful costs. Escape hatch while it beds in (spec §6): localStorage
// 'nicosoft-studio-virtual-list' = 'off' falls back to the plain full map. Read once at module load.
const VIRTUAL_LIST = ((): boolean => {
  try {
    return window.localStorage.getItem('nicosoft-studio-virtual-list') !== 'off'
  } catch {
    return true
  }
})()

/* — The full conversation view for a non-Engineer role — */
export function ChatView({ expert, onOpenSettings, onBackToProject }: { expert: Expert; onOpenSettings?: () => void; onBackToProject?: () => void }): ReactElement {
  const t = useT()
  const chat = useChat()
  const { byId: expertById } = useAllExperts()
  const activeConv = chat.activeConv
  const messages = activeConv ? (chat.byConversation[activeConv] ?? []) : []
  // Live ↑/↓ readout shows the CURRENT request only, never a session running total. Accumulating per-turn
  // input re-counts the (cache-resent) context N× and balloons on long multi-dispatch runs (Danny hit 11M).
  //   • liveInput/liveOutput are the current request overlay from streaming pings (overwrite, not summed).
  //   • contextTokens is the current context size — a pre-usage fallback before providers report live usage.
  const liveIn = activeConv ? (chat.liveInput[activeConv] ?? 0) : 0
  const liveOut = activeConv ? (chat.liveOutput[activeConv] ?? 0) : 0
  const ctxIn = activeConv ? (chat.contextTokens[activeConv] ?? 0) : 0
  const baseIn = liveIn || ctxIn
  const baseOut = liveOut
  // Cached split only applies to REAL live pings — the count_tokens fallback (ctxIn) has no split.
  const baseCached = liveIn && activeConv ? (chat.liveCached[activeConv] ?? 0) : 0
  const convStreaming = activeConv ? (chat.streaming[activeConv] ?? false) : false
  const retry = activeConv ? chat.retry[activeConv] : null
  const error = activeConv ? chat.error[activeConv] : null
  const permission = activeConv ? chat.permission[activeConv] : null
  const question = activeConv ? chat.question[activeConv] : null
  const approvals = activeConv ? chat.approvals[activeConv] : undefined
  const listRef = useRef<HTMLDivElement>(null)
  // Stick to the bottom while streaming. The flag is maintained from the user's OWN scrolls (onListScroll),
  // NOT recomputed inside the effect — recomputing there mis-fired: each new tool card grows scrollHeight,
  // so by the next render the distance already exceeds the threshold and we'd wrongly conclude "the user
  // scrolled up" and stop following (the symptom: a busy multi-expert turn stalling a few rows short).
  // Content growth never flips this; only a real wheel/drag up does. Our own rAF scroll lands at distance 0,
  // which onListScroll reads back as still-stuck.
  const stickRef = useRef(true)
  const [value, setValue] = useState('')
  const [viewer, setViewer] = useState<{ items: ViewerImage[]; index: number } | null>(null)
  const [focusNonce, setFocusNonce] = useState(0)

  // Run-level virtualization: item granularity = groupRuns' runs (the exact units the plain map
  // rendered), dynamic heights via measureElement (its ResizeObserver re-measures on streaming growth /
  // fold toggles). The hook always runs (rules of hooks); the escape hatch just zeroes the count.
  const runs = messages.length > 0 ? groupRuns(messages) : []
  const virtualizer = useVirtualizer({
    count: VIRTUAL_LIST ? runs.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => 120,
    overscan: 6,
    getItemKey: (i) => runs[i][0].id
  })

  // The user scrolling UP (onListWheel) is the ONLY thing that unsticks. onScroll then only RE-sticks when
  // they return to the bottom — it must NEVER unstick: during fast streaming our own scroll-to-bottom fires
  // onScroll a frame late, by which point the content grew again so the distance reads > threshold;
  // recomputing "stuck" from that falsely concludes the user scrolled up and stops following (the symptom:
  // streaming output stalling a few rows short of the bottom).
  const onListScroll = (): void => {
    const el = listRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) stickRef.current = true
  }
  const onListWheel = (e: React.WheelEvent): void => {
    if (e.deltaY < 0) stickRef.current = false // a deliberate upward scroll = "let me read back" → stop following
  }

  // Auto-scroll via a ResizeObserver on the inner content: ANY height growth (tool cards, deltas, approval
  // cards, async/late renders) fires it, AFTER layout, so scrollHeight is already final. Strictly more
  // reliable than a [messages] effect — that can fire before the new rows lay out (stale height → stops a
  // row short) and misses height changes that don't alter the messages array. Follows only when stuck
  // (stickRef, maintained from the user's own scrolls); re-pins to bottom on conversation switch.
  useEffect(() => {
    const list = listRef.current
    const inner = list?.firstElementChild
    if (!list || !inner) return
    stickRef.current = true
    list.scrollTop = list.scrollHeight
    const ro = new ResizeObserver(() => {
      if (stickRef.current) list.scrollTop = list.scrollHeight
    })
    ro.observe(inner)
    return () => ro.disconnect()
  }, [activeConv])

  // Re-pin to the bottom when an approval APPEARS and when it's RESOLVED. The dialog is an overlay (the
  // ResizeObserver above won't fire for it). On resolve the agent resumes streaming, and the user has
  // usually scrolled up to read the approval (so stickRef is false) — without re-pinning on BOTH edges
  // the resumed output scrolls past unseen (the "after I approve it doesn't scroll" bug, which looked
  // intermittent because it only bit when the user had scrolled). Keyed on the boolean so it fires on
  // appear (→true) AND resolve (→false), not on every render.
  const hasApproval = !!permission || !!(approvals && approvals.length)
  useEffect(() => {
    const list = listRef.current
    if (list) {
      stickRef.current = true
      list.scrollTop = list.scrollHeight
    }
  }, [hasApproval])

  const openImage = (items: ViewerImage[], index: number): void => setViewer({ items, index })
  // media.save opens a native save dialog: a truthy path = saved, a falsy value = the user cancelled
  // (stay silent), a thrown error = a real failure.
  const downloadImage = (img: ViewerImage): void => {
    void window.api.media
      .save(img.url, img.name)
      .then((path) => { if (path) toast.success(t('conv.imageSaved')) })
      .catch(() => toast.error(t('conv.imageSaveFailed')))
  }
  // Refine: close the viewer, seed the composer with a refine lead-in and focus it. The designer keeps
  // the prior image + its prompt in context, so the user just types the change and sends → regenerate.
  const refineImage = (): void => {
    setViewer(null)
    setValue((v) => (v.trim() ? v : t('conv.refineLeadIn')))
    setFocusNonce((n) => n + 1)
  }

  // Workspace Files panel → "Insert path to agent": append the clicked file's (cwd-relative) path to the
  // composer and focus it. Cross-component via a window event (same pattern as nsai:open-conversation),
  // since the composer's value lives here, not in the drawer.
  useEffect(() => {
    const h = (e: Event): void => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text
      if (!text) return
      setValue((v) => (v && !v.endsWith(' ') ? v + ' ' : v) + text + ' ')
      setFocusNonce((n) => n + 1)
    }
    window.addEventListener('nsai:insert-to-composer', h)
    return () => window.removeEventListener('nsai:insert-to-composer', h)
  }, [])

  return (
    <div className="main-col">
      {onBackToProject && (
        <div className="chat-crumb-bar">
          <button className="chat-crumb" onClick={onBackToProject}>
            <Icons.chevronLeft size={14} /> {t('conv.backToProject')}
          </button>
        </div>
      )}
      <div className="msg-list" ref={listRef} onScroll={onListScroll} onWheel={onListWheel}>
        <div className="msg-inner">
          {messages.length === 0 ? (
            <EmptyState expert={expert} onChip={setValue} />
          ) : (
            (() => {
              const renderRun = (run: (typeof runs)[number], ri: number): ReactElement => {
                const firstMsg = run[0]
                // Dispatch badge above the FIRST run of each pipeline turn — detected by a non-empty dispatch
                // chain differing from the previous run's last message. Single-mode turns have dispatch=null → none.
                const prevRun = ri > 0 ? runs[ri - 1] : null
                const prevMsg = prevRun ? prevRun[prevRun.length - 1] : null
                const showBadge =
                  firstMsg.role === 'assistant' &&
                  Array.isArray(firstMsg.dispatch) &&
                  firstMsg.dispatch.length > 0 &&
                  !sameChain(prevMsg?.dispatch, firstMsg.dispatch)
                return (
                  <>
                    {showBadge ? <DispatchBadge chain={firstMsg.dispatch as string[]} /> : null}
                    <ChatSegment
                      msgs={run}
                      expert={expert}
                      expertById={expertById}
                      onOpenImage={openImage}
                      inputTokens={baseIn}
                      outputTokens={baseOut}
                      cachedTokens={baseCached}
                      pendingLive={convStreaming && ri === runs.length - 1 && firstMsg.role === 'assistant'}
                    />
                  </>
                )
              }
              if (!VIRTUAL_LIST) return runs.map((run, ri) => <Fragment key={run[0].id}>{renderRun(run, ri)}</Fragment>)
              // Virtual window: a relative box at the full measured height, visible items absolutely
              // positioned by translateY. `flow-root` makes each item box contain its children's margins
              // (e.g. the dispatch badge's), so measureElement reads the true occupied height.
              return (
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((vi) => (
                    <div
                      key={vi.key}
                      data-index={vi.index}
                      ref={virtualizer.measureElement}
                      className="virt-item"
                      style={{ position: 'absolute', top: 0, left: 0, width: '100%', display: 'flow-root', transform: `translateY(${vi.start}px)` }}
                    >
                      {renderRun(runs[vi.index], vi.index)}
                    </div>
                  ))}
                </div>
              )
            })()
          )}
          {/* Between-turn liveness lives INSIDE the last assistant run (pendingLive) — a standalone pending
              segment only appears before the FIRST assistant message, when there's no run to host it yet. */}
          {convStreaming && messages.length > 0 && messages[messages.length - 1].role === 'user' ? (
            <PendingReadout expert={expert} inputTokens={baseIn} outputTokens={baseOut} />
          ) : null}
          {retry ? <RetryReadout attempt={retry.attempt} max={retry.max} since={retry.since} /> : null}
          {error ? (
            <div className="inline-notice">
              <span className="n-icon">
                <Icons.alert size={17} />
              </span>
              <span className="n-text">
                <strong>{error}</strong>
              </span>
            </div>
          ) : null}
          {activeConv && chat.approvals[activeConv]?.length ? (
            <ApprovalCards
              cards={chat.approvals[activeConv]}
              onApprove={(pid) => chat.approveApproval(activeConv, pid)}
              onReject={(pid) => chat.rejectApproval(activeConv, pid)}
            />
          ) : null}
          {activeConv ? <VerifyTimeline convId={activeConv} /> : null}
        </div>
      </div>
      <Composer expert={expert} value={value} setValue={setValue} onOpenSettings={onOpenSettings} focusNonce={focusNonce} />
      {permission && activeConv ? (
        <ApprovalDialog
          prompt={permission}
          onAllow={() => chat.respondPermission(activeConv, true)}
          onDeny={() => chat.respondPermission(activeConv, false)}
        />
      ) : null}
      {question && activeConv ? (
        <QuestionDialog prompt={question} onAnswer={(a) => chat.respondQuestion(activeConv, a)} />
      ) : null}
      {viewer ? (
        <ImageViewer
          items={viewer.items}
          index={viewer.index}
          onClose={() => setViewer(null)}
          onStep={(d) => setViewer((v) => (v ? { ...v, index: (v.index + d + v.items.length) % v.items.length } : v))}
          onDownload={downloadImage}
          onRefine={roleHasImageGen(expert.id) ? refineImage : undefined}
        />
      ) : null}
    </div>
  )
}
