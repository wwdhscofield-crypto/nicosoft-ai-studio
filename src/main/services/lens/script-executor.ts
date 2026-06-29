// Studio Lens — the node:vm script executor.
//
// This is the engine half of the lens rewrite: the reviewer AUTHORS a deterministic JS orchestration script
// and this module SAFELY EXECUTES it, replacing the old YAML-engine auto-fan-out. It mirrors how Claude
// Code's Workflow tool runs model-authored scripts — a hardened node:vm sandbox, the orchestration primitives
// (agent/parallel/pipeline), and a cross-realm async bridge — so the dynamic review fans out the way the model
// intends rather than being multiplied by an engine.
//
// Pipeline: parse + validate the `export const meta` header, transpile the body, build the hardened sandbox,
// then run the script. Without orchestration hooks it runs as a pure computation (args in, return value out)
// and a script that calls agent() gets a ReferenceError; with them, the primitives are injected so the script
// can fan sub-agents out.
//
// The hardening, in order: a null-prototype context with code generation disabled (eval/Function throw); a
// prelude that deletes the dangerous globals + freezes Error.prepareStackTrace; a determinism shim
// (Date.now/Math.random throw, an explicit `new Date(ts)` is fine); acorn validation that the first statement
// is a pure-literal `export const meta`; a transpile that wraps the body in an async IIFE; and execution under
// a sync timeout with dynamic import() disabled.
//
// SECURITY BOUNDARY: this contains a TRUSTED-BUT-FALLIBLE author — the user's OWN configured model reviewing
// the user's OWN code. The hardening contains an author that ERRS (no host object or function reaches the
// script, code generation is disabled, and results AND rejections are cloned into the vm realm). It is NOT a
// defense against a deliberately MALICIOUS author — a compromised or spoofed-slug reviewer endpoint — because
// node:vm is not a hard isolation boundary. Reviewing untrusted code, or wiring an untrusted reviewer
// endpoint, is OUT OF SCOPE for these guarantees and would require isolated-vm.

import vm from 'node:vm'
import { parse, type Node } from 'acorn'
import * as walk from 'acorn-walk'

// acorn's Node type is intentionally loose (estree shapes aren't bundled); widen for property access and
// rely on the RUNTIME node.type checks below.
type Ast = Node & { [k: string]: unknown }

// ── Constants ───────────────────────────────────────────────────────────────────────────────────────────

// The vm.Script runInContext timeout. NOTE: a vm timeout bounds the SYNCHRONOUS portion only (it cannot
// interrupt an awaited microtask); it's a runaway-sync backstop, not an overall wall-clock. The async budget
// is governed elsewhere (the agent cap / abort signal). 30s matches the Workflow default.
export const LENS_SCRIPT_TIMEOUT_MS = 30_000

// The reserved internal-variable prefix. The transpiler rejects any user identifier starting with it so a
// script can't collide with / shadow the bridge variables the primitives inject.
const RESERVED_PREFIX = '__wRg$'

// Globals with no orchestration use case that either run host-loop callbacks outside any try/catch
// (FinalizationRegistry — DoS shape) or expose shared-memory / debug-shell primitives (pure attack-surface
// reduction). eval/Function are NOT deleted here — they're blocked harder by the context's codeGeneration:
// false (createContext option below), which makes `Function('…')` throw at construction.
const DELETED_GLOBALS = [
  'ShadowRealm', 'WebAssembly', 'FinalizationRegistry', 'WeakRef', 'Atomics', 'SharedArrayBuffer',
  'queueMicrotask', '$vm', 'gc', 'edenGC', 'fullGC', 'print', 'readFile', 'Loader',
]

// Reserved meta key names: block prototype-pollution vectors even though the extractor builds onto a
// null-prototype object — defense in depth.
const RESERVED_META_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

