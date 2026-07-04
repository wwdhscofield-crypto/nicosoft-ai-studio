import Foundation

/// A parsed JSON-RPC 2.0 request.
struct RPCRequest {
    /// Request id. Absent for notifications (no response is sent).
    let id: JSONValue?
    let method: String
    let params: JSONValue?

    /// `true` when this is a notification (no `id`), meaning the peer does not
    /// expect a response frame.
    var isNotification: Bool { id == nil }

    init(from value: JSONValue) throws {
        guard let obj = value.objectValue else {
            throw CUAError.invalidRequest("request is not a JSON object")
        }
        guard let method = obj["method"]?.stringValue else {
            throw CUAError.invalidRequest("missing string \"method\"")
        }
        self.method = method
        self.params = obj["params"]
        // A JSON-RPC id may be a string, number, or null. We treat a missing id
        // as a notification; an explicit null is preserved as `.null`.
        self.id = obj["id"]
    }
}

/// Builds JSON-RPC 2.0 response frames.
enum RPCResponse {
    static func success(id: JSONValue?, result: JSONValue) -> JSONValue {
        .object([
            "jsonrpc": .string("2.0"),
            "id": id ?? .null,
            "result": result,
        ])
    }

    static func failure(id: JSONValue?, error: CUAError) -> JSONValue {
        .object([
            "jsonrpc": .string("2.0"),
            "id": id ?? .null,
            "error": .object([
                "code": .int(error.code),
                "message": .string(error.message),
            ]),
        ])
    }
}
