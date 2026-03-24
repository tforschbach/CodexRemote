import AVFoundation
import Foundation

struct RecordedDictationClip: Hashable {
    let data: Data
    let filename: String
    let mimeType: String
}

@MainActor
final class LiveDictationService: NSObject {
    enum DictationError: LocalizedError {
        case microphonePermissionDenied
        case recorderUnavailable
        case noActiveRecording
        case emptyRecording

        var errorDescription: String? {
            switch self {
            case .microphonePermissionDenied:
                return "Microphone permission is disabled for Codex Remote."
            case .recorderUnavailable:
                return "Voice recording could not start on this iPhone."
            case .noActiveRecording:
                return "There is no active dictation recording."
            case .emptyRecording:
                return "The recording was empty."
            }
        }
    }

    private let audioSession = AVAudioSession.sharedInstance()
    private var audioRecorder: AVAudioRecorder?
    private var currentRecordingURL: URL?

    func start() async throws {
        let microphoneGranted = await requestMicrophonePermission()
        guard microphoneGranted else {
            throw DictationError.microphonePermissionDenied
        }

        stop()

        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("codex-remote-dictation-\(UUID().uuidString)")
            .appendingPathExtension("m4a")

        try audioSession.setCategory(.playAndRecord, mode: .spokenAudio, options: [.duckOthers, .defaultToSpeaker])
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

        let recorder = try AVAudioRecorder(
            url: fileURL,
            settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 44_100,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            ]
        )

        guard recorder.prepareToRecord(), recorder.record() else {
            throw DictationError.recorderUnavailable
        }

        audioRecorder = recorder
        currentRecordingURL = fileURL
    }

    func finish() throws -> RecordedDictationClip {
        guard let recorder = audioRecorder, let fileURL = currentRecordingURL else {
            throw DictationError.noActiveRecording
        }

        recorder.stop()
        audioRecorder = nil
        currentRecordingURL = nil
        deactivateAudioSession()

        let data = try Data(contentsOf: fileURL)
        try? FileManager.default.removeItem(at: fileURL)

        guard !data.isEmpty else {
            throw DictationError.emptyRecording
        }

        return RecordedDictationClip(
            data: data,
            filename: "dictation.m4a",
            mimeType: "audio/m4a"
        )
    }

    func stop() {
        audioRecorder?.stop()
        audioRecorder = nil
        deactivateAudioSession()

        if let currentRecordingURL {
            try? FileManager.default.removeItem(at: currentRecordingURL)
        }
        currentRecordingURL = nil
    }

    private func deactivateAudioSession() {
        do {
            try audioSession.setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            // Ignore cleanup failures.
        }
    }

    private func requestMicrophonePermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted:
            return true
        case .denied:
            return false
        case .undetermined:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { granted in
                    continuation.resume(returning: granted)
                }
            }
        @unknown default:
            return false
        }
    }
}
