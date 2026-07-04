import CoreGraphics
import Foundation

/// One resolved key press: a virtual keycode plus any modifier flags implied by
/// the key name itself (e.g. an uppercase letter implies Shift).
struct KeyStroke {
    let keyCode: CGKeyCode
    let impliedFlags: CGEventFlags
}

/// Translates xdotool-style key names (`"Return"`, `"Tab"`, `"super+c"`,
/// `"KP_0"`) into macOS virtual keycodes and modifier flags.
///
/// The name set follows the X keysym vocabulary the reference implementations
/// and Anthropic's public computer-use tool use, so agents can emit the same
/// key strings across platforms. Text should go through `type`; this path is
/// for shortcuts and named keys.
enum KeyCodes {
    /// Modifier name → flag. Case-insensitive.
    static func modifierFlag(for name: String) -> CGEventFlags? {
        switch name.lowercased() {
        case "super", "cmd", "command", "meta", "win": return .maskCommand
        case "ctrl", "control": return .maskControl
        case "alt", "option", "opt": return .maskAlternate
        case "shift": return .maskShift
        case "fn", "function": return .maskSecondaryFn
        default: return nil
        }
    }

    /// Resolve a single (non-combo) key token to a keystroke.
    static func stroke(for token: String) -> KeyStroke? {
        // Single character: letters/digits/punctuation typed as-is.
        if token.count == 1, let scalar = token.unicodeScalars.first {
            return strokeForCharacter(Character(scalar))
        }
        if let code = named[token.lowercased()] {
            return KeyStroke(keyCode: code, impliedFlags: [])
        }
        return nil
    }

    /// Parse a full combo like `"super+shift+t"` into a keystroke whose flags
    /// include both the modifiers named in the combo and any implied by the key.
    static func parseCombo(_ combo: String) -> KeyStroke? {
        // Split on '+', keeping empty trailing token so a literal "+" key works.
        var parts = combo.components(separatedBy: "+")
        // Handle a trailing literal '+' (e.g. "shift++" or bare "+").
        if parts.count >= 2, parts.last == "" {
            parts.removeLast()
            parts[parts.count - 1] = "+"
        }
        guard let keyToken = parts.last else { return nil }
        let modifierTokens = parts.dropLast()

        var flags: CGEventFlags = []
        for token in modifierTokens {
            guard let flag = modifierFlag(for: token) else { return nil }
            flags.insert(flag)
        }

        // A modifier used as the final key (e.g. just "shift") presses that key.
        if let base = stroke(for: keyToken) {
            return KeyStroke(keyCode: base.keyCode, impliedFlags: flags.union(base.impliedFlags))
        }
        if let modAsKey = modifierKeyCode[keyToken.lowercased()] {
            return KeyStroke(keyCode: modAsKey, impliedFlags: flags)
        }
        return nil
    }

    // MARK: - Character resolution

    private static func strokeForCharacter(_ ch: Character) -> KeyStroke? {
        if let lower = ch.lowercased().first, let code = characterKeys[lower] {
            let needsShift = ch.isUppercase || shiftedSymbols.contains(ch)
            return KeyStroke(keyCode: code, impliedFlags: needsShift ? .maskShift : [])
        }
        if let code = characterKeys[ch] {
            let needsShift = shiftedSymbols.contains(ch)
            return KeyStroke(keyCode: code, impliedFlags: needsShift ? .maskShift : [])
        }
        return nil
    }

    /// Symbols reached with Shift on a US layout, mapped to their base key.
    private static let shiftedSymbols: Set<Character> = [
        "!", "@", "#", "$", "%", "^", "&", "*", "(", ")",
        "_", "+", "{", "}", "|", ":", "\"", "<", ">", "?", "~",
    ]

    // MARK: - Keycode tables (US ANSI virtual keycodes)

