import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

/* eslint-disable @typescript-eslint/no-explicit-any */
export type PlaywrightModule = any
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface PlaywrightAvailability {
  packageAvailable: boolean
  source: 'project' | 'studio' | 'missing'
  chromiumAvailable: boolean | null
  packagePath?: string
  chromiumPath?: string
  message?: string
}

export class PlaywrightUnavailableError extends Error {
  constructor(readonly availability: PlaywrightAvailability, message: string) {
    super(message)
  }
}

export async function loadPlaywright(cwd: string): Promise<{ playwright: PlaywrightModule; availability: PlaywrightAvailability }> {
  const fromProject = loadProjectPlaywright(cwd)
  if (fromProject) return fromProject
  try {
    const playwright = await import('playwright')
    return {
      playwright,
      availability: {
        packageAvailable: true,
        source: 'studio',
        chromiumAvailable: null,
        message: 'Using Studio bundled Playwright package.',
      },
    }
  } catch (err) {
    const availability: PlaywrightAvailability = {
      packageAvailable: false,
      source: 'missing',
      chromiumAvailable: null,
      message: installGuidance('package', err instanceof Error ? err.message : String(err)),
    }
    throw new PlaywrightUnavailableError(availability, availability.message ?? 'Playwright is unavailable.')
  }
}

export async function loadPlaywrightForChromium(cwd: string): Promise<{ playwright: PlaywrightModule; availability: PlaywrightAvailability }> {
  const loaded = await loadPlaywright(cwd)
  const chromiumPath = loaded.playwright.chromium?.executablePath?.()
  const chromiumAvailable = typeof chromiumPath === 'string' && existsSync(chromiumPath)
  const availability: PlaywrightAvailability = { ...loaded.availability, chromiumAvailable, chromiumPath }
  if (!chromiumAvailable) {
    availability.message = installGuidance('chromium')
    throw new PlaywrightUnavailableError(availability, availability.message)
  }
  return { playwright: loaded.playwright, availability }
}

export async function getPlaywrightAvailability(cwd: string): Promise<PlaywrightAvailability> {
  try {
    const loaded = await loadPlaywright(cwd)
    const chromiumPath = loaded.playwright.chromium?.executablePath?.()
    return {
      ...loaded.availability,
      chromiumAvailable: typeof chromiumPath === 'string' && existsSync(chromiumPath),
      chromiumPath,
    }
  } catch (err) {
    if (err instanceof PlaywrightUnavailableError) return err.availability
    return {
      packageAvailable: false,
      source: 'missing',
      chromiumAvailable: null,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

function loadProjectPlaywright(cwd: string): { playwright: PlaywrightModule; availability: PlaywrightAvailability } | null {
  try {
    const req = createRequire(join(cwd, 'package.json'))
    const packagePath = req.resolve('playwright')
    return {
      playwright: req('playwright'),
      availability: {
        packageAvailable: true,
        source: 'project',
        chromiumAvailable: null,
        packagePath,
        message: 'Using project-local Playwright package.',
      },
    }
  } catch {
    return null
  }
}

function installGuidance(kind: 'package' | 'chromium', detail?: string): string {
  const suffix = detail ? ` Details: ${detail}` : ''
  if (kind === 'chromium') {
    return 'Playwright is installed, but the Chromium browser binary is missing. Ask the user before installing it, then run the project-appropriate command such as `npx playwright install chromium`; otherwise use preview_* Tier 1 tools.'
  }
  return 'Playwright is not available for this project. Ask the user before installing it in the project or environment; otherwise use preview_* Tier 1 tools.' + suffix
}
