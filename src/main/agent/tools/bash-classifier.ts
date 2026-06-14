// Bash read-only classifier — quote-aware operator split. A command is read-only IFF every
// pipeline/chain segment is itself a read-only command AND the command contains no redirection,
// command/process substitution, subshell/group, or background operator. This supersedes the H1
// metachar-fail-closed stopgap so genuinely read-only pipes (`cat a | grep b`) and chains
// (`echo x && ls`) classify as read-only — parallelizable, no approval — while anything it can't
// prove read-only still falls through to "write" (serial + approval + plan-blocked).
//
// Deliberately NOT a full bash grammar (a full tree-sitter parser would be needed for that). It's the
// minimal quote-aware split needed to judge read-only intent: single/double quotes and backslash
// escapes are honored so operators inside them aren't mistaken for separators, and every exotic
// construct (substitution, redirect, subshell, heredoc, ANSI-C/locale quoting, background, embedded
// newline, unbalanced quote) fails closed to "write". Single linear pass — no recursion/backtracking,
// so no ReDoS surface on adversarial input.

// Read-only utilities with no destructive flags. find/sort/env/sed/awk are deliberately EXCLUDED:
// each has a write form (find -delete/-exec, sort -o, env-prefix hiding a write, sed -i) this
// classifier doesn't vet — they fall through to "write" (approval + serial + plan-blocked).
const READ_ONLY_CMDS = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'rg', 'wc', 'echo', 'pwd', 'which', 'type', 'stat', 'file',
  'tree', 'du', 'df', 'date', 'whoami', 'printenv', 'diff', 'uniq',
])
const GIT_READ_SUBS = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'ls-files', 'rev-parse'])

// Write/exec flags that turn an allowlisted read command into a write or arbitrary-exec:
// rg --pre runs a program per file; git/sort --output writes a file.
const DANGEROUS_FLAG = /--pre\b|--output\b/

// Split the command into pipeline/chain segments (each a list of raw words, quotes preserved).
// Returns null the moment it sees a construct that can't be statically proven read-only — the caller
// treats null as "write". Separators that legitimately chain simple commands: | || && ; (plus word
// whitespace). Everything else (< > redirect, $() `` <() substitution, () {} subshell/group, bare &
// background, |& ;; , embedded newline, unbalanced quote) → null.
function splitSegments(command: string): string[][] | null {
  const segments: string[][] = []
  let words: string[] = []
  let cur = ''
  let inWord = false
  const endWord = (): void => {
    if (inWord) {
      words.push(cur)
      cur = ''
      inWord = false
    }
  }
  const endSegment = (): void => {
    endWord()
    if (words.length > 0) {
      segments.push(words)
      words = []
    }
  }
  let i = 0
  const n = command.length
  while (i < n) {
    const c = command[i]!
    if (c === ' ' || c === '\t') {
      endWord()
      i++
      continue
    }
    if (c === '\n' || c === '\r') return null // embedded newline = multiple commands
    if (c === "'") {
      const end = command.indexOf("'", i + 1)
      if (end === -1) return null // unbalanced single quote — can't reason
      cur += command.slice(i, end + 1)
      inWord = true
      i = end + 1
      continue
    }
    if (c === '"') {
      cur += c
      inWord = true
      i++
      while (i < n && command[i] !== '"') {
        const d = command[i]!
        if (d === '\\' && i + 1 < n) {
          cur += command.slice(i, i + 2)
          i += 2
          continue
        }
        if (d === '`' || d === '$') return null // any substitution/expansion inside double quotes
        cur += d
        i++
      }
      if (i >= n) return null // unbalanced double quote
      cur += '"'
      i++
      continue
    }
    if (c === '\\') {
      if (i + 1 >= n) return null // trailing backslash
      cur += command.slice(i, i + 2)
      inWord = true
      i += 2
      continue
    }
    if (c === '`') return null // backtick substitution
    // Any $ expansion fails closed: $()/`` execute; $VAR / ${VAR} / $IFS expand to text that can
    // become an absolute path or an operator at runtime (cat $HOME/.ssh/id_rsa, cat $IFS/etc/passwd)
    // which a static scan can't vet. Inside single quotes $ is literal — handled by the SQUOTE skip.
    if (c === '$') return null
    if (c === '<' || c === '>') return null // redirect / process substitution
    if (c === '(' || c === ')' || c === '{' || c === '}') return null // subshell / command group
    if (c === '&') {
      if (command[i + 1] === '&') {
        endSegment()
        i += 2
        continue
      }
      return null // bare & = background
    }
    if (c === '|') {
      if (command[i + 1] === '&') return null // |& pipes stderr too
      endSegment()
      i += command[i + 1] === '|' ? 2 : 1 // | and || both separate segments
      continue
    }
    if (c === ';') {
      if (command[i + 1] === ';') return null // ;; case terminator
      endSegment()
      i++
      continue
    }
    cur += c
    inWord = true
    i++
  }
  endSegment()
  return segments
}

