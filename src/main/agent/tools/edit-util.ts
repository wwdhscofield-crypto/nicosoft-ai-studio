// Shared helpers for the writing tools: the stale-write guard (read-before-edit) and the single
// string-replacement primitive. See docs/nicosoft-studio/12-hex-coding-agent.md §3.4.

import { readFile, stat } from 'node:fs/promises'
import type { AgentContext } from '../context'

// The file must have been Read (so it's in readFileState) AND be unchanged on disk since. Returns the
// cached contents. Throws (→ error tool_result) otherwise — this is the core edit-safety guard.
export async function ensureFresh(ctx: AgentContext, abs: string, displayPath: string): Promise<string> {
  const cached = ctx.readFileState.get(abs)
  if (!cached) {
    throw new Error(`Read ${displayPath} before editing it — the agent must see the current contents first.`)
  }
  const st = await stat(abs).catch(() => null)
  if (!st) throw new Error(`${displayPath} no longer exists.`)
  if (st.mtimeMs !== cached.mtimeMs) {
    // mtime differs — but if the on-disk content is byte-identical to the cache, the file is
    // effectively unchanged (coarse-mtime FS, a no-op touch). Re-read + compare before refusing (§3.4).
    const current = await readFile(abs, 'utf-8').catch(() => null)
    if (current !== cached.content) {
      throw new Error(`${displayPath} was modified since it was last read. Read it again before editing.`)
    }
  }
  return cached.content
}

// Replace old with new in content. Function-form replacement so `$&`/`$1` in new_string stay literal
// (a string second arg would interpret them). Throws on not-found or ambiguous (>1 without replaceAll).
export function applyReplace(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
  displayPath: string,
): string {
  if (oldStr === newStr) throw new Error('old_string and new_string are identical — nothing to change.')
  if (oldStr === '') throw new Error('old_string is empty — use Write to create a file.')
  const count = content.split(oldStr).length - 1
  if (count === 0) throw new Error(`old_string not found in ${displayPath}.`)
  if (count > 1 && !replaceAll) {
    throw new Error(`old_string appears ${count} times in ${displayPath} — add more context or set replace_all.`)
  }
  return replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, () => newStr)
}
