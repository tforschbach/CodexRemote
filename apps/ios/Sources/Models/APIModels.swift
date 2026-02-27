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

struct DataEnvelope<T: Codable>: Codable {
    let data: T
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
    let id: UUID
    let role: String
    let text: String
    let createdAt: Date
}
