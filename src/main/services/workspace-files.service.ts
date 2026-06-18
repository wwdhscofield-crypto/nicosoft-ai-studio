/* ============================================================
   Workspace · Files service — the ONLY way the renderer reads the project tree.
   The renderer passes (convId, relPath); this resolves convId → the conversation's
   confine root (conversations.cwd, design §3 decision A) and runs every path through
   confineReal (realpath + prefix check — symlink/escape-safe) before any I/O. The
   renderer never traffics absolute paths.
   ============================================================ */
import { shell } from 'electron'
import { readdir, stat, readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { confineReal } from '../agent/confine'
import * as convService from './conversation.service'
import type { FsListDirResult, FsReadForViewResult, FsEntryDto } from '../ipc/contracts'

const MAX_VIEW_BYTES = 1024 * 1024 // 1 MB text cap for the viewer (design §3 P18; distinct from agent Read's 256 KB)
const MAX_IMAGE_BYTES = 8 * 1024 * 1024 // don't base64 a huge image into the renderer
const SNIFF_BYTES = 4096 // header window for the NUL / UTF-8 binary check
const ENTRY_CAP = 1000 // single-directory entry cap (design §3 P5) — main truncates, the UI shows "more"

// Extensions whose file openDefault refuses to hand the OS (design §3 P15): opening one with the default
// app would EXECUTE it, and a cwd routinely holds agent/clone/npm-dropped, unaudited content. The
// execute-bit check below covers chmod+x scripts of any extension; this list covers the Windows/macOS
// double-click-runs set that may not carry a unix exec bit.
const EXEC_EXTS = new Set([
  '.app', '.command', '.desktop', '.scpt', '.applescript', '.action', '.workflow',
  '.sh', '.bash', '.zsh', '.bat', '.cmd', '.com', '.exe', '.msi', '.scr',
  '.ps1', '.psm1', '.vbs', '.vbe', '.wsf', '.wsh', '.jar', '.jse',
  '.bin', '.run', '.appimage', '.pkg', '.dmg'
])

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif'
}

// ext → a highlighter language id the renderer's Shiki viewer understands. Unknown → 'text' (plain).
const LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.jsonc': 'json', '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown',
  '.go': 'go', '.py': 'python', '.rb': 'ruby', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.php': 'php',
  '.css': 'css', '.scss': 'scss', '.less': 'less', '.html': 'html', '.xml': 'xml', '.vue': 'vue', '.svelte': 'svelte',
  '.sh': 'bash', '.bash': 'bash', '.zsh': 'bash', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.ini': 'ini',
  '.sql': 'sql', '.graphql': 'graphql', '.dockerfile': 'docker', '.env': 'bash', '.gitignore': 'text'
}

function langForExt(ext: string): string {
  return LANG[ext] ?? 'text'
}

// Resolve convId → cwd; throw a typed message the handler surfaces. listDir handles no-cwd as an empty
// result instead (so the panel renders its empty state); the other ops require a cwd.
function requireCwd(convId: string): string {
  const cwd = convService.getCwd(convId)
  if (!cwd) throw new Error('This conversation has no working directory')
  return cwd
}

// List one directory level (design §3): name + type only — NO per-entry stat (avoids the syscall storm
// on node_modules-sized dirs, design §3 P18). Folders first, then case-insensitive name order.
export async function listDir(convId: string, relPath: string): Promise<FsListDirResult> {
  const cwd = convService.getCwd(convId)
  if (!cwd) return { root: null, entries: [], truncated: false }
  const abs = await confineReal(cwd, relPath || '.')
  const dirents = await readdir(abs, { withFileTypes: true })
  const entries: FsEntryDto[] = dirents.map((d) => ({ name: d.name, type: d.isDirectory() ? 'dir' : 'file' }))
  entries.sort((a, b) =>
    a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  )
  const truncated = entries.length > ENTRY_CAP
  return { root: cwd, entries: truncated ? entries.slice(0, ENTRY_CAP) : entries, truncated }
}

// Read a file for the by-type viewer (design §3). Images → data URL; text → decoded string + lang;
// binary / oversize → a kind flag with no content. Binary detection (P18): a NUL in the header OR a
// strict (fatal) UTF-8 decode failure — never the default lossy toString.
export async function readForView(convId: string, relPath: string): Promise<FsReadForViewResult> {
  const cwd = requireCwd(convId)
  const abs = await confineReal(cwd, relPath)
  const st = await stat(abs)
  if (!st.isFile()) throw new Error('Not a file')
  const ext = extname(abs).toLowerCase()
  const mime = IMAGE_MIME[ext]
  if (mime) {
    if (st.size > MAX_IMAGE_BYTES) return { kind: 'toolarge', size: st.size }
    const buf = await readFile(abs)
    return { kind: 'image', dataUrl: `data:${mime};base64,${buf.toString('base64')}`, size: st.size, mtime: st.mtimeMs }
  }
  if (st.size > MAX_VIEW_BYTES) return { kind: 'toolarge', size: st.size }
  const buf = await readFile(abs)
  const head = buf.subarray(0, Math.min(SNIFF_BYTES, buf.length))
  if (head.includes(0)) return { kind: 'binary', size: st.size }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return { kind: 'binary', size: st.size }
  }
  return { kind: 'text', text, lang: langForExt(ext), size: st.size, mtime: st.mtimeMs }
}

// Open a file with the OS default app — gated (design §3 P15): refuse an execute bit or an executable/
// script/bundle extension so this can't be turned into "double-click to run an unaudited cwd file".
export async function openDefault(convId: string, relPath: string): Promise<void> {
  const cwd = requireCwd(convId)
  const abs = await confineReal(cwd, relPath)
  const st = await stat(abs)
  if (!st.isFile()) throw new Error('Not a file')
  // Strip trailing dots/spaces BEFORE taking the extension: Windows ShellExecute drops them when opening,
  // so 'payload.exe.' / 'x.bat ' would execute as .exe/.bat while extname() sees '.'/'.bat ' and lets them
  // past the blocklist. realpath keeps the trailing chars, so normalize here (the POSIX mode bit below is
  // unreliable on Windows, making this blocklist the real gate there).
  const ext = extname(basename(abs).replace(/[. ]+$/, '')).toLowerCase()
  if ((st.mode & 0o111) !== 0 || EXEC_EXTS.has(ext)) {
    throw new Error('Refused: executable files are not opened from the Files panel')
  }
  const err = await shell.openPath(abs) // returns '' on success, an error string otherwise
  if (err) throw new Error(err)
}

// Reveal a cwd-relative path in the OS file manager (Finder/Explorer). Repurposed from the old
// absolute-path shell:reveal (design §3 P25) — now confined like every other fs op.
export async function reveal(convId: string, relPath: string): Promise<void> {
  const cwd = requireCwd(convId)
  const abs = await confineReal(cwd, relPath)
  shell.showItemInFolder(abs)
}
