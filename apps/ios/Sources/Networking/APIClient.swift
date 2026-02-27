import Foundation

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

final class APIClient {
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

    func createChat(host: String, port: Int, token: String, cwd: String?) async throws -> ChatThread {
        var request = try buildRequest(host: host, port: port, path: "/v1/chats", method: "POST", token: token)
        request.httpBody = try encoder.encode(["cwd": cwd])

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
        return try decoder.decode(DataEnvelope<ChatThread>.self, from: data).data
    }

    func sendMessage(host: String, port: Int, token: String, chatId: String, text: String) async throws {
        var request = try buildRequest(
            host: host,
            port: port,
            path: "/v1/chats/\(chatId)/messages",
            method: "POST",
            token: token
        )
        request.httpBody = try encoder.encode(["text": text])

        let (data, response) = try await URLSession.shared.data(for: request)
        try validateResponse(response: response, data: data)
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

    func openStream(host: String, port: Int, token: String, chatId: String) throws -> URLSessionWebSocketTask {
        guard var components = URLComponents(string: "ws://\(host):\(port)/v1/stream") else {
            throw APIClientError.invalidURL
        }
        components.queryItems = [URLQueryItem(name: "chatId", value: chatId)]

        guard let url = components.url else {
            throw APIClientError.invalidURL
        }

        var request = URLRequest(url: url)
        request.addValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return URLSession.shared.webSocketTask(with: request)
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