// Harden prelude — runs INSIDE the vm realm (so it hardens the script's globals, not the host's): freezes
// Error.prepareStackTrace (deny the stack-trace callback as an escape vector) and deletes the dangerous
// globals. It does NOT freeze the realm's prototypes (a full SES-style intrinsic freeze): a vm context has
// its OWN intrinsics, so a script polluting its Object.prototype can't reach the host's, and every review
// builds a FRESH context, so self-pollution neither escapes nor persists. A prototype freeze would be pure
// defense-in-depth and is intentionally deferred — it needs the SES enable-override dance to avoid breaking
// Error subclasses, which isn't load-bearing under this threat model.
const HARDEN_PRELUDE = `(() => {
  Object.defineProperty(Error, 'prepareStackTrace', {
    value: (err) => String((err && err.stack) ?? err),
    writable: false, configurable: false,
  });
  for (const g of ${JSON.stringify(DELETED_GLOBALS)}) {
    try { delete globalThis[g] } catch {}
  }
})()`

// Date/Math.random shim — disable non-deterministic sources so a review over the same diff is reproducible
// (determinism makes reviews testable + stops scripts keying behavior off wall-clock). `new Date(ts)` with an
// explicit argument is still allowed (parsing a passed-in timestamp); only Date.now()/`new Date()` (no arg)/
// bare `Date()` throw.
const NOW_ERR =
  'Date.now() / new Date() are unavailable in lens scripts (reproducibility). Pass any needed timestamp via args.'
const RANDOM_ERR =
  'Math.random() is unavailable in lens scripts (reproducibility). For N independent samples, include the index in the agent label or prompt.'
const DATE_RANDOM_SHIM = `(() => {
  const NOW_ERR = ${JSON.stringify(NOW_ERR)};
  const RANDOM_ERR = ${JSON.stringify(RANDOM_ERR)};
  Math.random = function random() { throw new Error(RANDOM_ERR) };
  const RealDate = Date;
  RealDate.now = function now() { throw new Error(NOW_ERR) };
  function ShimDate(...a) {
    if (!new.target) throw new Error(NOW_ERR);   // bare Date() → now-string
    if (a.length === 0) throw new Error(NOW_ERR); // new Date() with no args
    return Reflect.construct(RealDate, a, new.target); // new Date(ts) OK
  }
  ShimDate.now = RealDate.now;
  ShimDate.parse = RealDate.parse;
  ShimDate.UTC = RealDate.UTC;
  ShimDate.prototype = RealDate.prototype;
  RealDate.prototype.constructor = ShimDate; // close the (new Date(x)).constructor backdoor
  Object.freeze(RealDate);                    // …then freeze so it can't be undone
  globalThis.Date = ShimDate;
})()`

// ── Types ───────────────────────────────────────────────────────────────────────────────────────────────

export interface ScriptMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: unknown
  [k: string]: unknown
}

export type ParseResult = { meta: ScriptMeta; scriptBody: string } | { error: string }

// ── meta validation + transpile (acorn) ─────────────────────────────────────────────────────────────────

// The first statement must be `export const meta = { … }` — exactly one const declarator
// named `meta` whose init is an object literal.
function isMetaExport(node: Ast): boolean {
  const decl = node.declaration as Ast | undefined
  if (!decl || decl.type !== 'VariableDeclaration') return false
  if (decl.kind !== 'const') return false
  const decls = decl.declarations as Ast[]
  if (!Array.isArray(decls) || decls.length !== 1) return false
  const d = decls[0]
  const id = d.id as Ast
  const init = d.init as Ast | undefined
  return id?.type === 'Identifier' && id.name === 'meta' && init?.type === 'ObjectExpression'
}

// Extract a property key (Identifier or Literal), rejecting reserved/pollution names.
function literalKey(prop: Ast): string {
  const key = prop.key as Ast
  let name: string
  if (key.type === 'Identifier') name = key.name as string
  else if (key.type === 'Literal') name = String(key.value)
  else throw new Error(`unsupported key type in meta: ${key.type}`)
  if (RESERVED_META_KEYS.has(name)) throw new Error(`reserved key name not allowed in meta: ${name}`)
  return name
}

