/* ============================================================
   NicoSoft AI Studio — right workspace drawer (real, per active conversation)
   Files (what the agent produced) · Recent images (generated) · Tasks (the
   agent's TodoWrite list). All derived from the active conversation's
   transcript + messages — no mock. Re-derives as the conversation grows.
   ============================================================ */
import { useEffect, useState, type ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { ImageViewer, type ViewerImage } from '@/components/image-viewer'
import { useChat, type ToolCall } from '@/stores/chat'
import { useWorkspace } from '@/stores/workspace'
import { toast } from '@/stores/toast'

const basename = (p: string): string => p.split(/[\\/]/).pop() || p
// Tools that CREATE/CHANGE a file on disk — only these count as "produced" (Read is excluded by design).
const PRODUCE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'WritePdf'])
// What the agent is doing RIGHT NOW, from the in-flight tool. input is {} at tool-start (the renderer gets
// only id+name live — the full args land in the DB transcript after the tool finishes), so this leans on the
// tool NAME; a file_path/pattern fills in when present. Keeps the read phase from looking idle.
function activityLabel(t: ToolCall): string {
  const p = (t.input ?? null) as { file_path?: string; pattern?: string; description?: string } | null
  const file = p?.file_path ? ` ${basename(p.file_path)}` : ''
  switch (t.name) {
    case 'Read': return `Reading${file}`
    case 'Write': return `Writing${file}`
    case 'Edit':
    case 'MultiEdit': return `Editing${file}`
    case 'Bash': return p?.description || 'Running command'
    case 'Grep': return p?.pattern ? `Searching: ${p.pattern}` : 'Searching'
    case 'Glob': return 'Finding files'
    case 'TodoWrite': return 'Updating tasks'
    case 'WebFetch': return 'Fetching page'
    case 'WebSearch': return 'Searching the web'
    case 'Task': return p?.description ? `Sub-agent: ${p.description}` : 'Running sub-agent'
    default: return t.name
  }
}
// Agent TodoWrite statuses → the existing .task-status pill class + a readable label.
const TASK: Record<string, { cls: string; label: string }> = {
  pending: { cls: 'todo', label: 'To do' },
  in_progress: { cls: 'doing', label: 'In progress' },
  completed: { cls: 'done', label: 'Done' }
}

interface WsFile {
  path: string
  name: string
  op: string
}
interface WsTask {
  content: string
  status: string
}

