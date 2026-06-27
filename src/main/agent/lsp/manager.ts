// Generic Language Server Protocol client over stdio. The JSON-RPC framing, request/notify flow,
// document sync, diagnostics push handling, and LSP result mappers are language-agnostic; language-specific
// behavior is limited to the curated registry below, extension→languageId lookup, and server start command.

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, extname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dataDir } from '../../db/connection'
import type { AskUser, PermissionMode, RequestPermission } from '../context'

const lspRequire = createRequire(__dirname)
const CACHE_FILE = 'lsp-availability.json'

export interface LspLocation {
  file: string
  line: number
  col: number
  endLine: number
  endCol: number
}
export interface LspDiagnostic {
  line: number
  col: number
  severity: string
  message: string
  source?: string
}
export interface LspRuntime {
  permissionMode: PermissionMode
  signal: AbortSignal
  askUser?: AskUser
  requestPermission: RequestPermission
}
export interface LspHandle {
  definition(file: string, line: number, col: number, runtime: LspRuntime): Promise<LspLocation[]>
  references(file: string, line: number, col: number, runtime: LspRuntime): Promise<LspLocation[]>
  hover(file: string, line: number, col: number, runtime: LspRuntime): Promise<string>
  diagnostics(file: string, runtime: LspRuntime): Promise<LspDiagnostic[]>
}

interface LanguageRegistryEntry {
  id: string
  label: string
  extensions: string[]
  languageId: string | ((ext: string) => string)
  serverCmd: string
  serverArgs: string[]
  installCmd?: string
  bundled?: boolean
  versionArgs?: string[]
}

