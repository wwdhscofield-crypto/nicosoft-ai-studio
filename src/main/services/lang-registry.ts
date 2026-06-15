// Single source of truth for per-language toolchain knowledge — manifests, build/check commands, "is this a
// verify command" patterns, and code-file extensions. Three call sites used to hard-code their OWN narrow
// language lists and drifted apart: subject-build.detectChecks (shared build), loop-guards.VERIFY_COMMAND_RE
// (edit-without-verify nudge), coordinator-route.isNonTrivialTask (fallback Gate-B trigger). They now ALL
// derive from this registry, so adding a language is a one-place change and the three can't disagree.
//
// Coverage target: the mainstream of the TIOBE top-20 + the common rest. Honesty over breadth on buildChecks:
// only languages whose build/typecheck can be driven RELIABLY and FAST from a manifest get a buildChecks (the
// shared build runs it as ground truth). Interpreted / hard-to-automate stacks (python/ruby/php/r/cpp/…) get
// NO buildChecks — the shared build is ran:false for them and the subject reasons from the diff + its own reads,
// rather than running a slow/flaky/wrong command. verifyPatterns + extensions still cover them fully.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

type BuildCmd = [string, string[]]
type BuildChecks = ReadonlyArray<readonly [string, readonly string[]]> | ((cwd: string) => BuildCmd[])

export interface LangEntry {
  id: string
  extensions: readonly string[] // → CODE_EXTENSIONS (is-a-code-file); broadest coverage, incl. niche langs
  manifests?: readonly string[] // → detectBuildChecks (exact-filename presence ⇒ this stack is the project)
  manifestSuffixes?: readonly string[] // manifests matched by suffix instead of exact name (e.g. *.csproj, *.cabal)
  buildChecks?: BuildChecks // → shared build commands; omitted = no reliable fast build for this stack
  verifyPatterns?: readonly RegExp[] // → VERIFY_COMMAND_RE (does this Bash command verify the project?)
}

function readPackageScripts(cwd: string): Set<string> {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    return new Set(Object.keys(pkg.scripts ?? {}))
  } catch {
    return new Set()
  }
}