export function WorkspaceDrawer({ onClose, activeConv }: { onClose: () => void; activeConv: string | null }): ReactElement {
  const [files, setFiles] = useState<WsFile[]>([])
  const [images, setImages] = useState<ViewerImage[]>([])
  const [tasks, setTasks] = useState<WsTask[]>([])
  const [viewer, setViewer] = useState<number | null>(null)
  const [tick, setTick] = useState(0) // streaming-time re-derive trigger (TodoWrite tool calls don't bump msgCount)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}) // per-section fold state
  // Re-derive when the conversation grows or a run ends (new files/images/tasks land).
  const msgCount = useChat((s) => (activeConv ? (s.byConversation[activeConv]?.length ?? 0) : 0))
  const streaming = useChat((s) => (activeConv ? !!s.streaming[activeConv] : false))
  const conv = useChat((s) => s.conversations.find((c) => c.id === activeConv))
  const cwd = useWorkspace((s) => (conv?.primaryRoleId ? s.cwdByExpert[conv.primaryRoleId] : undefined))
  // Current activity for the Workspace, shown the whole time a run streams so the read phase is never blank:
  // the in-flight tool ("Reading", "Running command") when one is executing, else "Thinking" while the model
  // generates between tool calls (which is most of the wall-clock — a tool fires for <1s, the reply takes
  // seconds). Drawn from the LIVE message tree (chat store), not the DB transcript (which only lands after a
  // tool finishes). Returns a stable string so the selector doesn't churn renders; null only when idle.
  const activity = useChat((s) => {
    if (!activeConv || !s.streaming[activeConv]) return null
    const msgs = s.byConversation[activeConv] ?? []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const tools = msgs[i].tools
      if (tools) for (let j = tools.length - 1; j >= 0; j--) if (tools[j].status === 'running') return activityLabel(tools[j])
    }
    return 'Thinking'
  })

  // media.save opens a native save dialog: a truthy path = saved, a falsy value = the user cancelled
  // (stay silent), a thrown error = a real failure.
  const saveImage = (img: ViewerImage): void => {
    void window.api.media
      .save(img.url, img.name)
      .then((path) => { if (path) toast.success('Image saved') })
      .catch(() => toast.error('Couldn’t save image'))
  }

  // TodoWrite updates are tool calls (no new message), so msgCount stays put while a run streams. Poll a
  // re-derive tick during streaming so Tasks track live progress instead of freezing at the last snapshot.
  useEffect(() => {
    if (!streaming) return
    const id = setInterval(() => setTick((t) => t + 1), 1200)
    return () => clearInterval(id)
  }, [streaming])

  useEffect(() => {
    if (!activeConv) {
      setFiles([])
      setImages([])
      setTasks([])
      return
    }
    let cancelled = false
    void (async () => {
      const [transcript, msgs] = await Promise.all([
        window.api.agent.transcript(activeConv),
        window.api.conversations.messages(activeConv)
      ])
      if (cancelled) return
      const fileMap = new Map<string, WsFile>()
      let latestTodos: WsTask[] | null = null
      for (const run of Object.values(transcript)) {
        for (const t of run.tools) {
          if (PRODUCE_TOOLS.has(t.name)) {
            const p = (t.input as { file_path?: string } | null)?.file_path
            if (typeof p === 'string' && p) fileMap.set(p, { path: p, name: basename(p), op: t.name })
          } else if (t.name === 'TodoWrite') {
            const todos = (t.input as { todos?: WsTask[] } | null)?.todos
            if (Array.isArray(todos)) latestTodos = todos
          }
        }
      }
      setFiles([...fileMap.values()])
      setTasks(latestTodos ?? [])
      setImages(
        msgs
          .filter((m) => m.author !== 'user')
          .flatMap((m) => m.attachments ?? [])
          .filter((a) => (a.kind ?? 'image') === 'image' && typeof a.url === 'string')
          .map((a) => ({ url: a.url, name: a.name ?? 'image' }))
      )
    })()
    return () => {
      cancelled = true
    }
  }, [activeConv, msgCount, streaming, tick])

  return (
    <div className="workspace-drawer">
      <div className="ws-header">
        <span className="ws-title">Workspace</span>
        <button className="icon-btn" title="Collapse" onClick={onClose} style={{ marginLeft: 'auto' }}>
          <Icons.panelRight size={16} />
        </button>
      </div>
      <div className="ws-scroll">
        {activity ? (
          <div className="ws-activity">
            <span className="ws-activity-dot" />
            <span className="ws-activity-text">{activity}…</span>
          </div>
        ) : null}
        <div className="ws-section">
          <button className="ws-section-head" onClick={() => setCollapsed((c) => ({ ...c, files: !c.files }))}>
            <span className={'ws-chev' + (collapsed.files ? ' collapsed' : '')}><Icons.chevronDown size={11} /></span>
            Files{files.length > 0 ? ` · ${files.length}` : ''}
          </button>
          {collapsed.files ? null : files.length === 0 ? (
            <div className="ws-empty">No files created in this chat yet.</div>
          ) : (
            <div className="ws-files">
              {files.map((f) => (
                <div className="ws-file" key={f.path} title={`${f.path} — click to reveal`} role="button" onClick={() => void window.api.revealFile(f.path, cwd)}>
                  <span className="wf-ic">
                    <Icons.file size={15} />
                  </span>
                  <span className="wf-name">{f.name}</span>
                  <span className="wf-size">{f.op.toLowerCase()}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="ws-section">
          <button className="ws-section-head" onClick={() => setCollapsed((c) => ({ ...c, images: !c.images }))}>
            <span className={'ws-chev' + (collapsed.images ? ' collapsed' : '')}><Icons.chevronDown size={11} /></span>
            Recent images{images.length > 0 ? ` · ${images.length}` : ''}
          </button>
          {collapsed.images ? null : images.length === 0 ? (
            <div className="ws-empty">No images generated yet.</div>
          ) : (
            <div className="ws-images">
              {images.map((img, i) => (
                <img key={img.url + i} className="ws-thumb" style={{ objectFit: 'cover' }} src={img.url} alt={img.name} onClick={() => setViewer(i)} />
              ))}
            </div>
          )}
        </div>

        <div className="ws-section">
          <button className="ws-section-head" onClick={() => setCollapsed((c) => ({ ...c, tasks: !c.tasks }))}>
            <span className={'ws-chev' + (collapsed.tasks ? ' collapsed' : '')}><Icons.chevronDown size={11} /></span>
            Tasks{tasks.length > 0 ? ` · ${tasks.length}` : ''}
          </button>
          {collapsed.tasks ? null : tasks.length === 0 ? (
            <div className="ws-empty">No task list for this chat.</div>
          ) : (
            <div className="ws-tasks">
              {tasks.map((t, i) => {
                const meta = TASK[t.status] ?? TASK.pending
                return (
                  <div className="ws-task" key={i}>
                    <span className={'ws-task-label' + (meta.cls === 'done' ? ' done' : '')}>{t.content}</span>
                    <span className={'task-status ' + meta.cls}>{meta.label}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {viewer !== null && images[viewer] && (
        <ImageViewer
          items={images}
          index={viewer}
          onClose={() => setViewer(null)}
          onStep={(d) => setViewer((v) => (v === null ? null : Math.max(0, Math.min(images.length - 1, v + d))))}
          onDownload={saveImage}
        />
      )}
    </div>
  )
}
