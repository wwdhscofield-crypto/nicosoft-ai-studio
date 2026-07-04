import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

/// A warm, continuous screen capture session.
///
/// `SCScreenshotManager.captureImage` (see `ScreenCapture`) sets up and tears
/// down a capture session on every call — ~100 ms of latency per frame. A
/// long-lived `SCStream` pays that setup cost once, then delivers frames as
/// they are produced, so `next_capture` returns the most recent frame in a
/// fraction of the time. This mirrors the reference implementation's
/// StartCapture / NextCaptureUpdate pair.
///
/// The pull model is deliberate: frames are held (latest only) and handed out
/// on request, optionally long-polling until a frame newer than the caller's
/// last-seen index arrives. No frames are pushed unsolicited over the socket.
final class ScreenStreamer: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let condition = NSCondition()
    private var latestImage: CGImage?
    private var frameIndex = 0
    private(set) var isRunning = false

    private let sampleQueue = DispatchQueue(label: "dev.nicosoft.cuh.capture")
    // A reused CIContext — creating one per frame would defeat the point.
    private let ciContext = CIContext(options: [.cacheIntermediates: false])

    /// Start (or restart) capture of the given display at up to `fps` frames/sec.
    func start(display: DisplayInfo, fps: Int) async throws {
        await stopIfRunning()

        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
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
        config.width = display.pixelWidth
        config.height = display.pixelHeight
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, min(fps, 60))))
        config.queueDepth = 3
        config.showsCursor = true
        config.pixelFormat = kCVPixelFormatType_32BGRA

        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        do {
            try await stream.startCapture()
        } catch {
            throw CUAError.permissionDenied(
                "start capture failed (grant Screen Recording): \(error.localizedDescription)")
        }

        condition.lock()
        self.stream = stream
        self.latestImage = nil
        self.frameIndex = 0
        self.isRunning = true
        condition.unlock()
        Log.info("stream capture started (\(display.pixelWidth)x\(display.pixelHeight) @ \(fps)fps)")
    }

    func stop() async {
        await stopIfRunning()
    }

    private func stopIfRunning() async {
        let running: SCStream?
        condition.lock()
        running = stream
        stream = nil
        isRunning = false
        latestImage = nil
        condition.broadcast() // wake any waiters so they don't hang
        condition.unlock()
        if let running { try? await running.stopCapture() }
    }

    /// The most recent frame and its index, or nil if none has arrived yet.
    func latest() -> (image: CGImage, index: Int)? {
        condition.lock()
        defer { condition.unlock() }
        guard let image = latestImage else { return nil }
        return (image, frameIndex)
    }

    /// Block until a frame newer than `after` is available or the timeout
    /// elapses. Returns the frame and its index, or nil on timeout / stopped.
    func waitForFrame(after: Int, timeoutMs: Int) -> (image: CGImage, index: Int)? {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date().addingTimeInterval(Double(max(0, timeoutMs)) / 1000.0)
        while isRunning, frameIndex <= after || latestImage == nil {
            if !condition.wait(until: deadline) { break } // timed out
        }
        guard let image = latestImage else { return nil }
        return (image, frameIndex)
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ciImage = CIImage(cvImageBuffer: pixelBuffer)
        guard let cgImage = ciContext.createCGImage(ciImage, from: ciImage.extent) else { return }

        condition.lock()
        latestImage = cgImage
        frameIndex += 1
        condition.broadcast()
        condition.unlock()
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Log.warn("stream stopped with error: \(error.localizedDescription)")
        condition.lock()
        isRunning = false
        self.stream = nil
        condition.broadcast()
        condition.unlock()
    }
}