// Ordered: compiled / backend stacks first so a polyglot repo (e.g. a Go service with a Node web/) resolves
// its primary build. detectBuildChecks returns the FIRST manifest match.
export const LANGUAGES: readonly LangEntry[] = [
  {
    id: 'go',
    extensions: ['.go'],
    manifests: ['go.mod'],
    buildChecks: [['go', ['build', './...']], ['go', ['vet', './...']]],
    verifyPatterns: [/\bgo\s+(?:test|vet|build)\b/, /\bgolangci-lint\b/],
  },
  {
    id: 'rust',
    extensions: ['.rs'],
    manifests: ['Cargo.toml'],
    buildChecks: [['cargo', ['check']]],
    verifyPatterns: [/\bcargo\s+(?:test|check|clippy|build)\b/],
  },
  {
    id: 'node', // TypeScript + JavaScript (same toolchain)
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    manifests: ['package.json', 'tsconfig.json', 'deno.json', 'deno.jsonc'],
    buildChecks: (cwd) => {
      const scripts = readPackageScripts(cwd)
      const cmds: BuildCmd[] = []
      if (scripts.has('typecheck')) cmds.push(['npm', ['run', 'typecheck']])
      else if (existsSync(join(cwd, 'tsconfig.json'))) cmds.push(['npx', ['--no-install', 'tsc', '--noEmit']])
      if (scripts.has('build')) cmds.push(['npm', ['run', 'build']])
      return cmds
    },
    verifyPatterns: [
      /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|type-check|lint|check|build)\b/,
      /\bnpx\s+(?:tsc|vitest|jest|eslint|playwright)\b/,
      /(?<![./\w-])(?:tsc|vitest|jest|eslint)\b(?!\.\w)/,
      /\bnode\s+--test\b/,
      /\bdeno\s+(?:test|check|lint)\b/,
    ],
  },
  {
    id: 'jvm', // Java / Kotlin / Scala / Groovy — Maven / Gradle / sbt
    extensions: ['.java', '.kt', '.kts', '.scala', '.groovy', '.gradle'],
    manifests: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'build.sbt'],
    buildChecks: (cwd) => {
      if (existsSync(join(cwd, 'pom.xml'))) return [['mvn', ['-q', '-DskipTests', 'test-compile']]]
      if (existsSync(join(cwd, 'build.sbt'))) return [['sbt', ['compile']]]
      if (existsSync(join(cwd, 'build.gradle')) || existsSync(join(cwd, 'build.gradle.kts'))) return [['gradle', ['--console=plain', '-x', 'test', 'assemble']]]
      return []
    },
    verifyPatterns: [/\bmvn\s+(?:test|verify|package)\b/, /(?:\bgradle\b|gradlew)\s+(?:test|check|build)\b/, /\bsbt\s+(?:test|compile)\b/],
  },
  {
    id: 'dotnet', // C# / F# / VB.NET
    extensions: ['.cs', '.fs', '.vb'],
    manifests: ['global.json'],
    manifestSuffixes: ['.csproj', '.fsproj', '.vbproj', '.sln'],
    buildChecks: [['dotnet', ['build', '--nologo']]],
    verifyPatterns: [/\bdotnet\s+(?:test|build)\b/],
  },
  {
    id: 'swift',
    extensions: ['.swift'],
    manifests: ['Package.swift'],
    buildChecks: [['swift', ['build']]],
    verifyPatterns: [/\bswift\s+(?:test|build)\b/, /\bxcodebuild\b/],
  },
  {
    id: 'dart', // Dart / Flutter
    extensions: ['.dart'],
    manifests: ['pubspec.yaml'],
    buildChecks: (cwd) => {
      try {
        if (/^\s*flutter\s*:/m.test(readFileSync(join(cwd, 'pubspec.yaml'), 'utf8'))) return [['flutter', ['analyze']]]
      } catch {
        /* fall through to dart */
      }
      return [['dart', ['analyze']]]
    },
    verifyPatterns: [/\bdart\s+(?:test|analyze)\b/, /\bflutter\s+(?:test|analyze)\b/],
  },
  {
    id: 'elixir',
    extensions: ['.ex', '.exs'],
    manifests: ['mix.exs'],
    buildChecks: [['mix', ['compile']]],
    verifyPatterns: [/\bmix\s+(?:test|compile)\b/],
  },
  {
    id: 'haskell',
    extensions: ['.hs', '.lhs'],
    manifests: ['stack.yaml'],
    manifestSuffixes: ['.cabal'],
    buildChecks: (cwd) => (existsSync(join(cwd, 'stack.yaml')) ? [['stack', ['build']]] : [['cabal', ['build']]]),
    verifyPatterns: [/\b(?:cabal|stack)\s+(?:test|build)\b/],
  },
  // --- no reliable fast auto-build → verifyPatterns + extensions only (shared build ran:false) ---
  {
    id: 'python',
    extensions: ['.py', '.pyi'],
    manifests: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'tox.ini'],
    verifyPatterns: [/\bpytest\b/, /\bpython3?\s+-m\s+(?:pytest|unittest|mypy)\b/, /(?<![./\w-])mypy\b/, /\bruff\s+check\b/, /\b(?:tox|nox)\b/],
  },
  {
    id: 'cpp', // C / C++ — build is too project-specific (cmake/make/configure) to auto-run reliably
    extensions: ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.hh'],
    verifyPatterns: [/\bctest\b/, /\bmake\s+(?:test|check|lint|build)\b/, /\bcmake\s+--build\b/],
  },
  {
    id: 'php',
    extensions: ['.php'],
    manifests: ['composer.json'],
    verifyPatterns: [/\b(?:phpunit|pest)\b/, /\bcomposer\s+(?:test|run)\b/, /\bphp\s+-l\b/],
  },
  {
    id: 'ruby',
    extensions: ['.rb', '.rake', '.gemspec'],
    manifests: ['Gemfile', 'Rakefile'],
    verifyPatterns: [/\b(?:rspec|minitest)\b/, /\bbundle\s+exec\s+(?:rspec|rake|ruby)\b/, /\brake\s+(?:test|spec)\b/, /\bruby\s+-c\b/],
  },
  {
    id: 'r',
    extensions: ['.r', '.R', '.Rmd'],
    manifests: ['DESCRIPTION'],
    verifyPatterns: [/\bR\s+CMD\s+check\b/, /\btestthat\b/, /\bRscript\b/],
  },
  {
    id: 'lua',
    extensions: ['.lua'],
    verifyPatterns: [/\bbusted\b/, /\bluacheck\b/],
  },
  {
    id: 'perl',
    extensions: ['.pl', '.pm', '.t'],
    verifyPatterns: [/\bprove\b/, /\bperl\s+-c\b/],
  },
  // --- niche / no standard CLI build+test → extensions only (still counts as a code file for routing) ---
  {
    id: 'misc',
    extensions: [
      '.sql', '.m', '.mm', '.mlx', // SQL, Objective-C / MATLAB
      '.vb', '.f', '.f90', '.f95', '.for', // Visual Basic, Fortran
      '.pas', '.dpr', '.cob', '.cbl', // Delphi/Pascal, COBOL
      '.asm', '.s', '.clj', '.cljs', '.cljc', // Assembly, Clojure
      '.erl', '.ml', '.mli', '.nim', '.zig', '.jl', '.cr', '.v', '.sol', // Erlang, OCaml, Nim, Zig, Julia, Crystal, V, Solidity
    ],
  },
]

