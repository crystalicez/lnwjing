import AVFoundation
import Foundation

enum MacAudioProvider {
    private static let lock = NSLock()
    private static var sessions: [String: MacAudioSession] = [:]

    static func permissionGranted() -> Bool {
        AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    }

    static func status() -> [String: AnyEncodable] {
        let microphone = AVCaptureDevice.default(for: .audio) != nil
        let permission = permissionGranted()
        var value = ["available": AnyEncodable(true), "ready": AnyEncodable(microphone && permission), "backend": AnyEncodable("avfoundation"), "supportedActions": AnyEncodable(["status", "record", "play", "stop"]), "permissionState": AnyEncodable(permission ? "granted" : "permission_required")]
        if !microphone || !permission { value["readinessReason"] = AnyEncodable(!microphone ? "dependency_missing" : "permission_required") }
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
        guard action == "record" || action == "play", let limits = MacMediaValues.limits(input) else { return MediaFailure(code: "INVALID_INPUT").result }
        if action == "record" && !permissionGranted() {
            let semaphore = DispatchSemaphore(value: 0)
            AVCaptureDevice.requestAccess(for: .audio) { _ in semaphore.signal() }
            guard semaphore.wait(timeout: .now() + 60) == .success, permissionGranted() else { return .failure(code: "PERMISSION_REQUIRED", message: "Microphone consent was denied or is required", recoverable: true) }
        }
        lock.lock()
        guard MacMediaHistory.admit(&sessions, cleanedAt: { $0.cleanedAt }) else { lock.unlock(); return MediaFailure(code: "CONFLICT").result }
        do {
            let session = try MacAudioSession(owner: owner, input: input, record: action == "record", duration: limits.0, byteLimit: limits.1)
            let handle = UUID().uuidString
            sessions[handle] = session
            lock.unlock()
            return .value(session.receipt(handle))
        } catch {
            lock.unlock()
            return (error as? MediaFailure ?? MediaFailure(code: "INTERNAL_ERROR")).result
        }
    }

    static func close() {
        lock.lock()
        let current = Array(sessions.values)
        sessions.removeAll()
        lock.unlock()
        for session in current { session.stop(cancel: true) }
    }
}

private final class MacAudioSession: NSObject, AVAudioRecorderDelegate, AVAudioPlayerDelegate {
    let owner: MacMediaOwner
    private let lock = NSRecursiveLock()
    private let duration: Double
    private let byteLimit: Int64
    private let target: URL?
    private let temporary: URL?
    private var recorder: AVAudioRecorder?
    private var player: AVAudioPlayer?
    private var timer: DispatchSourceTimer?
    private var state = MacMediaState.running
    private var artifact: [String: AnyEncodable]?
    private var errorCode: String?
    private var finishedAt: Date?
    private let startedAt = Date()

    var cleanedAt: Date? {
        lock.lock(); defer { lock.unlock() }
        return state.requiresRetention ? nil : finishedAt
    }

    init(owner: MacMediaOwner, input: [String: Any], record: Bool, duration: Double, byteLimit: Int64) throws {
        self.owner = owner
        self.duration = duration
        self.byteLimit = byteLimit
        if record {
            let output = try MacMediaValues.output(input, extension: "wav")
            target = output.0
            temporary = output.1
        } else { target = nil; temporary = nil }
        super.init()
        do {
            if record, let temporary {
                let recorder = try AVAudioRecorder(url: temporary, settings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 44_100.0, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false])
                recorder.delegate = self
                self.recorder = recorder
                guard recorder.record(forDuration: duration) else { throw MediaFailure(code: "INTERNAL_ERROR") }
            } else {
                guard let path = MacMediaValues.string(input, "file_path"), path.hasPrefix("/"), !path.contains("\0") else { throw MediaFailure(code: "INVALID_INPUT") }
                let file = URL(fileURLWithPath: path)
                let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
                guard attributes[.type] as? FileAttributeType == .typeRegular, let bytes = attributes[.size] as? NSNumber, bytes.int64Value <= byteLimit else { throw MediaFailure(code: "FILE_TOO_LARGE") }
                let player = try AVAudioPlayer(contentsOf: file)
                player.delegate = self
                self.player = player
                guard player.play() else { throw MediaFailure(code: "INTERNAL_ERROR") }
            }
            let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
            timer.schedule(deadline: .now() + 0.1, repeating: 0.1)
            timer.setEventHandler { [weak self] in self?.checkLimits() }
            self.timer = timer
            timer.resume()
        } catch {
            recorder?.stop(); player?.stop()
            if let temporary { try? FileManager.default.removeItem(at: temporary) }
            throw error
        }
    }

    private func checkLimits() {
        lock.lock(); defer { lock.unlock() }
        guard state == .running else { return }
        if recorder != nil && !MacAudioProvider.permissionGranted() {
            errorCode = "PERMISSION_REQUIRED"
            stop(cancel: true)
        } else if let temporary, let bytes = (try? FileManager.default.attributesOfItem(atPath: temporary.path))?[.size] as? NSNumber, bytes.int64Value >= byteLimit {
            errorCode = "FILE_TOO_LARGE"
            stop(cancel: true)
        } else if Date().timeIntervalSince(startedAt) >= duration || recorder?.isRecording == false || player?.isPlaying == false { stop(cancel: false) }
    }

    func stop(cancel: Bool) {
        lock.lock(); defer { lock.unlock() }
        guard state == .running else { return }
        state = .stopping
        timer?.cancel(); timer = nil
        recorder?.stop(); player?.stop()
        if cancel {
            state = errorCode == nil ? .cancelled : .failed
            if let temporary { try? FileManager.default.removeItem(at: temporary) }
        } else if let target, let temporary {
            do {
                artifact = try MacMediaValues.publish(target: target, temporary: temporary, format: .wav, durationLimit: duration, byteLimit: byteLimit)
                state = .completed
            } catch {
                errorCode = (error as? MediaFailure)?.code ?? "INTERNAL_ERROR"
                state = .failed
                try? FileManager.default.removeItem(at: temporary)
            }
        } else { state = .completed }
        finishedAt = Date()
    }

    func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        lock.lock(); defer { lock.unlock() }
        guard state == .running else { return }
        if !flag { errorCode = "INTERNAL_ERROR" }
        stop(cancel: !flag)
    }

    func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        lock.lock(); defer { lock.unlock() }
        guard state == .running else { return }
        errorCode = "INTERNAL_ERROR"
        stop(cancel: true)
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        lock.lock(); defer { lock.unlock() }
        guard state == .running else { return }
        if !flag { errorCode = "INTERNAL_ERROR" }
        stop(cancel: !flag)
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        lock.lock(); defer { lock.unlock() }
        guard state == .running else { return }
        errorCode = "INTERNAL_ERROR"
        stop(cancel: true)
    }

    func receipt(_ handle: String) -> [String: AnyEncodable] {
        lock.lock(); defer { lock.unlock() }
        var receipt = ["handle": AnyEncodable(handle), "state": AnyEncodable(state.rawValue), "running": AnyEncodable(state == .running), "deliveryState": AnyEncodable(state == .running ? "running" : state == .completed ? "completed" : "failed"), "duration_limit_seconds": AnyEncodable(duration), "byte_limit": AnyEncodable(byteLimit), "backend": AnyEncodable("avfoundation")]
        if let artifact { receipt["artifact"] = AnyEncodable(artifact) }
        if let errorCode { receipt["error"] = AnyEncodable(["code": AnyEncodable(errorCode), "recoverable": AnyEncodable(true)]) }
        return receipt
    }
}
