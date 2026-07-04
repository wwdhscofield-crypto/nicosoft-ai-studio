import CoreGraphics
import Foundation

/// Decoded parameters for `perform_action`.
///
/// The field set is deliberately a superset covering every action kind; only
/// the fields relevant to a given `action` are read. This mirrors the single
/// polymorphic action schema the reference tools expose, so an agent has one
/// action verb to learn.
struct ActionParams: Decodable {
    /// Action discriminator: click / drag / type / key / scroll / move /
    /// screenshot / wait / secondary.
    let action: String

    // Targeting — pixel coordinate (from a screenshot) …
    let coordinate: [Double]?
    let x: Double?
    let y: Double?
    // … or an accessibility element (preferred when present).
    let index: Int?
    let elementID: String?

    // Mouse
    let button: String?
    let clickCount: Int?

    // Keyboard
    let text: String?
    let key: String?
    let keys: [String]?
    let modifiers: [String]?

    // Scroll
    let direction: String?
    let amount: Double?

    // Drag
    let start: [Double]?
    let end: [Double]?

    // Timing / misc
    let duration: Double?
    let actionName: String?
    let display: Int?

    /// The pixel target from `coordinate` or `x`/`y`, if either is present.
    func pixelPoint() -> CGPoint? {
        if let coordinate, coordinate.count >= 2 {
            return CGPoint(x: coordinate[0], y: coordinate[1])
        }
        if let x, let y { return CGPoint(x: x, y: y) }
        return nil
    }

    static func pixelPoint(from pair: [Double]?) -> CGPoint? {
        guard let pair, pair.count >= 2 else { return nil }
        return CGPoint(x: pair[0], y: pair[1])
    }

    /// The list of key combos to press, from either `keys` or a single `key`.
    func keyCombos() -> [String] {
        if let keys, !keys.isEmpty { return keys }
        if let key { return [key] }
        return []
    }
}

/// Normalizes the incoming `action` string to a canonical verb, folding the
/// documented aliases (`type_text`→`type`, `keypress`/`key`→`key`, …).
enum ActionKind: String {
    case click, drag, type, key, scroll, move, screenshot, wait, secondary

    init?(raw: String) {
        switch raw.lowercased() {
        case "click", "left_click", "tap": self = .click
        case "drag", "left_click_drag": self = .drag
        case "type", "type_text": self = .type
        case "key", "keypress", "key_press", "hotkey": self = .key
        case "scroll": self = .scroll
        case "move", "mouse_move", "hover": self = .move
        case "screenshot": self = .screenshot
        case "wait", "sleep": self = .wait
        case "secondary", "secondary_action", "menu": self = .secondary
        default: return nil
        }
    }
}

/// Maps a named scroll direction + magnitude to line deltas.
enum ScrollDirection {
    /// Returns `(deltaX, deltaY)` in lines. Convention: "down" reveals content
    /// below (wheel toward user → negative deltaY).
    static func deltas(direction: String?, amount: Double?) -> (Int, Int) {
        let magnitude = Int((amount ?? 3).rounded())
        switch direction?.lowercased() {
        case "up": return (0, magnitude)
        case "down": return (0, -magnitude)
        case "left": return (magnitude, 0)
        case "right": return (-magnitude, 0)
        default: return (0, -magnitude) // default: scroll down
        }
    }
}
