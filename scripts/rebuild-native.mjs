// Rebuild node-pty (the app's only native dependency) against the installed Electron's ABI.
//
// Two reasons the binary isn't usable straight from `npm install`:
//   1. npm 11 no longer runs dependency install scripts by default, so node-pty's node-gyp build never
//      fires — there's no compiled binary at all.
//   2. Even when it does build, node-pty targets the SYSTEM Node ABI; Electron bundles its own Node, so
//      that binary fails to load in the Electron main process.
// @electron/rebuild compiles node-pty against Electron's headers. Idempotent: a marker records which
// Electron version the current binary was built for, so this is a no-op on repeat installs.
// Skips silently when @electron/rebuild isn't present (a production `--omit=dev` install ships the
// already-rebuilt binary inside the asar-unpacked bundle — see electron-builder.yml).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const root = process.cwd()

const ptyDir = join(root, 'node_modules', 'node-pty')
const electronPkg = join(root, 'node_modules', 'electron', 'package.json')
const rebuildBin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild')
if (!existsSync(ptyDir) || !existsSync(electronPkg) || !existsSync(rebuildBin)) process.exit(0)

const electronVersion = require(electronPkg).version
const binary = join(ptyDir, 'build', 'Release', 'pty.node')
const marker = join(ptyDir, 'build', 'Release', '.electron-abi')
if (existsSync(binary) && existsSync(marker) && readFileSync(marker, 'utf8').trim() === electronVersion) {
  process.exit(0) // already built for this Electron
}

console.log(`[rebuild-native] building node-pty against Electron ${electronVersion}...`)
execFileSync(rebuildBin, ['--only', 'node-pty', '--force'], { stdio: 'inherit', cwd: root })
writeFileSync(marker, electronVersion)
console.log('[rebuild-native] node-pty ready')
