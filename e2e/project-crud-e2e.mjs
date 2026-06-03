// E2E for doc 19 §1 phase 5a — Project DB layer. Proves the project CRUD IPC round-trips through real
// SQLite (projects/project_tasks/project_tests): create → addTask → setTaskStatus → addTest → setPhase,
// a fresh get() reflects every write, the DERIVED view is correct (progress = done/total, experts =
// coordinator + distinct assignees in step order), and remove() cascades. NO LLM — pure DB, seconds.
//   node e2e/project-crud-e2e.mjs
import { _electron } from 'playwright'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..')
const errors = []
const app = await _electron.launch({ args: ['out/main/index.js'], cwd: PROJECT })
app.process().stderr?.on('data', (d) => process.stderr.write('[main:err] ' + d.toString()))
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(800)

const r = await page.evaluate(async () => {
  const p = window.api.project
  // 1. create — a fresh project: planning phase, no tasks
  const created = await p.create({ title: 'CRUD smoke', goal: 'verify the project DB layer', cwd: '/tmp/proj-smoke' })
  // 2. two tasks for two different experts (step_no auto-increments)
  const t1 = await p.addTask(created.id, { title: 'backend', assigneeRoleId: 'engineer' })
  const t2 = await p.addTask(created.id, { title: 'frontend', assigneeRoleId: 'shuri' })
  // 3. mark one task done → progress should derive to 0.5
  await p.setTaskStatus(created.id, t1.id, 'done', 'done output')
  // 4. a test, then mark it pass
  const test = await p.addTest(created.id, 'snake renders')
  await p.setTestStatus(created.id, test.id, 'pass')
  // 5. advance the phase
  await p.phase(created.id, 'executing')
  const afterWrites = await p.get(created.id)
  const inList = (await p.list()).some((x) => x.id === created.id)
  // 6. remove → gone from list + get() null (FK cascade removes its tasks/tests too)
  await p.remove(created.id)
  const afterRemove = await p.get(created.id)
  const goneFromList = !(await p.list()).some((x) => x.id === created.id)
  return {
    created: { phase: created.phase, progress: created.progress, experts: created.experts, cwd: created.cwd },
    t1: { stepNo: t1.stepNo, status: t1.status },
    t2: { stepNo: t2.stepNo },
    afterWrites,
    inList,
    afterRemove,
    goneFromList,
  }
})

console.log('created:', JSON.stringify(r.created))
console.log(
  'afterWrites:',
  JSON.stringify({
    phase: r.afterWrites.phase,
    progress: r.afterWrites.progress,
    experts: r.afterWrites.experts,
    plan: r.afterWrites.plan.map((t) => ({ step: t.stepNo, status: t.status, who: t.assigneeRoleId, out: t.output })),
    tests: r.afterWrites.tests,
  }),
)
console.log('inList:', r.inList, '| afterRemove:', r.afterRemove, '| goneFromList:', r.goneFromList)
console.log('page errors:', errors.length ? JSON.stringify(errors) : 'none')

assert.equal(errors.length, 0, 'no JS errors:\n' + errors.join('\n'))
// create: planning + empty + cwd persisted
assert.equal(r.created.phase, 'planning', 'new project starts in planning')
assert.equal(r.created.progress, 0, 'new project has 0 progress')
assert.deepEqual(r.created.experts, ['coordinator'], 'new project experts = [coordinator]')
assert.equal(r.created.cwd, '/tmp/proj-smoke', 'cwd persisted on create')
// tasks: step_no auto-increments, start todo
assert.equal(r.t1.stepNo, 1, 'first task is step 1')
assert.equal(r.t1.status, 'todo', 'task starts todo')
assert.equal(r.t2.stepNo, 2, 'second task is step 2')
// after writes: every mutation reflected by a fresh get()
assert.ok(r.afterWrites, 'project still exists after writes')
assert.equal(r.afterWrites.phase, 'executing', 'phase advanced to executing')
assert.equal(r.afterWrites.progress, 0.5, '1 of 2 tasks done → progress 0.5')
assert.deepEqual(r.afterWrites.experts, ['coordinator', 'engineer', 'shuri'], 'experts = coordinator + distinct assignees in step order')
assert.equal(r.afterWrites.plan.length, 2, 'plan has both tasks')
assert.equal(r.afterWrites.plan[0].status, 'done', 'task 1 persisted as done')
assert.equal(r.afterWrites.plan[0].output, 'done output', 'task output persisted')
assert.equal(r.afterWrites.tests.length, 1, 'one test')
assert.equal(r.afterWrites.tests[0].status, 'pass', 'test marked pass persisted')
assert.ok(r.inList, 'project appeared in list()')
// remove cascades
assert.equal(r.afterRemove, null, 'get() returns null after remove')
assert.ok(r.goneFromList, 'project gone from list() after remove')

await app.close()
console.log('✓ project CRUD e2e OK — DB round-trip + derived view (progress/experts) + cascade delete all work')
process.exit(0)
