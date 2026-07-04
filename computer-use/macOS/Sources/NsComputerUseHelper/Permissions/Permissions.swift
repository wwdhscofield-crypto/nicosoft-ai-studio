import ApplicationServices
import CoreGraphics
import Foundation

/// TCC permission state for one capability.
enum PermissionState: String, Encodable {
    case granted
    case denied
}

/// Full permission snapshot returned by `permission_status`.
struct PermissionStatus: Encodable {
    let accessibility: PermissionState
    let screenRecording: PermissionState

    var allGranted: Bool {
        accessibility == .granted && screenRecording == .granted
    }
}

/// Probes and (optionally) requests the two TCC grants the helper needs.
///
/// Neither grant can be enabled programmatically — the user must toggle them in
/// System Settings ▸ Privacy & Security. The `prompt` path only *triggers* the
/// system prompt / deep-links the pane; the helper then polls until granted,
/// mirroring how the reference implementations behave.
enum Permissions {
    /// Current state without prompting.
    static func status() -> PermissionStatus {
        PermissionStatus(
            accessibility: AXIsProcessTrusted() ? .granted : .denied,
            screenRecording: CGPreflightScreenCaptureAccess() ? .granted : .denied)
    }

    /// Probe state, first nudging the system to show its permission prompts for
    /// anything not yet granted.
    static func requestAndStatus() -> PermissionStatus {
        if !AXIsProcessTrusted() {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        }
        if !CGPreflightScreenCaptureAccess() {
            // Triggers the one-time Screen Recording prompt for this binary.
            _ = CGRequestScreenCaptureAccess()
        }
        return status()
    }

    /// Whether input synthesis / AX control is currently permitted.
    static var accessibilityGranted: Bool { AXIsProcessTrusted() }
}
