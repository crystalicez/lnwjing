import CoreGraphics
import AVFoundation
import Foundation
import ScreenCaptureKit

enum MacScreenRecordingProvider {
    private static let lock = NSLock()
    private static var sessions: [String: MacScreenSession] = [:]
    static func permissionGranted() -> Bool { CGPreflightScreenCaptureAccess() }

    static func status() -> [String: AnyEncodable] {
        let granted = permissionGranted()
        var value = ["available": AnyEncodable(true), "ready": AnyEncodable(granted), "backend": AnyEncodable("screencapturekit"), "supportedActions": AnyEncodable(["status", "start", "stop"]), "permissionState": AnyEncodable(granted ? "granted" : "permission_required")]
        if !granted { value["readinessReason"] = AnyEncodable("permission_required") }
        return value
    }

    static func execute(action: String, input: [String: Any]) -> MacNativeResult {
        guard let owner = MacMediaOwner.read(input) else { return MediaFailure(code: "INVALID_INPUT").result }
        if action == "status", MacMediaValues.string(input, "handle") == nil { return .value(status()) }
        if action == "status" || action == "stop" {
            guard let handle = MacMediaValues.string(input, "handle") else { return MediaFailure(code: "INVALID_INPUT").result }
            lock.lock()
            let session = sessions[handle]
            lock.unlock()
            guard let session, session.owner.permits(owner) else { return MediaFailure(code: "FILE_NOT_FOUND").result }
            if action == "stop" { session.stop(cancel: MacMediaValues.value(input, "cancel") as? Bool == true) }
            return .value(session.receipt(handle))
        }
        guard action == "start", let limits = MacMediaValues.limits(input) else { return MediaFailure(code: "INVALID_INPUT").result }
        if !permissionGranted() && !CGRequestScreenCaptureAccess() {
            return .failure(code: "PERMISSION_REQUIRED", message: "Screen recording consent was denied or is required", recoverable: true)
        }
        lock.lock()
        if sessions.values.contains(where: { $0.owner.permits(owner) && $0.terminationUnverified }) {
            lock.unlock()
            return .failure(code: "CONFLICT", message: "The owned screen recorder did not verify termination; restart its native provider before another capture", recoverable: true)
        }
        guard MacMediaHistory.admit(&sessions, cleanedAt: { $0.cleanedAt }) else { lock.unlock(); return MediaFailure(code: "CONFLICT").result }
        do {
            let session = try MacScreenSession(owner: owner, input: input, duration: limits.0, byteLimit: limits.1)
            let handle = UUID().uuidString
            sessions[handle] = session
            do {
                try session.start(input: input)
                lock.unlock()
                return .value(session.receipt(handle))
            } catch {
                if session.terminationUnverified {
                    lock.unlock()
                    return .value(session.receipt(handle))
                }
                sessions.removeValue(forKey: handle)
                lock.unlock()
                return (error as? MediaFailure ?? MediaFailure(code: "INTERNAL_ERROR")).result
            }
        } catch {
            lock.unlock()
            return (error as? MediaFailure ?? MediaFailure(code: "INTERNAL_ERROR")).result
        }
    }

    static func close() {
        lock.lock()
        let current = Array(sessions.values)
        lock.unlock()
        for session in current { session.stop(cancel: true) }
        lock.lock()
        sessions = sessions.filter { $0.value.requiresRetention }
        lock.unlock()
    }
}

private final class MacScreenSession: NSObject, SCStreamOutput, SCStreamDelegate {
    let owner: MacMediaOwner
    private let lock = NSRecursiveLock()
    private let outputQueue = DispatchQueue(label: "lnwjing.screen.samples", qos: .utility)
    private let target: URL
    private let temporary: URL
    private let duration: Double
    private let byteLimit: Int64
    private var stream: SCStream?
    private var writer: AVAssetWriter?
    private var video: AVAssetWriterInput?
    private var timer: DispatchSourceTimer?
    private var state = MacMediaState.running
    private var errorCode: String?
    private var artifact: [String: AnyEncodable]?
    private var firstFrame: CMTime?
    private var startedAt = Date()
    private var finishedAt: Date?
    private let lifecycle = MacCaptureLifecycle()

