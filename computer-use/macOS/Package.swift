// swift-tools-version:5.9
//
// NsComputerUseHelper — NicoSoft Computer Use helper.
//
// A standalone, non-sandboxed macOS agent that exposes screen capture, input
// synthesis, and the accessibility tree over a local unix-domain socket using
// newline-delimited JSON-RPC. It is packaged as a signed `.app` (LSUIElement)
// so it can hold the Accessibility + Screen Recording TCC grants on a stable
// signing identity. See docs/computer-use-replication-research.md.
//
// Swift 5 language mode is used deliberately: the process is a single-purpose
// daemon with an explicit threading model (see Server.swift), so the strict
// concurrency checking of the Swift 6 mode would add noise without value here.

import PackageDescription

let package = Package(
    name: "NsComputerUseHelper",
    platforms: [
        .macOS(.v14) // SCScreenshotManager.captureImage requires macOS 14+.
    ],
    targets: [
        .executableTarget(
            name: "NsComputerUseHelper",
            path: "Sources/NsComputerUseHelper"
            // System frameworks (ScreenCaptureKit, AppKit, ApplicationServices,
            // CoreGraphics, ImageIO) autolink from their `import` statements on
            // Apple platforms; no explicit linkerSettings are required.
        )
    ]
)