const REGISTRY: LanguageRegistryEntry[] = [
  {
    id: 'typescript',
    label: 'TypeScript',
    extensions: ['.ts', '.tsx', '.mts', '.cts'],
    languageId: (ext) => (ext === '.tsx' ? 'typescriptreact' : 'typescript'),
    serverCmd: 'typescript-language-server',
    serverArgs: ['--stdio'],
    bundled: true,
  },
  {
    id: 'javascript',
    label: 'JavaScript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    languageId: (ext) => (ext === '.jsx' ? 'javascriptreact' : 'javascript'),
    serverCmd: 'typescript-language-server',
    serverArgs: ['--stdio'],
    bundled: true,
  },
  { id: 'go', label: 'Go', extensions: ['.go'], languageId: 'go', serverCmd: 'gopls', serverArgs: [], installCmd: 'go install golang.org/x/tools/gopls@latest', versionArgs: ['version'] },
  { id: 'python', label: 'Python', extensions: ['.py', '.pyi'], languageId: 'python', serverCmd: 'pyright-langserver', serverArgs: ['--stdio'], installCmd: 'python -m pip install pyright', versionArgs: ['--version'] },
  { id: 'rust', label: 'Rust', extensions: ['.rs'], languageId: 'rust', serverCmd: 'rust-analyzer', serverArgs: [], installCmd: 'rustup component add rust-analyzer', versionArgs: ['--version'] },
  { id: 'cpp', label: 'C/C++', extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx'], languageId: (ext) => (ext === '.c' || ext === '.h' ? 'c' : 'cpp'), serverCmd: 'clangd', serverArgs: [], installCmd: 'brew install llvm', versionArgs: ['--version'] },
  { id: 'java', label: 'Java', extensions: ['.java'], languageId: 'java', serverCmd: 'jdtls', serverArgs: [], installCmd: 'brew install jdtls', versionArgs: ['--version'] },
  { id: 'ruby', label: 'Ruby', extensions: ['.rb'], languageId: 'ruby', serverCmd: 'solargraph', serverArgs: ['stdio'], installCmd: 'gem install solargraph', versionArgs: ['--version'] },
]

const BY_EXT = new Map<string, LanguageRegistryEntry>()
for (const entry of REGISTRY) for (const ext of entry.extensions) BY_EXT.set(ext, entry)
export const LSP_EXTS = new Set(BY_EXT.keys())

interface CachedServer {
  status: 'available'
  serverPath: string
  version?: string
  detectedAt: string
}
interface CachedDecline {
  status: 'declined'
  declinedAt: string
}
type CacheEntry = CachedServer | CachedDecline
interface CacheFile {
  languages: Record<string, CacheEntry>
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

class LspUnavailableError extends Error {}

export class LSPManager implements LspHandle {
  private servers = new Map<string, LspServer>()

  constructor(private cwd: string) {}

  async definition(file: string, line: number, col: number, runtime: LspRuntime): Promise<LspLocation[]> {
    return this.withServer(file, runtime, (server, languageId) => server.definition(file, line, col, languageId))
  }

  async references(file: string, line: number, col: number, runtime: LspRuntime): Promise<LspLocation[]> {
    return this.withServer(file, runtime, (server, languageId) => server.references(file, line, col, languageId))
  }

  async hover(file: string, line: number, col: number, runtime: LspRuntime): Promise<string> {
    return this.withServer(file, runtime, (server, languageId) => server.hover(file, line, col, languageId))
  }

  async diagnostics(file: string, runtime: LspRuntime): Promise<LspDiagnostic[]> {
    return this.withServer(file, runtime, (server, languageId) => server.diagnostics(file, languageId))
  }

  dispose(): void {
    for (const server of this.servers.values()) server.dispose()
    this.servers.clear()
  }

  private async withServer<T>(file: string, runtime: LspRuntime, fn: (server: LspServer, languageId: string) => Promise<T>): Promise<T> {
    const entry = entryForFile(file)
    if (!entry) throw new LspUnavailableError(`LSP unavailable for ${extname(file) || 'this file'} — use text search (grep/read) instead.`)
    const languageId = languageIdFor(entry, file)
    let server = await this.serverFor(entry, runtime)
    try {
      return await fn(server, languageId)
    } catch (err) {
      if (entry.bundled) throw err
      server.dispose()
      this.servers.delete(entry.id)
      await clearCachedLanguage(entry.id)
      server = await this.serverFor(entry, runtime, true)
      return fn(server, languageId)
    }
  }

  private async serverFor(entry: LanguageRegistryEntry, runtime: LspRuntime, afterFailure = false): Promise<LspServer> {
    const existing = this.servers.get(entry.id)
    if (existing) return existing
    const resolved = await resolveServer(entry, this.cwd, runtime, afterFailure)
    const server = new LspServer(this.cwd, entry, resolved.command, resolved.args)
    this.servers.set(entry.id, server)
    return server
  }
}

class LspServer {
  private proc?: ChildProcess
  private seq = 0
  private pending = new Map<number, Pending>()
  private buffer = Buffer.alloc(0)
  private contentLength = -1
  private diagnosticsByUri = new Map<string, LspDiagnostic[]>()
  private diagWaiters = new Map<string, (() => void)[]>()
  private opened = new Map<string, number>()
  private ready?: Promise<void>

  constructor(
    private cwd: string,
    private entry: LanguageRegistryEntry,
    private command: string,
    private args: string[],
  ) {}

  dispose(): void {
    const proc = this.proc
    this.proc = undefined
    if (!proc) return
    this.failAllPending('LSP disposed')
    try {
      proc.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        proc.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, 2000)
  }

  async definition(file: string, line: number, col: number, languageId: string): Promise<LspLocation[]> {
    const uri = await this.openDoc(file, languageId)
    const result = await this.request('textDocument/definition', {
      textDocument: { uri },
      position: { line: line - 1, character: col - 1 },
    })
    return toLocations(result)
  }

  async references(file: string, line: number, col: number, languageId: string): Promise<LspLocation[]> {
    const uri = await this.openDoc(file, languageId)
    const result = await this.request('textDocument/references', {
      textDocument: { uri },
      position: { line: line - 1, character: col - 1 },
      context: { includeDeclaration: true },
    })
    return toLocations(result)
  }

  async hover(file: string, line: number, col: number, languageId: string): Promise<string> {
    const uri = await this.openDoc(file, languageId)
    const result = await this.request('textDocument/hover', {
      textDocument: { uri },
      position: { line: line - 1, character: col - 1 },
    })
    return hoverText(result)
  }

  async diagnostics(file: string, languageId: string): Promise<LspDiagnostic[]> {
    const uri = await this.openDoc(file, languageId)
    await this.waitDiagnostics(uri, 4000)
    return this.diagnosticsByUri.get(uri) ?? []
  }

  private ensure(): Promise<void> {
    if (!this.ready) this.ready = this.startServer()
    return this.ready
  }

  private async startServer(): Promise<void> {
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: this.entry.bundled ? '1' : process.env.ELECTRON_RUN_AS_NODE },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.proc.stdout?.on('data', (d: Buffer) => this.onData(d))
    this.proc.stderr?.on('data', () => {})
    this.proc.on('exit', () => this.failAllPending('LSP server exited'))
    this.proc.on('error', (e) => this.failAllPending(`LSP server failed to start: ${e.message}`))

    const rootUri = pathToFileURL(this.cwd).toString()
    await this.request('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'root' }],
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          references: {},
          hover: { contentFormat: ['plaintext', 'markdown'] },
          publishDiagnostics: {},
          synchronization: { dynamicRegistration: false, didSave: false },
        },
        workspace: { configuration: true, workspaceFolders: true },
      },
    })
    this.notify('initialized', {})
  }

  private async openDoc(file: string, languageId: string): Promise<string> {
    await this.ensure()
    const uri = pathToFileURL(file).toString()
    const text = await readFile(file, 'utf8')
    const version = (this.opened.get(file) ?? 0) + 1
    this.opened.set(file, version)
    if (version === 1) {
      this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } })
    } else {
      this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] })
    }
    return uri
  }

  private waitDiagnostics(uri: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const list = this.diagWaiters.get(uri) ?? []
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }
      list.push(done)
      this.diagWaiters.set(uri, list)
      setTimeout(done, timeoutMs)
    })
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.contentLength < 0) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) return
        const header = this.buffer.subarray(0, headerEnd).toString('ascii')
        const m = header.match(/Content-Length:\s*(\d+)/i)
        this.contentLength = m ? Number(m[1]) : 0
        this.buffer = this.buffer.subarray(headerEnd + 4)
      }
      if (this.buffer.length < this.contentLength) return
      const body = this.buffer.subarray(0, this.contentLength).toString('utf8')
      this.buffer = this.buffer.subarray(this.contentLength)
      this.contentLength = -1
      try {
        this.onMessage(JSON.parse(body))
      } catch {
        /* malformed frame — skip */
      }
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'number' ? msg.id : undefined
    if (id !== undefined && !msg.method) {
      const p = this.pending.get(id)
      if (p) {
        this.pending.delete(id)
        if (msg.error) p.reject(new Error((msg.error as { message?: string }).message ?? 'LSP error'))
        else p.resolve(msg.result)
      }
      return
    }
    if (msg.method === 'textDocument/publishDiagnostics') {
      const params = msg.params as { uri: string; diagnostics?: unknown[] }
      this.diagnosticsByUri.set(params.uri, (params.diagnostics ?? []).map(toDiag))
      const waiters = this.diagWaiters.get(params.uri)
      if (waiters) {
        this.diagWaiters.delete(params.uri)
        waiters.forEach((w) => w())
      }
      return
    }
    if (id !== undefined && msg.method) {
      if (msg.method === 'workspace/configuration') {
        const items = (msg.params as { items?: unknown[] })?.items ?? [{}]
        this.respond(id, items.map(() => ({})))
      } else {
        this.respond(id, null)
      }
    }
  }

  private write(obj: unknown): void {
    if (!this.proc?.stdin) return
    const buf = Buffer.from(JSON.stringify(obj), 'utf8')
    this.proc.stdin.write(`Content-Length: ${buf.length}\r\n\r\n`)
    this.proc.stdin.write(buf)
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.seq
    this.write({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`LSP ${method} timed out`))
      }, 15000)
    })
  }

  private notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private respond(id: number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  private failAllPending(message: string): void {
    for (const p of this.pending.values()) p.reject(new Error(message))
    this.pending.clear()
  }
}

