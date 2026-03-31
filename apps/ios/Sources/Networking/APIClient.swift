import Foundation

private struct CheckoutBranchRequest: Encodable {
    let branch: String
}

private struct CommitRequest: Encodable {
    let message: String
}

private struct RuntimeConfigPatchRequest: Encodable {
    let approvalPolicy: String?
    let sandboxMode: String?
}

private struct DebugLogUploadRequest: Encodable {
    let contents: String
}

private struct StartChatRequest: Encodable {
    let cwd: String?
    let text: String?
    let attachments: [SendMessageAttachmentRequest]
}

enum APIClientError: LocalizedError {
    case invalidURL
    case invalidResponse
    case unauthorized
    case server(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Invalid URL."
        case .invalidResponse:
            return "Unexpected server response."
        case .unauthorized:
            return "Authentication failed. Please pair again."
        case .server(let message):
            return message
        }
    }
}

protocol APIClientProtocol {
    func requestPairing(host: String, port: Int) async throws -> PairingRequestResponse
    func confirmPairing(host: String, port: Int, pairingId: String, nonce: String, deviceName: String) async throws -> PairingConfirmResponse
    func fetchProjects(host: String, port: Int, token: String) async throws -> [Project]
    func fetchChats(host: String, port: Int, token: String, projectId: String?) async throws -> [ChatThread]
    func fetchProjectContext(host: String, port: Int, token: String, projectId: String) async throws -> ProjectContext
    func fetchGitBranches(host: String, port: Int, token: String, projectId: String) async throws -> [GitBranch]
    func fetchGitDiff(host: String, port: Int, token: String, projectId: String, path: String?) async throws -> GitDiff
    func checkoutGitBranch(host: String, port: Int, token: String, projectId: String, branch: String) async throws -> GitContext
    func commitGitChanges(host: String, port: Int, token: String, projectId: String, message: String) async throws -> GitCommitResult
    func updateRuntimeConfig(host: String, port: Int, token: String, approvalPolicy: String?, sandboxMode: String?) async throws -> RuntimeConfig
    func createChat(host: String, port: Int, token: String, cwd: String?) async throws -> ChatThread
    func startChat(host: String, port: Int, token: String, cwd: String?, text: String?, attachments: [ComposerAttachment]) async throws -> ChatStartResponse
    func activateChat(host: String, port: Int, token: String, chatId: String) async throws -> ChatActivationResult
    func fetchMessages(host: String, port: Int, token: String, chatId: String) async throws -> [RemoteChatMessage]
    func fetchTimeline(host: String, port: Int, token: String, chatId: String) async throws -> RemoteChatTimeline
    func fetchChatRunState(host: String, port: Int, token: String, chatId: String) async throws -> RemoteChatRunState
    func sendMessage(host: String, port: Int, token: String, chatId: String, text: String?, attachments: [ComposerAttachment]) async throws -> TurnStartResponse
    func steerMessage(host: String, port: Int, token: String, chatId: String, text: String?, attachments: [ComposerAttachment]) async throws -> TurnSteerResponse
    func stopTurn(host: String, port: Int, token: String, chatId: String) async throws -> TurnStopResponse
    func transcribeDictation(host: String, port: Int, token: String, filename: String, mimeType: String, audioData: Data, language: String?) async throws -> DictationTranscriptionResponse
    func sendApprovalDecision(host: String, port: Int, token: String, approvalId: String, decision: String) async throws
    func uploadDebugLog(host: String, port: Int, token: String, contents: String) async throws -> DebugLogUploadResult
    func openStream(host: String, port: Int, token: String, chatId: String) throws -> URLSessionWebSocketTask
}

class APIClient: APIClientProtocol {
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    func requestPairing(host: String, port: Int) async throws -> PairingRequestResponse {
        var request = try buildRequest(host: host, port: port, path: "/v1/pairing/request", method: "POST", token: nil)
        request.httpBody = try encoder.encode([String: String]())

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(PairingRequestResponse.self, from: data)
    }

