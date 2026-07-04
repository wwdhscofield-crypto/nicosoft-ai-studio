import AppKit
import CoreGraphics
import Foundation

/// A mouse button and its associated `CGEvent` types.
enum MouseButton: String {
    case left, right, middle

    static func parse(_ raw: String?) -> MouseButton {
        switch raw?.lowercased() {
        case "right": return .right
        case "middle", "center": return .middle
        default: return .left
        }
    }

    var cgButton: CGMouseButton {
        switch self {
        case .left: return .left
        case .right: return .right
        case .middle: return .center
        }
    }

    var downType: CGEventType {
        switch self {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        case .middle: return .otherMouseDown
        }
    }

    var upType: CGEventType {
        switch self {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        case .middle: return .otherMouseUp
        }
    }

    var draggedType: CGEventType {
        switch self {
        case .left: return .leftMouseDragged
        case .right: return .rightMouseDragged
        case .middle: return .otherMouseDragged
        }
    }
}

/// Synthesizes mouse and keyboard events via CoreGraphics `CGEvent`.
///
/// All coordinates here are already in the **global point** space (see
/// `DisplayInfo.globalPoint(fromPixel:)`). Posting events to other apps
/// requires the Accessibility TCC grant; callers should check
/// `Permissions.accessibilityGranted` first.
enum InputSynthesizer {
    /// Delay between the discrete events that make up a compound gesture. Small
    /// gaps make click/drag sequences land reliably in target apps.
    private static let interEventDelay: useconds_t = 8_000 // 8 ms

    // MARK: - Mouse

    static func move(to point: CGPoint) {
        postMouse(.mouseMoved, at: point, button: .left, clickState: 0)
    }

    static func click(at point: CGPoint, button: MouseButton, clickCount: Int) {
        move(to: point)
        let count = max(1, clickCount)
        for i in 1...count {
            postMouse(button.downType, at: point, button: button, clickState: i)
            postMouse(button.upType, at: point, button: button, clickState: i)
            if i < count { usleep(interEventDelay) }
        }
    }

    static func drag(from start: CGPoint, to end: CGPoint, button: MouseButton, steps: Int = 24) {
        move(to: start)
        postMouse(button.downType, at: start, button: button, clickState: 1)
        usleep(interEventDelay)
        let n = max(1, steps)
        for step in 1...n {
            let t = CGFloat(step) / CGFloat(n)
            let p = CGPoint(
                x: start.x + (end.x - start.x) * t,
                y: start.y + (end.y - start.y) * t)
            postMouse(button.draggedType, at: p, button: button, clickState: 1)
            usleep(interEventDelay / 2)
        }
        postMouse(button.upType, at: end, button: button, clickState: 1)
    }

    /// Scroll by line deltas. Positive `deltaY` scrolls content up (wheel away
    /// from user); positive `deltaX` scrolls content left.
    static func scroll(deltaX: Int, deltaY: Int) {
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .line,
            wheelCount: 2,
            wheel1: Int32(deltaY),
            wheel2: Int32(deltaX),
            wheel3: 0
        ) else { return }
        event.post(tap: .cghidEventTap)
    }

    private static func postMouse(
        _ type: CGEventType, at point: CGPoint, button: MouseButton, clickState: Int
    ) {
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: type,
            mouseCursorPosition: point,
            mouseButton: button.cgButton
        ) else { return }
        if clickState > 0 {
            event.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
        }
        event.post(tap: .cghidEventTap)
    }

    // MARK: - Keyboard

    /// Type a string as literal text via the pasteboard.
    ///
    /// Rationale — this is the robust, language-agnostic path, and why the
    /// obvious alternatives don't work:
    ///  * Per-character key events run through the active input method. With an
    ///    IME such as Pinyin, letters are captured into a composition buffer and
    ///    a following Return "confirms" the composition instead of submitting,
    ///    so a typed URL never navigates.
    ///  * Pure Unicode injection (`CGEventKeyboardSetUnicodeString`) bypasses the
    ///    IME but is dropped by some apps, notably Chrome's omnibox.
    ///  * Forcing an ASCII layout would make entering CJK / Japanese / Korean
    ///    text impossible.
    ///
    /// Placing the text on the pasteboard and issuing ⌘V inserts the exact
    /// characters in one shot — any language, any app, IME-independent, leaving
    /// no composition pending — then the previous pasteboard string is restored.
    /// This mirrors the reference implementation, which inserts text directly
    /// rather than through layout-dependent keystrokes.
    static func typeText(_ text: String) {
        guard !text.isEmpty else { return }
        let pasteboard = NSPasteboard.general
        let previous = pasteboard.string(forType: .string)

        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        usleep(30_000) // let the pasteboard settle

        // ⌘V — a modifier combo, which IMEs pass through untouched.
        press(KeyStroke(keyCode: 0x09 /* v */, impliedFlags: .maskCommand))
        usleep(120_000) // let the paste complete before restoring the pasteboard

        pasteboard.clearContents()
        if let previous { pasteboard.setString(previous, forType: .string) }
    }

    /// Press a resolved keystroke (keycode + modifier flags) as a down/up pair.
    static func press(_ stroke: KeyStroke, extraFlags: CGEventFlags = []) {
        let flags = stroke.impliedFlags.union(extraFlags)
        if let down = CGEvent(keyboardEventSource: nil, virtualKey: stroke.keyCode, keyDown: true) {
            down.flags = flags
            down.post(tap: .cghidEventTap)
        }
        if let up = CGEvent(keyboardEventSource: nil, virtualKey: stroke.keyCode, keyDown: false) {
            up.flags = flags
            up.post(tap: .cghidEventTap)
        }
    }
}
