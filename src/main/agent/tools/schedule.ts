// schedule_create / schedule_list / schedule_delete (doc 28) — the role's interface to the scheduled-task
// store (cron-style create/list/delete). A task is a STEP CHAIN: an ordered list of steps, each an
// agent run by its own role; the scheduler engine (engine.ts) fires due tasks and runs the steps in sequence,
// piping each step's output into the next. cwd defaults to the creating agent's cwd, which becomes the task's
// pre-authorized working dir (full perms inside it when fired — doc 28 §5.1).

import { z } from 'zod'
import { buildTool } from '../tool'
import type { ToolResultBlock } from '../types'
import { scheduledTaskStore } from '../scheduler/store'
import type { ScheduledTask } from '../../ipc/contracts'

function stepLabel(s: ScheduledTask['steps'][number]): string {
  return s.kind === 'expert' ? (s.roleId ?? 'expert') : s.kind
}

function fmtTask(t: ScheduledTask): string {
  const when = new Date(t.nextRunAt).toLocaleString()
  const kind = t.recurring ? `recurring (${t.cron})` : 'one-shot'
  const chain = t.steps.map(stepLabel).join(' → ')
  const flags = `${t.durable ? ' · durable' : ''}${t.enabled ? '' : ' · disabled'}`
  return `${t.id}  "${t.name}"  next=${when}  ${kind}${flags}  [${chain}] — ${t.steps[0]?.prompt.slice(0, 50) ?? ''}`
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
            .enum(['expert', 'tool', 'email', 'project'])
            .describe(
              'expert = run a role; tool = use an MCP tool; email = send via an email MCP (or draft if none connected); project = create/advance a Project'
            ),
          prompt: z
            .string()
            .describe(
              "What this step does. Each step also receives the previous step's output, so later steps build on earlier ones."
            ),
          role: z
            .string()
            .optional()
            .describe('expert: executor role id (e.g. "analyst"); tool/email: optional override, default scheduler'),
          to: z.string().optional().describe('email: recipient address'),
          subject: z.string().optional().describe('email: subject line'),
          action: z.enum(['create', 'advance']).optional().describe('project: create a new project or advance one'),
          projectId: z.string().optional().describe('project (advance): the target project id'),
        })
      )
      .min(1)
      .describe(
        'Ordered step chain. One step for a simple task; multiple steps hand work across roles/kinds (e.g. analyst computes → email step sends the result). Each step runs and its output feeds the next.'
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
    'work across roles. Keep it session-only (durable:false) unless the user wants it to survive restarts. ' +
    'Email/send is NOT built in: a step that should email must go through an email MCP tool or leave a draft. ' +
    'Use for "remind me / run X every / at <time> do Y".',
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async call(input, ctx) {
    const task = scheduledTaskStore.create(
      {
        name: input.name,
        schedule: input.schedule,
        steps: input.steps.map((s) => ({
          kind: s.kind,
          prompt: s.prompt,
          roleId: s.role,
          to: s.to,
          subject: s.subject,
          action: s.action,
          projectId: s.projectId,
        })),
        cwd: input.cwd ?? ctx.cwd,
        durable: input.durable,
      },
      Date.now()
    )
    const chain = task.steps.map((s) => s.roleId).join(' → ')
    return {
      data:
        `Scheduled "${task.name}" (${task.id}) — next run ${new Date(task.nextRunAt).toLocaleString()} ` +
        `(${task.recurring ? `recurring ${task.cron}` : 'one-shot'}${task.durable ? ', durable' : ', session-only'}). ` +
        `Steps: ${chain}.`,
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
