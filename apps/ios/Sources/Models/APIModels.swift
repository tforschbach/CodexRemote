import Foundation

struct Project: Codable, Identifiable, Hashable {
    let id: String
    let cwd: String
    let title: String
    let lastUpdatedAt: TimeInterval
}

struct ChatThread: Codable, Identifiable, Hashable {
    let id: String
    let projectId: String
    let title: String
    let preview: String
    let updatedAt: TimeInterval
}

struct ApprovalRequest: Codable, Identifiable, Hashable {
    let id: String
    let kind: String
    let summary: String
    let riskLevel: String
    let createdAt: TimeInterval
}

struct PairingRequestResponse: Codable {
    let pairingId: String
    let nonce: String
    let expiresAt: TimeInterval
    let pairingUri: String
    let qrDataUrl: String
}

struct PairingConfirmResponse: Codable {
    let deviceId: String
    let token: String
}

struct DebugLogUploadResult: Codable, Hashable {
    let path: String
    let bytes: Int
}

struct DataEnvelope<T: Codable>: Codable {
    let data: T
}

struct ChatActivationResult: Codable, Hashable {
    let chatId: String
    let status: String
}

enum ComposerAttachmentKind: String, Codable, Hashable {
    case image
    case textFile = "text_file"

    var iconName: String {
        switch self {
        case .image:
            return "photo"
        case .textFile:
            return "doc.text"
        }
    }

    var summaryPrefix: String {
        switch self {
        case .image:
            return "Attached photo"
        case .textFile:
            return "Attached file"
        }
    }
}

struct ComposerAttachment: Identifiable, Hashable {
    let id: String
    let kind: ComposerAttachmentKind
    let displayName: String
    let mimeType: String
    let payload: String

    init(
        id: String = UUID().uuidString,
        kind: ComposerAttachmentKind,
        displayName: String,
        mimeType: String,
        payload: String
    ) {
        self.id = id
        self.kind = kind
        self.displayName = displayName
        self.mimeType = mimeType
        self.payload = payload
    }

    var summaryLine: String {
        "\(kind.summaryPrefix): \(displayName)"
    }
}

struct SendMessageAttachmentRequest: Codable, Hashable {
    let type: String
    let name: String
    let mimeType: String
    let dataUrl: String?
    let text: String?

    init(attachment: ComposerAttachment) {
        type = attachment.kind.rawValue
        name = attachment.displayName
        mimeType = attachment.mimeType

        switch attachment.kind {
        case .image:
            dataUrl = attachment.payload
            text = nil
        case .textFile:
            dataUrl = nil
            text = attachment.payload
        }
    }
}

struct SendMessageRequest: Codable, Hashable {
    let text: String?
    let attachments: [SendMessageAttachmentRequest]
}

struct DictationTranscriptionRequest: Codable, Hashable {
    let filename: String
    let mimeType: String
    let audioBase64: String
    let language: String?
}

struct DictationTranscriptionResponse: Codable, Hashable {
    let text: String
    let model: String
}

func buildComposerDraftPreview(text: String, attachments: [ComposerAttachment]) -> String {
    let trimmedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
    let attachmentLines = attachments.map(\.summaryLine)

    if attachmentLines.isEmpty {
        return trimmedText
    }

    if trimmedText.isEmpty {
        return attachmentLines.joined(separator: "\n")
    }

    return ([trimmedText] + attachmentLines).joined(separator: "\n\n")
}

struct RemoteChatMessage: Codable, Hashable {
    let id: String
    let role: String
    let text: String
    let createdAt: TimeInterval
    let phase: String?
    let workedDurationSeconds: TimeInterval?
}

struct RemoteChatActivity: Codable, Hashable {
    let id: String
    let itemId: String
    let kind: ChatActivityKind
    let title: String
    let detail: String?
    let commandPreview: String?
    let createdAt: TimeInterval
    let updatedAt: TimeInterval
    let state: ChatActivityState
    let filePath: String?
    let additions: Int?
    let deletions: Int?
}

