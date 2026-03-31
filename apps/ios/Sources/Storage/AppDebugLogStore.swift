import CryptoKit
import Foundation
import SwiftUI

enum AppDebugLogLevel: String {
    case debug
    case info
    case warning
    case error
}

enum AppDebugLogMode: String, CaseIterable, Identifiable {
    case basic
    case verbose

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .basic:
            return "Basic"
        case .verbose:
            return "Verbose"
        }
    }

    func includes(_ minimumMode: AppDebugLogMode) -> Bool {
        switch (self, minimumMode) {
        case (.verbose, _):
            return true
        case (.basic, .basic):
            return true
        case (.basic, .verbose):
            return false
        }
    }
}

struct AppDebugLogEntry: Codable, Hashable {
    let timestamp: String
    let level: String
    let event: String
    let details: [String: String]
}

func debugLogScenePhaseLabel(_ phase: ScenePhase) -> String {
    switch phase {
    case .active:
        return "active"
    case .inactive:
        return "inactive"
    case .background:
        return "background"
    @unknown default:
        return "unknown"
    }
}

func makeAppDebugLogFileURL(fileManager: FileManager = .default) -> URL {
    let cachesURL = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
    ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)

    return cachesURL
        .appendingPathComponent("CodexRemote", isDirectory: true)
        .appendingPathComponent("DebugLogs", isDirectory: true)
        .appendingPathComponent("ios-debug.ndjson", isDirectory: false)
}

func makeAppDebugLogLine(
    level: AppDebugLogLevel,
    event: String,
    details: [String: String],
    timestamp: Date = Date()
) -> String {
    let entry = AppDebugLogEntry(
        timestamp: ISO8601DateFormatter().string(from: timestamp),
        level: level.rawValue,
        event: event,
        details: details
    )

    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]

    guard let data = try? encoder.encode(entry),
          let line = String(data: data, encoding: .utf8)
    else {
        return "{\"level\":\"error\",\"event\":\"debug_log_encoding_failed\"}\n"
    }

    return line + "\n"
}

func makeAppDebugLogSignature(_ contents: String) -> String {
    let normalized = contents.trimmingCharacters(in: .whitespacesAndNewlines)
    let digest = SHA256.hash(data: Data(normalized.utf8))
    return digest.map { String(format: "%02x", $0) }.joined()
}

func effectiveDebugLogMode(verboseUntil: Date?, now: Date = Date()) -> AppDebugLogMode {
    guard let verboseUntil, verboseUntil > now else {
        return .basic
    }

    return .verbose
}

func debugLogHostKind(_ host: String) -> String {
    let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.isEmpty == false else {
        return "unknown"
    }

    if trimmed.contains(":") {
        return "ipv6"
    }

    let parts = trimmed.split(separator: ".")
    if parts.count == 4, parts.allSatisfy({ Int($0) != nil }) {
        return "ipv4"
    }

    return "hostname"
}

func sanitizeDebugLogDetails(event: String, details: [String: String]) -> [String: String] {
    var sanitized = details

    if let host = sanitized.removeValue(forKey: "host"), host.isEmpty == false {
        sanitized["hostKind"] = debugLogHostKind(host)
    }

    for restrictedKey in ["deviceName", "token", "authorization", "apiKey", "body", "contents"] {
        sanitized.removeValue(forKey: restrictedKey)
    }

    return sanitized
}

func shouldUploadDebugLog(contents: String, lastUploadedSignature: String?, force: Bool) -> Bool {
    let normalized = contents.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else {
        return false
    }

    if force {
        return true
    }

    return makeAppDebugLogSignature(normalized) != lastUploadedSignature
}

final class AppDebugLogStore {
    let fileURL: URL

    private let fileManager: FileManager
    private let queue = DispatchQueue(label: "com.codexremote.ios.debug-log")
    private let maximumBytes: Int
    private let trimTargetBytes: Int

    init(
        fileURL: URL = makeAppDebugLogFileURL(),
        fileManager: FileManager = .default,
        maximumBytes: Int = 512_000,
        trimTargetBytes: Int = 256_000
    ) {
        self.fileURL = fileURL
        self.fileManager = fileManager
        self.maximumBytes = maximumBytes
        self.trimTargetBytes = trimTargetBytes
        queue.sync {
            ensureFileExists()
        }
    }

    func log(level: AppDebugLogLevel, event: String, details: [String: String] = [:]) {
        let line = makeAppDebugLogLine(level: level, event: event, details: details)
        queue.async { [self] in
            ensureFileExists()
            trimIfNeeded(pendingBytes: line.utf8.count)
            appendLine(line)
        }
    }

    func readContents() -> String {
        queue.sync {
            ensureFileExists()
            let data = (try? Data(contentsOf: fileURL)) ?? Data()
            return String(decoding: data, as: UTF8.self)
        }
    }

    func clear() {
        queue.sync {
            ensureFileExists()
            try? Data().write(to: fileURL, options: .atomic)
        }
    }

    private func ensureFileExists() {
        let directoryURL = fileURL.deletingLastPathComponent()
        try? fileManager.createDirectory(at: directoryURL, withIntermediateDirectories: true)

        if !fileManager.fileExists(atPath: fileURL.path) {
            fileManager.createFile(atPath: fileURL.path, contents: Data())
        }
    }

    private func trimIfNeeded(pendingBytes: Int) {
        let currentData = (try? Data(contentsOf: fileURL)) ?? Data()
        guard currentData.count + pendingBytes > maximumBytes else {
            return
        }

        var trimmed = Data(currentData.suffix(trimTargetBytes))
        if let firstNewline = trimmed.firstIndex(of: 0x0A) {
            trimmed = Data(trimmed.suffix(from: trimmed.index(after: firstNewline)))
        }

        try? trimmed.write(to: fileURL, options: .atomic)
    }

    private func appendLine(_ line: String) {
        guard let data = line.data(using: .utf8),
              let handle = try? FileHandle(forWritingTo: fileURL)
        else {
            return
        }

        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
            try handle.close()
        } catch {
            try? handle.close()
        }
    }
}
