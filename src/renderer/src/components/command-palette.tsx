/* ============================================================
   NicoSoft AI Studio — composer slash commands (optimization E)
   The GUI equivalent of CLI slash commands: type `/` in the composer to get a small palette of built-in
   quick actions. Kept GUI-relevant + small (most CLI commands already have toolbar buttons here). The
   registry is typed so adding a command is one entry; future work can append skill-triggered commands.
   ============================================================ */
import type { ReactElement } from 'react'
import { MODE_OPTIONS, type AgentMode } from '@/lib/agent-mode'

export interface CommandContext {
  newConversation: () => void
  compact: () => void
  setPlanMode: (on: boolean) => void
  setMode: (mode: AgentMode) => void
}

export interface SlashCommand {
  name: string
  desc: string
  takesArg?: boolean // when true, the palette stays open as the user types an argument (e.g. `/mode Ask`)
  run: (ctx: CommandContext, arg?: string) => void
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'clear', desc: 'Start a new conversation', run: (c) => c.newConversation() },
  { name: 'new', desc: 'New conversation', run: (c) => c.newConversation() },
  { name: 'compact', desc: 'Summarize older history now to free up context', run: (c) => c.compact() },
  { name: 'plan', desc: 'Plan mode — investigate read-only, then propose a plan', run: (c) => c.setPlanMode(true) },
  { name: 'default', desc: 'Switch back to default (acting) mode', run: (c) => c.setPlanMode(false) },
  // `/mode <Ask|Plan|Auto>` — a single entry; the user types the mode as an argument. Parsed against
  // MODE_OPTIONS labels (case-insensitive) so it stays in sync as modes change.
  {
    name: 'mode',
    desc: 'Switch mode — type ' + MODE_OPTIONS.map((o) => o.label).join(', '),
    takesArg: true,
    run: (c, arg) => {
      const m = MODE_OPTIONS.find((o) => o.label.toLowerCase() === (arg ?? '').trim().toLowerCase())
      if (m) c.setMode(m.value)
    }
  }
]

// Match the typed query (with or without a leading slash) against command names by prefix (case-insensitive,
// so `/mode a` matches `mode Ask`/`mode Auto`).
export function matchCommands(query: string): SlashCommand[] {
  const q = query.replace(/^\//, '').toLowerCase()
  return SLASH_COMMANDS.filter((cmd) => {
    const n = cmd.name.toLowerCase()
    // normal name-prefix match; arg-taking commands also stay matched once the user types an argument
    // (`/mode Ask`) — non-arg commands do NOT, so prose like "/clear the cache" is not treated as a command.
    return n.startsWith(q) || (cmd.takesArg === true && q.startsWith(n + ' '))
  })
}

export function CommandPalette({
  matches,
  index,
  onPick
}: {
  matches: SlashCommand[]
  index: number
  onPick: (cmd: SlashCommand) => void
}): ReactElement | null {
  if (!matches.length) return null
  return (
    <div className="cmd-palette" role="listbox">
      {matches.map((cmd, i) => (
        <div
          key={cmd.name}
          role="option"
          aria-selected={i === index}
          className={'cmd-item' + (i === index ? ' active' : '')}
          // onMouseDown + preventDefault (not onClick) so the textarea keeps focus through the pick.
          onMouseDown={(e) => {
            e.preventDefault()
            onPick(cmd)
          }}
        >
          <span className="cmd-name">/{cmd.name}</span>
          <span className="cmd-desc">{cmd.desc}</span>
        </div>
      ))}
    </div>
  )
}
