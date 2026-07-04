import Darwin
import Foundation

/// Newline-delimited JSON-RPC over a stream of client file descriptors.
///
/// Framing: each request and each response is a single JSON object on one line,
/// terminated by `\n`. This keeps the wire format trivially debuggable with
/// `nc`/`socat` and is transport-independent — `RPCServer` only ever sees file
/// descriptors handed to it by a listener.
final class RPCServer {
    /// Routes a request to a result, or throws a `CUAError`. Invoked serially
    /// per connection; the router itself serializes shared state (see `Server`).
    typealias Router = (RPCRequest) throws -> JSONValue

    private let listener: UnixSocketListener
    private let router: Router
    private let connectionQueue = DispatchQueue(
        label: "dev.nicosoft.cuh.conn", attributes: .concurrent)

    init(listener: UnixSocketListener, router: @escaping Router) {
        self.listener = listener
        self.router = router
        listener.onAccept = { [weak self] fd in self?.serve(fd) }
    }

    func start() throws {
        try listener.start()
    }

    func stop() {
        listener.stop()
    }

    // MARK: - Per-connection read loop

    private func serve(_ fd: Int32) {
        connectionQueue.async { [weak self] in
            guard let self else { close(fd); return }
            defer {
                close(fd)
                Log.debug("client disconnected (fd \(fd))")
            }

            var buffer = Data()
            let chunkCapacity = 64 * 1024
            var chunk = [UInt8](repeating: 0, count: chunkCapacity)

            while true {
                let n = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, chunkCapacity) }
                if n < 0 {
                    if errno == EINTR { continue }
                    break
                }
                if n == 0 { break } // peer closed

                buffer.append(contentsOf: chunk[0..<n])

                while let newlineIndex = buffer.firstIndex(of: 0x0A) {
                    let lineData = buffer.subdata(in: buffer.startIndex..<newlineIndex)
                    buffer.removeSubrange(buffer.startIndex...newlineIndex)
                    if lineData.isEmpty { continue } // keepalive blank line
                    self.processLine(lineData, fd: fd)
                }

                // Guard against an unbounded line from a misbehaving peer.
                if buffer.count > 32 * 1024 * 1024 {
                    Log.warn("dropping connection: request line exceeded 32 MiB")
                    break
                }
            }
        }
    }

    private func processLine(_ line: Data, fd: Int32) {
        // Parse the envelope first so we can echo the id back on error.
        let value: JSONValue
        do {
            value = try JSONDecoder().decode(JSONValue.self, from: line)
        } catch {
            writeFrame(RPCResponse.failure(id: nil, error: .parse("invalid JSON: \(error)")), to: fd)
            return
        }

        let request: RPCRequest
        do {
            request = try RPCRequest(from: value)
        } catch let e as CUAError {
            writeFrame(RPCResponse.failure(id: value["id"], error: e), to: fd)
            return
        } catch {
            writeFrame(RPCResponse.failure(id: value["id"], error: .invalidRequest("\(error)")), to: fd)
            return
        }

        let response: JSONValue
        do {
            let result = try router(request)
            response = RPCResponse.success(id: request.id, result: result)
        } catch let e as CUAError {
            response = RPCResponse.failure(id: request.id, error: e)
        } catch {
            response = RPCResponse.failure(id: request.id, error: .internalError("\(error)"))
        }

        // Notifications get no response frame.
        guard !request.isNotification else { return }
        writeFrame(response, to: fd)
    }

    // MARK: - Framing out

    private func writeFrame(_ value: JSONValue, to fd: Int32) {
        var data: Data
        do {
            data = try JSONEncoder().encode(value)
        } catch {
            Log.error("failed to encode response: \(error)")
            return
        }
        data.append(0x0A) // newline terminator
        writeAll(data, to: fd)
    }

    private func writeAll(_ data: Data, to fd: Int32) {
        data.withUnsafeBytes { raw in
            guard var ptr = raw.baseAddress else { return }
            var remaining = raw.count
            while remaining > 0 {
                let written = write(fd, ptr, remaining)
                if written <= 0 {
                    if written < 0 && errno == EINTR { continue }
                    Log.warn("write failed (fd \(fd)): \(String(cString: strerror(errno)))")
                    return
                }
                ptr = ptr.advanced(by: written)
                remaining -= written
            }
        }
    }
}
