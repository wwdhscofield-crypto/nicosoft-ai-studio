// hooks/executors/agent.ts — the agent hook: a tool-bearing SUB-AGENT that investigates before judging. Where
// the prompt hook is a blind one-shot, this runs a constrained agent loop (read-only kit: Read/Grep/Glob) so it
// can read the run transcript + inspect the repo to SELF-VERIFY the condition, then return strict JSON
// {"ok":boolean,"reason":string}. Anti-recursion is doubly enforced: the kit has no Task/agent/studio_lens (it
// cannot spawn children), and the sub-query carries a 'hook-agent-' id so the engine drops prompt/agent hooks
// inside it. The kit is deliberately read-only-and-non-exfiltrating: it runs under permissionMode 'bypass' (so
// it never blocks on a permission prompt), and its prompt embeds the FULL event payload — which on PostToolUse
// carries tool_response, i.e. attacker-influenceable prior-tool output — so a write/exec/network tool here would
// be a prompt-injection→RCE/exfiltration vector. Read/Grep/Glob can only read within the project and cannot
// mutate, spawn, or reach the network; Bash (NOT read-only, NOT cwd-confined, auto-allowed under bypass) is
// therefore excluded by design.

import { ulid } from '../../../db/id'
import { runDispatchedAgent, type AgentCallbacks } from '../../../services/agent-dispatch'
import { HOOK_AGENT_PREFIX } from '../engine'
import type { AgentHookConfig, HookExecContext, HookOutcome } from '../types'
import type { HookPayload } from '../events'
import { eventMeta } from '../events'

// Read-only investigation kit — no write/exec-mutation, no network, no spawn tools (the structural recursion
// guard). Bash is intentionally absent: under permissionMode 'bypass' it is auto-allowed (execution.ts) and is
// neither read-only nor cwd-confined, so over the prompt-injectable payload it would be an arbitrary-command
// vector. Read/Grep/Glob fully cover "read the transcript + inspect the repo" with no exec/exfiltration surface.
const HOOK_AGENT_TOOLS = ['Read', 'Grep', 'Glob'] as const

const SYSTEM =
  'You are a hook verifier sub-agent inside an autonomous agent runtime. Investigate the CONDITION below using ' +
  'your read-only tools (read the transcript at the given path, grep/inspect the repository) and decide whether ' +
  'it is satisfied. Do real verification — do not guess. When done, reply with ONLY a single JSON object: ' +
  '{"ok": boolean, "reason": string}. ok=true = the condition holds; ok=false = it does not, with a brief reason. ' +
  'Output nothing but that JSON as your final message.'

// Headless callbacks: the sub-agent runs unattended (bypass + a read-only kit confined to cwd), so a permission
// prompt (shouldn't occur) denies rather than hangs; no streaming/question surface.
const HEADLESS_CB: AgentCallbacks = {
  onStream: () => {},
  onEvent: () => {},
  requestPermission: async () => ({ allow: false }),
  askUser: undefined,
}

function parseOkReason(text: string): { ok: boolean; reason: string } {
  const m = /\{[\s\S]*\}/.exec(text)
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { ok?: unknown; reason?: unknown }
      return { ok: j.ok === true, reason: typeof j.reason === 'string' ? j.reason : '' }
    } catch {
      /* fall through */
    }
  }
  // No parseable JSON object → FAIL CLOSED (block / deny). The reply is model-generated over an
  // attacker-influenceable payload, so prose is never read as an allow signal: a bare "ok"/"yes" appearing in a
  // negation ("not ok") or in slightly-malformed JSON ({ ok: false }) must not pass a deny gate.
  return { ok: false, reason: text.trim().slice(0, 500) || 'Agent hook reply was not valid JSON' }
}

export async function executeAgentHook(config: AgentHookConfig, payload: HookPayload, opts: HookExecContext): Promise<HookOutcome> {
  if (!opts.llm) return { outcome: 'success' } // no LLM/endpoint access → silently pass (fail-open skip)
  // A nested agent hook (we're already inside a hook-spawned agent) is suppressed by the engine before reaching
  // here; guard anyway so a direct call can't recurse.
  if (opts.selfAgentId?.startsWith(HOOK_AGENT_PREFIX)) return { outcome: 'success' }

  const prompt =
    `CONDITION:\n${config.prompt}\n\n` +
    `EVENT: ${payload.hook_event_name}\n` +
    `Run transcript: ${payload.transcript_path ?? '(none)'}\n` +
    `Working directory: ${opts.cwd}\n\n` +
    `EVENT payload:\n${JSON.stringify(payload, null, 2)}`

  let text: string
  try {
    const res = await runDispatchedAgent(
      {
        convId: opts.convId,
        roleId: opts.roleId ?? 'engineer',
        prompt,
        cwd: opts.cwd,
        protocol: opts.llm.protocol,
        baseUrl: opts.llm.baseUrl,
        apiKey: opts.llm.apiKey,
        model: config.model ?? opts.llm.model,
        includeHistory: false,
        memories: [],
        summary: null,
        toolNames: HOOK_AGENT_TOOLS,
        systemPromptOverride: SYSTEM,
        permissionMode: 'bypass', // read-only kit confined to cwd → safe to run unattended
        maxTurns: 50, // bound the investigation (matches the reference forked-agent cap)
        hookAgentId: `${HOOK_AGENT_PREFIX}${ulid()}`,
      },
      HEADLESS_CB,
      opts.signal,
    )
    text = res.text
  } catch (err) {
    if (opts.signal.aborted) return { outcome: 'cancelled' }
    return { outcome: 'non_blocking_error', systemMessage: `Agent hook failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const { ok, reason } = parseOkReason(text)
  if (ok) return { outcome: 'success' }
  const meta = eventMeta(payload.hook_event_name)
  if (meta.isToolEvent) return { outcome: 'blocking', permissionBehavior: 'deny', hookPermissionDecisionReason: reason || 'Agent hook condition not met', blockingError: reason || 'Agent hook condition not met' }
  return { outcome: 'blocking', blockingError: reason || 'Agent hook condition not met' }
}
