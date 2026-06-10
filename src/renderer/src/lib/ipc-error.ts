// Surface a service's real reason from an IPC-thrown error, stripping the layered
// "Error: … invoking remote method … Error:" wrapper Electron puts around it.
export function ipcErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.split(/Error:\s*/).filter(Boolean).pop() ?? msg
}
