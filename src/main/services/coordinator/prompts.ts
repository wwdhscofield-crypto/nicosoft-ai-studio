// Synthesis / hand-off / panel prompt builders for the coordinator's multi-expert modes — stateless pure
// functions over (question, prior outputs). The personas these pair with live in agent/roles/prompts.ts;
// these build the per-turn USER message content.

import { displayName } from '../../agent/roles/prompts'

// Pipeline step N+1 hand-off: the next role sees the user's original request + every prior step's
// output + a one-line directive. Without this, the next role sees just the previous output and may
// (correctly) ask "what are you trying to do?" because the prompt looks like an answer, not a task.
export function buildHandoffPrompt(originalQuery: string, priorSteps: { role: string; text: string }[], nextRoleId: string): string {
  const sections = [`Original user request:\n${originalQuery}`, '', 'Prior pipeline steps:']
  for (const s of priorSteps) sections.push('', `## ${displayName(s.role)}`, s.text)
  sections.push('', `Now continue the user's task as ${displayName(nextRoleId)}. Build on the prior step's output — don't repeat what's already been said, and don't ask the user to restate the question.`)
  return sections.join('\n')
}

export function buildSynthesisInput(originalQuery: string, outputs: { role: string; text: string }[]): string {
  const sections = [`Original user message:\n${originalQuery}`, '', 'Expert outputs in order:']
  for (const o of outputs) sections.push('', `## ${displayName(o.role)}`, o.text)
  sections.push('', 'Now produce ONE coherent reply for the user. Follow the synthesis rules in your system prompt.')
  return sections.join('\n')
}

// Each parallel-panel expert gets the question + a nudge that they're one independent voice. Without it,
// role personas like Engineer's "dispatch mode" wording make them try to route or defer instead of answering
// (observed in e2e: Engineer replied "Routing this…" rather than giving its take).
export function buildPanelPrompt(question: string, roleId: string): string {
  return `${question}\n\n---\nYou are one of several experts answering this independently. Give YOUR own substantive take from your specialty as ${displayName(roleId)} — don't route it, don't defer to other experts, don't ask who should handle it. Coordinator compares everyone's answers afterward.`
}

export function buildParallelSynthesisInput(originalQuery: string, outputs: { role: string; text: string }[], reviewNote?: string): string {
  const sections = [`Original user question:\n${originalQuery}`, '', 'Each expert answered INDEPENDENTLY (a panel, not a pipeline):']
  for (const o of outputs) sections.push('', `## ${displayName(o.role)}`, o.text)
  // Collaborate closeout: an independent reviewer verified the combined build (Gate-B doesn't run in collaborate,
  // so this is the one verification gate). Surface its verdict so the synthesis CLOSES on the real state — never
  // round an unverified or FAILED result up to "done"; if it failed, say so plainly and what remains.
  if (reviewNote) sections.push('', '## Independent verification (factor this into your closeout — do NOT present failed/unverified work as done)', reviewNote)
  sections.push('', 'Now synthesize the panel for the user. Follow the rules in your system prompt — lead with your recommendation, surface agreement vs divergence, attribute distinct points.')
  return sections.join('\n')
}

// B2 council round 2+: each expert sees everyone's prior-round positions and critiques/refines.
export function buildCritiquePrompt(question: string, positions: { role: string; text: string }[], roleId: string): string {
  const sections = [`Original question:\n${question}`, '', `The experts' positions so far (including yours):`]
  for (const p of positions) sections.push('', `## ${displayName(p.role)}${p.role === roleId ? ' (you)' : ''}`, p.text)
  sections.push('', `You are ${displayName(roleId)}. Critique and refine. Where another expert is wrong or missed something, say so directly and explain why. Where they convinced you, concede and update. Then restate YOUR position — sharper, accounting for the others. Don't agree just to agree; don't dig in out of stubbornness. Be substantive and concise, and don't label your answer with a round number.`)
  return sections.join('\n')
}

export function buildFacilitateInput(question: string, positions: { role: string; text: string }[], panel: string[], available: string[]): string {
  const sections = [
    `Question:\n${question}`,
    '',
    `Current panel: ${panel.map(displayName).join(', ')}`,
    `Available to add: ${available.length ? available.map(displayName).join(', ') : '(none)'}`,
    '',
    'Current expert positions:'
  ]
  for (const p of positions) sections.push('', `## ${displayName(p.role)}`, p.text)
  sections.push('', 'What is the next move? Respond with ONLY the JSON object.')
  return sections.join('\n')
}

export function buildCouncilSynthesisInput(question: string, positions: { role: string; text: string }[]): string {
  const sections = [`Original question:\n${question}`, '', 'Final expert positions after the debate:']
  for (const p of positions) sections.push('', `## ${displayName(p.role)}`, p.text)
  sections.push('', 'Now write the final verdict for the user. Follow the rules in your system prompt — lead with the resolved answer, explain how disagreement resolved, attribute decisive moves.')
  return sections.join('\n')
}
