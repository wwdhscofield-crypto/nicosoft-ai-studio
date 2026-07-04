import ApplicationServices
import CoreGraphics
import Foundation

/// Accessibility attribute and action names.
///
/// These are defined as raw string literals rather than the SDK's `kAX*`
/// symbols on purpose: several of those symbols are C `#define … CFSTR(...)`
/// macros that do not import into Swift. The underlying attribute strings
/// ("AXRole", "AXPress", …) are stable public API.
enum AXAttr {
    static let role = "AXRole"
    static let subrole = "AXSubrole"
    static let roleDescription = "AXRoleDescription"
    static let title = "AXTitle"
    static let label = "AXLabel"
    static let value = "AXValue"
    static let description = "AXDescription"
    static let help = "AXHelp"
    static let placeholder = "AXPlaceholderValue"
    static let identifier = "AXIdentifier"
    static let position = "AXPosition"
    static let size = "AXSize"
    static let enabled = "AXEnabled"
    static let selected = "AXSelected"
    static let focused = "AXFocused"
    static let children = "AXChildren"
    static let focusedWindow = "AXFocusedWindow"
    static let mainWindow = "AXMainWindow"
    static let windows = "AXWindows"
    static let focusedUIElement = "AXFocusedUIElement"
    static let minimized = "AXMinimized"
    static let main = "AXMain"
    static let menuBar = "AXMenuBar"
}

enum AXAction {
    static let press = "AXPress"
}

/// Thin, memory-safe wrappers over the `AXUIElement` C API.
enum AXCore {
    static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        return result == .success ? value : nil
    }

    static func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
        guard let value = attribute(element, name) else { return nil }
        if let s = value as? String { return s.isEmpty ? nil : s }
        if let n = value as? NSNumber { return n.stringValue }
        return nil
    }

    static func boolAttribute(_ element: AXUIElement, _ name: String) -> Bool? {
        guard let value = attribute(element, name) else { return nil }
        if CFGetTypeID(value) == CFBooleanGetTypeID() {
            return CFBooleanGetValue((value as! CFBoolean))
        }
        if let n = value as? NSNumber { return n.boolValue }
        return nil
    }

    static func pointAttribute(_ element: AXUIElement, _ name: String) -> CGPoint? {
        guard let value = attribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
            return nil
        }
        var point = CGPoint.zero
        return AXValueGetValue((value as! AXValue), .cgPoint, &point) ? point : nil
    }

    static func sizeAttribute(_ element: AXUIElement, _ name: String) -> CGSize? {
        guard let value = attribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
            return nil
        }
        var size = CGSize.zero
        return AXValueGetValue((value as! AXValue), .cgSize, &size) ? size : nil
    }

    static func children(_ element: AXUIElement) -> [AXUIElement] {
        guard let value = attribute(element, AXAttr.children) else { return [] }
        return (value as? [AXUIElement]) ?? []
    }

    static func actionNames(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
        return (names as? [String]) ?? []
    }

    @discardableResult
    static func perform(_ element: AXUIElement, action: String) -> Bool {
        AXUIElementPerformAction(element, action as CFString) == .success
    }

    static func setValue(_ element: AXUIElement, _ name: String, _ value: CFTypeRef) -> Bool {
        AXUIElementSetAttributeValue(element, name as CFString, value) == .success
    }

    /// Read an attribute whose value is itself an `AXUIElement` (e.g. AXFocusedWindow,
    /// AXMainWindow, AXFocusedUIElement, AXMenuBar).
    static func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return nil
        }
        return (value as! AXUIElement)
    }

    /// The application's windows (AXWindows), in front-to-back order.
    static func windows(_ appElement: AXUIElement) -> [AXUIElement] {
        guard let value = attribute(appElement, AXAttr.windows) else { return [] }
        return (value as? [AXUIElement]) ?? []
    }

    /// Programmatically move keyboard focus to an element (AXFocused = true). More reliable than a
    /// synthesized click for focusing text inputs in apps whose custom views don't take first-responder
    /// on a click. Returns whether the set succeeded (not whether focus was actually taken — verify with
    /// `isFocused`).
    @discardableResult
    static func setFocused(_ element: AXUIElement) -> Bool {
        setValue(element, AXAttr.focused, kCFBooleanTrue)
    }

    /// Whether this element currently holds keyboard focus.
    static func isFocused(_ element: AXUIElement) -> Bool {
        boolAttribute(element, AXAttr.focused) == true
    }

    /// Set an element's text value directly via AX (no keyboard). The focus-independent fallback for
    /// inserting text when a click/AXFocused doesn't take. Replaces the field's contents; not all
    /// elements are settable (returns false when the element rejects it).
    @discardableResult
    static func setStringValue(_ element: AXUIElement, _ text: String) -> Bool {
        setValue(element, AXAttr.value, text as CFString)
    }

    /// Frame in global points, or nil if either position or size is unavailable.
    static func frame(_ element: AXUIElement) -> ElementFrame? {
        guard let position = pointAttribute(element, AXAttr.position),
              let size = sizeAttribute(element, AXAttr.size) else { return nil }
        return ElementFrame(
            x: Double(position.x), y: Double(position.y),
            width: Double(size.width), height: Double(size.height))
    }
}