    func confirmPairing(host: String, port: Int, pairingId: String, nonce: String, deviceName: String) async throws -> PairingConfirmResponse {
        var request = try buildRequest(host: host, port: port, path: "/v1/pairing/confirm", method: "POST", token: nil)
        request.httpBody = try encoder.encode([
            "pairingId": pairingId,
            "nonce": nonce,
            "deviceName": deviceName
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(PairingConfirmResponse.self, from: data)
    }

    func fetchProjects(host: String, port: Int, token: String) async throws -> [Project] {
        let request = try buildRequest(host: host, port: port, path: "/v1/projects", method: "GET", token: token)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<[Project]>.self, from: data).data
    }

    func fetchChats(host: String, port: Int, token: String, projectId: String?) async throws -> [ChatThread] {
        let suffix = projectId.map { "?projectId=\($0.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $0)" } ?? ""
        let request = try buildRequest(host: host, port: port, path: "/v1/chats\(suffix)", method: "GET", token: token)
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<[ChatThread]>.self, from: data).data
    }

    func fetchProjectContext(host: String, port: Int, token: String, projectId: String) async throws -> ProjectContext {
        let request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/projects/\(projectId)/context",
            method: "GET",
            token: token
        )
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<ProjectContext>.self, from: data).data
    }

    func fetchGitBranches(host: String, port: Int, token: String, projectId: String) async throws -> [GitBranch] {
        let request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/projects/\(projectId)/git/branches",
            method: "GET",
            token: token
        )
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<[GitBranch]>.self, from: data).data
    }

    func fetchGitDiff(host: String, port: Int, token: String, projectId: String, path: String?) async throws -> GitDiff {
        let suffix: String
        if let path, !path.isEmpty {
            let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
            suffix = "?path=\(encoded)"
        } else {
            suffix = ""
        }

        let request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/projects/\(projectId)/git/diff\(suffix)",
            method: "GET",
            token: token
        )
        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<GitDiff>.self, from: data).data
    }

    func checkoutGitBranch(host: String, port: Int, token: String, projectId: String, branch: String) async throws -> GitContext {
        var request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/projects/\(projectId)/git/checkout",
            method: "POST",
            token: token
        )
        request.httpBody = try encoder.encode(CheckoutBranchRequest(branch: branch))

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<GitContext>.self, from: data).data
    }

    func commitGitChanges(host: String, port: Int, token: String, projectId: String, message: String) async throws -> GitCommitResult {
        var request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/projects/\(projectId)/git/commit",
            method: "POST",
            token: token
        )
        request.httpBody = try encoder.encode(CommitRequest(message: message))

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<GitCommitResult>.self, from: data).data
    }

    func updateRuntimeConfig(
        host: String,
        port: Int,
        token: String,
        approvalPolicy: String?,
        sandboxMode: String?
    ) async throws -> RuntimeConfig {
        var request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/runtime/config",
            method: "PATCH",
            token: token
        )
        request.httpBody = try encoder.encode(RuntimeConfigPatchRequest(
            approvalPolicy: approvalPolicy,
            sandboxMode: sandboxMode
        ))

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<RuntimeConfig>.self, from: data).data
    }

    func createChat(host: String, port: Int, token: String, cwd: String?) async throws -> ChatThread {
        var request = try buildRequest(host: host, port: port, path: "/v1/chats", method: "POST", token: token)
        request.httpBody = try encoder.encode(["cwd": cwd])

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<ChatThread>.self, from: data).data
    }

    func startChat(
        host: String,
        port: Int,
        token: String,
        cwd: String?,
        text: String?,
        attachments: [ComposerAttachment]
    ) async throws -> ChatStartResponse {
        var request = try buildRequest(host: host, port: port, path: "/v1/chats/start", method: "POST", token: token)
        let trimmedText = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        request.httpBody = try encoder.encode(
            StartChatRequest(
                cwd: cwd,
                text: trimmedText?.isEmpty == false ? trimmedText : nil,
                attachments: attachments.map(SendMessageAttachmentRequest.init)
            )
        )

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<ChatStartResponse>.self, from: data).data
    }

    func activateChat(host: String, port: Int, token: String, chatId: String) async throws -> ChatActivationResult {
        let request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/chats/\(chatId)/activate",
            method: "POST",
            token: token
        )

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<ChatActivationResult>.self, from: data).data
    }

    func fetchMessages(host: String, port: Int, token: String, chatId: String) async throws -> [RemoteChatMessage] {
        let request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/chats/\(chatId)/messages",
            method: "GET",
            token: token
        )

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<[RemoteChatMessage]>.self, from: data).data
    }

    func fetchTimeline(host: String, port: Int, token: String, chatId: String) async throws -> RemoteChatTimeline {
        let request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/chats/\(chatId)/timeline",
            method: "GET",
            token: token
        )

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<RemoteChatTimeline>.self, from: data).data
    }

    func fetchChatRunState(host: String, port: Int, token: String, chatId: String) async throws -> RemoteChatRunState {
        let request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/chats/\(chatId)/run-state",
            method: "GET",
            token: token
        )

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<RemoteChatRunState>.self, from: data).data
    }

    func sendMessage(
        host: String,
        port: Int,
        token: String,
        chatId: String,
        text: String?,
        attachments: [ComposerAttachment]
    ) async throws -> TurnStartResponse {
        var request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/chats/\(chatId)/messages",
            method: "POST",
            token: token
        )
        let trimmedText = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        request.httpBody = try encoder.encode(
            SendMessageRequest(
                text: trimmedText?.isEmpty == false ? trimmedText : nil,
                attachments: attachments.map(SendMessageAttachmentRequest.init)
            )
        )

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<TurnStartResponse>.self, from: data).data
    }

    func steerMessage(
        host: String,
        port: Int,
        token: String,
        chatId: String,
        text: String?,
        attachments: [ComposerAttachment]
    ) async throws -> TurnSteerResponse {
        var request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/chats/\(chatId)/steer",
            method: "POST",
            token: token
        )
        let trimmedText = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        request.httpBody = try encoder.encode(
            SendMessageRequest(
                text: trimmedText?.isEmpty == false ? trimmedText : nil,
                attachments: attachments.map(SendMessageAttachmentRequest.init)
            )
        )

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<TurnSteerResponse>.self, from: data).data
    }

    func stopTurn(
        host: String,
        port: Int,
        token: String,
        chatId: String
    ) async throws -> TurnStopResponse {
        let request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/chats/\(chatId)/stop",
            method: "POST",
            token: token
        )

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<TurnStopResponse>.self, from: data).data
    }

    func transcribeDictation(
        host: String,
        port: Int,
        token: String,
        filename: String,
        mimeType: String,
        audioData: Data,
        language: String?
    ) async throws -> DictationTranscriptionResponse {
        var request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/dictation/transcribe",
            method: "POST",
            token: token
        )
        request.timeoutInterval = 90
        request.httpBody = try encoder.encode(
            DictationTranscriptionRequest(
                filename: filename,
                mimeType: mimeType,
                audioBase64: audioData.base64EncodedString(),
                language: language
            )
        )

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<DictationTranscriptionResponse>.self, from: data).data
    }

    func sendApprovalDecision(
        host: String,
        port: Int,
        token: String,
        approvalId: String,
        decision: String
    ) async throws {
        var request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/approvals/\(approvalId)",
            method: "POST",
            token: token
        )
        request.httpBody = try encoder.encode(["decision": decision])

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
    }

    func uploadDebugLog(host: String, port: Int, token: String, contents: String) async throws -> DebugLogUploadResult {
        var request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/debug/ios-log",
            method: "POST",
            token: token
        )
        request.httpBody = try encoder.encode(DebugLogUploadRequest(contents: contents))

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<DebugLogUploadResult>.self, from: data).data
    }

    func openStream(host: String, port: Int, token: String, chatId: String) throws -> URLSessionWebSocketTask {
        guard let url = buildWebSocketURL(host: host, port: port, chatId: chatId) else {
            throw APIClientError.invalidURL
        }

        var request = URLRequest(url: url)
        request.addValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return URLSession.shared.webSocketTask(with: request)
    }

    func buildWebSocketURL(host: String, port: Int, chatId: String) -> URL? {
        guard var components = URLComponents(string: "ws://\(host):\(port)/v1/stream") else {
            return nil
        }
        components.queryItems = [
            URLQueryItem(name: "chatId", value: chatId)
        ]
        return components.url
    }

    private func buildRequest(host: String, port: Int, path: String, method: String, token: String?) throws -> URLRequest {
        guard let url = URL(string: "http://\(host):\(port)\(path)") else {
            throw APIClientError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token {
            request.addValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func validateResponse(response: URLResponse, data: Data) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIClientError.invalidResponse
        }

        if httpResponse.statusCode == 401 {
            throw APIClientError.unauthorized
        }

        if (200..<300).contains(httpResponse.statusCode) {
            return
        }

        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let message = json["error"] as? String {
            throw APIClientError.server(message)
        }

        throw APIClientError.server("Request failed with status \(httpResponse.statusCode)")
    }
}
