/* ============================================================
   NicoSoft AI Studio — right workspace drawer (real, per active conversation)
   Files (what the agent produced) · Recent images (generated) · Tasks (the
   agent's TodoWrite list). All derived from the active conversation's
   transcript + messages — no mock. Re-derives as the conversation grows.
   ============================================================ */
import { useEffect, useState, type ReactElement } from 'react'
import { Icons } from '@/components/icons'
import { ImageViewer, type ViewerImage } from '@/components/image-viewer'
import { useChat } from '@/stores/chat'
import { useWorkspace } from '@/stores/workspace'
import { toast } from '@/stores/toast'

const basename = (p: string): string => p.split(/[\\/]/).pop() || p
// Tools that CREATE/CHANGE a file on disk — only these count as "produced" (Read is excluded by design).
const PRODUCE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'WritePdf'])
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
  // Re-derive when the conversation grows or a run ends (new files/images/tasks land).
  const msgCount = useChat((s) => (activeConv ? (s.byConversation[activeConv]?.length ?? 0) : 0))
  const streaming = useChat((s) => (activeConv ? !!s.streaming[activeConv] : false))
  const conv = useChat((s) => s.conversations.find((c) => c.id === activeConv))
  const cwd = useWorkspace((s) => (conv?.primaryRoleId ? s.cwdByExpert[conv.primaryRoleId] : undefined))

  // media.save opens a native save dialog: a truthy path = saved, a falsy value = the user cancelled
  // (stay silent), a thrown error = a real failure.
  const saveImage = (img: ViewerImage): void => {
    void window.api.media
      .save(img.url, img.name)
      .then((path) => { if (path) toast.success('Image saved') })
      .catch(() => toast.error('Couldn’t save image'))
  }

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
  }, [activeConv, msgCount, streaming])

  return (
    <div className="workspace-drawer">
      <div className="ws-header">
        <span className="ws-title">Workspace</span>
        <button className="icon-btn" title="Collapse" onClick={onClose} style={{ marginLeft: 'auto' }}>
          <Icons.panelRight size={16} />
        </button>
      </div>
      <div className="ws-scroll">
        <div className="ws-section">
          <div className="ws-section-head">Files</div>
          {files.length === 0 ? (
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
          <div className="ws-section-head">Recent images</div>
          {images.length === 0 ? (
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
          <div className="ws-section-head">Tasks</div>
          {tasks.length === 0 ? (
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
