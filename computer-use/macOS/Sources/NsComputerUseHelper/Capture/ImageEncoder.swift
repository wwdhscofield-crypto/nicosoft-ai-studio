import AppKit
import CoreGraphics
import Foundation

/// Encodes a `CGImage` to PNG or JPEG. JPEG is the sensible default for the
/// streaming path (far smaller and faster to encode than PNG at full screen
/// resolution); PNG stays the default for single screenshots where fidelity
/// matters more than throughput.
enum ImageEncoder {
    struct Encoded {
        let data: Data
        let format: String
        let mime: String
    }

    static func encode(_ cgImage: CGImage, format: String, quality: Double) -> Encoded? {
        let rep = NSBitmapImageRep(cgImage: cgImage)
        rep.size = NSSize(width: cgImage.width, height: cgImage.height)

        switch format.lowercased() {
        case "jpeg", "jpg":
            let q = min(max(quality, 0.1), 1.0)
            guard let data = rep.representation(using: .jpeg, properties: [.compressionFactor: q]) else {
                return nil
            }
            return Encoded(data: data, format: "jpeg", mime: "image/jpeg")
        default:
            guard let data = rep.representation(using: .png, properties: [:]) else { return nil }
            return Encoded(data: data, format: "png", mime: "image/png")
        }
    }
}
