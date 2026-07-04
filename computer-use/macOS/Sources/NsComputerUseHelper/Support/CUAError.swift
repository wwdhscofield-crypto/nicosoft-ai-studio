import Foundation

/// A domain error carrying a JSON-RPC error code and human-readable message.
///
/// Codes follow the JSON-RPC 2.0 convention for the reserved range and add an
/// application range at `-32000…-32099` for helper-specific failures.
struct CUAError: Error, CustomStringConvertible {
    let code: Int
    let message: String

    var description: String { "CUAError(\(code)): \(message)" }

    // JSON-RPC reserved codes.
    static func parse(_ message: String) -> CUAError { CUAError(code: -32700, message: message) }
    static func invalidRequest(_ message: String) -> CUAError { CUAError(code: -32600, message: message) }
    static func methodNotFound(_ method: String) -> CUAError { CUAError(code: -32601, message: "method not found: \(method)") }
    static func invalidParams(_ message: String) -> CUAError { CUAError(code: -32602, message: message) }
    static func internalError(_ message: String) -> CUAError { CUAError(code: -32603, message: message) }

    // Application range.
    static func permissionDenied(_ message: String) -> CUAError { CUAError(code: -32001, message: message) }
    static func notFound(_ message: String) -> CUAError { CUAError(code: -32002, message: message) }
    static func unavailable(_ message: String) -> CUAError { CUAError(code: -32003, message: message) }

    /// Build a `CUAError` from the current POSIX `errno`.
    static func posix(_ syscall: String) -> CUAError {
        let e = errno
        let msg = String(cString: strerror(e))
        return CUAError(code: -32050, message: "\(syscall) failed: \(msg) (errno \(e))")
    }
}