// Recursively materialize a PURE-LITERAL node into its JS value, or throw. Allowed:
// Literal, Array (no holes/spread), Object, TemplateLiteral (no interpolation), negative-number unary.
// Anything else (Identifier, Call, spread, …) means meta isn't a pure literal → throw → caller reports it.
function literalValue(node: Ast): unknown {
  switch (node.type) {
    case 'Literal':
      return node.value
    case 'ArrayExpression':
      return (node.elements as (Ast | null)[]).map((el) => {
        if (el === null) throw new Error('sparse arrays not allowed in meta')
        if (el.type === 'SpreadElement') throw new Error('spread not allowed in meta')
        return literalValue(el)
      })
    case 'ObjectExpression':
      return literalObject(node)
    case 'TemplateLiteral': {
      const expr = node.expressions as Ast[]
      if (expr.length > 0) throw new Error('template interpolation not allowed in meta')
      const quasis = node.quasis as Ast[]
      return quasis.map((q) => ((q.value as { cooked?: string }).cooked ?? '')).join('')
    }
    case 'UnaryExpression': {
      const arg = node.argument as Ast
      if (node.operator === '-' && arg.type === 'Literal' && typeof arg.value === 'number') return -arg.value
      throw new Error('only negative-number unary allowed in meta')
    }
    default:
      throw new Error(`non-literal node type in meta: ${node.type}`)
  }
}

// Build a null-prototype object from an ObjectExpression's plain (non-computed,
// non-method, init-kind) properties.
function literalObject(node: Ast): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  for (const p of node.properties as Ast[]) {
    if (p.type !== 'Property') throw new Error('only plain properties allowed in meta')
    if (p.computed) throw new Error('computed keys not allowed in meta')
    if (p.method || p.kind !== 'init') throw new Error('methods/accessors not allowed in meta')
    out[literalKey(p)] = literalValue(p.value as Ast)
  }
  return out
}

// Required meta fields. name + description are mandatory non-empty strings (name shows in
// the permission dialog / run list, description is the one-liner). phases/whenToUse are optional.
function validateMetaFields(meta: Record<string, unknown>): string | null {
  if (typeof meta.name !== 'string' || !meta.name.trim()) return 'meta.name must be a non-empty string'
  if (typeof meta.description !== 'string' || !meta.description.trim()) return 'meta.description must be a non-empty string'
  return null
}

// Parse + validate the script header, returning the materialized meta and the body with the meta
// declaration sliced off. Validates the header: acorn parse as a module
// (so `export` is legal) with top-level await/return allowed, first statement must be the meta export,
// then strip it to get the executable body.
export function parseScript(src: string): ParseResult {
  let ast: Ast
  try {
    ast = parse(src, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as Ast
  } catch (e) {
    return {
      error:
        `Script parse error: ${e instanceof Error ? e.message : String(e)}. ` +
        'Lens scripts must be plain JavaScript — TypeScript syntax (type annotations like `: string[]`, ' +
        'interfaces, generics) fails to parse.',
    }
  }
  const first = (ast.body as Ast[])[0]
  if (!first || first.type !== 'ExportNamedDeclaration' || !isMetaExport(first)) {
    return { error: '`export const meta = { name, description, phases }` must be the FIRST statement in the script' }
  }
  const decl = first.declaration as Ast
  const init = (decl.declarations as Ast[])[0].init as Ast
  let raw: Record<string, unknown>
  try {
    raw = literalObject(init)
  } catch (e) {
    return { error: `meta must be a pure literal: ${e instanceof Error ? e.message : String(e)}` }
  }
  const fieldError = validateMetaFields(raw)
  if (fieldError) return { error: fieldError }
  // Strip the meta declaration: everything after its end, with a leading `;`/blank line trimmed.
  const scriptBody = src.slice(first.end).replace(/^[;\s]*\n/, '').trimStart()
  return { meta: raw as ScriptMeta, scriptBody }
}

// Wrap the body in an async IIFE under strict mode so top-level await + top-level return
// are legal and the return value is the IIFE's resolution. Then re-parse the WRAPPED form as a script and
// walk every identifier to reject the reserved `__wRg$` prefix (collision guard for 批 2's bridge vars).
export function transpile(scriptBody: string): { code: string } | { error: string } {
  const code = `(async () => {'use strict';\n${scriptBody}\n})()`
  let wrappedAst: Ast
  try {
    wrappedAst = parse(code, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true }) as unknown as Ast
  } catch (e) {
    return { error: `Script body parse error: ${e instanceof Error ? e.message : String(e)}` }
  }
  let reserved: string | null = null
  walk.full(wrappedAst as never, (node) => {
    const n = node as unknown as Ast
    if (n.type === 'Identifier' && typeof n.name === 'string' && n.name.startsWith(RESERVED_PREFIX)) {
      reserved = n.name
    }
  })
  if (reserved) return { error: `Identifier '${reserved}' is reserved (the '${RESERVED_PREFIX}' prefix is internal).` }
  return { code }
}

