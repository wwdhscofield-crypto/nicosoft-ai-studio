// QuestionDialog — the agent paused to ask the user a multiple-choice question (AskUserQuestion). A
// centered floating card: an optional header chip, the question, 2-4 option buttons, and an "Other"
// free-text input. Picking an option (or submitting Other) answers it. Keyboard: 1-4 pick an option.
// Styles in styles/agent.css alongside ApprovalDialog.

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import type { QuestionPrompt } from '@/stores/chat'
import { useAllExperts } from '@/lib/all-experts'
import { useT } from '@/stores/locale'

export function QuestionDialog({
  prompt,
  onAnswer
}: {
  prompt: QuestionPrompt
  onAnswer: (answer: string) => void
}): ReactElement {
  const t = useT()
  const { byId } = useAllExperts() // custom agents ask questions too — show their name, not "the agent"
  const [other, setOther] = useState('')
  const name = (prompt.roleId && byId[prompt.roleId]?.name) || t('q.theAgent')
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Ignore the keypress while the IME is composing — pressing 1/2 to pick a Chinese/Japanese candidate must NOT
      // select an option (isComposing / keyCode 229 flag it, the same guard the composer uses). Also ignore keys
      // typed INTO an input/textarea (a digit in the Other field is text being typed, not an option hotkey).
      if (e.isComposing || e.keyCode === 229) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const n = parseInt(e.key, 10)
      if (n >= 1 && n <= prompt.options.length) {
        e.preventDefault()
        onAnswer(prompt.options[n - 1])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [prompt, onAnswer])
  return (
    <div className="approval-overlay">
      <div className="approval-card">
        <div className="q-head">
          {prompt.header ? <span className="q-tag">{prompt.header}</span> : null}
          <span className="ap-title">{t('q.isAsking', { name })}</span>
        </div>
        <div className="q-question">{prompt.question}</div>
        <div className="q-options">
          {prompt.options.map((opt, i) => (
            <button key={i} className="q-option" onClick={() => onAnswer(opt)} type="button">
              <span className="q-num">{i + 1}</span>
              <span className="q-opt-text">{opt}</span>
            </button>
          ))}
        </div>
        <input
          className="q-other"
          placeholder={t('q.otherPlaceholder')}
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => {
            // Don't submit on the Enter that CONFIRMS an IME composition (Chinese/Japanese) — only a real Enter.
            // nativeEvent.isComposing / keyCode 229 flag the IME confirm, the same guard as the composer.
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229 && other.trim()) {
              e.preventDefault()
              onAnswer(other.trim())
            }
          }}
        />
      </div>
    </div>
  )
}