    /// Base characters (unshifted) → keycode. Shifted symbols reuse their base.
    private static let characterKeys: [Character: CGKeyCode] = [
        "a": 0x00, "s": 0x01, "d": 0x02, "f": 0x03, "h": 0x04, "g": 0x05,
        "z": 0x06, "x": 0x07, "c": 0x08, "v": 0x09, "b": 0x0B, "q": 0x0C,
        "w": 0x0D, "e": 0x0E, "r": 0x0F, "y": 0x10, "t": 0x11,
        "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15, "6": 0x16, "5": 0x17,
        "=": 0x18, "9": 0x19, "7": 0x1A, "-": 0x1B, "8": 0x1C, "0": 0x1D,
        "]": 0x1E, "o": 0x1F, "u": 0x20, "[": 0x21, "i": 0x22, "p": 0x23,
        "l": 0x25, "j": 0x26, "'": 0x27, "k": 0x28, ";": 0x29, "\\": 0x2A,
        ",": 0x2B, "/": 0x2C, "n": 0x2D, "m": 0x2E, ".": 0x2F, "`": 0x32,
        " ": 0x31,
        // Shifted symbols reuse the base keycode; strokeForCharacter adds Shift.
        "!": 0x12, "@": 0x13, "#": 0x14, "$": 0x15, "^": 0x16, "%": 0x17,
        "+": 0x18, "(": 0x19, "&": 0x1A, "_": 0x1B, "*": 0x1C, ")": 0x1D,
        "}": 0x1E, "{": 0x21, "\"": 0x27, ":": 0x29, "|": 0x2A,
        "<": 0x2B, "?": 0x2C, ">": 0x2F, "~": 0x32,
    ]

    /// Modifier key names → their keycode, for when a modifier is the final key.
    private static let modifierKeyCode: [String: CGKeyCode] = [
        "super": 0x37, "cmd": 0x37, "command": 0x37, "meta": 0x37, "win": 0x37,
        "shift": 0x38, "capslock": 0x39,
        "alt": 0x3A, "option": 0x3A, "opt": 0x3A,
        "ctrl": 0x3B, "control": 0x3B, "fn": 0x3F, "function": 0x3F,
    ]

    /// Named keys (X keysym vocabulary), lowercased → keycode.
    private static let named: [String: CGKeyCode] = [
        // Whitespace / editing
        "return": 0x24, "enter": 0x24, "kp_enter": 0x4C,
        "tab": 0x30, "space": 0x31, "backspace": 0x33, "delete": 0x33,
        "escape": 0x35, "esc": 0x35, "forwarddelete": 0x75, "kp_delete": 0x41,
        // Navigation
        "home": 0x73, "end": 0x77, "pageup": 0x74, "prior": 0x74,
        "pagedown": 0x79, "next": 0x79, "help": 0x72,
        "left": 0x7B, "right": 0x7C, "down": 0x7D, "up": 0x7E,
        // Punctuation aliases
        "minus": 0x1B, "equal": 0x18, "comma": 0x2B, "period": 0x2F,
        "slash": 0x2C, "backslash": 0x2A, "semicolon": 0x29,
        "apostrophe": 0x27, "quoteright": 0x27, "grave": 0x32,
        "bracketleft": 0x21, "bracketright": 0x1E, "plus": 0x18,
        // Function keys
        "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60, "f6": 0x61,
        "f7": 0x62, "f8": 0x64, "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
        "f13": 0x69, "f14": 0x6B, "f15": 0x71, "f16": 0x6A, "f17": 0x40,
        // Keypad digits
        "kp_0": 0x52, "kp_1": 0x53, "kp_2": 0x54, "kp_3": 0x55, "kp_4": 0x56,
        "kp_5": 0x57, "kp_6": 0x58, "kp_7": 0x59, "kp_8": 0x5B, "kp_9": 0x5C,
        "kp_decimal": 0x41, "kp_multiply": 0x43, "kp_add": 0x45, "kp_subtract": 0x4E,
        "kp_divide": 0x4B, "kp_equal": 0x51,
    ]
}