// A friendly STATIC pre-check — does the body statically reference Date.now / Math.random
// / no-arg `new Date()`? The runtime shim already throws on these, but flagging them statically gives a
// clearer signal than a deep-in-execution throw. Non-fatal: returns the offending names (caller may warn).
export function detectNonDeterminism(scriptBody: string): string[] {
  const found = new Set<string>()
  let ast: Ast
  try {
    ast = parse(scriptBody, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }) as unknown as Ast
  } catch {
    return []
  }
  walk.simple(ast as never, {
    MemberExpression(node) {
      const n = node as unknown as Ast
      const obj = n.object as Ast
      const prop = n.property as Ast
      if (n.computed || obj.type !== 'Identifier' || prop.type !== 'Identifier') return
      if (obj.name === 'Date' && prop.name === 'now') found.add('Date.now')
      if (obj.name === 'Math' && prop.name === 'random') found.add('Math.random')
    },
    NewExpression(node) {
      const n = node as unknown as Ast
      const callee = n.callee as Ast
      if (callee.type === 'Identifier' && callee.name === 'Date' && (n.arguments as unknown[]).length === 0) {
        found.add('new Date()')
      }
    },
  })
  return [...found]
}

// ── orchestration primitives (批 2) ─────────────────────────────────────────────────────────────────────

// The total agent() spawns across ONE review's lifetime — a runaway
// backstop set far above any real review (~32-40 agents), never a normal throttle. The CONCURRENCY cap
// (min(16,cores-2)) is deliberately NOT here: it lives in the spawnAgent hook (批 5 → pool.ts), exactly like
// the Workflow tool, where parallel/pipeline just fire the thunks and a semaphore wraps each individual spawn.
export const LENS_MAX_AGENTS = 1000
// The per-call fan-out cap (parallel thunks / pipeline items) — an oversized batch is rejected, not fired.
export const LENS_MAX_FANOUT = 4096

// The script-facing agent() options — the Workflow agent opts (label/phase/schema/model/effort/isolation/
// agentType). Passed through to the spawnAgent hook; unknown keys are preserved.
export interface AgentOpts {
  label?: string
  phase?: string
  schema?: unknown
  model?: string
  effort?: string
  isolation?: string
  agentType?: string
  [k: string]: unknown
}

export interface OrchestrationHooks {
  // The host agent-spawn seam: receives the script's prompt + opts, returns the sub-agent's result as
  // JSON-safe data (text, or parsed structured output). 批 5 wires this to lens step.ts (runAgent over
  // pool.ts; unbounded turns, stall-timeout-bounded); unit tests inject a fake to prove the primitives off-channel.
  spawnAgent: (prompt: string, opts: AgentOpts) => Promise<unknown>
  onLog?: (msg: string) => void
  onPhase?: (title: string) => void
  maxAgents?: number
  signal?: AbortSignal // an aborted run stops fanning out new agents (in-flight ones abort via their own signal)
}

function reasonMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (reason && typeof reason === 'object' && 'message' in reason) return String((reason as { message: unknown }).message)
  return String(reason)
}

interface VmBridge {
  call: (fn: unknown, ...a: unknown[]) => unknown
  settle: (p: unknown) => Promise<{ v: unknown }>
  vmClone: (s: string) => unknown
  wrapHost: (h: unknown) => (...a: unknown[]) => Promise<unknown>
  toVm: (hostVal: unknown) => unknown
}

