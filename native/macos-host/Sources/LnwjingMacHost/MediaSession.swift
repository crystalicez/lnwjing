import CoreFoundation
import Foundation
import CoreGraphics
import AVFoundation

struct MacMediaOwner: Equatable {
    let client: String
    let session: String
    let workspace: String?

    static func read(_ input: [String: Any]) -> MacMediaOwner? {
        guard let metadata = input["metadata"] as? [String: Any], let raw = metadata["lnwjing.taskOwner.v1"] else {
            return MacMediaOwner(client: "legacy", session: "legacy", workspace: nil)
        }
        guard let owner = raw as? [String: Any], let client = valid(owner["clientId"]), let session = valid(owner["sessionId"]) else { return nil }
        if owner["workspaceId"] != nil && valid(owner["workspaceId"]) == nil { return nil }
        return MacMediaOwner(client: client, session: session, workspace: valid(owner["workspaceId"]))
    }

    private static func valid(_ value: Any?) -> String? {
        guard let value = value as? String, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, value.utf8.count <= 256, !value.contains("\0") else { return nil }
        return value
    }

    func permits(_ requester: MacMediaOwner) -> Bool {
        client == requester.client && session == requester.session && (requester.workspace == nil || workspace == requester.workspace)
    }
}

enum MacMediaState: String {
    case running, stopping, completed, cancelled, failed
    case terminationUnverified = "termination_unverified"

    var requiresRetention: Bool {
        self == .running || self == .stopping || self == .terminationUnverified
    }
}

enum MacMediaHistory {
    static func admit<Session>(_ sessions: inout [String: Session], now: Date = Date(), limit: Int = 16, cleanedAt: (Session) -> Date?) -> Bool {
        sessions = sessions.filter { entry in
            cleanedAt(entry.value).map { now.timeIntervalSince($0) < 900 } ?? true
        }
        while sessions.count >= limit {
            let terminal = sessions.compactMap { entry -> (String, Date)? in
                cleanedAt(entry.value).map { (entry.key, $0) }
            }.min { left, right in
                left.1 == right.1 ? left.0 < right.0 : left.1 < right.1
            }
            guard let terminal else { return false }
            sessions.removeValue(forKey: terminal.0)
        }
        return true
    }
}

final class MacCaptureLifecycle {
    typealias Operation = (@escaping (Error?) -> Void) -> Void
    private let lock = NSLock()
    private var startIssued = false
    private var startSettled = false

    func start(timeout: TimeInterval, operation: Operation) -> Bool {
        lock.lock()
        startIssued = true
        startSettled = false
        lock.unlock()
        let completion = MacCaptureCompletion()
        operation { error in
            self.lock.lock()
            self.startSettled = true
            self.lock.unlock()
            completion.complete(error == nil)
        }
        return completion.wait(timeout: timeout)
    }

    func stop(timeout: TimeInterval, operation: Operation) -> Bool {
        let completion = MacCaptureCompletion()
        operation { error in completion.complete(error == nil) }
        guard completion.wait(timeout: timeout) else { return false }
        lock.lock(); defer { lock.unlock() }
        return !startIssued || startSettled
    }
}

private final class MacCaptureCompletion {
    private let lock = NSLock()
    private let semaphore = DispatchSemaphore(value: 0)
    private var succeeded: Bool?

    func complete(_ success: Bool) {
        lock.lock()
        guard succeeded == nil else { lock.unlock(); return }
        succeeded = success
        lock.unlock()
        semaphore.signal()
    }

    func wait(timeout: TimeInterval) -> Bool {
        guard semaphore.wait(timeout: .now() + timeout) == .success else { return false }
        lock.lock(); defer { lock.unlock() }
        return succeeded == true
    }
}

enum MacMediaFormat: String {
    case wav, mp4
}

enum MacMediaValues {
    static let maximumBytes: Int64 = 64 * 1024 * 1024
    static let maximumDuration = 600.0

    static func value(_ input: [String: Any], _ name: String) -> Any? {
        input[name] ?? (input["parameters"] as? [String: Any])?[name]
    }

    static func string(_ input: [String: Any], _ name: String) -> String? { value(input, name) as? String }

    static func number(_ input: [String: Any], _ name: String, default fallback: Double, minimum: Double, maximum: Double) -> Double? {
        guard let raw = value(input, name) else { return fallback }
        guard let raw = raw as? NSNumber, CFGetTypeID(raw) != CFBooleanGetTypeID() else { return nil }
        let value = raw.doubleValue
        return value.isFinite && value >= minimum && value <= maximum ? value : nil
    }

    static func limits(_ input: [String: Any]) -> (Double, Int64)? {
        guard let duration = number(input, "duration_seconds", default: 60, minimum: 0.1, maximum: maximumDuration),
              let bytes = number(input, "max_bytes", default: Double(maximumBytes), minimum: 1024, maximum: Double(maximumBytes)), bytes.rounded(.towardZero) == bytes else { return nil }
        return (duration, Int64(bytes))
    }