function entryForFile(file: string): LanguageRegistryEntry | undefined {
  return BY_EXT.get(extname(file).toLowerCase())
}

function languageIdFor(entry: LanguageRegistryEntry, file: string): string {
  const ext = extname(file).toLowerCase()
  return typeof entry.languageId === 'function' ? entry.languageId(ext) : entry.languageId
}

async function resolveServer(entry: LanguageRegistryEntry, cwd: string, runtime: LspRuntime, afterFailure: boolean): Promise<{ command: string; args: string[] }> {
  if (entry.bundled) {
    const cliPath = lspRequire.resolve('typescript-language-server/lib/cli.mjs')
    return { command: process.execPath, args: [cliPath, ...entry.serverArgs] }
  }

  const cache = await readCache()
  const cached = cache.languages[entry.id]
  if (!afterFailure && cached?.status === 'available') return { command: cached.serverPath, args: entry.serverArgs }
  if (!afterFailure && cached?.status === 'declined') throw unavailable(entry, 'installation was declined')

  const probed = await probe(entry)
  if (probed) {
    cache.languages[entry.id] = { status: 'available', serverPath: probed.serverPath, version: probed.version, detectedAt: new Date().toISOString() }
    await writeCache(cache)
    return { command: probed.serverPath, args: entry.serverArgs }
  }

  if (runtime.permissionMode === 'bypass' || !runtime.askUser || !entry.installCmd) {
    console.warn(`[lsp] ${entry.label} language server unavailable; degrading to text search`)
    throw unavailable(entry, 'server is not installed')
  }

  const answer = await runtime.askUser({
    header: 'LSP',
    question: `This project uses ${entry.label}, but ${entry.serverCmd} is not installed. Install it? This runs: ${entry.installCmd}`,
    options: ['Install', 'Skip'],
  }, runtime.signal)
  if (answer !== 'Install') {
    cache.languages[entry.id] = { status: 'declined', declinedAt: new Date().toISOString() }
    await writeCache(cache)
    throw unavailable(entry, 'installation was declined')
  }

  const decision = await runtime.requestPermission({
    toolName: 'Bash',
    input: { command: entry.installCmd, description: `Install ${entry.serverCmd}` },
    reason: `${entry.label} LSP server is required for code intelligence.`,
  }, runtime.signal)
  if (!decision.allow) {
    cache.languages[entry.id] = { status: 'declined', declinedAt: new Date().toISOString() }
    await writeCache(cache)
    throw unavailable(entry, 'installation was denied')
  }

  await runInstall(entry.installCmd, cwd, runtime.signal)
  const installed = await probe(entry)
  if (!installed) throw unavailable(entry, 'install command completed but server is still unavailable')
  cache.languages[entry.id] = { status: 'available', serverPath: installed.serverPath, version: installed.version, detectedAt: new Date().toISOString() }
  await writeCache(cache)
  return { command: installed.serverPath, args: entry.serverArgs }
}

