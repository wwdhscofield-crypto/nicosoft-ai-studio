import AppKit
import Darwin
import Foundation

// MARK: - Entry point
//
// nsai-cua runs as a long-lived accessory application: it needs an AppKit run
// loop on the main thread for the overlay window and the Esc monitor, while the
// JSON-RPC server accepts connections on its own background queue.

// A write to a peer that has closed the socket must never raise SIGPIPE.
signal(SIGPIPE, SIG_IGN)

/// Resolve the socket path: `NSAI_CUA_SOCKET` override, else the fixed
/// per-user path that keeps the TCC grant stable across launches.
let socketPath: String = {
    let env = ProcessInfo.processInfo.environment["NSAI_CUA_SOCKET"]
    if let env, !env.isEmpty {
        return (env as NSString).expandingTildeInPath
    }
    return NSHomeDirectory() + "/.nsai/cua/cua.sock"
}()

let server = Server(socketPath: socketPath)
do {
    try server.start()
} catch {
    Log.error("failed to start: \(error)")
    exit(1)
}

Log.info("\(Version.displayName) \(Version.string) ready — socket \(socketPath)")

// Clean shutdown: remove the socket file and exit on SIGINT/SIGTERM. A plain
// signal handler can do very little safely, so route the signal through GCD.
var signalSources: [DispatchSourceSignal] = []
func installSignalHandler(_ sig: Int32) {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    source.setEventHandler {
        Log.info("received signal \(sig) — shutting down")
        server.stop()
        exit(0)
    }
    source.resume()
    signalSources.append(source)
}
installSignalHandler(SIGINT)
installSignalHandler(SIGTERM)

// Accessory policy: no Dock icon, but windows (the overlay) may still appear.
// When packaged, Info.plist's LSUIElement=true has the same effect.
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
application.run()
