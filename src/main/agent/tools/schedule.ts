// schedule_create / schedule_list / schedule_delete (doc 28) — the role's interface to the scheduled-task
// store (cron-style create/list/delete). A task is a STEP CHAIN: an ordered list of steps, each an
// agent run by its own role; the scheduler engine (engine.ts) fires due tasks and runs the steps in sequence,
// piping each step's output into the next. cwd defaults to the creating agent's cwd, which becomes the task's
// pre-authorized working dir (full perms inside it when fired — doc 28 §5.1).

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import { scheduledTaskStore } from '../scheduler/store'
import * as workflowService from '../../services/workflow/service'
import type { ScheduledTask } from '../../ipc/contracts'

function stepLabel(s: ScheduledTask['steps'][number]): string {
  if (s.kind === 'workflow') return s.workflowId ? (workflowService.get(s.workflowId)?.name ?? 'workflow') : 'workflow'
  return s.kind === 'expert' ? (s.roleId ?? 'expert') : s.kind
}

function fmtTask(t: ScheduledTask): string {
  const when = new Date(t.nextRunAt).toLocaleString()
  const kind = t.recurring ? `recurring (${t.cron})` : 'one-shot'
  const chain = t.steps.map(stepLabel).join(' → ')
  const flags = `${t.durable ? ' · durable' : ''}${t.enabled ? '' : ' · disabled'}`
  // A command step has no meaningful prompt (and durable tasks load from JSON unvalidated), so read it
  // defensively — `?? ''` after .slice would still call .slice on an undefined prompt.
  return `${t.id}  "${t.name}"  next=${when}  ${kind}${flags}  [${chain}] — ${(t.steps[0]?.prompt ?? '').slice(0, 50)}`
}

function stringResult(out: string, toolUseId: string): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content: out }
}

