// Install integrity (review round-4 P1-3). Two guarantees for the source folder of an install:
//   realDir  — resolve to the CANONICAL real path (root symlink followed), so a symlink sitting inside the
//              working folder can't be labeled "inside cwd" by the renderer's string-only check (the
//              renderer has no fs to realpath) and quietly install content from outside it. Preview and
//              install both operate on — and digest — the SAME real location.
//   digestDir — a stable content digest of the folder, computed at PREVIEW and re-computed at INSTALL. If
//              the source changed between the user reviewing the preview and the install running, the digests
//              differ → abort and install nothing (the review→install TOCTOU), rather than installing
//              something other than what was approved.

import { createHash } from 'node:crypto'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { MATERIALIZE_MAX_BYTES, MATERIALIZE_MAX_FILES } from './materialize'

// Canonical real path of a source directory (root symlink resolved). Throws if the path doesn't exist — the
// install callers already existence-check first, so a throw here is a genuinely vanished/broken source.
export async function realDir(dir: string): Promise<string> {
  return realpath(dir)
}

// sha256 over every REGULAR file's (relative-path, content), sorted so the result is independent of walk
// order. Applies the SAME skips materialize does — .git / .DS_Store / symlinks — because symlinks are never
// copied into the materialized payload, so hashing them would diverge from what actually installs. This is
// what binds the preview the user approved to the bytes the install writes.
//
// STREAMED, not buffered: collect the relative paths first (readdir yields names — no content read), sort
// them, then read + hash ONE FILE AT A TIME so peak memory is a single file, not the whole tree. It runs on
// the MAIN process at both preview (dialog open) and install, and a plugin/MCP folder can legitimately carry
// a large node_modules — buffering every file at once would spike RSS / freeze the app. It honors the SAME
// file-count / byte cap materialize enforces, so a mis-pointed source (a repo root, ~) is rejected cheaply
// (the count cap trips during the read-free walk) instead of being read at all.
export async function digestDir(dir: string): Promise<string> {
  const rels: string[] = []
  async function walk(d: string): Promise<void> {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.DS_Store') continue
      if (entry.isSymbolicLink()) continue // never copied → never hashed
      const p = join(d, entry.name)
      if (entry.isDirectory()) await walk(p)
      else if (entry.isFile()) {
        rels.push(relative(dir, p).split(sep).join('/'))
        if (rels.length > MATERIALIZE_MAX_FILES) {
          throw new Error(`source folder exceeds the install limit (${MATERIALIZE_MAX_FILES.toLocaleString()} files) — point the install at the extension's own folder, not a parent directory`)
        }
      }
    }
  }
  await walk(dir)
  rels.sort()
  const h = createHash('sha256')
  let bytes = 0
  for (const rel of rels) {
    const buf = await readFile(join(dir, rel)) // node's join treats the posix '/' in rel as a separator on every OS
    bytes += buf.length
    if (bytes > MATERIALIZE_MAX_BYTES) {
      throw new Error(`source folder exceeds the install limit (${Math.round(MATERIALIZE_MAX_BYTES / (1024 * 1024))} MB) — point the install at the extension's own folder, not a parent directory`)
    }
    h.update(rel)
    h.update('\0')
    h.update(buf)
    h.update('\0')
  }
  return h.digest('hex')
}
