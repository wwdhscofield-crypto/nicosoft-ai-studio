import Darwin
import Foundation

/// Accepts connections on a unix-domain socket.
///
/// This is the only transport-specific piece of the IPC stack. Everything above
/// it (framing, JSON-RPC, routing) operates on a raw file descriptor, so the
/// transport can be swapped (e.g. for XPC) by replacing this type alone — see
/// the "transport-agnostic" constraint in docs/computer-use-replication-research.md §7.
final class UnixSocketListener {
    /// Absolute filesystem path of the socket.
    let path: String

    /// Invoked on the accept queue for every accepted client. The handler takes
    /// ownership of the file descriptor and must close it when done.
    var onAccept: ((Int32) -> Void)?

    private var listenFD: Int32 = -1
    private var running = false
    private let acceptQueue = DispatchQueue(label: "dev.nicosoft.cuh.accept")

    init(path: String) {
        self.path = path
    }

    /// The maximum bytes available for the socket path, from `sockaddr_un.sun_path`.
    private static let sunPathCapacity = MemoryLayout.size(ofValue: sockaddr_un().sun_path)

    func start() throws {
        // The parent directory holds the rendezvous socket; keep it private to
        // the current user so no other account can connect.
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(
            atPath: dir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])

        // Remove any stale socket left by a previous crash so bind() succeeds.
        unlink(path)

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw CUAError.posix("socket") }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)

        let pathBytes = Array(path.utf8)
        guard pathBytes.count < Self.sunPathCapacity else {
            close(fd)
            throw CUAError.internalError("socket path too long (\(pathBytes.count) >= \(Self.sunPathCapacity))")
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { tuplePtr in
            tuplePtr.withMemoryRebound(to: UInt8.self, capacity: Self.sunPathCapacity) { dst in
                for (i, byte) in pathBytes.enumerated() { dst[i] = byte }
                dst[pathBytes.count] = 0 // null terminator
            }
        }

        let addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bindResult = withUnsafePointer(to: &addr) { rawPtr in
            rawPtr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockPtr in
                Darwin.bind(fd, sockPtr, addrLen)
            }
        }
        guard bindResult == 0 else {
            let err = CUAError.posix("bind")
            close(fd)
            throw err
        }

        // Restrict the socket file itself to the owner.
        chmod(path, 0o600)

        guard listen(fd, 8) == 0 else {
            let err = CUAError.posix("listen")
            close(fd)
            unlink(path)
            throw err
        }

        listenFD = fd
        running = true
        Log.info("listening on \(path)")
        acceptQueue.async { [weak self] in self?.acceptLoop() }
    }

    private func acceptLoop() {
        while running {
            let clientFD = accept(listenFD, nil, nil)
            if clientFD < 0 {
                if errno == EINTR { continue }
                if running { Log.warn("accept failed: \(String(cString: strerror(errno)))") }
                break
            }
            // Never let a write to a closed peer raise SIGPIPE and kill us.
            var on: Int32 = 1
            setsockopt(clientFD, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
            Log.debug("client connected (fd \(clientFD))")
            onAccept?(clientFD)
        }
    }

    func stop() {
        running = false
        if listenFD >= 0 {
            close(listenFD)
            listenFD = -1
        }
        unlink(path)
    }
}
