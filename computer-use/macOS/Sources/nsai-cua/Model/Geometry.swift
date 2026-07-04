import CoreGraphics
import Foundation

/// Physical description of one display, used to translate the pixel coordinates
/// the model reads off a screenshot into the point-based global coordinate
/// space that `CGEvent` and the accessibility APIs use.
///
/// Three coordinate systems are in play (see research doc §5, item 6):
///  * **Screenshot pixels** — what the model sees; origin at the display's
///    top-left, unit = 1 captured pixel.
///  * **Global points** — `CGEvent` / AX space; origin at the *main* display's
///    top-left, unit = 1 point. Secondary displays sit at a point offset.
///  * **Display bounds** — `CGDisplayBounds` gives each display's origin/size in
///    global points.
struct DisplayInfo {
    let id: CGDirectDisplayID
    /// Top-left of the display in the global point space.
    let originPoints: CGPoint
    /// Display size in points.
    let sizePoints: CGSize
    /// Pixels per point (2.0 on Retina, 1.0 otherwise).
    let scale: CGFloat

    var pixelWidth: Int { Int((sizePoints.width * scale).rounded()) }
    var pixelHeight: Int { Int((sizePoints.height * scale).rounded()) }

    /// Convert a coordinate in this display's screenshot-pixel space to the
    /// global point space consumed by `CGEvent`/AX.
    func globalPoint(fromPixel pixel: CGPoint) -> CGPoint {
        CGPoint(
            x: originPoints.x + pixel.x / scale,
            y: originPoints.y + pixel.y / scale)
    }
}

enum Displays {
    static func info(for id: CGDirectDisplayID) -> DisplayInfo {
        let bounds = CGDisplayBounds(id) // global points, main at (0,0)
        var scale: CGFloat = 1
        if let mode = CGDisplayCopyDisplayMode(id) {
            let pointWidth = bounds.width
            if pointWidth > 0 {
                scale = CGFloat(mode.pixelWidth) / pointWidth
            }
        }
        return DisplayInfo(
            id: id,
            originPoints: bounds.origin,
            sizePoints: bounds.size,
            scale: scale)
    }

    static func main() -> DisplayInfo {
        info(for: CGMainDisplayID())
    }

    /// All active displays, main first.
    static func all() -> [DisplayInfo] {
        var count: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &count)
        guard count > 0 else { return [main()] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        CGGetActiveDisplayList(count, &ids, &count)
        return ids.prefix(Int(count)).map { info(for: $0) }
    }

    /// Resolve an optional zero-based display index to a `DisplayInfo`,
    /// defaulting to the main display.
    static func resolve(index: Int?) -> DisplayInfo {
        let list = all()
        if let index, index >= 0, index < list.count { return list[index] }
        return list.first ?? main()
    }
}
