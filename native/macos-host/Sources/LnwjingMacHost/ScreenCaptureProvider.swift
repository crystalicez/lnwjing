import CoreGraphics

enum MacScreenCaptureProvider {
    static func captureWindow(_ id: CGWindowID) -> CGImage? {
        CGWindowListCreateImage(.null, [.optionIncludingWindow], id, [.bestResolution])
    }

    static func captureDisplay(_ id: CGDirectDisplayID) -> CGImage? {
        CGDisplayCreateImage(id)
    }

    static func captureRegion(_ bounds: CGRect) -> CGImage? {
        CGWindowListCreateImage(bounds, [.optionOnScreenOnly], kCGNullWindowID, [.bestResolution])
    }
}
