import Foundation

/// Minimal leveled logger that writes to **stderr** only.
///
/// The JSON-RPC protocol owns the unix socket; stdout/stderr are kept free of
/// protocol traffic so framework chatter never corrupts a response frame. This
/// is one of the reasons the transport is a socket rather than stdio (see the
/// IPC rationale in docs/computer-use-replication-research.md §7).
enum Log {
    enum Level: String {
        case debug = "DEBUG"
        case info = "INFO"
        case warn = "WARN"
        case error = "ERROR"
    }

    /// Set from the `NSAI_CUA_DEBUG` environment variable at launch.
    static var verbose = ProcessInfo.processInfo.environment["NSAI_CUA_DEBUG"] != nil

    private static let queue = DispatchQueue(label: "dev.nicosoft.aistudio.cua.log")
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()

    static func debug(_ message: @autoclosure () -> String) {
        guard verbose else { return }
        emit(.debug, message())
    }

    static func info(_ message: @autoclosure () -> String) { emit(.info, message()) }
    static func warn(_ message: @autoclosure () -> String) { emit(.warn, message()) }
    static func error(_ message: @autoclosure () -> String) { emit(.error, message()) }

    private static func emit(_ level: Level, _ message: String) {
        let line = "\(formatter.string(from: Date())) [\(level.rawValue)] nsai-cua: \(message)\n"
        queue.async {
            FileHandle.standardError.write(Data(line.utf8))
        }
    }
}
