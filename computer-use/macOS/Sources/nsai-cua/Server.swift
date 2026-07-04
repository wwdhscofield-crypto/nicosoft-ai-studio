import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// The JSON-RPC method router and owner of all subsystems.
///
/// Requests are serialized by `stateLock` so the element registry, the
/// "active display" used for coordinate mapping, and the overlay are never
/// touched concurrently — computer-use actions are inherently sequential, so
/// this costs nothing and keeps every handler free of its own locking.
final class Server {
    let socketPath: String

    private let registry = ElementRegistry()
    private let stateLock = NSLock()
    /// Display that pixel coordinates are interpreted against — the one most
    /// recently screenshotted, so the model's coordinates match what it saw.
    private var activeDisplay: DisplayInfo = Displays.main()

    private var rpc: RPCServer?

    init(socketPath: String) {
        self.socketPath = socketPath
    }

    func start() throws {
        let listener = UnixSocketListener(path: socketPath)
        let server = RPCServer(listener: listener) { [weak self] request in
            guard let self else { throw CUAError.internalError("server deallocated") }
            return try self.route(request)
        }
        try server.start()
        rpc = server
    }

    func stop() {
        rpc?.stop()
    }

    // MARK: - Routing

    private func route(_ request: RPCRequest) throws -> JSONValue {
        stateLock.lock()
        defer { stateLock.unlock() }

        Log.debug("→ \(request.method)")
        switch request.method {
        case "ping": return ping()
        case "permission_status": return try permissionStatus(request.params)
        case "screenshot": return try screenshot(request.params)
        case "ui_tree": return try uiTree(request.params)
        case "frontmost_window": return try frontmostWindow()
        case "list_apps": return try listApps()
        case "perform_action": return try performAction(request.params)
        case "set_active": return try setActive(request.params)
        default: throw CUAError.methodNotFound(request.method)
        }
    }

    // MARK: - Handlers

    private func ping() -> JSONValue {
        .object([
            "pong": .bool(true),
            "name": .string(Version.name),
            "version": .string(Version.string),
        ])
    }

    private func permissionStatus(_ params: JSONValue?) throws -> JSONValue {
        let shouldPrompt = params?["prompt"]?.boolValue ?? false
        let status = shouldPrompt ? Permissions.requestAndStatus() : Permissions.status()
        return try JSONValue.from(status)
    }

    private func screenshot(_ params: JSONValue?) throws -> JSONValue {
        let display = Displays.resolve(index: params?["display"]?.intValue)
        activeDisplay = display
        let shot = try runBlocking { try await ScreenCapture.capture(display: display) }
        return .object([
            "pngBase64": .string(shot.pngBase64),
            "width": .int(shot.width),
            "height": .int(shot.height),
            "scale": .double(Double(shot.scale)),
            "displayID": .int(Int(shot.displayID)),
        ])
    }

    private func uiTree(_ params: JSONValue?) throws -> JSONValue {
        try requireAccessibility()
        let pid: pid_t
        if let requested = params?["pid"]?.intValue {
            pid = pid_t(requested)
        } else if let front = NSWorkspace.shared.frontmostApplication {
            pid = front.processIdentifier
        } else {
            throw CUAError.unavailable("no frontmost application")
        }

        let snapshot = AccessibilityTree.snapshot(pid: pid)
        let token = registry.update(snapshot)
        return .object([
            "token": .int(token),
            "pid": .int(Int(pid)),
            "count": .int(snapshot.elements.count),
            "elements": try JSONValue.from(snapshot.elements),
        ])
    }

