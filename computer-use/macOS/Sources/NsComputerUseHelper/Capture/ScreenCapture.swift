import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

/// A captured screenshot plus the metadata the caller needs to map coordinates.
struct Screenshot {
    let pngBase64: String
    /// Image dimensions in pixels.
    let width: Int
    let height: Int
    /// Pixels per point of the source display.
    let scale: CGFloat
    let displayID: CGDirectDisplayID
}

/// Captures full-display screenshots via ScreenCaptureKit (macOS 14+).
///
/// ScreenCaptureKit requires the Screen Recording TCC grant; without it the
/// capture throws and the caller surfaces a permission error so the model can
/// poll `permission_status` until the user grants access.
enum ScreenCapture {
    /// Capture a single frame of the given display (main display by default).
    static func capture(display: DisplayInfo) async throws -> Screenshot {
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false)
        } catch {
            throw CUAError.permissionDenied(
                "screen capture unavailable (grant Screen Recording): \(error.localizedDescription)")
        }

        guard let scDisplay = content.displays.first(where: { $0.displayID == display.id })
            ?? content.displays.first else {
            throw CUAError.unavailable("no shareable display found")
        }

        let filter = SCContentFilter(display: scDisplay, excludingWindows: [])

        let config = SCStreamConfiguration()
        // Capture at native pixel resolution so on-screen geometry matches the
        // scale we report back for coordinate mapping.
        config.width = display.pixelWidth
        config.height = display.pixelHeight
        config.showsCursor = true
        config.capturesAudio = false
        config.scalesToFit = false

        let cgImage: CGImage
        do {
            cgImage = try await SCScreenshotManager.captureImage(
                contentFilter: filter, configuration: config)
        } catch {
            throw CUAError.permissionDenied(
                "capture failed (grant Screen Recording): \(error.localizedDescription)")
        }

        guard let png = pngData(from: cgImage) else {
            throw CUAError.internalError("PNG encoding failed")
        }

        return Screenshot(
            pngBase64: png.base64EncodedString(),
            width: cgImage.width,
            height: cgImage.height,
            scale: display.scale,
            displayID: display.id)
    }

    private static func pngData(from cgImage: CGImage) -> Data? {
        let rep = NSBitmapImageRep(cgImage: cgImage)
        rep.size = NSSize(width: cgImage.width, height: cgImage.height)
        return rep.representation(using: .png, properties: [:])
    }
}