export const scheduleCreateTool = buildTool({
  name: 'schedule_create',
  inputSchema: z.strictObject({
    name: z.string().describe('Short human label for the task, shown in the Scheduled page (e.g. "Weekly report")'),
    schedule: z
      .string()
      .describe(
        'When to run: an interval ("5m" / "2h" / "1d"), a one-shot datetime ("2026-06-05T15:00", local), or a 5-field cron ("0 9 * * 1-5", local time)'
      ),
    steps: z
      .array(
        z.object({
          kind: z
            .enum(['expert', 'tool', 'email', 'project', 'workflow', 'command'])
            .describe(
              'expert = run a role; tool = use an MCP tool; email = send via an email MCP (or draft if none connected); project = create/advance a Project; workflow = run an existing SAVED workflow (by name — this schedules it, it does not define one); command = run a shell command or a program DIRECTLY (no role, no model, no tokens)'
            ),
          prompt: z
            .string()
            .optional()
            .describe(
              "What this step does — required for every kind EXCEPT workflow and command (those have their own fields). Each step also receives the previous step's output, so later steps build on earlier ones."
            ),
          role: z
            .string()
            .optional()
            .describe('expert: executor role id (e.g. "analyst"); tool/email: optional override, default scheduler'),
          to: z.string().optional().describe('email: recipient address'),
          subject: z.string().optional().describe('email: subject line'),
          action: z.enum(['create', 'advance']).optional().describe('project: create a new project or advance one'),
          projectId: z.string().optional().describe('project (advance): the target project id'),
          workflow: z.string().optional().describe('workflow: the saved workflow by its EXACT name (must be enabled — drafts cannot be scheduled)'),
          params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe('workflow: run parameters (omitted params use their defaults)'),
          // command fields — the command is NOT confined to the working directory and runs with the user's
          // full permissions. Always tell the user the exact command you are scheduling before you call this.
          mode: z.enum(['shell', 'program']).optional().describe('command: "shell" (default) runs `command` in a login shell; "program" runs `program` + `args` with NO shell'),
          command: z.string().optional().describe('command (shell mode): the command line to run'),
          program: z.string().optional().describe('command (program mode): absolute path of the executable'),
          args: z.array(z.string()).optional().describe('command (program mode): arguments, passed verbatim'),
          shell: z.enum(['auto', 'zsh', 'bash', 'sh', 'powershell', 'cmd']).optional().describe('command (shell mode): which shell; default "auto" = the login shell (cmd on Windows)'),
          working_dir: z.string().optional().describe('command: working directory override; defaults to the task cwd'),
          timeout_sec: z.number().optional().describe('command: kill the process tree after this many seconds (default 600)'),
          on_failure: z.enum(['stop', 'continue']).optional().describe('command: on a non-zero exit, "stop" (default) aborts the chain or "continue" carries on'),
          env: z.record(z.string(), z.string()).optional().describe('command: extra environment variables (never put secrets here)'),
        })
      )
      .min(1)
      .describe(
        'Ordered step chain. One step for a simple task; multiple steps hand work across roles/kinds (e.g. analyst computes → email step sends the result; a workflow step pipes its return text onward). Each step runs and its output feeds the next.'
      ),
    cwd: z
      .string()
      .optional()
      .describe(
        'Working dir every step is pre-authorized to act in (full permission inside it when fired); defaults to your current cwd'
      ),
    durable: z
      .boolean()
      .optional()
      .describe(
        'true = persist across app restarts. Default false = session-only (gone when the app closes). Only pass true when the user explicitly wants it kept ("every day", "permanently")'
      ),
  }),
  prompt: () =>
    'Create a scheduled task that fires later. "schedule" is an interval (5m/2h/1d), a one-shot datetime, or ' +
    'a 5-field cron (local time). "steps" is an ordered chain: each step runs as an agent turn by its "role" ' +
    'inside "cwd" (full permission there), and its output is piped into the next step — so one task can hand ' +
    'work across roles. A "workflow" step runs an existing SAVED workflow by name (enabled only — never a ' +
    'draft; the run is checked again at fire time) and pipes its return text onward — use it when the user ' +
    'wants a saved workflow on a schedule. A "command" step runs a shell command or a program DIRECTLY with ' +
    'no role and no tokens — use it for scripts, backups, syncs. A command runs UNATTENDED with the user\'s ' +
    'full permissions and is NOT confined to the working directory, so ALWAYS state the exact command you ' +
    'are scheduling to the user in your reply, and only schedule commands that came from the user or that ' +
    'they would clearly expect. Keep it session-only (durable:false) unless the user wants it to survive ' +
    'restarts. Email/send is NOT built in: a step that should email must go through an email MCP tool or ' +
    'leave a draft. Use for "remind me / run X every / at <time> do Y / run <workflow> every morning".',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async call(input, ctx) {
    // §7.5 "whoever launches, checks" — creating a workflow schedule IS the launch decision, made by the
    // role in its own turn, so the CREATE-time gate is the strict one: resolve the name against ENABLED
    // workflows only (a draft cannot be scheduled — same red line as every entry point) and run the SAME
    // mechanical preflight the run itself enforces (params/folder/gates), refusing the task on failure.
    // Fire time re-checks mechanically (engine → preflightRun), so a workflow disabled later fails honestly.
    const steps = await Promise.all(
      input.steps.map(async (s) => {
        if (s.kind === 'workflow') {
          if (!s.workflow) throw new Error('a workflow step needs "workflow" (the saved workflow\'s exact name)')
          const w = workflowService.list().find((x) => x.name === s.workflow && x.enabled)
          if (!w) {
            const enabled = workflowService.list().filter((x) => x.enabled).map((x) => x.name)
            throw new Error(`no ENABLED workflow named "${s.workflow}"${enabled.length ? ` — available: ${enabled.join(', ')}` : ' — none are enabled'}`)
          }
          workflowService.preflightRun(w.id, s.params ?? {}) // throws with the concrete reason → the task is refused
          return { kind: s.kind, prompt: '', workflowId: w.id, workflowParams: s.params }
        }
        if (s.kind === 'command') {
          // Infer the mode from which field the agent populated when it omitted `mode` (setting `program`
          // without `mode` clearly means program mode) — otherwise a program step would hit a misleading
          // "needs command" error. An explicit `mode` always wins.
          const mode = s.mode ?? (s.program?.trim() ? 'program' : 'shell')
          if (mode === 'shell' && !s.command?.trim()) throw new Error('a shell command step needs "command"')
          if (mode === 'program' && !s.program?.trim()) throw new Error('a program command step needs "program" (the executable path)')
          return {
            kind: s.kind,
            prompt: '',
            mode,
            command: s.command,
            program: s.program,
            args: s.args,
            shell: s.shell,
            stepCwd: s.working_dir,
            timeoutSec: s.timeout_sec,
            onFailure: s.on_failure,
            env: s.env,
          }
        }
        if (!s.prompt) throw new Error(`a ${s.kind} step needs a prompt`)
        return {
          kind: s.kind,
          prompt: s.prompt,
          roleId: s.role,
          to: s.to,
          subject: s.subject,
          action: s.action,
          projectId: s.projectId,
        }
      })
    )
    const task = scheduledTaskStore.create(
      {
        name: input.name,
        schedule: input.schedule,
        steps,
        cwd: input.cwd ?? ctx.cwd,
        durable: input.durable,
        // §7.5 provenance: the creating role + its conversation — a workflow step fired by this task
        // anchors its run to that conversation's Tasks section (user-created tasks carry neither).
        creatorRoleId: ctx.roleId,
        creatorConvId: ctx.convId,
      },
      Date.now()
    )
    const chain = task.steps.map(stepLabel).join(' → ')
    // D4 visibility: echo any command step VERBATIM in the receipt so the exact command the task will run
    // unattended is on the record (the user sees it in the tool result) — a raw command isn't confined to
    // the cwd and runs with full permissions.
    const commandEcho = task.steps
      .map((s, i) =>
        s.kind === 'command'
          ? `  step ${i + 1} command (${(s.mode ?? 'shell') === 'program' ? 'program' : 'shell'}): ${
              (s.mode ?? 'shell') === 'program' ? [s.program ?? '', ...(s.args ?? [])].join(' ') : (s.command ?? '')
            }`
          : null
      )
      .filter(Boolean)
      .join('\n')
    return {
      data:
        `Scheduled "${task.name}" (${task.id}) — next run ${new Date(task.nextRunAt).toLocaleString()} ` +
        `(${task.recurring ? `recurring ${task.cron}` : 'one-shot'}${task.durable ? ', durable' : ', session-only'}). ` +
        `Steps: ${chain}.` +
        (commandEcho ? `\nCommands (run unattended with your full permissions, NOT confined to the working dir):\n${commandEcho}` : ''),
    }
  },
  mapResult: stringResult,
})

export const scheduleListTool = buildTool({
  name: 'schedule_list',
  inputSchema: z.strictObject({}),
  prompt: () => 'List the scheduled tasks (id, name, next run time, recurring/one-shot, step chain).',
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call() {
    const tasks = scheduledTaskStore.list()
    if (!tasks.length) return { data: 'No scheduled tasks.' }
    return { data: `${tasks.length} scheduled task(s):\n` + tasks.map(fmtTask).join('\n') }
  },
  mapResult: stringResult,
})

export const scheduleDeleteTool = buildTool({
  name: 'schedule_delete',
  inputSchema: z.strictObject({ id: z.string().describe('Task id from schedule_list') }),
  prompt: () => 'Delete (cancel) a scheduled task by its id.',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async call(input) {
    const ok = scheduledTaskStore.delete(input.id)
    return { data: ok ? `Deleted scheduled task ${input.id}.` : `No scheduled task with id "${input.id}".` }
  },
  mapResult: stringResult,
})