struct RemoteChatTimeline: Codable, Hashable {
    let messages: [RemoteChatMessage]
    let activities: [RemoteChatActivity]
}

struct RemoteChatRunState: Codable, Hashable {
    let chatId: String
    let isRunning: Bool
    let activeTurnId: String?
}

struct TurnStartResponse: Codable, Hashable {
    let chatId: String
    let turnId: String?
}

struct TurnStopResponse: Codable, Hashable {
    let chatId: String
    let interrupted: Bool
    let turnId: String?
}

struct TurnSteerResponse: Codable, Hashable {
    let chatId: String
    let turnId: String?
    let mode: String
}

struct GitChangedFile: Codable, Hashable, Identifiable {
    var id: String { path }
    let path: String
    let indexStatus: String
    let workingTreeStatus: String
}

struct GitBranch: Codable, Hashable, Identifiable {
    var id: String { name }
    let name: String
    let isCurrent: Bool
}

struct GitContext: Codable, Hashable {
    let isRepository: Bool
    let branch: String?
    let changedFiles: Int
    let stagedFiles: Int
    let unstagedFiles: Int
    let untrackedFiles: Int
    let changedPaths: [GitChangedFile]
}

struct ProjectContext: Codable, Hashable {
    let projectId: String
    let cwd: String
    let runtimeMode: String
    let approvalPolicy: String?
    let sandboxMode: String?
    let model: String?
    let modelReasoningEffort: String?
    let trustLevel: String?
    let git: GitContext
}

struct GitDiff: Codable, Hashable {
    let path: String?
    let text: String
    let truncated: Bool
    let untrackedPaths: [String]
}

struct GitCommitResult: Codable, Hashable {
    let branch: String?
    let commitHash: String
    let summary: String
}

struct RuntimeConfig: Codable, Hashable {
    let approvalPolicy: String?
    let sandboxMode: String?
    let model: String?
    let modelReasoningEffort: String?
}

struct StreamEventEnvelope: Codable {
    let event: String
    let chatId: String
    let payload: JSONValue
    let timestamp: TimeInterval
}

enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case object([String: JSONValue])
    case array([JSONValue])
    case bool(Bool)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self = .null
            return
        }

        if let value = try? container.decode(Bool.self) {
            self = .bool(value)
            return
        }

        if let value = try? container.decode(Double.self) {
            self = .number(value)
            return
        }

        if let value = try? container.decode(String.self) {
            self = .string(value)
            return
        }

        if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
            return
        }

        if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
            return
        }

        throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value")
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }
}

struct ChatMessage: Identifiable, Hashable {
    let id: String
    let role: String
    var text: String
    let createdAt: Date
    let phase: String?
    let workedDurationSeconds: TimeInterval?
}

enum ChatActivityKind: String, Codable, Hashable {
    case thinking
    case exploring
    case runningCommand = "running_command"
    case fileEdited = "file_edited"
    case contextCompacted = "context_compacted"
    case backgroundTerminal = "background_terminal"
    case reconnecting

    var iconName: String {
        switch self {
        case .thinking:
            return "sparkles"
        case .exploring:
            return "magnifyingglass"
        case .runningCommand:
            return "terminal"
        case .fileEdited:
            return "square.and.pencil"
        case .contextCompacted:
            return "rectangle.compress.vertical"
        case .backgroundTerminal:
            return "terminal"
        case .reconnecting:
            return "arrow.triangle.2.circlepath"
        }
    }

    func title(for state: ChatActivityState) -> String {
        switch (self, state) {
        case (.thinking, .inProgress):
            return "Thinking"
        case (.thinking, .completed):
            return "Thought through it"
        case (.exploring, .inProgress):
            return "Exploring"
        case (.exploring, .completed):
            return "Explored"
        case (.runningCommand, .inProgress):
            return "Running command"
        case (.runningCommand, .completed):
            return "Command finished"
        case (.fileEdited, _):
            return "Edited"
        case (.contextCompacted, _):
            return "Context automatically compacted"
        case (.backgroundTerminal, .inProgress):
            return "Background terminal running"
        case (.backgroundTerminal, .completed):
            return "Background terminal finished"
        case (.reconnecting, .inProgress):
            return "Reconnecting..."
        case (.reconnecting, .completed):
            return "Reconnected"
        }
    }
}

