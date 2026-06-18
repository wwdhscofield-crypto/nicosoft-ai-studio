// active-services.ts — convId → live ServiceRegistry handle + the conv:services broadcast.
//
// The registry is a per-run local in agent-collab / agent-dispatch; registering it here lets the renderer
// list / stop / read-logs of a running conversation's services on demand (services:* IPC). Registered when a
// run starts, cleared in its finally — one active run per conversation at a time.
//
// Broadcast is all-windows (the conv-scoped Tasks panel filters by convId), NOT the sender-based usage
// broadcaster: the registry's change/exit hooks fire asynchronously (a dev server can bind its port or die
// at any time), with no WebContents in scope at that moment.
import { BrowserWindow } from 'electron'
import type { ServiceHandle, ServiceInfo } from '../agent/service-registry'
import type { ConvServices } from '../ipc/contracts'

const active = new Map<string, ServiceHandle>()

export function setActiveServices(convId: string, handle: ServiceHandle): void {
  active.set(convId, handle)
}
// Clear only if this exact handle is still the current one — a newer run for the same conversation may have
// already replaced it, and that successor's registration must survive this run's finally.
export function clearActiveServices(convId: string, handle: ServiceHandle): void {
  if (active.get(convId) === handle) active.delete(convId)
}
export function activeServicesFor(convId: string): ServiceHandle | undefined {
  return active.get(convId)
}

// Tree-kill every live service across all conversations — called on app quit. A service's child is spawned
// detached:true (its own process group), so it OUTLIVES the Electron main process; without this, quitting
// mid-run (or with any service still up) leaks zombie dev servers holding their ports. stop() tree-kills the
// whole group (SIGTERM → SIGKILL), mirroring registry.dispose() but reachable without the registry handle.
export function disposeAllActiveServices(): void {
  for (const h of active.values()) {
    for (const s of h.list()) if (s.status !== 'exited') h.stop(s.id)
  }
  active.clear()
}

export function broadcastConvServices(convId: string, services: ServiceInfo[]): void {
  const ev: ConvServices = { convId, services }
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('conv:services', ev)
}
