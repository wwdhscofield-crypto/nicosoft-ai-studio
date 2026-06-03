// approval.ts — unattended approval classifier (doc 19 §8). Classifies a tool call into a safety zone so
// the coordinator can self-approve without popping the user for every step:
//   🟢 green  — cwd-confined reads + writes/edits, internal coordination, read-only commands → auto-allow.
//   🟡 yellow — in-cwd mutating bash, network reads, spawning a service → allow, but LOG it in chat.
//   🔴 red    — delete, privilege escalation, network egress, dangerous system commands, out-of-cwd writes
//               → HARD-DENY now; the caller records a PendingApproval + alerts the user (deferred approval).
//
// PURE RULES, deliberately not an LLM judge: a classifier you can talk into allowing `rm -rf /` is worse
// than useless. Red is a hard floor and fails CLOSED — anything the rules can't prove safe lands in red or
// yellow, never green by omission. Write/Edit/MultiEdit are green because the loop already confines their
// paths to cwd (confinePath throws on escape before this is ever consulted); Bash is the real surface since
// its command string isn't path-confined, so it gets the most scrutiny.

import { isReadOnlyCommand } from './tools/bash-classifier'

export type ApprovalZone = 'green' | 'yellow' | 'red'

export interface ApprovalVerdict {
  zone: ApprovalZone
  reason: string
}

// cwd-confined or internal-only tools — safe to auto-run. Write/Edit/MultiEdit: paths already confined to
// cwd by the loop. consult (send_message/assign_task/wait): in-process messaging. stop_service: kills a
// process this session started. Read-only investigators + planning + todos: no side effects.
const GREEN_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'Write', 'Edit', 'MultiEdit', 'TodoWrite',
  'EnterPlanMode', 'ExitPlanMode', 'send_message', 'assign_task', 'wait', 'stop_service',
])

// Allowed but worth surfacing in chat: network reads + spawning a long-running process + sandboxed exec.
const YELLOW_TOOLS = new Set(['WebFetch', 'WebSearch', 'start_service', 'code_execution', 'service_logs', 'list_services'])

export function classifyApproval(toolName: string, input: unknown, cwd: string): ApprovalVerdict {
  if (toolName === 'Bash') return classifyBashCommand(commandOf(input))
  if (GREEN_TOOLS.has(toolName)) return { zone: 'green', reason: 'cwd-confined / internal' }
  if (YELLOW_TOOLS.has(toolName)) return { zone: 'yellow', reason: 'network read / process / sandboxed exec' }
  // MCP (mcp__server__tool) and any unknown tool: external, intent unknown → fail closed to yellow (logged),
  // never green. (A genuinely dangerous MCP tool the user trusts can still be approved when surfaced.)
  void cwd // reserved for future per-path checks (out-of-cwd MCP file ops)
  return { zone: 'yellow', reason: 'external / unrecognized tool — surfaced for visibility' }
}

function commandOf(input: unknown): string {
  const c = (input as { command?: unknown } | null)?.command
  return typeof c === 'string' ? c : ''
}

// Delete / unlink, privilege escalation, destructive system ops, and process-killing — always red.
const DANGEROUS_CMD = /(^|[;&|]\s*)(sudo|su|doas|rm|rmdir|unlink|shred|dd|mkfs|fdisk|mkswap|shutdown|reboot|halt|poweroff|kill|killall|pkill)\b/i
// Network EGRESS (sending data out / remote shells / transfers). curl/wget READS (GET) are yellow, but an
// upload/POST/PUT or a remote-copy tool is red. Bare `curl host` (a GET) is NOT matched here → falls to yellow.
const NET_EGRESS = /\b(scp|sftp|rsync|ssh|nc|ncat|telnet|ftp)\b|\b(curl|wget)\b[^\n|;&]*(?:-d\b|--data|-F\b|--form|-T\b|--upload-file|-X\s*(?:POST|PUT|DELETE|PATCH))/i
// Redirecting a write to an absolute path OUTSIDE a project — system dirs. cwd is itself absolute, but these
// well-known system roots are never a project cwd, so writing into them is out-of-bounds.
const OUT_OF_CWD_WRITE = /(^|\s)>>?\s*(\/(etc|usr|bin|sbin|var|boot|sys|proc|dev|Library|System|Applications)\b|~|\$HOME)/i
// chmod/chown with a recursive or world-writable bit on something broad — privilege/permission tampering.
const PERM_TAMPER = /\b(chmod|chown|chgrp)\b[^\n|;&]*(-R\b|\s777\b|\sa\+|\/(etc|usr|bin|var)\b)/i

// Classify a Bash command. Read-only (proven by the quote-aware classifier) → green. Anything matching a
// dangerous pattern → red (hard floor). Everything else is an in-cwd mutating command → yellow (allow+log).
function classifyBashCommand(command: string): ApprovalVerdict {
  if (!command.trim()) return { zone: 'green', reason: 'empty command' }
  if (DANGEROUS_CMD.test(command)) return { zone: 'red', reason: 'delete / privilege / destructive system command' }
  if (NET_EGRESS.test(command)) return { zone: 'red', reason: 'network egress (upload / remote shell / transfer)' }
  if (OUT_OF_CWD_WRITE.test(command)) return { zone: 'red', reason: 'write to a system path outside the project' }
  if (PERM_TAMPER.test(command)) return { zone: 'red', reason: 'permission/ownership tampering' }
  // Read-only check last: a dangerous flag wouldn't be read-only anyway, but this keeps the green path tight.
  if (isReadOnlyCommand(command)) return { zone: 'green', reason: 'read-only command' }
  return { zone: 'yellow', reason: 'in-cwd mutating command' }
}
