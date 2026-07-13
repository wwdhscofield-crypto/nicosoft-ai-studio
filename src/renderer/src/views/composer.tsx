/* ============================================================
   NicoSoft AI Studio — regular role conversation (real streaming via chat store)
   Composer (model + thinking + path + image attachments)
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ClipboardEvent as ReactClipboardEvent, ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { AttachmentStrip } from '@/components/attachment-strip'
import { ModelPicker, ThinkingPicker, ImageModelPicker, ModePicker } from '@/components/composer-controls'
import { CommandPalette, matchCommands, type SlashCommand } from '@/components/command-palette'
import { MentionPalette, type MentionCandidate } from '@/components/mention-palette'
import { parseWorkflowArgs, launchPayload, type WfCmdWorkflow } from '@/lib/workflow-command'
import { resolveTarget } from '@/lib/command-routing'
import { toast } from '@/stores/toast'
import { PathBar } from '@/components/path-bar'
import { GitStatusChip } from '@/components/git-status-chip'
import { resolveConvCwd } from '@/lib/resolve-cwd'
import { participantsOf, matchLeadingMention } from '@/lib/conversation-participants'
import { useAllExperts } from '@/lib/all-experts'
import { useRoles } from '@/stores/roles'
import { useWorkspace } from '@/stores/workspace'
import { useMemoryCloud } from '@/stores/memory-cloud'
import { useChat, roleHasAgent, roleHasImageGen, roleRunsAgentLoop, roleIsCoordinator } from '@/stores/chat'
import { useRoleBinding, type RoleBindingControls } from '@/lib/use-role-binding'
import type { EndpointDto } from '@/lib/api'
import { fileToImage, imagesFromClipboard, type ImageAttachment } from '@/lib/image'
import { defaultThinkingChoice, getThinkingCapability, resolveThinking, type ThinkingChoice } from '@/lib/thinking'
import { useT, type TFunction } from '@/stores/locale'
import type { Expert } from '@/types'

// The composer's empty-state banner covers FOUR distinct setup gaps — not one. Collapsing them into a
// single "bind an endpoint with a key and a model" sentence is misleading (a user who added an endpoint
// but left the key blank gets told to bind one). Resolve the exact missing item and return an actionable
// line so they know precisely what to fix. Order mirrors the `noEndpoint` OR-chain in the component, with
// the agent-protocol gate kept first.
function bindBannerMessage(
  t: TFunction,
  name: string,
  selectedEp: EndpointDto | undefined,
  b: RoleBindingControls,
  needAgentProto: boolean
): string {
  if (needAgentProto) return t('conv.needAgentProto', { name })
  if (b.endpoints.length === 0 || !selectedEp) return t('conv.noEndpointYet', { name })
  if (!selectedEp.enabled) return t('conv.endpointDisabled', { name, endpoint: selectedEp.name })
  if (selectedEp.keyState === 'unreadable') return t('conv.endpointKeyUnreadable', { endpoint: selectedEp.name })
  if (selectedEp.keyState !== 'ok') return t('conv.endpointNoKey', { endpoint: selectedEp.name })
  if (!b.model) return t('conv.endpointNoModel', { name })
  return t('conv.bindEndpoint', { name }) // unreachable given noEndpoint already true — defensive
}

// Compact token readout: K below 1M, M at/above it (1M, 1.05M, 1.5M — trailing zeros trimmed).
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${parseFloat((n / 1_000_000).toFixed(2))}M`
  return `${parseFloat((n / 1000).toFixed(1))}K`
}

/* — Composer: real model/thinking pickers, path bar, image paste, streams via the chat store — */
export function Composer({
  expert,
  value,
  setValue,
  onOpenSettings,
  focusNonce
}: {
  expert: Expert
  value: string
  setValue: (v: string) => void
  onOpenSettings?: () => void
  focusNonce?: number
}): ReactElement {
  const t = useT()
  const chat = useChat()
  const b = useRoleBinding(expert)
  const cwdByExpert = useWorkspace((s) => s.cwdByExpert)
  const draftCwd = useWorkspace((s) => s.draftCwd)
  const setDraftCwd = useWorkspace((s) => s.setDraftCwd)
  // Per-conversation cwd (see resolve-cwd): an OPEN conversation owns its cwd (conv.cwd, incl. '' = folder-free);
  // the GREETING (no conversation yet) uses the transient draft. conv.cwd === null = a legacy conversation → fall
  // back to the old per-expert cwd so it keeps resolving to the role's folder until the user re-picks.
  const conv = chat.activeConv ? chat.conversations.find((c) => c.id === chat.activeConv) ?? null : null
  const cwd = conv ? conv.cwd ?? cwdByExpert[expert.id] ?? '' : draftCwd
  // Set the operative cwd: an open conversation persists to its OWN row (per-conversation); the greeting updates
  // the draft that the newly-created conversation inherits on send.
  const setCwd = (next: string): void => {
    if (chat.activeConv) void chat.setConvCwd(chat.activeConv, next)
    else setDraftCwd(next)
  }
  // A picked folder can vanish from disk afterwards (deleted, volume unmounted). Probe on cwd change +
  // window focus; while missing, the WHOLE chain treats the chat as folder-free — PathBar shows its
  // "choose a folder" state, send() omits the cwd (agent falls back to its scratch workspace), the git
  // chip hides. The store keeps the path on purpose: a re-mounted volume restores everything unprompted.
  const [cwdMissing, setCwdMissing] = useState(false)
  useEffect(() => {
    let alive = true
    if (!cwd) {
      setCwdMissing(false)
      return
    }
    const probe = (): void => {
      void window.api.fs.dirExists(cwd).then((ok) => {
        if (alive) setCwdMissing(!ok)
      })
    }
    probe()
    window.addEventListener('focus', probe)
    return () => {
      alive = false
      window.removeEventListener('focus', probe)
    }
  }, [cwd])
  const effectiveCwd = cwdMissing ? '' : cwd
  const mode = useWorkspace((s) => s.modeByExpert[expert.id] ?? 'default')
  const setMode = useWorkspace((s) => s.setMode)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [attach, setAttach] = useState<ImageAttachment[]>([])
  const [cmdIndex, setCmdIndex] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  // @-mention roster inputs (coordinator conversations): the full expert lookup + which roles are
  // disabled/deleted right now, so the picker can dim (not drop) an unavailable participant.
  const { experts: allExperts, byId: expertById } = useAllExperts()
  const rolesDisabled = useRoles((s) => s.disabled)
  const rolesDeleted = useRoles((s) => s.deleted)

  // A Refine action (from the image viewer) bumps focusNonce → pull focus into the composer.
  useEffect(() => {
    if (focusNonce) taRef.current?.focus()
  }, [focusNonce])

  const activeConv = chat.activeConv
  const streaming = activeConv ? (chat.streaming[activeConv] ?? false) : false
  const compacting = activeConv ? (chat.compacting[activeConv] ?? false) : false
  const messages = activeConv ? (chat.byConversation[activeConv] ?? []) : []
  // Exact prompt tokens of the last sent turn (count_tokens, measured server-side) plus the unsent input
  // — far more accurate than chars/4, especially for agent runs where tool schemas dominate. Falls back
  // to a chars/4 estimate before the first turn lands a measurement.
  const baseTokens = activeConv ? (chat.contextTokens[activeConv] ?? 0) : 0
  const usedTokens =
    baseTokens > 0
      ? baseTokens + value.length / 4
      : messages.reduce((s, m) => s + m.text.length, 0) / 4 + value.length / 4
  const tokenAmber = b.contextLength > 0 && usedTokens / b.contextLength > 0.85
  const selectedEp = b.endpoints.find((e) => e.id === b.endpointId)
  const agent = roleHasAgent(expert.id)
  // A project folder is OPTIONAL for every agent role, Flynn/Shuri included: they can chat folder-free,
  // and the backend falls back to a per-conversation scratch workspace (the agent asks the user where to
  // save real work). Agent roles still need an Anthropic / OpenAI / Gemini endpoint — the loop's three
  // tool-use protocols (doc 29 wired Gemini's function-calling agent loop).
  const needAgentProto =
    agent &&
    !!selectedEp &&
    selectedEp.protocol !== 'anthropic' &&
    selectedEp.protocol !== 'openai' &&
    selectedEp.protocol !== 'custom' &&
    selectedEp.protocol !== 'gemini'
  const noEndpoint =
    b.loaded &&
    (b.endpoints.length === 0 || !selectedEp || !selectedEp.enabled || selectedEp.keyState !== 'ok' || !b.model || needAgentProto)
  const ready = b.loaded && !noEndpoint
  // No stored pick → the model's TOP tier (think as hard as possible unless the user dials it down);
  // 'medium' only as the final fallback for capability gaps.
  const effectiveDepth = (b.depth || defaultThinkingChoice(b.family, b.model) || 'medium') as ThinkingChoice

  const grow = (): void => {
    const ta = taRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'
    }
  }
  const addFiles = async (files: File[]): Promise<void> => {
    const imgs = (await Promise.all(files.map(fileToImage))).filter((x): x is ImageAttachment => x !== null)
    if (imgs.length) setAttach((p) => [...p, ...imgs])
  }
  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const files = imagesFromClipboard(e.clipboardData?.items ?? null)
    if (files.length === 0) return // no images → let the text paste through
    e.preventDefault()
    void addFiles(files)
  }
  const onPickFiles = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? [])
    e.target.value = ''
    void addFiles(files)
  }
  // Drag-and-drop images onto the composer (3rd intake next to paste and the file picker). dragDepth
  // counts enter/leave because moving across the composer's CHILDREN fires leave on the parent — a
  // plain boolean would flicker the highlight off mid-drag.
  const [dragDepth, setDragDepth] = useState(0)
  const hasFileDrag = (e: React.DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setDragDepth(0)
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
    if (files.length) void addFiles(files)
  }
  // A drop anywhere OUTSIDE the composer would make Electron navigate the window to the file — kill the
  // default at the document level so a missed drop is a no-op instead of replacing the app.
  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault()
    document.addEventListener('dragover', prevent)
    document.addEventListener('drop', prevent)
    return () => {
      document.removeEventListener('dragover', prevent)
      document.removeEventListener('drop', prevent)
    }
  }, [])

  // The one send payload builder — the typed-text path (send) and the git chip's preset instructions
  // (visible user messages riding the SAME turn machinery) both go through here, so binding/model/
  // thinking/mode always come from the current UI state.
  const dispatchSend = (text: string, images?: { dataUrl: string; mime: string; name: string }[]): void => {
    const thinking = resolveThinking(getThinkingCapability(b.family, b.model), effectiveDepth) ?? undefined
    // R5.1: the renderer does NOT resolve or submit the @mention target — main does, in route(), against the
    // DISPATCHABLE roster (the only authoritative source). A renderer prediction over the all-experts roster
    // would mislabel a chat-only @mention that main never routes there. The live chip re-derives from the
    // dispatchable roster (chat-segment) for the optimistic turn; the persisted chip reads main's write.
    void chat.send({
      expertId: expert.id,
      endpointId: b.endpointId,
      model: b.model,
      thinking,
      text,
      images: images?.length ? images : undefined,
      // cwd gates on the CAPABILITY predicate (roleRunsAgentLoop), not the routing one (roleHasAgent):
      // Danny's coordinator.run consumes the conversation's cwd too — every dispatched / collab expert
      // operates in it. Gating on roleHasAgent silently dropped the folder for coordinator conversations
      // (live 2026-07-09: the collab ran cwd-less and wrote into the app's process cwd).
      cwd: roleRunsAgentLoop(expert.id) ? effectiveCwd : undefined,
      contextWindow: agent ? b.contextLength || undefined : undefined,
      permissionMode: agent ? mode : undefined,
      imageModel: roleHasImageGen(expert.id) ? b.imageModel : undefined
    })
  }

  const send = (): void => {
    const text = value.trim()
    if ((!text && attach.length === 0) || !ready || streaming || compacting) return // compacting: the send slot is a Stop button — Enter stays consistent with it
    setValue('')
    setCmdOutput(null) // a real message supersedes any lingering /workflow · /schedule help block
    setTimeout(grow, 0)
    const images = attach.map((a) => ({ dataUrl: a.dataUrl, mime: a.mime, name: a.name }))
    setAttach([])
    dispatchSend(text, images)
  }

  // Git chip action: hand the commit/push work to this conversation's agent as a normal, visible turn.
  const sendGitPreset = (preset: string): void => {
    if (!ready || streaming || compacting) return
    dispatchSend(preset)
  }
  // A widget's sendPrompt (visualize §5.3): the WidgetCard dispatches 'nsai:send-prompt' scoped to its
  // conversation; it rides dispatchSend — the SAME visible, auditable turn path as the git chip presets
  // (G10: no hidden machine channel). Latest-closure ref so the once-registered listener never goes stale.
  const sendPromptRef = useRef((text: string): void => dispatchSend(text))
  sendPromptRef.current = (text: string): void => {
    if (!ready || streaming || compacting) return
    dispatchSend(text)
  }
  useEffect(() => {
    const onPrompt = (e: Event): void => {
      const d = (e as CustomEvent).detail as { convId?: string | null; text?: string } | null
      if (!d || typeof d.text !== 'string' || !d.text.trim()) return
      if ((d.convId ?? null) !== (activeConv ?? null)) return
      sendPromptRef.current(d.text)
    }
    window.addEventListener('nsai:send-prompt', onPrompt)
    return () => window.removeEventListener('nsai:send-prompt', onPrompt)
  }, [activeConv])
  // A companion "Reply to <expert>" button (chat-segment) prefills the composer with `@<name> ` so the user
  // answers that expert directly. Same fire-once, scoped-to-conversation pattern as nsai:send-prompt — a
  // CustomEvent, NEVER a persistent store field, so it can't re-fire and clobber a draft (design §3.8 / R6).
  // Prepend, never overwrite: an existing draft X becomes `@Name X` (mention stays at the line start); a
  // mention prefix already present is REPLACED so clicking a second expert re-targets instead of stacking.
  const prefillRef = useRef((_name: string): void => {})
  prefillRef.current = (name: string): void => {
    // Strip an EXISTING leading mention by its ACCURATE length: matchLeadingMention handles multi-word
    // display names ("@Data Analyst"), where a bare /^@\S*/ would truncate to "@Data" and corrupt the
    // draft ("@Data Analyst hello" → "@Flynn Analyst hello"). No valid leading mention → keep the draft.
    const m = matchLeadingMention(value, allExperts)
    const rest = (m ? value.slice(m.matchedLen) : value).replace(/^\s+/, '')
    const next = `@${name} ${rest}`
    setValue(next)
    setTimeout(() => {
      grow()
      const pos = name.length + 2 // @ + name + space → caret at the body start, ready to type the reply
      taRef.current?.focus()
      taRef.current?.setSelectionRange(pos, pos)
    }, 0)
  }
  useEffect(() => {
    const onPrefill = (e: Event): void => {
      const d = (e as CustomEvent).detail as { convId?: string | null; name?: string } | null
      if (!d || typeof d.name !== 'string' || !d.name.trim()) return
      if ((d.convId ?? null) !== (activeConv ?? null)) return
      prefillRef.current(d.name)
    }
    window.addEventListener('nsai:composer-prefill', onPrefill)
    return () => window.removeEventListener('nsai:composer-prefill', onPrefill)
  }, [activeConv])
  // The chip reads the CONVERSATION's cwd (resolveConvCwd — the same resolver the Files/Diff panels use):
  // for a solo conv that IS the PathBar's cwd; for coordinator/collab convs it falls back to the first
  // participating role with a folder. Greeting (no conversation yet) → the composer's own cwd. This
  // expert's entry is overridden with effectiveCwd so a vanished folder hides the chip too.
  const gitCwd = conv
    ? resolveConvCwd(conv, { ...cwdByExpert, [expert.id]: effectiveCwd }, messages)
    : effectiveCwd.trim() || null

  // `/workflow <name> [k=v …]` (workflow-design §6.5 + §7.5 launch review): the `/workflow` ROOT command
  // resolves the typed name against ENABLED workflows (drafts/disabled never run — §9 red line) and hands
  // off to launchWorkflow. The list is fetched when the palette opens, so a just-enabled workflow resolves
  // without a view switch. Running/validation lives in launchWorkflow via a latest-closure ref (same
  // pattern as sendPromptRef).
  //
  // Launch discipline (§7.5, "whoever launches, checks"): in an AGENT role's conversation the command
  // does NOT start the run — it persists the command line, then main drives ONE visible role turn that
  // reviews the workflow (mechanical verdict + its own read) and decides via a per-turn closure tool;
  // a block is absolute. On the greeting page the conversation is minted first (send()'s lazy-create
  // shape) so the command + review + card all persist — reopening the thread shows what happened.
  // A non-agent-loop role's conversation (no reviewer to run) keeps the direct start + card.
  const launchWorkflow = (w: WfCmdWorkflow, arg?: string): boolean | undefined => {
    const parsed = parseWorkflowArgs(w.params, arg)
    if (!parsed.ok) {
      const err = parsed.error
      toast.error(
        err.kind === 'unknown'
          ? t('wf.unknownParam', { name: err.name })
          : err.kind === 'missing'
            ? t('wf.missingParam', { name: err.name })
            : err.kind === 'bad-value'
              ? t('wf.badParam', { name: err.name })
              : t('wf.malformedArg', { token: err.token })
      )
      return false // keep the typed command in the composer so the user fixes it in place
    }
    const rawCmd = value.trim() // the user's literal command line — persisted as their bubble
    void (async () => {
      try {
        let convId = activeConv
        // roleHasAgent (not the raw built-in constant): an agent-enabled CUSTOM role must run the
        // same launch-review turn as built-in agents — 'whoever launches, checks'. Danny stays on
        // the direct-start branch below (his routing carries its own review).
        if (roleHasAgent(expert.id)) {
          chat.ensureStreamListeners() // the review turn streams on agent:resume-stream — subscribe before it can fire
          if (!convId) {
            const conv = await window.api.conversations.create({ kind: 'single', primaryRoleId: expert.id, title: rawCmd.slice(0, 60), cwd: effectiveCwd || '' })
            convId = conv.id
            chat.adoptConversation(conv)
          }
          const line = await window.api.conversations.append(convId, { author: 'user', content: rawCmd })
          chat.insertUserLine(convId, { id: line.id, text: rawCmd })
          await window.api.workflows.launchFromConv({
            workflowId: w.id,
            convId,
            roleId: expert.id,
            params: parsed.values,
            cwd: effectiveCwd || undefined,
            permissionMode: mode
          })
          // the review turn streams in via agent:resume-stream (streaming flag + segment open included)
          return
        }
        // No agent loop to review with (e.g. Danny's conversation — his natural-language routing branch
        // carries its own review; non-loop roles) → direct start + card, mechanical preflight in main.
        const { runId } = await window.api.workflows.run(w.id, parsed.values, 'command')
        if (convId) {
          const dto = await window.api.conversations.append(convId, {
            author: 'expert',
            content: launchPayload(w.id, runId, w.name, parsed.values),
            segmentKind: 'workflow-launch'
          })
          chat.insertCard(convId, { id: dto.id, content: dto.content, segmentKind: 'workflow-launch' })
        } else {
          toast.success(t('wf.started', { name: w.name }))
        }
      } catch (err) {
        toast.error(t('wf.startFailed', { name: w.name, message: err instanceof Error ? err.message : String(err) }))
      }
    })()
    return undefined
  }
  const launchWorkflowRef = useRef(launchWorkflow)
  launchWorkflowRef.current = launchWorkflow
  // §4/D10: the palette shows the root commands for this domain — `/workflow`, `/schedule`, `/research`,
  // `/design` — never a per-item expansion (no `/workflow <name>` rows). All stay matched while an argument is typed
  // (takesArg). The other built-in commands (/new, /compact, …) are unaffected. The lists are cached when
  // the palette is relevant so a command resolves synchronously (and can keep the input on a bad arg).
  const paletteRelevant = value.startsWith('/') && !value.includes('\n')
  const [wfAll, setWfAll] = useState<Awaited<ReturnType<typeof window.api.workflows.list>>>([])
  const [taskAll, setTaskAll] = useState<Awaited<ReturnType<typeof window.api.scheduled.list>>>([])
  const [cmdOutput, setCmdOutput] = useState<string[] | null>(null) // transient help/list block (not persisted, never sent to the model)
  useEffect(() => {
    if (!paletteRelevant) return
    let alive = true
    void window.api.workflows.list().then((l) => alive && setWfAll(l)).catch(() => {})
    void window.api.scheduled.list().then((l) => alive && setTaskAll(l)).catch(() => {})
    return () => {
      alive = false
    }
  }, [paletteRelevant])
  // Drop a lingering /workflow · /schedule help block when the conversation changes (the composer isn't
  // remounted per conversation) — the block belonged to the previous view.
  useEffect(() => setCmdOutput(null), [activeConv])

  // `/workflow` — bare = usage, `list` = every workflow, `<name> [k=v …]` = launch. Resolution is over
  // ENABLED workflows only (§9 red line: a draft never runs); `list` shows all with a status dot. Reuses
  // launchWorkflow so the launch keeps its review-turn / persisted-card discipline. Returns false to keep
  // the typed input when the argument is bad. `list` is the full workflow set the resolve saw.
  const actWorkflow = (list: typeof wfAll, arg?: string): boolean | undefined => {
    const enabled = list.filter((w) => w.enabled)
    const r = resolveTarget(enabled, arg, true)
    if (r.kind === 'usage') {
      setCmdOutput(['Usage:  /workflow list  ·  /workflow <name> [key=value …]', enabled.length ? `Enabled: ${enabled.map((w) => w.name).join(', ')}` : 'No enabled workflows.'])
      return
    }
    if (r.kind === 'list') {
      setCmdOutput(list.length ? list.map((w) => `${w.enabled ? '●' : '○'} ${w.name}${w.enabled ? '' : '  (draft)'}`) : ['No workflows saved.'])
      return
    }
    if (r.kind === 'error') {
      toast.error(r.message)
      return false
    }
    setCmdOutput(null)
    return launchWorkflowRef.current(r.target, r.rest || undefined)
  }
  // A cold cache (first command before the palette-open fetch resolved) would resolve against [] and give a
  // spurious "No match" — so on an empty cache, fetch fresh and act on the result. The warm path stays
  // synchronous so a bad arg can still keep the input (return false).
  const runWorkflowCommand = (arg?: string): boolean | undefined => {
    if (!wfAll.length) {
      void window.api.workflows.list().then((l) => {
        setWfAll(l)
        actWorkflow(l, arg)
      }).catch(() => {})
      return
    }
    return actWorkflow(wfAll, arg)
  }
  const runWorkflowCommandRef = useRef(runWorkflowCommand)
  runWorkflowCommandRef.current = runWorkflowCommand

  // `/schedule` — bare = usage, `list` = every task, `<id|name>` = run it now (fireNow). A disabled task
  // may be triggered (an explicit id/name is intent). Resolution is over ALL tasks. Toasts the outcome; the
  // run itself is visible on the Scheduled page + the Tasks panel Running section.
  const actSchedule = (list: typeof taskAll, arg?: string): boolean | undefined => {
    const r = resolveTarget(list, arg, false)
    if (r.kind === 'usage') {
      setCmdOutput(['Usage:  /schedule list  ·  /schedule <id|name>', list.length ? `${list.length} task(s) — type “/schedule list” to see them.` : 'No scheduled tasks.'])
      return
    }
    if (r.kind === 'list') {
      setCmdOutput(list.length ? list.map((t) => `${t.enabled ? '●' : '○'} ${t.name}  ·  ${t.recurring ? (t.cron ?? 'recurring') : 'once'}  ·  ${t.id}`) : ['No scheduled tasks.'])
      return
    }
    if (r.kind === 'error') {
      toast.error(r.message)
      return false
    }
    setCmdOutput(null)
    const task = r.target
    void window.api.scheduled
      .fireNow(task.id)
      .then((res) => (res.ok ? toast.success(`Running “${task.name}” now.`) : toast.error(res.error ?? `Couldn't run “${task.name}”.`)))
      .catch(() => toast.error(`Couldn't run “${task.name}”.`))
    return undefined
  }
  const runScheduleCommand = (arg?: string): boolean | undefined => {
    if (!taskAll.length) {
      void window.api.scheduled.list().then((l) => {
        setTaskAll(l)
        actSchedule(l, arg)
      }).catch(() => {})
      return
    }
    return actSchedule(taskAll, arg)
  }
  const runScheduleCommandRef = useRef(runScheduleCommand)
  runScheduleCommandRef.current = runScheduleCommand

  // `/research <question>` — a deep-research run (fan-out web searches → fetch sources → adversarially verify
  // claims → a cited report). The argument is FREE TEXT (no id/name resolution, unlike /workflow · /schedule);
  // bare = usage. Mirrors launchWorkflow's ensure-conversation + persisted user-bubble discipline, then hands
  // the question to research:run — the run surfaces as a research card in the conversation (live progress + the
  // final report, driven over conv:card). A start-time failure (no research-capable expert) toasts.
  const runResearchCommand = (arg?: string): boolean | undefined => {
    const question = arg?.trim()
    if (!question) {
      setCmdOutput(['Usage:  /research <question>', 'Fan-out web research with adversarial verification → a cited report.'])
      return
    }
    const rawCmd = value.trim() // the user's literal command line — persisted as their bubble
    setCmdOutput(null)
    void (async () => {
      try {
        // The research card + all its live patches arrive on the conv:card broadcast, whose renderer listener
        // (onConvCard) is subscribed only inside ensureListeners(). A /research as the FIRST action of a session
        // (greeting page, or a boot-restored conversation) never ran send(), so without this the card and the
        // whole run are invisible live (only a reload surfaces the persisted card). Same guard launchWorkflow uses.
        chat.ensureStreamListeners()
        let convId = activeConv
        if (!convId) {
          const conv = await window.api.conversations.create({ kind: 'single', primaryRoleId: expert.id, title: rawCmd.slice(0, 60), cwd: effectiveCwd || '' })
          convId = conv.id
          chat.adoptConversation(conv)
        }
        const line = await window.api.conversations.append(convId, { author: 'user', content: rawCmd })
        chat.insertUserLine(convId, { id: line.id, text: rawCmd }) // seeds byConversation so onConvCard's `if (!msgs) return` guard passes
        const res = await window.api.research.run({ convId, question })
        if (!res.ok) toast.error(res.error)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    })()
    return undefined
  }
  const runResearchCommandRef = useRef(runResearchCommand)
  runResearchCommandRef.current = runResearchCommand

  // `/design <problem>` — a judge-panel design review (N independent solution attempts from different angles →
  // parallel judge → a scored synthesis). Free text, bare = usage. Mirrors /research: ensure the conversation +
  // a persisted user bubble + the stream-listener subscription, then hand the problem to design:run (surfaces as
  // a design card). Kept distinct from the coordinator council — this is a one-shot, leaf-level approach review.
  const runDesignCommand = (arg?: string): boolean | undefined => {
    const problem = arg?.trim()
    if (!problem) {
      setCmdOutput(['Usage:  /design <problem>', 'Judge-panel design review: N angles → scored synthesis.'])
      return
    }
    const rawCmd = value.trim()
    setCmdOutput(null)
    void (async () => {
      try {
        chat.ensureStreamListeners() // the design card + patches ride conv:card — subscribe before it can fire
        let convId = activeConv
        if (!convId) {
          const conv = await window.api.conversations.create({ kind: 'single', primaryRoleId: expert.id, title: rawCmd.slice(0, 60), cwd: effectiveCwd || '' })
          convId = conv.id
          chat.adoptConversation(conv)
        }
        const line = await window.api.conversations.append(convId, { author: 'user', content: rawCmd })
        chat.insertUserLine(convId, { id: line.id, text: rawCmd })
        const res = await window.api.design.run({ convId, problem })
        if (!res.ok) toast.error(res.error)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    })()
    return undefined
  }
  const runDesignCommandRef = useRef(runDesignCommand)
  runDesignCommandRef.current = runDesignCommand

  // The root commands, rebuilt each render (cheap) — their run handlers read the latest closures via refs.
  const rootCommands: SlashCommand[] = [
    { name: 'workflow', desc: 'Run a saved workflow — list, or <name> [key=value …]', takesArg: true, run: (_c, arg) => runWorkflowCommandRef.current(arg) },
    { name: 'schedule', desc: 'Run a scheduled task now — list, or <id|name>', takesArg: true, run: (_c, arg) => runScheduleCommandRef.current(arg) },
    { name: 'research', desc: 'Deep web research → a cited report — <question>', takesArg: true, run: (_c, arg) => runResearchCommandRef.current(arg) },
    { name: 'design', desc: 'Judge-panel design review → scored synthesis — <problem>', takesArg: true, run: (_c, arg) => runDesignCommandRef.current(arg) }
  ]

  // Slash-command palette (optimization E): `/` at the start (no space yet) opens a quick-action menu.
  // Single-line `/…` input opens the palette; matchCommands does the precise filtering (so prose like
  // "/clear the cache" yields no match → closed), and multi-word commands like `/mode Ask` keep it open.
  const cmdQuery = paletteRelevant ? value : ''
  const cmdMatches = cmdQuery ? matchCommands(cmdQuery, rootCommands) : []
  const cmdOpen = cmdMatches.length > 0
  const runCommand = (cmd: SlashCommand): void => {
    // arg = whatever the user typed after the command name (e.g. "Ask" in "/mode Ask"); undefined if none.
    const arg = value.replace(/^\//, '').slice(cmd.name.length).trim() || undefined
    const outcome = cmd.run({
      newConversation: chat.newConversation,
      compact: () => {
        // Store action (not a bare IPC call): it owns the "Compacting…" readout, the receipt block and
        // the skip/fail toasts — the old fire-and-forget invoke gave the user zero feedback.
        if (activeConv) void chat.compactNow(activeConv)
      },
      setPlanMode: (on) => setMode(expert.id, on ? 'plan' : 'default'),
      setMode: (m) => setMode(expert.id, m),
      openMemoryCloud: () => useMemoryCloud.getState().show()
    }, arg)
    if (outcome === false) return // validation failed (workflow args) — input stays for in-place fixing
    setValue('')
    setCmdIndex(0)
    setTimeout(grow, 0)
  }

  // — @-mention expert picker (at-mention-expert-picker-design) — the GUI twin of the `/` palette above,
  //   scoped to COORDINATOR conversations: type `@` at the START of a message to reach one of the experts
  //   this conversation has been talking to. roleIsCoordinator is the ONLY gate that keeps solo chats 100%
  //   untouched — a solo expert.id is never 'coordinator', so mentionMatch stays null and the whole branch
  //   (palette, keydown interception, pick) never runs. The server already routes a leading @mention
  //   (route.ts matchMention); this is pure renderer discoverability — send/routing are unchanged.
  const mentionMatch = roleIsCoordinator(expert.id) && !value.includes('\n') ? /^@(\S*)$/.exec(value) : null
  const mentionRelevant = mentionMatch !== null
  const mentionQuery = mentionMatch ? mentionMatch[1] : ''
  const disabledSet = useMemo(() => new Set(rolesDisabled), [rolesDisabled])
  const deletedSet = useMemo(() => new Set(rolesDeleted), [rolesDeleted])
  // Roster = this conversation's participants; empty (a brand-new coordinator conv, nothing dispatched yet)
  // → fall back to the globally dispatchable enabled roles so the very first @ still offers candidates.
  const mentionRoster = useMemo(
    () => participantsOf(messages, expertById, { disabledIds: disabledSet, deletedIds: deletedSet }),
    [messages, expertById, disabledSet, deletedSet]
  )
  const mentionFallback = useMemo(
    () =>
      allExperts
        .filter((e) => !roleIsCoordinator(e.id) && roleHasAgent(e.id) && !disabledSet.has(e.id) && !deletedSet.has(e.id))
        .map((e) => ({ id: e.id, name: e.name, color: e.color })),
    [allExperts, disabledSet, deletedSet]
  )
  const mentionPool: MentionCandidate[] = mentionRoster.length ? mentionRoster : mentionFallback
  const mentionMatches = mentionRelevant
    ? mentionPool.filter((p) => p.name.toLowerCase().startsWith(mentionQuery.toLowerCase()))
    : []
  const mentionOpen = mentionMatches.length > 0
  const pickMention = (c: MentionCandidate): void => {
    // A disabled/undispatchable participant can't be routed to — the server drops it from the mention
    // roster (route.ts) and would SILENTLY reroute the turn to another expert. Don't fill a misleading
    // mention; tell the user to re-enable the role instead (the "淡列 → 选中给提示" behavior).
    if (c.disabled) {
      toast.error(t('conv.mentionUnavailable', { name: c.name }))
      return
    }
    const rest = value.replace(/^@\S*/, '').replace(/^\s+/, '') // drop the @prefix + any gap, keep the body
    const next = `@${c.name} ${rest}`
    setValue(next)
    setMentionIndex(0)
    setTimeout(() => {
      grow()
      const pos = c.name.length + 2 // @ + name + space → caret at the body start
      taRef.current?.setSelectionRange(pos, pos)
      taRef.current?.focus()
    }, 0)
  }

  return (
    <div className="input-dock">
      <div className="input-dock-inner">
        {noEndpoint ? (
          <div className="dock-banner">
            <Icons.plug size={15} style={{ color: 'var(--text-3)' }} />
            <span>{bindBannerMessage(t, expert.name, selectedEp, b, needAgentProto)}</span>
            <span className="db-arrow" onClick={onOpenSettings}>
              {t('conv.openSettings')} <Icons.arrowRight size={13} />
            </span>
          </div>
        ) : null}
        {/* Folder picker on every chat — the CONVERSATION's cwd. For dispatchable agent roles it's the
            working dir + restricted-read boundary; for Danny it rides coordinator.run as the dir every
            dispatched / collab expert operates in (and scopes his read-only direct kit). The git chip
            beside it shows the CC-style working ± + Commit/Push handoff button — only for roles whose
            kit can actually run git (Danny's read-only direct kit can't). */}
        <div className="cmp-path-row">
          <PathBar cwd={effectiveCwd} onPick={(dir) => setCwd(dir)} />
          {agent ? <GitStatusChip cwd={gitCwd} disabled={!ready || streaming || compacting} onAction={sendGitPreset} /> : null}
        </div>
        <div
          className={'composer2' + (ready ? '' : ' disabled') + (dragDepth > 0 ? ' dragging' : '')}
          onDragEnter={(e) => {
            if (hasFileDrag(e)) {
              e.preventDefault()
              setDragDepth((d) => d + 1)
            }
          }}
          onDragOver={(e) => {
            if (hasFileDrag(e)) e.preventDefault()
          }}
          onDragLeave={(e) => {
            if (hasFileDrag(e)) setDragDepth((d) => Math.max(0, d - 1))
          }}
          onDrop={onDrop}
        >
          <div className="cmp-toolbar">
            <ModelPicker models={b.models} value={b.model} onChange={b.onModel} disabled={!ready} />
            {roleHasImageGen(expert.id) ? (
              <ImageModelPicker models={b.imageModels} value={b.imageModel} onChange={b.onImageModel} disabled={!ready} />
            ) : null}
            <ThinkingPicker family={b.family} model={b.model} depth={effectiveDepth} onChange={b.onDepth} disabled={!ready} />
            {agent ? <ModePicker value={mode} onChange={(m) => setMode(expert.id, m)} disabled={!ready} /> : null}
            {b.contextLength > 0 ? (
              <span className={'cmp-tokens' + (tokenAmber ? ' amber' : '')}>
                {fmtTokens(usedTokens)} / {fmtTokens(b.contextLength)}
              </span>
            ) : null}
          </div>
          <AttachmentStrip items={attach} onRemove={(id) => setAttach((p) => p.filter((a) => a.id !== id))} />
          {cmdOutput ? (
            <div className="cmd-output">
              <button className="cmd-output-x" title={t('common.close')} onClick={() => setCmdOutput(null)}>
                <Icons.x size={12} />
              </button>
              {cmdOutput.map((line, i) => (
                <div className="cmd-output-line" key={i}>{line}</div>
              ))}
            </div>
          ) : null}
          {cmdOpen ? <CommandPalette matches={cmdMatches} index={cmdIndex} onPick={runCommand} /> : null}
          {mentionOpen ? <MentionPalette matches={mentionMatches} index={mentionIndex} onPick={pickMention} /> : null}
          <textarea
            ref={taRef}
            className="cmp-textarea"
            rows={1}
            value={value}
            placeholder={
              roleIsCoordinator(expert.id)
                ? t('conv.askCoordinatorPlaceholder', { name: expert.name })
                : t('conv.askPlaceholder', { name: expert.name })
            }
            onChange={(e) => {
              setValue(e.target.value)
              setCmdIndex(0)
              setMentionIndex(0)
              grow()
            }}
            onPaste={onPaste}
            onKeyDown={(e) => {
              const native = e.nativeEvent as KeyboardEvent
              // @-mention palette open: arrows navigate, Enter/Tab pick, Esc closes. Mutually exclusive with
              // the `/` palette (a message starts with `@` OR `/`, never both), so this sits beside cmdOpen
              // and the order is irrelevant. Only ever intercepts when mentionOpen — i.e. a coordinator
              // conversation with a leading `@…` that matches a participant; every other keystroke path is
              // byte-for-byte unchanged (solo chats never reach here — mentionOpen is always false there).
              if (mentionOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMentionIndex((i) => Math.min(i + 1, mentionMatches.length - 1))
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionIndex((i) => Math.max(i - 1, 0))
                  return
                }
                if ((e.key === 'Enter' || e.key === 'Tab') && !native.isComposing && native.keyCode !== 229) {
                  e.preventDefault()
                  pickMention(mentionMatches[mentionIndex])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setValue('')
                  return
                }
              }
              // Command palette open: arrows navigate, Enter/Tab run the selected command, Esc closes.
              if (cmdOpen) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setCmdIndex((i) => Math.min(i + 1, cmdMatches.length - 1))
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setCmdIndex((i) => Math.max(i - 1, 0))
                  return
                }
                // A command that carries a `complete` template fills it into the composer for inline editing;
                // Enter runs. No built-in command sets one today (the per-workflow expansion that used it was
                // replaced by the `/workflow` root — §4/D10), so Tab currently just runs like Enter. Kept
                // generic for any future template-bearing command.
                if (e.key === 'Tab' && !native.isComposing && cmdMatches[cmdIndex]?.complete) {
                  e.preventDefault()
                  const filled = cmdMatches[cmdIndex].complete
                  setValue(filled)
                  setCmdIndex(0)
                  setTimeout(() => {
                    grow()
                    taRef.current?.setSelectionRange(filled.length, filled.length) // caret to the end — React keeps the old (shorter) offset otherwise
                  }, 0)
                  return
                }
                if ((e.key === 'Enter' || e.key === 'Tab') && !native.isComposing) {
                  e.preventDefault()
                  runCommand(cmdMatches[cmdIndex])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setValue('')
                  return
                }
              }
              // Enter sends, Shift+Enter newlines; never submit mid-IME-composition (CJK candidate
              // selection) — nativeEvent.isComposing / keyCode 229 (older Firefox) flag it.
              if (e.key === 'Enter' && !e.shiftKey && !native.isComposing && native.keyCode !== 229) {
                e.preventDefault()
                send()
              }
            }}
            disabled={!ready}
          />
          <div className="cmp-bottom">
            <button className="icon-btn" title={t('conv.attachImage')} disabled={!ready} onClick={() => fileInputRef.current?.click()}>
              <Icons.paperclip size={16} />
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
            <div className="tb-spacer" />
            {streaming ? (
              <button className="cmp-stop" onClick={() => chat.stop()}>
                <span className="stop-sq" /> {t('conv.stop')}
              </button>
            ) : compacting ? (
              // Manual /compact in flight — the send slot becomes Stop (aborts the fold; nothing written).
              <button className="cmp-stop" onClick={() => activeConv && chat.cancelCompact(activeConv)}>
                <span className="stop-sq" /> {t('conv.stop')}
              </button>
            ) : (
              <button className="cmp-send" disabled={(!value.trim() && attach.length === 0) || !ready} onClick={send}>
                {t('conv.send')} <Icons.arrowUp size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
