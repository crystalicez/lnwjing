import Foundation
import CoreGraphics
import XCTest
@testable import LnwjingMacHost

final class MediaSessionTests: XCTestCase {
    func testSeventeenthOperationEvictsOnlyOldestCleanedTerminalHistory() {
        let now = Date(timeIntervalSince1970: 2_000)
        var history = Dictionary(uniqueKeysWithValues: (0..<16).map { (String($0), now.addingTimeInterval(Double($0 - 16))) })
        XCTAssertTrue(MacMediaHistory.admit(&history, now: now, cleanedAt: { $0 }))
        XCTAssertEqual(history.count, 15)
        XCTAssertNil(history["0"])
        history["seventeenth"] = now
        XCTAssertTrue(MacMediaHistory.admit(&history, now: now, cleanedAt: { $0 }))
        XCTAssertNil(history["1"])
        XCTAssertEqual(history["seventeenth"], now)
    }

    func testAdmissionNeverEvictsLiveStoppingOrQuarantinedSessions() {
        let now = Date(timeIntervalSince1970: 2_000)
        let cleaned: (MacMediaState) -> Date? = { $0.requiresRetention ? nil : now.addingTimeInterval(-1_000) }
        var history: [String: MacMediaState] = [:]
        for index in 0..<16 {
            let state: MacMediaState
            switch index % 3 {
            case 0: state = .running
            case 1: state = .stopping
            default: state = .terminationUnverified
            }
            history[String(index)] = state
        }
        let original = history
        XCTAssertFalse(MacMediaHistory.admit(&history, now: now, cleanedAt: cleaned))
        XCTAssertEqual(history, original)
        history["15"] = .completed
        XCTAssertTrue(MacMediaHistory.admit(&history, now: now, cleanedAt: cleaned))
        XCTAssertNil(history["15"])
        XCTAssertEqual(history.count, 15)
        XCTAssertTrue(history.values.allSatisfy { $0.requiresRetention })
    }

    func testStartupTimeoutCannotBeReleasedWhileItsCallbackIsUnknown() {
        let lifecycle = MacCaptureLifecycle()
        var lateStart: ((Error?) -> Void)?
        XCTAssertFalse(lifecycle.start(timeout: 0, operation: { lateStart = $0 }))
        XCTAssertFalse(lifecycle.stop(timeout: 0, operation: { $0(nil) }))
        lateStart?(nil)
        XCTAssertTrue(lifecycle.stop(timeout: 0, operation: { $0(nil) }))
    }

    func testStopFailureAndTimeoutRemainUnverifiedUntilANewVerifiedStop() {
        let lifecycle = MacCaptureLifecycle()
        XCTAssertTrue(lifecycle.start(timeout: 0, operation: { $0(nil) }))
        XCTAssertFalse(lifecycle.stop(timeout: 0, operation: { $0(MediaFailure(code: "PROCESS_TIMEOUT")) }))
        var lateStop: ((Error?) -> Void)?
        XCTAssertFalse(lifecycle.stop(timeout: 0, operation: { lateStop = $0 }))
        lateStop?(nil)
        XCTAssertFalse(lifecycle.stop(timeout: 0, operation: { _ in }))
        XCTAssertTrue(lifecycle.stop(timeout: 0, operation: { $0(nil) }))
    }

    func testFailedStartRequiresPositiveCleanupAndIgnoresDuplicateCallbacks() {
        let lifecycle = MacCaptureLifecycle()
        XCTAssertFalse(lifecycle.start(timeout: 0, operation: { completion in
            completion(MediaFailure(code: "PERMISSION_REQUIRED"))
            completion(nil)
        }))
        XCTAssertFalse(lifecycle.stop(timeout: 0, operation: { _ in }))
        XCTAssertTrue(lifecycle.stop(timeout: 0, operation: { $0(nil) }))
    }

    func testOwnerReadsOnlyTrustedTopLevelMetadataAndNeverDowngradesPartialOwner() throws {
        let metadata: [String: Any] = ["clientId": "client", "sessionId": "session", "workspaceId": "workspace"]
        let owner = try XCTUnwrap(MacMediaOwner.read(["metadata": ["lnwjing.taskOwner.v1": metadata], "parameters": ["metadata": ["lnwjing.taskOwner.v1": ["clientId": "spoof", "sessionId": "spoof"]]]]))
        XCTAssertEqual(owner.client, "client")
        XCTAssertEqual(owner.session, "session")
        XCTAssertEqual(owner.workspace, "workspace")
        XCTAssertNil(MacMediaOwner.read(["metadata": ["lnwjing.taskOwner.v1": ["clientId": "client"]]]))
        XCTAssertNil(MacMediaOwner.read(["metadata": ["lnwjing.taskOwner.v1": ["clientId": "client", "sessionId": " "]]]))
        XCTAssertNil(MacMediaOwner.read(["metadata": ["lnwjing.taskOwner.v1": false]]))
    }

