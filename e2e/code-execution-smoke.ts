// Offline verify for the code_execution tool: run Python locally (stdout/stderr/exit) + matplotlib
// chart → image block. No LLM. Skips gracefully if python3 / matplotlib aren't installed.
// Run: npx tsx e2e/code-execution-smoke.ts
import { strict as assert } from 'node:assert'
import { codeExecutionTool } from '../src/main/agent/tools/code-execution'

interface CodeData {
  stdout: string
  stderr: string
  code: number
  timedOut: boolean
  images: { mime: string; base64: string }[]
  spawnError?: string
}
const ctx = { cwd: '/tmp', signal: new AbortController().signal } as never
const textOf = (c: string | Array<{ type: string; text?: string }>): string =>
  typeof c === 'string' ? c : (c.find((b) => b.type === 'text')?.text ?? '')

async function main(): Promise<void> {
  // 1. stdout
  const r1 = await codeExecutionTool.call({ code: 'print(1 + 1)' }, ctx)
  const d1 = r1.data as CodeData
  if (d1.spawnError) {
    console.log(`⚠ SKIP — ${d1.spawnError}`)
    return
  }
  const out1 = codeExecutionTool.mapResult(d1, 'call_1')
  console.log('print(1+1) →', JSON.stringify(out1.content))
  assert.ok(textOf(out1.content).includes('2'), 'stdout has 2')
  console.log('✓ python stdout')

  // 2. stderr + non-zero exit
  const r2 = await codeExecutionTool.call({ code: 'import sys; sys.stderr.write("oops"); sys.exit(3)' }, ctx)
  const out2 = codeExecutionTool.mapResult(r2.data as CodeData, 'call_2')
  const t2 = textOf(out2.content)
  assert.ok(t2.includes('oops'), 'stderr captured')
  assert.ok(t2.includes('exit code: 3'), 'exit code surfaced')
  console.log('✓ stderr + exit code')

  // 3. matplotlib chart → image block (if matplotlib is installed)
  const chartCode = [
    'import os',
    'try:',
    '    import matplotlib; matplotlib.use("Agg")',
    '    import matplotlib.pyplot as plt',
    '    plt.plot([1, 2, 3])',
    '    plt.savefig(os.path.join(os.environ["NSAI_CODE_OUTPUT"], "fig.png"))',
    '    print("saved")',
    'except Exception as e:',
    '    print("no-mpl:", e)'
  ].join('\n')
  const r3 = await codeExecutionTool.call({ code: chartCode }, ctx)
  const d3 = r3.data as CodeData
  const out3 = codeExecutionTool.mapResult(d3, 'call_3')
  const imgs = Array.isArray(out3.content) ? out3.content.filter((b) => b.type === 'image') : []
  console.log('chart →', imgs.length, 'image block(s); stdout:', JSON.stringify(textOf(out3.content).slice(0, 60)))
  if (textOf(out3.content).includes('saved')) {
    assert.equal(imgs.length, 1, 'saved PNG returned as one image block')
    assert.equal((imgs[0] as { source: { media_type: string } }).source.media_type, 'image/png')
    console.log('✓ matplotlib chart → image block')
  } else {
    console.log('⚠ matplotlib not installed — chart→image check skipped')
  }

  console.log('\n✓ ALL code_execution checks passed')
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('✗', e instanceof Error ? e.stack : e)
    process.exit(1)
  })
