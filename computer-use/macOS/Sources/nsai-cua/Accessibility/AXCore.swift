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

    /// Frame in global points, or nil if either position or size is unavailable.
    static func frame(_ element: AXUIElement) -> ElementFrame? {
        guard let position = pointAttribute(element, AXAttr.position),
              let size = sizeAttribute(element, AXAttr.size) else { return nil }
        return ElementFrame(
            x: Double(position.x), y: Double(position.y),
            width: Double(size.width), height: Double(size.height))
    }
}
