// Install-source resolution + the confirmation-dialog gate (extension-install-design §5.3, re-anchored
// 2026-07-11). The install source is the CONVERSATION's working folder (or a path the user gives in
// chat) — the old global `extensions.sourceDir` setting is gone. Pure string logic, dependency-free, so
// the dialog and its e2e both use the SAME predicate (no drift between what the UI enforces and what the
// test pins). Mirrors the main-side resolveDir in agent/tools/install-extension.ts.

// True when a path is absolute (posix, Windows drive, or UNC) — a leading test that covers both OSes so
// we never mis-join a Windows path with a posix separator.
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

// Resolve a proposed folder against the conversation's working dir: an absolute path stands as-is; a
// relative one ("./my-skill", "my-skill") resolves UNDER cwd. Empty or no-cwd → returned unchanged (the
// dialog then asks the user to pick). Matches the tool's resolveDir so the dialog shows, previews, and
// gates on the exact absolute path the install will use.
export function resolveInstallDir(dir: string, cwd?: string | null): string {
  const d = (dir ?? '').trim()
  if (!d || !cwd || isAbsolutePath(d)) return d
  const base = cwd.replace(/[/\\]+$/, '')
  return `${base}/${d.replace(/^\.\//, '')}`
}

// Is this (already-resolved, absolute) folder inside the conversation's working folder? Inside → the user
// set that cwd and works there, so it's authorized ground. The empty cwd / empty dir cases are NOT inside.
export function isInsideCwd(dir: string, cwd?: string | null): boolean {
  const base = cwd ? cwd.replace(/[/\\]+$/, '') : ''
  // A `..` segment can textually start with base yet resolve OUTSIDE it ("/work/../etc" → "/etc"). The
  // renderer has no path module to normalize, and the main-side join() DOES normalize — so a dot-dot path
  // would display one place and install another, escaping the gate. Fail closed: any `..` segment makes
  // the path "not inside", forcing a native re-pick (which yields a clean, normalized absolute path).
  if (!base || !dir || dir.split(/[/\\]/).includes('..')) return false
  return dir === base || dir.startsWith(base + '/') || dir.startsWith(base + '\\')
}

// The gate: block confirmation when the proposed folder is OUTSIDE the working folder AND the user hasn't
// hand-picked it. A hand-pick (the native picker click) is provable authorization and always clears the
// gate; an empty proposal isn't blocked (there's simply nothing to install yet — a separate "needs a
// folder" state handles that).
export function installDirBlocked(dir: string, cwd: string | null | undefined, pickedByUser: boolean): boolean {
  return !!dir && !isInsideCwd(dir, cwd) && !pickedByUser
}
