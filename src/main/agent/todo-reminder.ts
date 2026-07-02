// CC-verbatim periodic todo reminder (2.1.186, the `todo_reminder` attachment): when the model hasn't
// called TodoWrite for TURNS_SINCE_WRITE assistant turns AND no reminder was injected in the last
// TURNS_BETWEEN_REMINDERS turns, append the reminder text (+ the current list when non-empty) onto the
// turn's trailing user message. The backward transcript scan is the whole state machine — after an
// autocompact folds the TodoWrite history into the summary, the counts spike past the threshold and the
// list returns within the cooldown naturally (the summary's "Pending Tasks" section covers the gap),
// which is exactly CC's post-compaction behavior. Pure functions so the e2e suite pins them.

import { isContentBlock, type AgentMessage } from './types'

// CC `T5t` verbatim.
export const TODO_REMINDER_TURNS = { SINCE_WRITE: 10, BETWEEN_REMINDERS: 10 } as const

// CC reminder copy, byte-verbatim — including the original's "if has become stale" phrasing.
export const TODO_REMINDER_TEXT =
  "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.\n"

export interface TodoItem {
  content: string
  status: string
}

// CC `gzp` verbatim semantics: walk the transcript backwards; count assistant turns since the last
// TodoWrite tool_use and since the last injected reminder (identified by the verbatim copy prefix —
// Studio has no attachment layer, the text IS the marker).
export function todoReminderCounts(messages: readonly AgentMessage[]): { sinceWrite: number; sinceReminder: number } {
  let writeIdx = -1
  let reminderIdx = -1
  let sinceWrite = 0
  let sinceReminder = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant') {
      if (
        writeIdx === -1 &&
        Array.isArray(m.content) &&
        m.content.some((b) => isContentBlock(b) && b.type === 'tool_use' && (b as { name?: string }).name === 'TodoWrite')
      ) {
        writeIdx = i
      }
      if (writeIdx === -1) sinceWrite++
      if (reminderIdx === -1) sinceReminder++
    } else if (
      reminderIdx === -1 &&
      m.role === 'user' &&
      Array.isArray(m.content) &&
      m.content.some((b) => isContentBlock(b) && b.type === 'text' && (b as { text?: string }).text?.startsWith("The TodoWrite tool hasn't been used recently"))
    ) {
      reminderIdx = i
    }
    if (writeIdx !== -1 && reminderIdx !== -1) break
  }
  return { sinceWrite, sinceReminder }
}

// CC render arm verbatim: numbered `${i+1}. [${status}] ${content}` lines, the whole list wrapped in
// square brackets; an empty list sends the bare nudge with no list section.
export function renderTodoReminder(todos: readonly TodoItem[]): string {
  const lines = todos.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join('\n')
  let text = TODO_REMINDER_TEXT
  if (lines.length > 0) text += `\n\nHere are the existing contents of your todo list:\n\n[${lines}]`
  return text
}

// The per-turn decision (CC `_zp` semantics; kit gating — CC skips when TodoWrite isn't in the kit —
// is the caller's check). Returns the reminder text to append, or null.
export function maybeTodoReminder(messages: readonly AgentMessage[], todos: readonly TodoItem[] | undefined): string | null {
  const { sinceWrite, sinceReminder } = todoReminderCounts(messages)
  if (sinceWrite < TODO_REMINDER_TURNS.SINCE_WRITE || sinceReminder < TODO_REMINDER_TURNS.BETWEEN_REMINDERS) return null
  return renderTodoReminder(todos ?? [])
}
