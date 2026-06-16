// AskUserQuestion tool — pause and ask the user to clarify intent before acting. Use when the request is
// ambiguous, several approaches are valid, or a choice is genuinely the user's to make (not one the agent
// can settle from context). Pairs with the plan-first doctrine: ask in the planning phase, don't guess.
//
// Schema tolerance (audit F7): models commonly send the `questions[]` shape with OBJECT
// options ({label, description, preview}); the original Studio shape was a single flat question with bare
// string options, so such a call was hard-rejected. We accept BOTH and normalize to Studio's
// single-select UI (ctx.askUser takes string options). multiSelect / preview are tolerated but not
// enforced (Studio's picker is single-select); a description is folded into the option label so it still
// shows. Multiple questions are asked sequentially.

import { z } from 'zod'
import { semanticBoolean } from './semantic'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'

// An option is a bare label (legacy) OR the object form {label, description?, preview?}.
const optionSchema = z.union([
  z.string(),
  z.object({ label: z.string(), description: z.string().optional(), preview: z.string().optional() }),
])
const questionSchema = z.object({
  question: z.string().describe('The question to ask the user'),
  header: z.string().max(12).optional().describe('A very short label for the question (max 12 chars)'),
  multiSelect: semanticBoolean(z.boolean().optional()).describe('Tolerated — Studio asks single-select; the flag is accepted, not enforced'),
  options: z.array(optionSchema).min(2).max(4).describe('2-4 distinct, mutually-exclusive options (a string, or {label, description})'),
})
// Accept the `questions[]` shape AND a single flat question (legacy), so neither is rejected.
const inputSchema = z.object({
  questions: z.array(questionSchema).min(1).max(4).optional().describe('One or more questions to ask (structured shape)'),
  question: z.string().optional().describe('A single question — shorthand for questions:[{question, options}]'),
  header: z.string().max(12).optional().describe('Header for the single-question shorthand'),
  options: z.array(optionSchema).min(2).max(4).optional().describe('Options for the single-question shorthand'),
})

type Opt = z.infer<typeof optionSchema>
function optLabel(o: Opt): string {
  if (typeof o === 'string') return o
  return o.description ? `${o.label} — ${o.description}` : o.label
}

export const askUserQuestionTool = buildTool<typeof inputSchema, string>({
  name: 'AskUserQuestion',
  inputSchema,
  prompt: () =>
    'Ask the user a multiple-choice question to clarify intent BEFORE acting. Use it when the request is ' +
    'ambiguous, there are several valid approaches, or the choice is genuinely the user\'s to make (not ' +
    'one you can settle from the code or context). Give 2-4 distinct options; the user can also answer ' +
    'freeform. Do NOT use it for things you can decide yourself. In plan mode, ask here to settle ' +
    'requirements — but do NOT ask "is the plan good / should I proceed" and do NOT reference "the plan" ' +
    '(the user cannot see it yet); use ExitPlanMode for plan approval.',
  isReadOnly: () => true, // asking mutates nothing
  isConcurrencySafe: () => false, // one question at a time — it blocks on the user
  async call(input, ctx) {
    if (!ctx.askUser) throw new Error('Asking the user is not available in this context (no interactive user).')
    // Normalize the `questions[]` shape and the legacy single-question shape into one list.
    const questions = input.questions?.length
      ? input.questions
      : input.question && input.options
        ? [{ question: input.question, header: input.header, options: input.options }]
        : []
    if (!questions.length) throw new Error('AskUserQuestion needs `questions` (or a single `question` + `options`).')
    const answers: string[] = []
    for (const q of questions) {
      const answer = await ctx.askUser({ question: q.question, header: q.header, options: q.options.map(optLabel) }, ctx.signal)
      answers.push(questions.length > 1 ? `${q.header ?? q.question}: ${answer}` : answer)
    }
    return { data: answers.join('\n') }
  },
  mapResult(out, toolUseId): ToolResultBlock {
    return { type: 'tool_result', tool_use_id: toolUseId, content: `The user answered:\n${out}` }
  },
})
