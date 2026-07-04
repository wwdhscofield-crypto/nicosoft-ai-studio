import Foundation

/// A rectangle in the global point space (top-left origin), matching CGEvent/AX.
struct ElementFrame: Encodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    /// Center point, used as the pixel-fallback click target for an element.
    var center: CGPoint { CGPoint(x: x + width / 2, y: y + height / 2) }
}

/// The projection of one accessibility node handed to the model — the local,
/// independently-designed equivalent of the reference "readable element".
///
/// Every field is optional and omitted from JSON when absent (Swift synthesizes
/// `encodeIfPresent` for optionals), so the wire output stays compact. `index`
/// is the stable handle: the model sends `perform_action click index=<n>` and
/// the helper resolves it against the registry captured by the same `ui_tree`.
struct ReadableElement: Encodable {
    /// Stable ordinal within the tree snapshot; the click target.
    let index: Int
    /// Depth in the accessibility hierarchy (0 = application root's children).
    let depth: Int

    let role: String?
    let subrole: String?
    let roleDescription: String?
    let title: String?
    let label: String?
    let value: String?
    let description: String?
    let help: String?
    let placeholder: String?
    let identifier: String?

    let frame: ElementFrame?
    let enabled: Bool?
    let selected: Bool?

    /// Accessibility actions the element exposes (e.g. `AXPress`), so the model
    /// knows what a secondary action could invoke.
    let actions: [String]?
}