// Resolve a raw word (quotes/escapes) to its literal value, for command-name matching and path-escape
// checks — `cat '/etc/passwd'` must see the absolute path, not the leading quote.
function unquote(word: string): string {
  let out = ''
  let i = 0
  const n = word.length
  while (i < n) {
    const c = word[i]!
    if (c === "'") {
      const end = word.indexOf("'", i + 1)
      if (end === -1) {
        out += word.slice(i + 1)
        break
      }
      out += word.slice(i + 1, end)
      i = end + 1
      continue
    }
    if (c === '"') {
      i++
      while (i < n && word[i] !== '"') {
        if (word[i] === '\\' && i + 1 < n) {
          out += word[i + 1]
          i += 2
          continue
        }
        out += word[i]
        i++
      }
      i++
      continue
    }
    if (c === '\\' && i + 1 < n) {
      out += word[i + 1]
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

function isReadOnlySegment(words: string[]): boolean {
  if (words.length === 0) return false
  const name = unquote(words[0]!)
  const args = words.slice(1).map(unquote)
  // Known write/exec flag (checked post-unquote so `'--output'` / `--out""put` can't hide it).
  if (args.some((a) => DANGEROUS_FLAG.test(a))) return false
  // Path-ish arg escaping the project (absolute or containing ..). bash args don't go through
  // confineReal, so an auto-allowed read of /etc/passwd or ../secret must be denied here — the
  // dedicated Read/Grep tools confine; bash reads of outside-looking paths require approval.
  if (args.some((a) => !a.startsWith('-') && (a.startsWith('/') || a.includes('..')))) return false
  if (name === 'git') return GIT_READ_SUBS.has(unquote(words[1] ?? ''))
  return READ_ONLY_CMDS.has(name)
}

// A command is read-only iff every pipeline/chain segment is a read-only command and the splitter saw
// no write-capable construct. Empty / unparseable → false (write — fail closed).
export function isReadOnlyCommand(command: string): boolean {
  const segments = splitSegments(command)
  if (segments === null || segments.length === 0) return false
  return segments.every(isReadOnlySegment)
}

// --- System-software install detection -----------------------------------------------------------
// Flags commands that install SYSTEM software or GLOBAL tools (package managers, global language-tool
// installs) — the things that mutate the user's machine OUTSIDE the project. Used to keep bypass /
// coordinator auto-approval from SILENTLY installing software (the agent should implement a temporary
// in-language helper or surface a genuine system dependency to the user instead).
//
// Project-LOCAL dependency installs are deliberately NOT flagged — they only touch the project tree and
// are part of building it: `npm install` (no -g), `go mod download` / `go get`, `pip install -r reqs.txt`
// / `pip install -e .`, `cargo add`, `bundle install`, `composer install`. The distinction is global/system
// (flagged) vs project-local (allowed).
//
// Intent is to stop ACCIDENTAL silent installs by our own agent, NOT to be an adversarial sandbox: this is
// a TARGETED detector over directly-named install commands. An unparseable command (substitution/redirect)
// is not flagged here — it already fails closed to "write" (serial + approval) via isReadOnlyCommand — so
// this never broadens the write surface. A command hidden inside `sh -c '...'` or `$(...)` is out of scope.

// An inline env assignment (FOO=bar) prefixing a command.
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

// Peel benign command prefixes so the REAL program name is inspected. Without this, the head word is a
// wrapper (never the package manager) and an install slips every gate — these are NORMAL agent idioms, not
// adversarial tricks: `sudo -E apt install …`, `env DEBIAN_FRONTEND=noninteractive apt-get install …`,
// bare `DEBIAN_FRONTEND=… pip install …`, `command npm install -g …`. Strips: inline VAR=val assignments,
// sudo/doas (+ flags, incl. `-u user` value), env (+ its VAR=val / `-u name` / `-C dir` flags), and the
// command/nohup/setsid exec wrappers (+ flags).
function stripExecPrefix(words: string[]): string[] {
  let w = words
  for (;;) {
    if (w.length === 0) return w
    const head = w[0]!
    if (ENV_ASSIGN.test(head)) {
      w = w.slice(1)
      continue
    }
    if (head === 'sudo' || head === 'doas') {
      let j = 1
      while (j < w.length && w[j]!.startsWith('-')) {
        const takesValue = /^-[ugCp]$/.test(w[j]!) // -u user / -g group / -C limit / -p prompt
        j++
        if (takesValue && j < w.length && !w[j]!.startsWith('-')) j++
      }
      w = w.slice(j)
      continue
    }
    if (head === 'env') {
      let j = 1
      while (j < w.length) {
        const t = w[j]!
        if (ENV_ASSIGN.test(t)) {
          j++
          continue
        }
        if (t.startsWith('-')) {
          const takesValue = /^-[uC]$/.test(t) // -u name / -C dir
          j++
          if (takesValue && j < w.length && !w[j]!.startsWith('-')) j++
          continue
        }
        break
      }
      w = w.slice(j)
      continue
    }
    if (head === 'command' || head === 'nohup' || head === 'setsid') {
      let j = 1
      while (j < w.length && w[j]!.startsWith('-')) j++
      w = w.slice(j)
      continue
    }
    return w
  }
}

// True if a pip-style `install` arg list installs a BARE package (system/user site) rather than a
// project-local target. Shared by `pip` and `uv pip`. -r/-c (and other location flags) take a filename
// VALUE that must not be mistaken for a package; a target of `.`/a path/a requirements file is project-local.
const PIP_VALUE_FLAG = /^(-r|--requirement|-c|--constraint|-i|--index-url|--extra-index-url|-f|--find-links|-t|--target|--prefix|--root)$/
function isLocalPipTarget(t: string): boolean {
  return (
    t === '.' || t.startsWith('./') || t.startsWith('../') || t.startsWith('/') ||
    t.endsWith('.txt') || t.endsWith('.whl') || t.endsWith('.tar.gz')
  )
}
function pipInstallsBarePackage(args: string[]): boolean {
  const targets: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === 'install') continue
    if (a.startsWith('-')) {
      if (PIP_VALUE_FLAG.test(a) && i + 1 < args.length && !args[i + 1]!.startsWith('-')) i++ // skip the flag's value
      continue
    }
    targets.push(a)
  }
  if (targets.length === 0) return false // pure `-r reqs.txt` / `-e .` / flags-only install — project-local
  return targets.some((t) => !isLocalPipTarget(t)) // any bare package name → system/user install
}

function segmentIsSystemInstall(rawWords: string[]): boolean {
  // Peel sudo/doas/env/VAR=val/wrapper prefixes to inspect the real command.
  const words = stripExecPrefix(rawWords)
  if (words.length === 0) return false
  const name = words[0]!
  const args = words.slice(1)
  const has = (...tokens: string[]): boolean => args.some((a) => tokens.includes(a))
  const hasGlobal = has('-g', '--global', '--location=global')

  // `python -m pip install …` / `python -m pipx …` → re-dispatch as the pip/pipx command.
  if ((name === 'python' || name === 'python3') && args[0] === '-m' && (args[1] === 'pip' || args[1] === 'pipx')) {
    return segmentIsSystemInstall(args.slice(1))
  }

  // System package managers — any install/upgrade subcommand mutates the machine.
  if (name === 'brew') return has('install', 'reinstall', 'upgrade')
  if (name === 'apt' || name === 'apt-get' || name === 'aptitude') return has('install')
  if (name === 'yum' || name === 'dnf' || name === 'zypper') return has('install')
  if (name === 'pacman') {
    // -S group only. -Ss search / -Si info are read-only queries (allow); -Syu/-Su upgrade installs;
    // -S/-Sy WITH a package operand installs; bare -Sy/-Syy is a db refresh (allow).
    const sync = args.find((a) => /^-S/.test(a))
    if (!sync) return false
    if (/[si]/.test(sync.slice(2))) return false // -Ss / -Si query
    if (/u/.test(sync)) return true // -Su / -Syu upgrade
    return args.some((a) => !a.startsWith('-')) // a package operand → install
  }
  if (name === 'apk') return has('add')
  if (name === 'snap') return has('install')
  if (name === 'port') return has('install') // MacPorts
  // conda/mamba: only `conda install` (into an env) is flagged; `conda create` / `conda env create -f` build
  // a (typically project-local) environment — the conda analog of `python -m venv`, which is allowed.
  if (name === 'conda' || name === 'mamba') return has('install')

  // JS package managers — only GLOBAL installs; project-local (no -g) is allowed.
  if (name === 'npm' || name === 'pnpm' || name === 'bun') return hasGlobal && has('install', 'i', 'add')
  if (name === 'yarn') return has('global') // `yarn global add X`; plain `yarn add` is project-local

  // pip — bare-package install is system-ish; -r / -e / a local path are project deps (allowed).
  if (name === 'pip' || name === 'pip3') return has('install') && pipInstallsBarePackage(args)
  if (name === 'pipx') return has('install')

  // uv (Astral) — `uv tool install` is a global tool (like pipx); `uv pip install <pkg>` mirrors pip; project
  // deps (`uv add` / `uv sync` / `uv lock` / `uv venv`) and ephemeral runs (`uvx` / `uv tool run`) are allowed.
  if (name === 'uv') {
    if (args[0] === 'tool' && args[1] === 'install') return true
    if (args[0] === 'pip' && has('install')) return pipInstallsBarePackage(args.slice(1))
    return false
  }

  // Other language global-tool installs.
  if (name === 'gem') return has('install')
  if (name === 'cargo') return has('install') // builds + installs a global binary; `cargo add` / `build` allowed
  if (name === 'go') return args[0] === 'install' // `go install pkg`; `go mod` / `get` / `build` allowed
  if (name === 'composer') return has('global') // `composer global require`; project require/install allowed
  if (name === 'rustup') return has('install') || (args[0] === 'component' && args[1] === 'add')
  if (name === 'dotnet') return args[0] === 'tool' && has('install') && hasGlobal

  return false
}

// True if ANY pipeline/chain segment installs system software or a global tool. Quote-aware via the same
// splitter; unparseable → false (already gated as a write elsewhere — see note above).
export function isSystemSoftwareInstall(command: string): boolean {
  const segments = splitSegments(command)
  if (segments === null) return false
  return segments.some((seg) => segmentIsSystemInstall(seg.map(unquote)))
}
