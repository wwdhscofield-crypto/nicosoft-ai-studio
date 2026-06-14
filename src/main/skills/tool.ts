// The single `Skill` tool a role's agent gets (inline mode only). The model picks a
// skill by name — from the "Available skills" listing in the system prompt — and this resolves the
// skill's instruction body and returns it as the tool result for the model to follow. Forked
// sub-agents, !cmd execution and allowed-tools switching (extras) are intentionally not in v1.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { buildTool, type Tool } from '../agent/tool'
import type { ToolResultBlock } from '../agent/types'
import { parseFrontmatter } from './frontmatter'
import { SKILL_FILE, type LoadedSkill } from './types'

const SKILL_TOOL_NAME = 'Skill'

interface SkillCallResult {
  error: boolean
  text: string
}

// Build the Skill tool bound to one role's in-scope skills (name → skill). The map is captured in the
// closure so the same tool resolves whatever the model names.
export function buildSkillTool(skills: ReadonlyMap<string, LoadedSkill>): Tool {
  return buildTool({
    name: SKILL_TOOL_NAME,
    inputSchema: z.object({ skill: z.string(), args: z.string().optional() }),
    prompt: () => SKILL_TOOL_PROMPT,
    isReadOnly: () => true, // loading a skill body is read-only; the model acts on the instructions after
    isConcurrencySafe: () => true,
    async call(input: { skill: string; args?: string }): Promise<{ data: SkillCallResult }> {
      const name = input.skill.replace(/^\//, '').trim()
      const args = input.args ?? ''
      const skill = skills.get(name)
      if (!skill) {
        const avail = [...skills.keys()].join(', ') || '(none)'
        return { data: { error: true, text: `Unknown skill "${name}". Available skills: ${avail}` } }
      }
      return { data: { error: false, text: expand(resolveBody(skill), skill, args) } }
    },
    mapResult(out: SkillCallResult, toolUseId): ToolResultBlock {
      return { type: 'tool_result', tool_use_id: toolUseId, content: out.text, ...(out.error ? { is_error: true } : {}) }
    }
  }) as unknown as Tool
}

// Imported skills re-read SKILL.md at call time (picks up edits + keeps ${SKILL_DIR} refs valid);
// builtin skills carry their body inline. Falls back to any cached body if the file read fails.
function resolveBody(skill: LoadedSkill): string {
  if (skill.dirPath) {
    try {
      return parseFrontmatter(readFileSync(join(skill.dirPath, SKILL_FILE), 'utf-8')).body
    } catch {
      return skill.body ?? ''
    }
  }
  return skill.body ?? ''
}

function expand(body: string, skill: LoadedSkill, args: string): string {
  let out = skill.dirPath ? body.replace(/\$\{SKILL_DIR\}/g, skill.dirPath) : body
  if (/\$ARGUMENTS\b/.test(out)) out = out.replace(/\$ARGUMENTS\b/g, args)
  else if (args) out += `\n\nArguments: ${args}`
  return out
}

const SKILL_TOOL_PROMPT = `Execute a skill within the conversation.

Skills are specialized, pre-written instructions for specific tasks. The skills available to you are
listed in your system prompt under "Available skills" (each with a name and when to use it). When the
user's request matches one, call this tool with that skill's name to load its full instructions, then
follow them.

How to invoke:
- skill: the skill name from the listing (e.g. "code-review")
- args: optional arguments to pass along

When a loaded skill references its own scripts, templates, assets, or examples, prefer those over
recreating the workflow from memory. If no listed skill matches the request, just proceed normally — do
not load an unrelated skill to satisfy a rule.

Do not call a skill that isn't in the listing, and never claim to use a skill without actually calling
this tool.`
