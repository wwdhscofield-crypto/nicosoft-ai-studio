import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Bake the app version from package.json at build time. app.getVersion() is unreliable when the main
// process is launched directly (electron out/main/index.js) — it returns the Electron runtime version
// instead of the app's. Injecting here is correct in both dev and packaged builds.
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf-8')) as { version: string }

// src/shared/ holds cross-process single-source modules (thinking tables, role names) imported by BOTH
// the main process and the renderer — the alias keeps the import spelling identical on either side.
const sharedAlias = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        // externalizeDepsPlugin only externalizes `dependencies` — playwright is a DEV dependency
        // (Playwright browser tool, dev roles only), so rollup BUNDLED it into out/main. Bundling hoisted
        // playwright-core's lazy `require("chromium-bidi/…")` (never executed on the normal launch
        // paths) into an eager top-level require, crashing EVERY Playwright browser launch with "Cannot find
        // module 'chromium-bidi/…'". Externalized, import('playwright') resolves the real package from
        // node_modules in dev (lazy requires stay lazy), and a packaged build (no devDeps) fails
        // cleanly into the tool's existing "playwright unavailable" path — the degradation its header
        // comment was designed for.
        external: ['playwright', 'playwright-core']
      }
    },
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        ...sharedAlias
      }
    },
    plugins: [react()]
  }
})
