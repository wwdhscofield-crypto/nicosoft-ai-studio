import ApplicationServices
import Foundation

/// Holds the live `AXUIElement` handles from the most recent `ui_tree` snapshot
/// so `perform_action` can resolve an `index` (or `elementID`) back to an
/// element and drive it via `AXPress`.
///
/// A snapshot token is bumped on every update; it lets a caller detect that the
/// tree it indexed against has since been replaced. Access is serialized by the
/// owning `Server`, so no internal locking is needed here.
final class ElementRegistry {
    private(set) var token: Int = 0
    private var handles: [AXUIElement] = []
    private var elements: [ReadableElement] = []

    /// Replace the registry with a fresh snapshot and return its token.
    @discardableResult
    func update(_ snapshot: AXSnapshot) -> Int {
        token += 1
        handles = snapshot.handles
        elements = snapshot.elements
        return token
    }

    /// Look up an element handle by its snapshot index.
    func handle(atIndex index: Int) -> AXUIElement? {
        guard index >= 0, index < handles.count else { return nil }
        return handles[index]
    }

    /// Look up an element handle by its accessibility identifier (first match).
    func handle(withIdentifier identifier: String) -> AXUIElement? {
        guard let position = elements.firstIndex(where: { $0.identifier == identifier }) else {
            return nil
        }
        return handles[position]
    }

    /// The readable element at an index, for reporting its frame/center.
    func element(atIndex index: Int) -> ReadableElement? {
        guard index >= 0, index < elements.count else { return nil }
        return elements[index]
    }
}