    func testForeignSessionClientAndExplicitWorkspaceCannotAccessAnOwnedHandle() {
        let owner = MacMediaOwner(client: "client", session: "session", workspace: "workspace")
        XCTAssertTrue(owner.permits(MacMediaOwner(client: "client", session: "session", workspace: nil)))
        XCTAssertTrue(owner.permits(owner))
        XCTAssertFalse(owner.permits(MacMediaOwner(client: "foreign", session: "session", workspace: "workspace")))
        XCTAssertFalse(owner.permits(MacMediaOwner(client: "client", session: "foreign", workspace: "workspace")))
        XCTAssertFalse(owner.permits(MacMediaOwner(client: "client", session: "session", workspace: "foreign")))
    }

    func testLimitsRejectBooleanNonFiniteFractionalAndOversizeInputs() throws {
        let defaults = try XCTUnwrap(MacMediaValues.limits([:]))
        XCTAssertEqual(defaults.0, 60)
        XCTAssertEqual(defaults.1, 67_108_864)
        XCTAssertNil(MacMediaValues.limits(["duration_seconds": true]))
        XCTAssertNil(MacMediaValues.limits(["duration_seconds": Double.nan]))
        XCTAssertNil(MacMediaValues.limits(["duration_seconds": 601]))
        XCTAssertNil(MacMediaValues.limits(["max_bytes": 1024.5]))
        XCTAssertNil(MacMediaValues.limits(["max_bytes": 67_108_865]))
        XCTAssertEqual(try XCTUnwrap(MacMediaValues.limits(["duration_seconds": 600, "max_bytes": 1024])).0, 600)
    }

    func testScreenRegionAndFrameRateArePreservedAndOutsideRegionIsRefused() throws {
        let display = CGRect(x: -100, y: 0, width: 100, height: 100)
        let geometry = try XCTUnwrap(MacMediaValues.screenGeometry(["offset_x": -80, "offset_y": 10, "width": 20, "height": 40, "fps": 30], display: display, pixelWidth: 200, pixelHeight: 200))
        XCTAssertEqual(geometry.source, CGRect(x: 20, y: 10, width: 20, height: 40))
        XCTAssertEqual(geometry.width, 20)
        XCTAssertEqual(geometry.height, 40)
        XCTAssertEqual(geometry.fps, 30)
        XCTAssertNil(MacMediaValues.screenGeometry(["width": 120, "height": 40], display: display, pixelWidth: 200, pixelHeight: 200))
        XCTAssertNil(MacMediaValues.screenGeometry(["width": 21, "height": 40], display: display, pixelWidth: 200, pixelHeight: 200))
    }

    func testUnknownHandleStatusAndStopNeverAskForDesktopPermission() throws {
        for operation in ["audio", "screen_record"] {
            for action in ["status", "stop"] {
                let result = MacNativeProviders.execute(operation: operation, input: ["action": action, "parameters": ["handle": "foreign"]])
                guard case let .failure(code, _, _) = result else { return XCTFail("Unknown handle became a successful native action") }
                XCTAssertEqual(code, "FILE_NOT_FOUND")
            }
        }
    }

    func testArtifactPublicationKeepsExistingTargetAndRejectsAnEmptyFile() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let target = directory.appendingPathComponent("ไทย.wav")
        let output = try MacMediaValues.output(["output_path": target.path], extension: "wav")
        let wave = Data([82, 73, 70, 70, 38, 0, 0, 0, 87, 65, 86, 69, 102, 109, 116, 32, 16, 0, 0, 0, 1, 0, 1, 0, 64, 31, 0, 0, 128, 62, 0, 0, 2, 0, 16, 0, 100, 97, 116, 97, 2, 0, 0, 0, 0, 0])
        try wave.write(to: output.1)
        let artifact = try MacMediaValues.publish(target: output.0, temporary: output.1, format: .wav, durationLimit: 0.1, byteLimit: 1024)
        XCTAssertEqual(try Data(contentsOf: target), wave)
        XCTAssertNotNil(artifact["byte_length"])
        XCTAssertThrowsError(try MacMediaValues.output(["output_path": target.path], extension: "wav"))
        XCTAssertEqual(try Data(contentsOf: target), wave)
        let empty = directory.appendingPathComponent("empty.wav")
        try Data().write(to: empty)
        XCTAssertThrowsError(try MacMediaValues.publish(target: directory.appendingPathComponent("no.wav"), temporary: empty, format: .wav, durationLimit: 0.1, byteLimit: 1024))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("no.wav").path))
    }
}