// Compile the cross-realm bridge helpers INSIDE the vm realm. The load-bearing rule: EVERYTHING the script can
// touch must be a vm-realm value. A HOST object or function placed on the context leaks the host realm's
// Function via `.constructor` (objects: `.constructor.constructor`) — codeGeneration:false only neuters the VM
// context, so the host realm still generates code → sandbox escape (empirically verified). So:
//   • call    — `(fn,...args) => fn(...args)` — invoke a vm-realm function (a thunk / stage)
//   • settle  — `async v => ({__proto__:null, v: await v})` — await a vm-realm thenable IN-realm, handing back
//               a {v} envelope so the host never holds a raw cross-realm thenable
//   • vmClone — `s => JSON.parse(s)` — materialize a host JSON value as a FRESH vm-realm object (severs host
//               references AND the host-realm prototype chain). A JSON round-trip is enough for lens's
//               JSON-safe data under this benign threat model.
//   • wrapHost— present a host primitive to the script as a VM-realm async function (its `.constructor` is the
//               neutered vm Function), cloning BOTH the resolve AND the reject path so a host throw never leaks
//               a host object the script could walk back to the host Function.
function vmBridge(ctx: vm.Context): VmBridge {
  const call = vm.runInContext('((fn, ...args) => fn(...args))', ctx, { filename: 'lens:call' }) as VmBridge['call']
  const settle = vm.runInContext('(async v => ({__proto__: null, v: await v}))', ctx, {
    filename: 'lens:settle',
  }) as VmBridge['settle']
  const vmClone = vm.runInContext('(s => JSON.parse(s))', ctx, { filename: 'lens:clone' }) as VmBridge['vmClone']
  // A host throw/rejection must NOT reach the script as a raw host object: its `.constructor.constructor` is the
  // live host Function (codeGeneration:false only neuters the vm context), so `try { await agent() } catch (e) {
  // e.constructor.constructor('return process')() }` would be host RCE. Catch it IN-realm and re-throw a vm-realm
  // Error carrying only a cloned string message — mirroring how toVm clones the RESOLVE path. Covers both async
  // rejections and synchronous throws of the host fn (e.g. the cap error, a validation TypeError).
  const wrapHost = vm.runInContext(
    '(h => async (...a) => { try { return await h(...a) } catch (e) { let m = "lens sub-agent error"; try { m = String(e && e.message != null ? e.message : e) } catch (_) {} throw new Error(m) } })',
    ctx,
    { filename: 'lens:wrap' },
  ) as VmBridge['wrapHost']
  const toVm = (hostVal: unknown): unknown => (hostVal === undefined ? undefined : vmClone(JSON.stringify(hostVal)))
  return { call, settle, vmClone, wrapHost, toVm }
}