    private func frontmostWindow() throws -> JSONValue {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            throw CUAError.unavailable("no frontmost application")
        }
        return try JSONValue.from(AccessibilityTree.frontmostWindow(app: app))
    }

    private func listApps() throws -> JSONValue {
        let apps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .map { app -> JSONValue in
                .object([
                    "name": app.localizedName.map(JSONValue.string) ?? .null,
                    "bundleId": app.bundleIdentifier.map(JSONValue.string) ?? .null,
                    "pid": .int(Int(app.processIdentifier)),
                ])
            }
        return .array(apps)
    }

    private func setActive(_ params: JSONValue?) throws -> JSONValue {
        let active = params?["active"]?.boolValue ?? false
        OverlayController.shared.setActive(active, label: params?["label"]?.stringValue)
        return .object(["active": .bool(active)])
    }

    // MARK: - perform_action

    private func performAction(_ params: JSONValue?) throws -> JSONValue {
        guard let params else { throw CUAError.invalidParams("perform_action requires params") }
        let action = try params.decode(ActionParams.self)
        guard let kind = ActionKind(raw: action.action) else {
            throw CUAError.invalidParams("unknown action \"\(action.action)\"")
        }

        // Screenshot and wait need no input permission; everything else does.
        switch kind {
        case .screenshot, .wait: break
        default: try requireAccessibility()
        }

        switch kind {
        case .click: return try performClick(action)
        case .drag: return try performDrag(action)
        case .type: return performType(action)
        case .key: return try performKey(action)
        case .scroll: return performScroll(action)
        case .move: return try performMove(action)
        case .secondary: return try performSecondary(action)
        case .wait:
            let seconds = max(0, min(action.duration ?? 0.5, 30))
            usleep(useconds_t(seconds * 1_000_000))
            return .object(["ok": .bool(true), "waited": .double(seconds)])
        case .screenshot:
            return try screenshot(params)
        }
    }

    private func performClick(_ action: ActionParams) throws -> JSONValue {
        let button = MouseButton.parse(action.button)
        let clickCount = action.clickCount ?? 1

        // Prefer an accessibility element: press it directly (layout-robust).
        if let element = resolveElement(action) {
            if AXCore.perform(element, action: AXAction.press) {
                return .object(["ok": .bool(true), "method": .string("axpress")])
            }
            // Fall back to a synthesized click at the element's center.
            if let frame = AXCore.frame(element) {
                InputSynthesizer.click(at: frame.center, button: button, clickCount: clickCount)
                return .object(["ok": .bool(true), "method": .string("element-center")])
            }
            throw CUAError.notFound("element has no actionable frame")
        }

        // Otherwise use the pixel coordinate from the screenshot.
        guard let pixel = action.pixelPoint() else {
            throw CUAError.invalidParams("click requires index, elementID, or coordinate")
        }
        let global = display(for: action).globalPoint(fromPixel: pixel)
        InputSynthesizer.click(at: global, button: button, clickCount: clickCount)
        return .object(["ok": .bool(true), "method": .string("pixel")])
    }

    private func performDrag(_ action: ActionParams) throws -> JSONValue {
        guard let startPixel = ActionParams.pixelPoint(from: action.start) ?? action.pixelPoint(),
              let endPixel = ActionParams.pixelPoint(from: action.end) else {
            throw CUAError.invalidParams("drag requires start and end coordinates")
        }
        let d = display(for: action)
        InputSynthesizer.drag(
            from: d.globalPoint(fromPixel: startPixel),
            to: d.globalPoint(fromPixel: endPixel),
            button: MouseButton.parse(action.button))
        return .object(["ok": .bool(true)])
    }

    private func performType(_ action: ActionParams) -> JSONValue {
        let text = action.text ?? ""
        InputSynthesizer.typeText(text)
        return .object(["ok": .bool(true), "length": .int(text.count)])
    }

    private func performKey(_ action: ActionParams) throws -> JSONValue {
        let combos = action.keyCombos()
        guard !combos.isEmpty else {
            throw CUAError.invalidParams("key requires \"key\" or \"keys\"")
        }
        var extraFlags: CGEventFlags = []
        for modifier in action.modifiers ?? [] {
            if let flag = KeyCodes.modifierFlag(for: modifier) { extraFlags.insert(flag) }
        }
        for combo in combos {
            guard let stroke = KeyCodes.parseCombo(combo) else {
                throw CUAError.invalidParams("unrecognized key \"\(combo)\"")
            }
            InputSynthesizer.press(stroke, extraFlags: extraFlags)
            usleep(6_000)
        }
        return .object(["ok": .bool(true), "count": .int(combos.count)])
    }

    private func performScroll(_ action: ActionParams) -> JSONValue {
        if let pixel = action.pixelPoint() {
            InputSynthesizer.move(to: display(for: action).globalPoint(fromPixel: pixel))
        }
        let (dx, dy) = ScrollDirection.deltas(direction: action.direction, amount: action.amount)
        InputSynthesizer.scroll(deltaX: dx, deltaY: dy)
        return .object(["ok": .bool(true), "deltaX": .int(dx), "deltaY": .int(dy)])
    }

    private func performMove(_ action: ActionParams) throws -> JSONValue {
        guard let pixel = action.pixelPoint() else {
            throw CUAError.invalidParams("move requires a coordinate")
        }
        InputSynthesizer.move(to: display(for: action).globalPoint(fromPixel: pixel))
        return .object(["ok": .bool(true)])
    }

    private func performSecondary(_ action: ActionParams) throws -> JSONValue {
        guard let element = resolveElement(action) else {
            throw CUAError.invalidParams("secondary action requires index or elementID")
        }
        guard let name = action.actionName else {
            throw CUAError.invalidParams("secondary action requires actionName")
        }
        guard AXCore.perform(element, action: name) else {
            throw CUAError.internalError("accessibility action \"\(name)\" failed")
        }
        return .object(["ok": .bool(true), "action": .string(name)])
    }

    // MARK: - Helpers

    private func resolveElement(_ action: ActionParams) -> AXUIElement? {
        if let index = action.index { return registry.handle(atIndex: index) }
        if let id = action.elementID { return registry.handle(withIdentifier: id) }
        return nil
    }

    private func display(for action: ActionParams) -> DisplayInfo {
        if let index = action.display { return Displays.resolve(index: index) }
        return activeDisplay
    }

    private func requireAccessibility() throws {
        guard Permissions.accessibilityGranted else {
            throw CUAError.permissionDenied(
                "Accessibility permission not granted — call permission_status({prompt:true}) and grant it in System Settings")
        }
    }

    /// Run an async operation to completion from the synchronous connection
    /// thread. Safe because it never runs on the main thread (the RPC read loop
    /// is on a background queue), so blocking here cannot stall the run loop.
    private func runBlocking<T>(_ operation: @escaping () async throws -> T) throws -> T {
        let semaphore = DispatchSemaphore(value: 0)
        var outcome: Result<T, Error>!
        Task {
            do { outcome = .success(try await operation()) }
            catch { outcome = .failure(error) }
            semaphore.signal()
        }
        semaphore.wait()
        return try outcome.get()
    }
}
