// studio_guide — read one section of the built-in Studio product manual (studio-guide-product-manual).
// The anti-hallucination pair of the STUDIO_GUIDE_INDEX prompt section: the index tells every agent to
// check the guide before answering product questions; this tool is the check. Read-only app asset →
// auto-allowed, usable in plan mode. Every agent role + coordinator-direct carries it (agent-tools.ts);
// sub-agents have it stripped in loop.ts like the other conversation-level standing tools.

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import { STUDIO_GUIDE_TOPICS, loadGuideSection } from '../../services/studio-guide'

const schema = z.object({
  topic: z.enum(STUDIO_GUIDE_TOPICS).describe('the manual section to read (see the "# Studio product guide" directory in your system prompt)'),
})

export const studioGuideTool = buildTool({
  name: 'studio_guide',
  inputSchema: schema,
  prompt: () =>
    'Read one section of the built-in Studio product manual (English; user-visible features with concrete ' +
    'how-to steps). Call it BEFORE answering any question about Studio itself — what Studio can do, how a ' +
    "feature works, where a control lives — then answer from what it returns, in the user's language. " +
    "If the section doesn't cover the question, say you don't know; never invent Studio features or UI.",
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  call: async (input) => {
    const text = loadGuideSection(input.topic)
    if (!text) return { data: { error: `Guide section "${input.topic}" is unavailable in this build — tell the user you can't verify this right now instead of guessing.` } }
    return { data: { text } }
  },
  mapResult: (out: { text?: string; error?: string }, toolUseId): ToolResultBlock => {
    if (out.error) return { type: 'tool_result', tool_use_id: toolUseId, content: out.error, is_error: true }
    return { type: 'tool_result', tool_use_id: toolUseId, content: out.text ?? '' }
  },
})