// Inject agent/parallel/pipeline/phase/log onto the vm context, mirroring the Workflow tool's primitives. Each
// primitive is a host closure; it is exposed to the script ONLY through bridge.wrapHost so the script-visible
// function is vm-realm (no host-Function escape).
function injectPrimitives(ctx: vm.Context, bridge: VmBridge, hooks: OrchestrationHooks): void {
  const { call, settle, toVm, wrapHost } = bridge
  const maxAgents = hooks.maxAgents ?? LENS_MAX_AGENTS
  let agentCount = 0
  let currentPhase: string | undefined

  // Cap check before any spawn / fan-out.
  const checkCap = (): void => {
    if (agentCount >= maxAgents) {
      throw new Error(
        `studio_lens exceeded the ${maxAgents}-agent lifetime cap (runaway fan-out backstop) — the review folds with what completed.`,
      )
    }
  }
  // Coerce a vm-realm array-like into a host array, capped at LENS_MAX_FANOUT (an oversized batch is rejected,
  // not fired). Array.from keeps element references (thunks stay callable) while giving the host a clean array.
  const asArray = (v: unknown, what: string): unknown[] => {
    if (Array.isArray(v) || (v && typeof v === 'object' && typeof (v as { length?: unknown }).length === 'number')) {
      const arr = Array.from(v as ArrayLike<unknown>)
      if (arr.length > LENS_MAX_FANOUT) throw new RangeError(`fan-out of ${arr.length} exceeds the ${LENS_MAX_FANOUT}-item cap`)
      return arr
    }
    throw new TypeError(what)
  }
  // A slot value that cannot cross the vm boundary as JSON (BigInt / Symbol / cyclic / throwing getter) becomes
  // null in THAT slot rather than poisoning the whole batch's toVm clone.
  const jsonSafe = (x: unknown): unknown => {
    try {
      JSON.stringify(x)
      return x
    } catch {
      return null
    }
  }
  const aborted = (): boolean => hooks.signal?.aborted === true

  // agent(prompt, opts) — spawn ONE read-only reviewer sub-agent. Counts toward the cap, threads
  // the current phase onto opts, returns the result cloned into the vm realm.
  const agent = async (prompt: unknown, opts?: unknown): Promise<unknown> => {
    if (aborted()) throw new Error('review aborted')
    checkCap()
    agentCount++
    const o: AgentOpts = opts && typeof opts === 'object' ? { ...(opts as AgentOpts) } : {}
    if (currentPhase !== undefined && o.phase === undefined) o.phase = currentPhase
    const result = await hooks.spawnAgent(String(prompt), o)
    return toVm(result)
  }

  // parallel(thunks) — concurrency barrier: fire every thunk; a fulfilled thunk → its value, a
  // thrown thunk → null (degrade, never reject the whole batch). Returns a vm-realm array.
  const parallel = async (vmArr: unknown): Promise<unknown> => {
    if (aborted()) return toVm([])
    const thunks = asArray(vmArr, 'parallel() expects an array of functions')
    if (thunks.length === 0) return toVm([])
    checkCap()
    for (const t of thunks) {
      if (typeof t !== 'function') {
        throw new TypeError('parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)')
      }
    }
    // `async (t) =>` so a thunk that throws SYNCHRONOUSLY rejects its slot (→ null below) instead of
    // propagating out of .map and rejecting the whole batch. Upholds the Workflow contract ("a thunk that
    // throws → null; the call itself never rejects") even for sync throws; normal `() => agent(...)` thunks
    // reject asynchronously and behave identically.
    const settled = await Promise.allSettled(thunks.map(async (t) => settle(call(t))))
    const out = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value.v
      hooks.onLog?.(`parallel[${i}] failed: ${reasonMessage(r.reason)}`)
      return null
    })
    return toVm(out.map(jsonSafe))
  }

  // pipeline(items, ...stages) — NO barrier: each item flows through all stages independently;
  // every stage receives (prevResult, originalItem, index); a null result short-circuits the item's remaining
  // stages; a thrown stage → null for that item. Returns a vm-realm array.
  const pipeline = async (vmItems: unknown, ...stages: unknown[]): Promise<unknown> => {
    if (aborted()) return toVm([])
    const items = asArray(vmItems, 'pipeline() expects an array as the first argument')
    if (items.length === 0) return toVm([])
    checkCap()
    for (const s of stages) {
      if (typeof s !== 'function') {
        throw new TypeError('pipeline() stages must be functions: pipeline(items, item => ..., result => ...)')
      }
    }
    const settled = await Promise.allSettled(
      items.map(async (item, idx) => {
        let env = await settle(item)
        for (const stage of stages) {
          if (env.v === null) break
          env = await settle(call(stage, env.v, item, idx))
        }
        return env.v
      }),
    )
    const out = settled.map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      hooks.onLog?.(`pipeline[${i}] failed: ${reasonMessage(r.reason)}`)
      return null
    })
    return toVm(out.map(jsonSafe))
  }

  const phaseFn = (t: unknown): void => {
    currentPhase = typeof t === 'string' ? t : String(t)
    hooks.onPhase?.(currentPhase)
  }
  const logFn = (m: unknown): void => hooks.onLog?.(typeof m === 'string' ? m : `[${typeof m}]`)

  for (const [name, fn] of Object.entries({ agent, parallel, pipeline, phase: phaseFn, log: logFn })) {
    Object.defineProperty(ctx, name, { value: wrapHost(fn), writable: true, enumerable: true, configurable: true })
  }
}

// ── sandbox ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SandboxHooks {
  // 批 1 surface: orchestration logging only. agent/parallel/pipeline are injected from OrchestrationHooks (批 2).
  log?: (msg: string) => void
  phase?: (title: string) => void
}