    static func screenGeometry(_ input: [String: Any], display: CGRect, pixelWidth: Int, pixelHeight: Int) -> (source: CGRect?, width: Int, height: Int, fps: Int)? {
        guard let fps = number(input, "fps", default: 15, minimum: 1, maximum: 60), fps.rounded(.towardZero) == fps else { return nil }
        let regionRequested = ["offset_x", "offset_y", "width", "height"].contains { value(input, $0) != nil }
        if !regionRequested {
            let width = min(1280, pixelWidth) / 2 * 2
            let height = max(2, Int(Double(pixelHeight) * Double(width) / Double(max(1, pixelWidth))) / 2 * 2)
            return width >= 2 && height <= 16384 ? (nil, width, height, Int(fps)) : nil
        }
        guard value(input, "width") != nil, value(input, "height") != nil,
              let x = number(input, "offset_x", default: display.minX, minimum: -16384, maximum: 16384),
              let y = number(input, "offset_y", default: display.minY, minimum: -16384, maximum: 16384),
              let width = number(input, "width", default: 1280, minimum: 2, maximum: 7680),
              let height = number(input, "height", default: 720, minimum: 2, maximum: 4320),
              [x, y, width, height].allSatisfy({ $0.rounded(.towardZero) == $0 }), Int(width) % 2 == 0, Int(height) % 2 == 0 else { return nil }
        let region = CGRect(x: x, y: y, width: width, height: height)
        guard display.contains(region) else { return nil }
        return (CGRect(x: x - display.minX, y: y - display.minY, width: width, height: height), Int(width), Int(height), Int(fps))
    }

    static func output(_ input: [String: Any], extension suffix: String) throws -> (URL, URL) {
        guard let path = string(input, "output_path"), path.hasPrefix("/"), !path.contains("\0"), path.utf8.count <= 4096 else { throw MediaFailure(code: "INVALID_INPUT") }
        let target = URL(fileURLWithPath: path)
        guard !FileManager.default.fileExists(atPath: target.path) else { throw MediaFailure(code: "CONFLICT") }
        var directory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: target.deletingLastPathComponent().path, isDirectory: &directory), directory.boolValue else { throw MediaFailure(code: "FILE_NOT_FOUND") }
        return (target, target.deletingLastPathComponent().appendingPathComponent(".lnwjing-\(UUID().uuidString).\(suffix)"))
    }

    static func publish(target: URL, temporary: URL, format: MacMediaFormat, durationLimit: Double, byteLimit: Int64) throws -> [String: AnyEncodable] {
        let attributes = try FileManager.default.attributesOfItem(atPath: temporary.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular, let bytes = attributes[.size] as? NSNumber, bytes.int64Value > 0 else { throw MediaFailure(code: "INTERNAL_ERROR") }
        guard bytes.int64Value <= byteLimit else { throw MediaFailure(code: "FILE_TOO_LARGE") }
        let duration: Double
        var details: [String: AnyEncodable] = [:]
        switch format {
        case .wav:
            let file = try AVAudioFile(forReading: temporary)
            guard file.length > 0, file.processingFormat.sampleRate > 0 else { throw MediaFailure(code: "INTERNAL_ERROR") }
            let header = try FileHandle(forReadingFrom: temporary)
            defer { try? header.close() }
            let bytes = try header.read(upToCount: 12) ?? Data()
            guard bytes.count == 12, String(decoding: bytes.prefix(4), as: UTF8.self) == "RIFF", String(decoding: bytes.suffix(4), as: UTF8.self) == "WAVE" else { throw MediaFailure(code: "INTERNAL_ERROR") }
            duration = Double(file.length) / file.processingFormat.sampleRate
            details = ["sample_rate": AnyEncodable(file.processingFormat.sampleRate), "channels": AnyEncodable(file.processingFormat.channelCount)]
        case .mp4:
            let asset = AVURLAsset(url: temporary)
            guard let track = asset.tracks(withMediaType: .video).first else { throw MediaFailure(code: "INTERNAL_ERROR") }
            duration = CMTimeGetSeconds(asset.duration)
            details = ["width": AnyEncodable(Int(abs(track.naturalSize.width))), "height": AnyEncodable(Int(abs(track.naturalSize.height)))]
        }
        guard duration.isFinite, duration > 0, duration <= durationLimit + 0.2, duration <= maximumDuration + 0.2 else { throw MediaFailure(code: "PROCESS_TIMEOUT") }
        do { try FileManager.default.linkItem(at: temporary, to: target) }
        catch { throw MediaFailure(code: FileManager.default.fileExists(atPath: target.path) ? "CONFLICT" : "INTERNAL_ERROR") }
        try? FileManager.default.removeItem(at: temporary)
        var artifact = ["file_path": AnyEncodable(target.path), "output_path": AnyEncodable(target.path), "format": AnyEncodable(format.rawValue), "mime_type": AnyEncodable(format == .wav ? "audio/wav" : "video/mp4"), "byte_length": AnyEncodable(bytes.int64Value), "duration_seconds": AnyEncodable(duration), "verified": AnyEncodable(true)]
        artifact.merge(details) { _, verified in verified }
        return artifact
    }
}

struct MediaFailure: Error {
    let code: String
    var result: MacNativeResult { .failure(code: code, message: "Native media could not start, finish, or verify its owned artifact", recoverable: code != "INVALID_INPUT") }
}
