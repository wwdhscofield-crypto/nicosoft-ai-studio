import AppKit
import Foundation

/// The always-on-top banner shown while the helper is actively controlling the
/// Mac, plus the global Esc watcher that lets the user abort.
///
/// This is the standalone-helper safety surface. When wired into Studio, the
/// host can additionally gate each action behind its permission mode; the
/// overlay remains the user's unconditional "it's happening / stop it" signal.
/// All AppKit work is marshaled to the main thread.
final class OverlayController {
    static let shared = OverlayController()

    /// Invoked (on the main thread) when the user presses Esc while active.
    var onCancel: (() -> Void)?

    private var window: NSWindow?
    private var globalMonitor: Any?
    private var localMonitor: Any?
    private(set) var isActive = false

    private init() {}

    /// Show or hide the banner. Safe to call from any thread.
    func setActive(_ active: Bool, label: String? = nil) {
        onMain { [weak self] in
            guard let self else { return }
            if active {
                self.showBanner(text: label ?? "\(Version.displayName) is controlling your Mac — press Esc to stop")
                self.installEscMonitor()
            } else {
                self.hideBanner()
                self.removeEscMonitor()
            }
            self.isActive = active
        }
    }

    // MARK: - Banner

    private func showBanner(text: String) {
        let width: CGFloat = 460
        let height: CGFloat = 44

        let window = self.window ?? makeWindow(width: width, height: height)
        self.window = window
        (window.contentView as? BannerView)?.text = text

        if let screen = NSScreen.main {
            let frame = screen.frame
            let origin = NSPoint(
                x: frame.midX - width / 2,
                y: frame.maxY - height - 16)
            window.setFrameOrigin(origin)
        }
        window.orderFrontRegardless()
    }

    private func hideBanner() {
        window?.orderOut(nil)
    }

    private func makeWindow(width: CGFloat, height: CGFloat) -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: .borderless,
            backing: .buffered,
            defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.level = .screenSaver
        window.ignoresMouseEvents = true
        window.hasShadow = true
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
        window.contentView = BannerView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        return window
    }

    // MARK: - Esc monitor

    private func installEscMonitor() {
        if globalMonitor == nil {
            globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
                if event.keyCode == 53 { self?.triggerCancel() } // Esc
            }
        }
        if localMonitor == nil {
            localMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                if event.keyCode == 53 { self?.triggerCancel(); return nil }
                return event
            }
        }
    }

    private func removeEscMonitor() {
        if let m = globalMonitor { NSEvent.removeMonitor(m); globalMonitor = nil }
        if let m = localMonitor { NSEvent.removeMonitor(m); localMonitor = nil }
    }

    private func triggerCancel() {
        Log.info("Esc pressed — cancelling active control session")
        setActive(false)
        onCancel?()
    }

    private func onMain(_ block: @escaping () -> Void) {
        if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
    }
}

/// The rounded pill drawn inside the overlay window.
private final class BannerView: NSView {
    private let dot = NSView()
    private let label = NSTextField(labelWithString: "")

    var text: String = "" {
        didSet { label.stringValue = text }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.cornerRadius = 12
        layer?.backgroundColor = NSColor(calibratedWhite: 0.08, alpha: 0.92).cgColor
        layer?.borderWidth = 1
        // Studio accent blue (--accent: oklch(0.625 0.155 271)).
        layer?.borderColor = NSColor(srgbRed: 0.40, green: 0.50, blue: 0.90, alpha: 0.9).cgColor

        dot.wantsLayer = true
        dot.layer?.backgroundColor = NSColor(srgbRed: 0.40, green: 0.50, blue: 0.90, alpha: 1).cgColor
        dot.layer?.cornerRadius = 5
        dot.translatesAutoresizingMaskIntoConstraints = false
        addSubview(dot)

        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.textColor = .white
        label.backgroundColor = .clear
        label.isBezeled = false
        label.isEditable = false
        label.lineBreakMode = .byTruncatingTail
        label.translatesAutoresizingMaskIntoConstraints = false
        addSubview(label)

        NSLayoutConstraint.activate([
            dot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 18),
            dot.centerYAnchor.constraint(equalTo: centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 10),
            dot.heightAnchor.constraint(equalToConstant: 10),
            label.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 10),
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -18),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not supported") }
}