function unavailable(entry: LanguageRegistryEntry, reason: string): LspUnavailableError {
  return new LspUnavailableError(`LSP unavailable for ${entry.label} — ${reason}. Use text search (grep/read) instead.`)
}

async function clearCachedLanguage(language: string): Promise<void> {
  const cache = await readCache()
  delete cache.languages[language]
  await writeCache(cache)
}

async function probe(entry: LanguageRegistryEntry): Promise<{ serverPath: string; version?: string } | null> {
  const serverPath = findExecutable(entry.serverCmd)
  if (!serverPath) return null
  const version = entry.versionArgs ? await readVersion(serverPath, entry.versionArgs) : undefined
  return { serverPath, version }
}

function findExecutable(command: string): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : ['']
  for (const dir of dirs) {
    for (const suffix of extensions) {
      const candidate = join(dir, command.endsWith(suffix.toLowerCase()) || command.endsWith(suffix.toUpperCase()) ? command : `${command}${suffix}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function readVersion(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const done = (): void => resolve(out.trim().split('\n')[0]?.slice(0, 200) || undefined)
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8') })
    child.stderr?.on('data', (d: Buffer) => { out += d.toString('utf8') })
    child.on('error', () => resolve(undefined))
    child.on('exit', done)
    setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      done()
    }, 3000)
  })
}

function runInstall(command: string, cwd: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const onAbort = (): void => {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      reject(new Error('LSP install cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (d: Buffer) => { output += d.toString('utf8') })
    child.stderr?.on('data', (d: Buffer) => { output += d.toString('utf8') })
    child.on('error', (err) => {
      signal.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('exit', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (code === 0) resolve()
      else reject(new Error(`LSP install failed with exit ${code}: ${output.slice(-2000)}`))
    })
  })
}

async function readCache(): Promise<CacheFile> {
  try {
    const raw = await readFile(join(dataDir(), CACHE_FILE), 'utf8')
    const parsed = JSON.parse(raw) as CacheFile
    return { languages: parsed.languages ?? {} }
  } catch {
    return { languages: {} }
  }
}

async function writeCache(cache: CacheFile): Promise<void> {
  const dir = dataDir()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, CACHE_FILE), JSON.stringify(cache, null, 2), 'utf8')
}

interface LspRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

function toLocations(result: unknown): LspLocation[] {
  if (!result) return []
  const arr = (Array.isArray(result) ? result : [result]) as Record<string, unknown>[]
  const out: LspLocation[] = []
  for (const loc of arr) {
    const uri = (loc.uri ?? loc.targetUri) as string | undefined
    const range = (loc.range ?? loc.targetSelectionRange ?? loc.targetRange) as LspRange | undefined
    if (!uri || !range) continue
    out.push({
      file: fileURLToPath(uri),
      line: range.start.line + 1,
      col: range.start.character + 1,
      endLine: range.end.line + 1,
      endCol: range.end.character + 1,
    })
  }
  return out
}

function hoverText(result: unknown): string {
  const contents = (result as { contents?: unknown })?.contents
  if (!contents) return ''
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) return contents.map((c) => (typeof c === 'string' ? c : ((c as { value?: string }).value ?? ''))).join('\n')
  return (contents as { value?: string }).value ?? ''
}

const SEVERITY = ['', 'error', 'warning', 'info', 'hint']
function toDiag(d: unknown): LspDiagnostic {
  const diag = d as { range: LspRange; severity?: number; message: string; source?: string }
  return {
    line: diag.range.start.line + 1,
    col: diag.range.start.character + 1,
    severity: SEVERITY[diag.severity ?? 3] ?? 'info',
    message: diag.message,
    source: diag.source,
  }
}