    var cleanedAt: Date? {
        lock.lock(); defer { lock.unlock() }
        return state.requiresRetention ? nil : finishedAt
    }

    var terminationUnverified: Bool {
        lock.lock(); defer { lock.unlock() }
        return state == .terminationUnverified
    }

    var requiresRetention: Bool {
        lock.lock(); defer { lock.unlock() }
        return state.requiresRetention
    }

    init(owner: MacMediaOwner, input: [String: Any], duration: Double, byteLimit: Int64) throws {
        self.owner = owner
        self.duration = duration
        self.byteLimit = byteLimit
        let output = try MacMediaValues.output(input, extension: "mp4")
        target = output.0
        temporary = output.1
        super.init()
    }

    func start(input: [String: Any]) throws {
        do {
            let semaphore = DispatchSemaphore(value: 0)
            var content: SCShareableContent?
            var failure: Error?
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { result, error in
                content = result
                failure = error
                semaphore.signal()
            }
            guard semaphore.wait(timeout: .now() + 10) == .success, failure == nil, let content else { throw MediaFailure(code: "PERMISSION_REQUIRED") }
            let requested: CGDirectDisplayID
            if let selector = MacMediaValues.string(input, "display_id") {
                guard let parsed = UInt32(selector) else { throw MediaFailure(code: "INVALID_INPUT") }
                requested = parsed
            } else { requested = CGMainDisplayID() }
            guard let display = content.displays.first(where: { $0.displayID == requested }), display.width > 0, display.height > 0 else { throw MediaFailure(code: "FILE_NOT_FOUND") }
            guard let geometry = MacMediaValues.screenGeometry(input, display: display.frame, pixelWidth: display.width, pixelHeight: display.height) else { throw MediaFailure(code: "INVALID_INPUT") }
            let width = geometry.width
            let height = geometry.height
            let writer = try AVAssetWriter(outputURL: temporary, fileType: .mp4)
            let video = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height, AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 2_000_000]])
            video.expectsMediaDataInRealTime = true
            guard writer.canAdd(video) else { throw MediaFailure(code: "INTERNAL_ERROR") }
            writer.add(video)
            self.writer = writer
            self.video = video
            let configuration = SCStreamConfiguration()
            configuration.width = width
            configuration.height = height
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(geometry.fps))
            if let source = geometry.source { configuration.sourceRect = source }
            configuration.queueDepth = 3
            configuration.showsCursor = true
            configuration.capturesAudio = false
            let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration, delegate: self)
            self.stream = stream
            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: outputQueue)
            guard lifecycle.start(timeout: 10, operation: { completion in stream.startCapture(completionHandler: completion) }) else { throw MediaFailure(code: "PERMISSION_REQUIRED") }
            startedAt = Date()
            let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
            timer.schedule(deadline: .now() + 0.1, repeating: 0.1)
            timer.setEventHandler { [weak self] in self?.checkLimits() }
            self.timer = timer
            timer.resume()
        } catch {
            lock.lock()
            state = .stopping
            timer?.cancel(); timer = nil
            lock.unlock()
            let stoppedCleanly = stream.map { stream in
                lifecycle.stop(timeout: 5, operation: { completion in stream.stopCapture(completionHandler: completion) })
            } ?? true
            writer?.cancelWriting()
            try? FileManager.default.removeItem(at: temporary)
            lock.lock()
            if stoppedCleanly {
                finishFailure((error as? MediaFailure)?.code ?? "INTERNAL_ERROR")
                self.stream = nil
            } else {
                state = .terminationUnverified
                errorCode = "PROCESS_TIMEOUT"
            }
            lock.unlock()
            throw error
        }
    }

    private func checkLimits() {
        lock.lock()
        guard state == .running else { lock.unlock(); return }
        let bytes = ((try? FileManager.default.attributesOfItem(atPath: temporary.path))?[.size] as? NSNumber)?.int64Value ?? 0
        let exceeded = bytes >= byteLimit
        if exceeded { errorCode = "FILE_TOO_LARGE" }
        let revoked = !MacScreenRecordingProvider.permissionGranted()
        if revoked { errorCode = "PERMISSION_REQUIRED" }
        let ended = Date().timeIntervalSince(startedAt) >= duration
        lock.unlock()
        if exceeded || revoked || ended { stop(cancel: exceeded || revoked) }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        lock.lock(); defer { lock.unlock() }
        guard state == .running, outputType == .screen, CMSampleBufferIsValid(sampleBuffer), CMSampleBufferDataIsReady(sampleBuffer),
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: rawStatus) == .complete,
              let writer, let video else { return }
        if firstFrame == nil {
            guard writer.startWriting() else { errorCode = "INTERNAL_ERROR"; DispatchQueue.global().async { self.stop(cancel: true) }; return }
            let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            writer.startSession(atSourceTime: time)
            firstFrame = time
        }
        if video.isReadyForMoreMediaData, !video.append(sampleBuffer) {
            errorCode = "INTERNAL_ERROR"
            DispatchQueue.global().async { self.stop(cancel: true) }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        if state != .running { lock.unlock(); return }
        errorCode = "PERMISSION_REQUIRED"
        lock.unlock()
        DispatchQueue.global().async { self.stop(cancel: true) }
    }

    func stop(cancel: Bool) {
        lock.lock()
        guard state == .running || state == .terminationUnverified else { lock.unlock(); return }
        state = .stopping
        timer?.cancel(); timer = nil
        let stream = self.stream
        lock.unlock()
        let stoppedCleanly = stream.map { stream in
            lifecycle.stop(timeout: 5, operation: { completion in stream.stopCapture(completionHandler: completion) })
        } ?? true
        lock.lock(); defer { lock.unlock() }
        if !stoppedCleanly {
            writer?.cancelWriting()
            state = .terminationUnverified
            errorCode = "PROCESS_TIMEOUT"
            try? FileManager.default.removeItem(at: temporary)
            return
        }
        self.stream = nil
        guard let writer, let video else { finishFailure("INTERNAL_ERROR"); return }
        if cancel || firstFrame == nil {
            writer.cancelWriting()
            state = cancel && errorCode == nil ? .cancelled : .failed
            if !cancel && firstFrame == nil { errorCode = "INTERNAL_ERROR" }
            try? FileManager.default.removeItem(at: temporary)
            finishedAt = Date()
            return
        }
        video.markAsFinished()
        let finished = DispatchSemaphore(value: 0)
        writer.finishWriting { finished.signal() }
        guard finished.wait(timeout: .now() + 5) == .success, writer.status == .completed else { writer.cancelWriting(); finishFailure("INTERNAL_ERROR"); return }
        do {
            artifact = try MacMediaValues.publish(target: target, temporary: temporary, format: .mp4, durationLimit: duration, byteLimit: byteLimit)
            state = .completed
            finishedAt = Date()
        } catch { finishFailure((error as? MediaFailure)?.code ?? "INTERNAL_ERROR") }
    }

    private func finishFailure(_ code: String) {
        errorCode = code
        state = .failed
        finishedAt = Date()
        try? FileManager.default.removeItem(at: temporary)
    }

    func receipt(_ handle: String) -> [String: AnyEncodable] {
        lock.lock(); defer { lock.unlock() }
        let live = state == .running || state == .stopping || state == .terminationUnverified
        var receipt = ["handle": AnyEncodable(handle), "state": AnyEncodable(state.rawValue), "running": AnyEncodable(live), "deliveryState": AnyEncodable(live ? "running" : state == .completed ? "completed" : "failed"), "duration_limit_seconds": AnyEncodable(duration), "byte_limit": AnyEncodable(byteLimit), "backend": AnyEncodable("screencapturekit"), "coordinate_space": AnyEncodable("display_logical")]
        if state == .terminationUnverified { receipt["termination_verified"] = AnyEncodable(false) }
        if let artifact { receipt["artifact"] = AnyEncodable(artifact) }
        if let errorCode { receipt["error"] = AnyEncodable(["code": AnyEncodable(errorCode), "recoverable": AnyEncodable(true)]) }
        return receipt
    }
}
