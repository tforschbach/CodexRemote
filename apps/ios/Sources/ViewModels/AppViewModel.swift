import Foundation
import SwiftUI
import UIKit

@MainActor
final class AppViewModel: ObservableObject {
    @Published var host: String = ""
    @Published var port: Int = 8787
    @Published var token: String = ""

    @Published var projects: [Project] = []
    @Published var chats: [ChatThread] = []
    @Published var messagesByChat: [String: [ChatMessage]] = [:]

    @Published var selectedProjectId: String?
    @Published var selectedChatId: String?
    @Published var composerText: String = ""
    @Published var pendingApproval: ApprovalRequest?

    @Published var isPairingSheetPresented = false
    @Published var scanResultText: String = ""
    @Published var errorMessage: String?

    private let apiClient = APIClient()
    private var streamTask: URLSessionWebSocketTask?
    private var pollingTask: Task<Void, Never>?

    var isPaired: Bool {
        !host.isEmpty && !token.isEmpty
    }

    func bootstrap() async {
        host = KeychainStore.load("host") ?? ""
        if let rawPort = KeychainStore.load("port"), let parsed = Int(rawPort) {
            port = parsed
        }
        token = KeychainStore.load("token") ?? ""

        guard isPaired else {
            return
        }

        await refreshData()
        startPolling()
    }

    func pairFromURI(_ uriString: String) async {
        guard let components = URLComponents(string: uriString),
              components.scheme == "codexremote"
        else {
            errorMessage = "Invalid pairing URI."
            return
        }

        let hostValue = components.queryItems?.first(where: { $0.name == "host" })?.value
        let portValue = components.queryItems?.first(where: { $0.name == "port" })?.value
        let pairingId = components.queryItems?.first(where: { $0.name == "pairingId" })?.value
        let nonce = components.queryItems?.first(where: { $0.name == "nonce" })?.value

        guard let hostValue, let pairingId, let nonce else {
            errorMessage = "Pairing URI is missing required values."
            return
        }

        let selectedPort = Int(portValue ?? "8787") ?? 8787

        do {
            let confirmation = try await apiClient.confirmPairing(
                host: hostValue,
                port: selectedPort,
                pairingId: pairingId,
                nonce: nonce,
                deviceName: UIDevice.current.name
            )

            host = hostValue
            port = selectedPort
            token = confirmation.token

            KeychainStore.save(hostValue, for: "host")
            KeychainStore.save(String(selectedPort), for: "port")
            KeychainStore.save(confirmation.token, for: "token")

            await refreshData()
            startPolling()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func unpair() {
        streamTask?.cancel(with: .goingAway, reason: nil)
        streamTask = nil
        pollingTask?.cancel()
        pollingTask = nil

        host = ""
        token = ""
        projects = []
        chats = []
        messagesByChat = [:]
        selectedProjectId = nil
        selectedChatId = nil

        KeychainStore.delete("host")
        KeychainStore.delete("port")
        KeychainStore.delete("token")
    }

    func refreshData() async {
        guard isPaired else {
            return
        }

        do {
            projects = try await apiClient.fetchProjects(host: host, port: port, token: token)

            if selectedProjectId == nil {
                selectedProjectId = projects.first?.id
            }

            chats = try await apiClient.fetchChats(
                host: host,
                port: port,
                token: token,
                projectId: selectedProjectId
            )

            if selectedChatId == nil {
                selectedChatId = chats.first?.id
            }

            if let selectedChatId {
                connectStream(chatId: selectedChatId)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func selectProject(_ project: Project) {
        selectedProjectId = project.id
        Task {
            await refreshData()
        }
    }

    func selectChat(_ chat: ChatThread) {
        selectedChatId = chat.id
        connectStream(chatId: chat.id)
    }

    func startNewChat() async {
        guard isPaired else { return }

        let cwd = projects.first(where: { $0.id == selectedProjectId })?.cwd

        do {
            let created = try await apiClient.createChat(host: host, port: port, token: token, cwd: cwd)
            selectedChatId = created.id
            await refreshData()
            connectStream(chatId: created.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func sendMessage() async {
        guard let chatId = selectedChatId else { return }
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        composerText = ""
        appendMessage(chatId: chatId, role: "user", text: text)

        do {
            try await apiClient.sendMessage(host: host, port: port, token: token, chatId: chatId, text: text)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func sendApproval(_ decision: String) async {
        guard let pendingApproval else { return }
        do {
            try await apiClient.sendApprovalDecision(
                host: host,
                port: port,
                token: token,
                approvalId: pendingApproval.id,
                decision: decision
            )
            self.pendingApproval = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func startPolling() {
        pollingTask?.cancel()
        pollingTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 15_000_000_000)
                await refreshData()
            }
        }
    }

    private func connectStream(chatId: String) {
        streamTask?.cancel(with: .goingAway, reason: nil)

        do {
            let task = try apiClient.openStream(host: host, port: port, token: token, chatId: chatId)
            streamTask = task
            task.resume()
            receiveNextWebSocketMessage(for: task)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func receiveNextWebSocketMessage(for task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }

            switch result {
            case .failure(let error):
                Task { @MainActor in
                    self.errorMessage = error.localizedDescription
                }
            case .success(let message):
                if case .string(let text) = message {
                    Task { @MainActor in
                        self.handleStreamText(text)
                    }
                }
                self.receiveNextWebSocketMessage(for: task)
            @unknown default:
                self.receiveNextWebSocketMessage(for: task)
            }
        }
    }

    private func handleStreamText(_ text: String) {
        guard let data = text.data(using: .utf8) else {
            return
        }

        do {
            let envelope = try JSONDecoder().decode(StreamEventEnvelope.self, from: data)

            switch envelope.event {
            case "message_delta":
                if let delta = findString(in: envelope.payload, keys: ["delta", "text"]) {
                    appendMessage(chatId: envelope.chatId, role: "assistant", text: delta)
                }
            case "approval_required":
                if case .object(let object) = envelope.payload,
                   let id = object["id"]?.stringValue,
                   let kind = object["kind"]?.stringValue,
                   let summary = object["summary"]?.stringValue,
                   let risk = object["riskLevel"]?.stringValue,
                   let createdAt = object["createdAt"]?.numberValue {
                    pendingApproval = ApprovalRequest(
                        id: id,
                        kind: kind,
                        summary: summary,
                        riskLevel: risk,
                        createdAt: createdAt
                    )
                }
            case "error":
                errorMessage = findString(in: envelope.payload, keys: ["message", "error"])
            default:
                break
            }
        } catch {
            errorMessage = "Failed to parse stream event."
        }
    }

    private func appendMessage(chatId: String, role: String, text: String) {
        var messages = messagesByChat[chatId] ?? []
        messages.append(ChatMessage(id: UUID(), role: role, text: text, createdAt: Date()))
        messagesByChat[chatId] = messages
    }

    private func findString(in value: JSONValue, keys: [String]) -> String? {
        switch value {
        case .string(let string):
            return string
        case .object(let object):
            for key in keys {
                if let nested = object[key], let found = findString(in: nested, keys: keys) {
                    return found
                }
            }
            for nested in object.values {
                if let found = findString(in: nested, keys: keys) {
                    return found
                }
            }
            return nil
        case .array(let array):
            for nested in array {
                if let found = findString(in: nested, keys: keys) {
                    return found
                }
            }
            return nil
        default:
            return nil
        }
    }
}

private extension JSONValue {
    var stringValue: String? {
        if case .string(let value) = self {
            return value
        }
        return nil
    }

    var numberValue: Double? {
        if case .number(let value) = self {
            return value
        }
        return nil
    }
}
