import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

/// One accessibility snapshot: the model-facing element list plus the live
/// element handles at matching indices, so `perform_action index=<n>` can
/// resolve back to an `AXUIElement`. `windowIndex`/`windowTitle` name the window
/// the tree was scoped to (nil when it fell back to the whole app).
struct AXSnapshot {
    let elements: [ReadableElement]
    let handles: [AXUIElement]
    let windowIndex: Int?
    let windowTitle: String?
}

/// Focused-window metadata for `frontmost_window`.
struct FrontmostWindow: Encodable {
    let app: String?
    let bundleId: String?
    let pid: Int32
    let title: String?
    let frame: ElementFrame?
}

/// One window of an application, for `list_windows`. `index` addresses it in
/// `ui_tree(window:)`; `focused` marks the app's key window, `main` its main
/// window — targeting the right one is what keeps a multi-window app (e.g. a
/// chat app with pop-out windows) from collapsing into one ambiguous element list.
struct WindowInfo: Encodable {
    let index: Int
    let title: String?
    let frame: ElementFrame?
    let main: Bool
    let focused: Bool
    let minimized: Bool
}

/// Walks an application's accessibility hierarchy and projects the actionable
/// nodes into `ReadableElement`s.
///
/// The snapshot is intentionally a *flat, indexed list of actionable elements*
/// rather than the full nested tree: it is what lets the model click by index
/// instead of guessing pixels, and it stays bounded on huge UIs. Hierarchy is
/// still conveyed via traversal order + `depth`.
enum AccessibilityTree {
    /// Roles worth surfacing as click targets even when they expose no explicit
    /// AX action (some apps under-report actions).
    private static let interactiveRoles: Set<String> = [
        "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXSearchField",
        "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton",
        "AXMenuItem", "AXMenuBarItem", "AXComboBox", "AXSlider", "AXStepper",
        "AXDisclosureTriangle", "AXTab", "AXCell", "AXColorWell", "AXIncrementor",
        "AXSegmentedControl", "AXToolbarButton", "AXSwitch",
    ]

    private static let maxDepth = 45
    private static let maxNodes = 2_500

    /// Snapshot the given process's accessibility tree, scoped to ONE window +
    /// the menu bar. `windowIndex` (from `list_windows`) picks the window;
    /// nil = the app's focused/main window. Scoping is what keeps a multi-window
    /// app from flattening every window's elements into one ambiguous list.
    /// Requires the Accessibility grant; without it the app element yields no children.
    static func snapshot(pid: pid_t, windowIndex: Int? = nil) -> AXSnapshot {
        let appElement = AXUIElementCreateApplication(pid)
        var elements: [ReadableElement] = []
        var handles: [AXUIElement] = []
        var visited = 0

        func actionable(role: String?, actions: [String]) -> Bool {
            if let role, interactiveRoles.contains(role) { return true }
            return actions.contains(AXAction.press)
        }

        func walk(_ element: AXUIElement, depth: Int) {
            guard depth <= maxDepth, visited < maxNodes else { return }
            visited += 1

            let role = AXCore.stringAttribute(element, AXAttr.role)
            let actions = AXCore.actionNames(element)
            let frame = AXCore.frame(element)

            // Collect only actionable nodes that occupy real screen space.
            if actionable(role: role, actions: actions),
               let frame, frame.width > 0, frame.height > 0 {
                let readable = ReadableElement(
                    index: elements.count,
                    depth: depth,
                    role: role,
                    subrole: AXCore.stringAttribute(element, AXAttr.subrole),
                    roleDescription: AXCore.stringAttribute(element, AXAttr.roleDescription),
                    title: AXCore.stringAttribute(element, AXAttr.title),
                    label: AXCore.stringAttribute(element, AXAttr.label),
                    value: AXCore.stringAttribute(element, AXAttr.value),
                    description: AXCore.stringAttribute(element, AXAttr.description),
                    help: AXCore.stringAttribute(element, AXAttr.help),
                    placeholder: AXCore.stringAttribute(element, AXAttr.placeholder),
                    identifier: AXCore.stringAttribute(element, AXAttr.identifier),
                    frame: frame,
                    enabled: AXCore.boolAttribute(element, AXAttr.enabled),
                    selected: AXCore.boolAttribute(element, AXAttr.selected),
                    actions: actions.isEmpty ? nil : actions)
                elements.append(readable)
                handles.append(element)
            }

            for child in AXCore.children(element) {
                walk(child, depth: depth + 1)
            }
        }

        let resolved = resolveRoots(appElement: appElement, windowIndex: windowIndex)
        for root in resolved.roots {
            walk(root, depth: 0)
        }
        return AXSnapshot(elements: elements, handles: handles, windowIndex: resolved.index, windowTitle: resolved.title)
    }

    /// Pick the roots to walk: the target window (explicit index, else the
    /// focused/main window) plus the menu bar. Falls back to every app child
    /// only when no window resolves at all, preserving the old whole-app tree.
    private static func resolveRoots(appElement: AXUIElement, windowIndex: Int?) -> (roots: [AXUIElement], index: Int?, title: String?) {
        let windows = AXCore.windows(appElement)
        var target: AXUIElement?
        var resolvedIndex: Int?
        if let windowIndex, windowIndex >= 0, windowIndex < windows.count {
            target = windows[windowIndex]
            resolvedIndex = windowIndex
        }
        if target == nil,
           let focused = AXCore.elementAttribute(appElement, AXAttr.focusedWindow)
            ?? AXCore.elementAttribute(appElement, AXAttr.mainWindow) {
            target = focused
            resolvedIndex = windows.firstIndex { CFEqual($0, focused) }
        }
        let title = target.flatMap { AXCore.stringAttribute($0, AXAttr.title) }
        var roots: [AXUIElement] = []
        if let target { roots.append(target) }
        if let menuBar = AXCore.elementAttribute(appElement, AXAttr.menuBar) { roots.append(menuBar) }
        return roots.isEmpty ? (AXCore.children(appElement), nil, nil) : (roots, resolvedIndex, title)
    }

    /// Every window of the running process, front-to-back, for `list_windows`.
    static func listWindows(pid: pid_t) -> [WindowInfo] {
        let appElement = AXUIElementCreateApplication(pid)
        let windows = AXCore.windows(appElement)
        let focused = AXCore.elementAttribute(appElement, AXAttr.focusedWindow)
        return windows.enumerated().map { index, window in
            WindowInfo(
                index: index,
                title: AXCore.stringAttribute(window, AXAttr.title),
                frame: AXCore.frame(window),
                main: AXCore.boolAttribute(window, AXAttr.main) == true,
                focused: focused.map { CFEqual($0, window) } ?? false,
                minimized: AXCore.boolAttribute(window, AXAttr.minimized) == true)
        }
    }

    /// Metadata about the focused window of a running application.
    static func frontmostWindow(app: NSRunningApplication) -> FrontmostWindow {
        let pid = app.processIdentifier
        let appElement = AXUIElementCreateApplication(pid)
        let window = (AXCore.attribute(appElement, AXAttr.focusedWindow)
            ?? AXCore.attribute(appElement, AXAttr.mainWindow))

        var title: String?
        var frame: ElementFrame?
        if let window, CFGetTypeID(window) == AXUIElementGetTypeID() {
            let windowElement = (window as! AXUIElement)
            title = AXCore.stringAttribute(windowElement, AXAttr.title)
            frame = AXCore.frame(windowElement)
        }

        return FrontmostWindow(
            app: app.localizedName,
            bundleId: app.bundleIdentifier,
            pid: pid,
            title: title,
            frame: frame)
    }
}