enum ChatActivityState: String, Codable, Hashable {
    case inProgress = "in_progress"
    case completed
}

struct ChatActivity: Identifiable, Hashable {
    let id: String
    let itemId: String
    let kind: ChatActivityKind
    var title: String
    var detail: String?
    var commandPreview: String?
    var state: ChatActivityState
    let createdAt: Date
    var updatedAt: Date
    var filePath: String?
    var additions: Int?
    var deletions: Int?

    init(
        id: String,
        itemId: String,
        kind: ChatActivityKind,
        title: String,
        detail: String?,
        commandPreview: String?,
        state: ChatActivityState,
        createdAt: Date,
        updatedAt: Date,
        filePath: String? = nil,
        additions: Int? = nil,
        deletions: Int? = nil
    ) {
        self.id = id
        self.itemId = itemId
        self.kind = kind
        self.title = title
        self.detail = detail
        self.commandPreview = commandPreview
        self.state = state
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.filePath = filePath
        self.additions = additions
        self.deletions = deletions
    }
}

enum ChatTimelineItem: Identifiable, Hashable {
    case message(ChatMessage)
    case activity(ChatActivity)

    var id: String {
        switch self {
        case .message(let message):
            return "message:\(message.id)"
        case .activity(let activity):
            return "activity:\(activity.id)"
        }
    }

    var createdAt: Date {
        switch self {
        case .message(let message):
            return message.createdAt
        case .activity(let activity):
            return activity.createdAt
        }
    }
}

func buildChatTimeline(messages: [ChatMessage], activities: [ChatActivity]) -> [ChatTimelineItem] {
    let timelineMessages = messages.map(ChatTimelineItem.message)
    let timelineActivities = activities.map(ChatTimelineItem.activity)

    return (timelineMessages + timelineActivities).sorted { lhs, rhs in
        if lhs.createdAt == rhs.createdAt {
            switch (lhs, rhs) {
            case (.activity, .message):
                return true
            case (.message, .activity):
                return false
            default:
                return lhs.id < rhs.id
            }
        }

        return lhs.createdAt < rhs.createdAt
    }
}

struct CommandActivitySummary: Hashable {
    let kind: ChatActivityKind
    let detail: String?
}

func summarizeCommandActions(_ commandActions: [JSONValue]) -> CommandActivitySummary {
    var fileCount = 0
    var searchCount = 0
    var otherCount = 0

    for action in commandActions {
        guard case .object(let object) = action else {
            otherCount += 1
            continue
        }

        switch object["type"]?.stringValue {
        case "read", "listFiles":
            fileCount += 1
        case "search":
            searchCount += 1
        default:
            otherCount += 1
        }
    }

    if fileCount > 0 || searchCount > 0 {
        let detail = [
            formatCount(fileCount, singular: "file", plural: "files"),
            formatCount(searchCount, singular: "search", plural: "searches"),
        ]
        .compactMap { $0 }
        .joined(separator: ", ")

        return CommandActivitySummary(
            kind: .exploring,
            detail: detail.isEmpty ? nil : detail
        )
    }

    if otherCount > 0 {
        return CommandActivitySummary(kind: .runningCommand, detail: nil)
    }

    return CommandActivitySummary(kind: .runningCommand, detail: nil)
}

private func formatCount(_ value: Int, singular: String, plural: String) -> String? {
    guard value > 0 else {
        return nil
    }

    return "\(value) \(value == 1 ? singular : plural)"
}

private extension JSONValue {
    var stringValue: String? {
        if case .string(let value) = self {
            return value
        }
        return nil
    }
}
