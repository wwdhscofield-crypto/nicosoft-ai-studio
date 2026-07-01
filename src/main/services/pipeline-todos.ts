// Pipeline-shared todos, keyed by convId: a coordinator turn's dispatched experts (Flynn → Shuri → …) all
// read + write this ONE list, so the team's TodoWrite progress is continuous instead of each expert keeping a
// private list that strands the others' tasks (Shuri's run inherits Flynn's items + updates the SAME ones).
//
// Lives in its own leaf module (not coordinator-step) so conversation.service can reset it on conv-delete
// WITHOUT a coordinator-step ↔ conversation.service import cycle (coordinator-step already imports
// conversation.service). Reset at the start of each coordinator run (a new turn = a new pipeline) AND on
// conv delete (else a deleted conv's list leaks in this Map forever).

import type { AgentContext } from '../agent/context'

const pipelineTodos = new Map<string, AgentContext['todos']>()

export function getPipelineTodos(convId: string): AgentContext['todos'] | undefined {
  return pipelineTodos.get(convId)
}

export function setPipelineTodos(convId: string, todos: AgentContext['todos']): void {
  pipelineTodos.set(convId, todos)
}

export function resetPipelineTodos(convId: string): void {
  pipelineTodos.delete(convId)
}