// Build the hardened vm context: a null-prototype sandbox with code generation
// disabled (eval/Function throw → blocks the classic `constructor.constructor('return process')()` escape),
// then run the harden + date/random preludes INSIDE the realm, then inject args + log/phase. Returns the
// context ready for a compiled vm.Script.
export function createLensSandbox(
  args: unknown,
  hooks: SandboxHooks = {},
  orchestration?: OrchestrationHooks,
): vm.Context {
  const ctx = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  })
  // Run the determinism shim then the harden prelude; either order is safe since they touch disjoint globals.
  vm.runInContext(DATE_RANDOM_SHIM, ctx, { filename: 'lens:shim' })
  vm.runInContext(HARDEN_PRELUDE, ctx, { filename: 'lens:harden' })

  const bridge = vmBridge(ctx)
  // args injection: clone INTO the vm realm. A host object here would expose host Function via
  // `args.constructor.constructor` (a sandbox escape, verified) — the round-trip both severs host aliasing
  // and makes args a vm-realm object. undefined stays undefined. (A circular value throws → runScript's try.)
  const clonedArgs = args === undefined ? undefined : bridge.vmClone(JSON.stringify(args))
  Object.defineProperty(ctx, 'args', { value: clonedArgs, writable: true, enumerable: true, configurable: true })

  if (orchestration) {
    // 批 2: inject agent/parallel/pipeline + the async bridge; phase/log route to the orchestration hooks.
    injectPrimitives(ctx, bridge, orchestration)
  } else {
    // 批 1: orchestration logging only, no primitives — a script that calls agent() ReferenceErrors. log/phase
    // go through bridge.wrapHost so they're vm-realm functions, not host-Function escape vectors.
    const log = hooks.log ?? (() => {})
    const phase = hooks.phase ?? (() => {})
    Object.defineProperty(ctx, 'log', {
      value: bridge.wrapHost((m: unknown) => log(typeof m === 'string' ? m : `[${typeof m}]`)),
      writable: true, enumerable: true, configurable: true,
    })
    Object.defineProperty(ctx, 'phase', {
      value: bridge.wrapHost((t: unknown) => phase(typeof t === 'string' ? t : String(t))),
      writable: true, enumerable: true, configurable: true,
    })
  }
  return ctx
}

// ── execute ─────────────────────────────────────────────────────────────────────────────────────────────

export interface RunScriptOptions {
  src: string
  args?: unknown
  hooks?: SandboxHooks
  // When present, agent/parallel/pipeline are injected (批 2) and the script can orchestrate sub-agents.
  // Absent → 批 1 pure-computation path (no primitives).
  orchestration?: OrchestrationHooks
  timeoutMs?: number
}

export type RunScriptResult = { ok: true; meta: ScriptMeta; value: unknown } | { ok: false; error: string }

// End-to-end: parse+validate → transpile → sandbox → compile → run → settle. Without opts.orchestration this
// is the 批 1 pure-computation path (args in, value out). With it (批 2), agent/parallel/pipeline are live and
// the script orchestrates sub-agents through the injected spawnAgent hook.
export async function runScript(opts: RunScriptOptions): Promise<RunScriptResult> {
  const parsed = parseScript(opts.src)
  if ('error' in parsed) return { ok: false, error: parsed.error }

  const t = transpile(parsed.scriptBody)
  if ('error' in t) return { ok: false, error: t.error }

  let script: vm.Script
  try {
    script = new vm.Script(t.code, {
      filename: 'lens-script.js',
      // import() is unavailable — a lens script is self-contained, not a module loader.
      importModuleDynamically: (() => {
        throw new Error('import() is not available in lens scripts.')
      }) as never,
    })
  } catch (e) {
    return { ok: false, error: `Script compile error: ${e instanceof Error ? e.message : String(e)}` }
  }

  // Sandbox build + settle bridge + execution all live inside one try, so any failure — an args-clone error
  // (e.g. a circular value), a prelude throw, a script throw, or a sync-timeout — degrades to ok:false
  // instead of escaping runScript.
  try {
    const ctx = createLensSandbox(opts.args, opts.hooks, opts.orchestration)
    // settle bridge: the wrapped IIFE returns a vm-realm Promise. Awaiting a cross-realm
    // thenable directly is brittle, so we await it INSIDE the realm via a tiny helper that hands back a
    // null-prototype { v } envelope — the host then reads `.v`.
    const settle = vm.runInContext('(async v => ({__proto__: null, v: await v}))', ctx, {
      filename: 'lens:settle',
    }) as (p: unknown) => Promise<{ v: unknown }>
    const promise = script.runInContext(ctx, { timeout: opts.timeoutMs ?? LENS_SCRIPT_TIMEOUT_MS })
    const settled = await settle(promise)
    return { ok: true, meta: parsed.meta, value: settled.v }
  } catch (e) {
    return { ok: false, error: `Script execution error: ${e instanceof Error ? e.message : String(e)}` }
  }
}
