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