// Detect the project's own build/check commands from its manifests (shared build, A). First manifest match
// wins (backend stacks ordered first for polyglot repos). Resolves a dynamic buildChecks against the cwd.
export function detectBuildChecks(cwd: string): BuildCmd[] {
  for (const lang of LANGUAGES) {
    if (!lang.buildChecks) continue
    const hit =
      (lang.manifests?.some((f) => existsSync(join(cwd, f))) ?? false) ||
      (lang.manifestSuffixes ? dirHasSuffix(cwd, lang.manifestSuffixes) : false)
    if (!hit) continue
    return typeof lang.buildChecks === 'function' ? lang.buildChecks(cwd) : lang.buildChecks.map(([c, a]) => [c, [...a]] as BuildCmd)
  }
  return []
}

// Cheap top-level check for a manifest by suffix (e.g. *.csproj / *.cabal) — reads the cwd dir once.
function dirHasSuffix(cwd: string, suffixes: readonly string[]): boolean {
  try {
    return readdirSync(cwd).some((n) => suffixes.some((s) => n.endsWith(s)))
  } catch {
    return false
  }
}

// All code-file extensions (isNonTrivialTask). Lowercased; callers compare lowercased.
export const CODE_EXTENSIONS: ReadonlySet<string> = new Set(LANGUAGES.flatMap((l) => l.extensions.map((e) => e.toLowerCase())))

// One combined "is this a verify command" matcher (loop-guards), built from every entry's patterns.
export const VERIFY_COMMAND_RE = new RegExp(LANGUAGES.flatMap((l) => l.verifyPatterns ?? []).map((r) => r.source).join('|'), 'i')

// A file-mention matcher for PROSE (isNonTrivialTask). Single-char extensions (.c/.h/.m/.s/.t/.r/.v) are
// EXCLUDED here: in plain English they collide with ordinary abbreviations ("a.m."/"p.m."/"B.s.") and would
// falsely flip the heuristic on non-code text. They remain in CODE_EXTENSIONS (exact-extension checks are
// safe); only this loose prose regex drops them. Extensions of length >= 2 are unambiguous enough to keep.
const PROSE_EXTS = [...CODE_EXTENSIONS].map((e) => e.slice(1)).filter((e) => e.length >= 2)
export const CODE_FILE_RE = new RegExp(String.raw`\b[\w./-]+\.(?:` + PROSE_EXTS.join('|') + String.raw`)\b`, 'gi')
