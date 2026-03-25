import Foundation
import PDFKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

private struct QueuedComposerDraft {
    let text: String
    let attachments: [ComposerAttachment]
    let previewText: String
}

@MainActor
final class AppViewModel: ObservableObject {
    private let maximumImageBytes = 850_000
    private let maximumStreamReconnectAttempts = 5
    private let streamReconnectDelayNs: UInt64 = 1_200_000_000
    private let sidebandTimelineRefreshNs: UInt64 = 3_000_000_000

    @Published var host: String = ""
    @Published var port: Int = 8787
    @Published var token: String = ""

    @Published var projects: [Project] = []
    @Published var chats: [ChatThread] = []
    @Published var chatsByProjectId: [String: [ChatThread]] = [:]
    @Published var messagesByChat: [String: [ChatMessage]] = [:]
    @Published var activitiesByChat: [String: [ChatActivity]] = [:]
    @Published var runStateByChat: [String: RemoteChatRunState] = [:]
    @Published var projectContextByProjectId: [String: ProjectContext] = [:]
    @Published var gitBranches: [GitBranch] = []
    @Published var currentGitDiff: GitDiff?
    @Published var isDictating = false
    @Published var loadingChatProjectIDs = Set<String>()

    @Published var selectedProjectId: String?
    @Published var selectedChatId: String?
    @Published var composerText: String = ""
    @Published var composerAttachments: [ComposerAttachment] = []
    @Published var pendingApproval: ApprovalRequest?

    @Published var isPairingSheetPresented = false
    @Published var scanResultText: String = ""
    @Published var errorMessage: String?

    private let apiClient = APIClient()
    private var streamTask: URLSessionWebSocketTask?
    private var streamChatId: String?
    private var streamReconnectTask: Task<Void, Never>?
    private var sidebandTimelineRefreshTask: Task<Void, Never>?
    private var pollingTask: Task<Void, Never>?
    private var activatedChatIds = Set<String>()
    private var queuedComposerDraftByChat: [String: QueuedComposerDraft] = [:]
    private var assistantMessageIDsByItemKey: [String: String] = [:]
    private var assistantMessagePhasesByItemKey: [String: String] = [:]
    private let dictationService = LiveDictationService()
    private var dictationBaseText = ""

    var isPaired: Bool {
        !host.isEmpty && !token.isEmpty
    }

    var selectedProject: Project? {
        projects.first(where: { $0.id == selectedProjectId })
    }

    var selectedChat: ChatThread? {
        allChats.first(where: { $0.id == selectedChatId })
    }

    var selectedChatRunState: RemoteChatRunState? {
        guard let selectedChatId else {
            return nil
        }

        return runStateByChat[selectedChatId]
    }

    var selectedChatIsRunning: Bool {
        selectedChatRunState?.isRunning == true
    }

    var selectedChatHasQueuedFollowUp: Bool {
        guard let selectedChatId else {
            return false
        }

        return queuedComposerDraftByChat[selectedChatId] != nil
    }

    var selectedProjectContext: ProjectContext? {
        guard let selectedProjectId else {
            return nil
        }

        return projectContextByProjectId[selectedProjectId]
    }

    var selectedProjectDisplayTitle: String {
        selectedProject?.title ?? "Choose a project"
    }

    var selectedChatDisplayTitle: String {
        selectedChat?.title ?? "New conversation"
    }

    var connectionStatusLabel: String {
        if pendingApproval != nil {
            return "Approval required"
        }

        return isPaired ? "Live on your Mac" : "Not connected"
    }

    var runtimeModeLabel: String {
        selectedProjectContext?.runtimeMode.capitalized ?? "Local"
    }

    var approvalPolicyLabel: String {
        selectedProjectContext?.approvalPolicy?.replacingOccurrences(of: "_", with: " ").capitalized ?? "Unknown approvals"
    }

    var sandboxModeLabel: String {
        selectedProjectContext?.sandboxMode?.replacingOccurrences(of: "-", with: " ").capitalized ?? "Unknown sandbox"
    }

    var branchLabel: String {
        if let branch = selectedProjectContext?.git.branch, !branch.isEmpty {
            return branch
        }

        return "No git branch"
    }

    var trustLevelLabel: String {
        selectedProjectContext?.trustLevel?.capitalized ?? "Unknown trust"
    }

    var allChats: [ChatThread] {
        var mergedChats: [ChatThread] = []
        var seenChatIDs = Set<String>()

        for chat in chats {
            if seenChatIDs.insert(chat.id).inserted {
                mergedChats.append(chat)
            }
        }

        for chat in chatsByProjectId.values.flatMap({ $0 }) {
            if seenChatIDs.insert(chat.id).inserted {
                mergedChats.append(chat)
            }
        }

        return mergedChats
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
        stopDictation()
        stopLiveStatusTasks()
        streamTask?.cancel(with: .goingAway, reason: nil)
        streamTask = nil
        streamChatId = nil
        pollingTask?.cancel()
        pollingTask = nil

        host = ""
        token = ""
        projects = []
        chats = []
        chatsByProjectId = [:]
        messagesByChat = [:]
        activitiesByChat = [:]
        runStateByChat = [:]
        projectContextByProjectId = [:]
        gitBranches = []
        currentGitDiff = nil
        selectedProjectId = nil
        selectedChatId = nil
        composerAttachments = []
        loadingChatProjectIDs = []
        activatedChatIds = []
        queuedComposerDraftByChat = [:]
        assistantMessageIDsByItemKey = [:]
        assistantMessagePhasesByItemKey = [:]

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

            if let selectedProjectId,
               !projects.contains(where: { $0.id == selectedProjectId }) {
                self.selectedProjectId = nil
            }

            if selectedProjectId == nil {
                selectedProjectId = projects.first?.id
            }

            if let selectedProjectId {
                await hydrateProjectContext(projectId: selectedProjectId)
                await loadChats(projectId: selectedProjectId, selectFirstChatIfNeeded: true)
            } else {
                chats = []
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func selectProject(_ project: Project) {
        stopDictation()
        stopLiveStatusTasks()
        composerAttachments = []
        selectedProjectId = project.id
        selectedChatId = nil
        chats = chatsByProjectId[project.id] ?? []
        Task {
            await hydrateProjectContext(projectId: project.id)
            await loadChats(projectId: project.id, selectFirstChatIfNeeded: true)
        }
    }

    func selectChat(_ chat: ChatThread) {
        stopDictation()
        stopLiveStatusTasks()
        composerAttachments = []
        selectedProjectId = chat.projectId
        selectedChatId = chat.id
        chats = chatsByProjectId[chat.projectId] ?? []
        Task {
            await hydrateChat(chatId: chat.id)
        }
    }

    func startNewChat(projectId: String? = nil) async {
        guard isPaired else { return }

        let targetProjectId = projectId ?? selectedProjectId
        let cwd = projects.first(where: { $0.id == targetProjectId })?.cwd

        do {
            stopLiveStatusTasks()
            composerAttachments = []
            let created = try await apiClient.createChat(host: host, port: port, token: token, cwd: cwd)
            selectedProjectId = created.projectId
            selectedChatId = created.id
            activatedChatIds.insert(created.id)
            messagesByChat[created.id] = []
            await loadChats(projectId: created.projectId, selectFirstChatIfNeeded: false, forceRefresh: true)
            await hydrateChat(chatId: created.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func sendMessage() async {
        guard let chatId = selectedChatId else { return }
        let draftText = composerText
        let draftAttachments = composerAttachments
        let previewText = buildComposerDraftPreview(text: draftText, attachments: draftAttachments)
        let trimmedText = draftText.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedText.isEmpty || !draftAttachments.isEmpty else { return }

        stopDictation()
        composerText = ""
        composerAttachments = []
        let optimisticMessageId = appendMessage(chatId: chatId, role: "user", text: previewText)

        do {
            let result = try await apiClient.sendMessage(
                host: host,
                port: port,
                token: token,
                chatId: chatId,
                text: trimmedText,
                attachments: draftAttachments
            )
            applyRunState(
                RemoteChatRunState(
                    chatId: chatId,
                    isRunning: result.turnId != nil,
                    activeTurnId: result.turnId
                )
            )
        } catch {
            composerText = draftText
            composerAttachments = draftAttachments
            removeMessage(chatId: chatId, messageId: optimisticMessageId)
            errorMessage = error.localizedDescription
        }
    }

    func steerMessage() async {
        guard let chatId = selectedChatId else { return }
        let draftText = composerText
        let draftAttachments = composerAttachments
        let previewText = buildComposerDraftPreview(text: draftText, attachments: draftAttachments)
        let trimmedText = draftText.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedText.isEmpty || !draftAttachments.isEmpty else { return }

        stopDictation()
        composerText = ""
        composerAttachments = []
        let optimisticMessageId = appendMessage(chatId: chatId, role: "user", text: previewText)

        do {
            let result = try await apiClient.steerMessage(
                host: host,
                port: port,
                token: token,
                chatId: chatId,
                text: trimmedText,
                attachments: draftAttachments
            )
            applyRunState(
                RemoteChatRunState(
                    chatId: chatId,
                    isRunning: result.turnId != nil,
                    activeTurnId: result.turnId
                )
            )
        } catch {
            composerText = draftText
            composerAttachments = draftAttachments
            removeMessage(chatId: chatId, messageId: optimisticMessageId)
            errorMessage = error.localizedDescription
        }
    }

    func stopSelectedTurn() async {
        guard let chatId = selectedChatId else { return }

        do {
            let result = try await apiClient.stopTurn(
                host: host,
                port: port,
                token: token,
                chatId: chatId
            )
            if result.interrupted {
                applyRunState(
                    RemoteChatRunState(
                        chatId: chatId,
                        isRunning: false,
                        activeTurnId: nil
                    )
                )
            } else {
                await refreshChatRunState(chatId: chatId)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func queueMessage() {
        guard let chatId = selectedChatId else { return }
        let draftText = composerText
        let draftAttachments = composerAttachments
        let previewText = buildComposerDraftPreview(text: draftText, attachments: draftAttachments)
        let trimmedText = draftText.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedText.isEmpty || !draftAttachments.isEmpty else { return }

        stopDictation()
        queuedComposerDraftByChat[chatId] = QueuedComposerDraft(
            text: trimmedText,
            attachments: draftAttachments,
            previewText: previewText
        )
        composerText = ""
        composerAttachments = []
    }

    func addImageAttachment(data: Data, suggestedName: String?) throws {
        guard let image = UIImage(data: data) else {
            throw APIClientError.server("The selected photo could not be read.")
        }

        guard let preparedData = prepareJPEGData(from: image) else {
            throw APIClientError.server("The selected photo could not be prepared.")
        }

        guard preparedData.count <= maximumImageBytes else {
            throw APIClientError.server("Photos must be smaller than 850 KB right now.")
        }

        let sanitizedSuggestedName = suggestedName?.trimmingCharacters(in: .whitespacesAndNewlines)
        let filename = sanitizedSuggestedName?.isEmpty == false
            ? sanitizedSuggestedName!
            : "Photo \(composerAttachments.count + 1).jpg"

        composerAttachments.append(
            ComposerAttachment(
                kind: .image,
                displayName: filename,
                mimeType: "image/jpeg",
                payload: "data:image/jpeg;base64,\(preparedData.base64EncodedString())"
            )
        )
    }

    func addDocumentAttachment(from url: URL) throws {
        let startedAccessing = url.startAccessingSecurityScopedResource()
        defer {
            if startedAccessing {
                url.stopAccessingSecurityScopedResource()
            }
        }

        let fileData = try Data(contentsOf: url)
        let contentType = (try? url.resourceValues(forKeys: [.contentTypeKey]))?.contentType
            ?? UTType(filenameExtension: url.pathExtension)
        let attachment = try ComposerDocumentImporter.buildAttachment(
            fileURL: url,
            data: fileData,
            contentType: contentType
        )

        composerAttachments.append(attachment)
    }

    func removeComposerAttachment(id: String) {
        composerAttachments.removeAll { $0.id == id }
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

    func refreshSelectedProjectContext() async {
        guard let selectedProjectId else {
            return
        }

        await hydrateProjectContext(projectId: selectedProjectId)
    }

    func loadGitBranches() async {
        guard isPaired, let selectedProjectId else {
            return
        }

        do {
            gitBranches = try await apiClient.fetchGitBranches(
                host: host,
                port: port,
                token: token,
                projectId: selectedProjectId
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadGitDiff(path: String?) async {
        guard isPaired, let selectedProjectId else {
            return
        }

        do {
            currentGitDiff = try await apiClient.fetchGitDiff(
                host: host,
                port: port,
                token: token,
                projectId: selectedProjectId,
                path: path
            )
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func checkoutGitBranch(_ branch: String) async {
        guard isPaired, let selectedProjectId else {
            return
        }

        do {
            let git = try await apiClient.checkoutGitBranch(
                host: host,
                port: port,
                token: token,
                projectId: selectedProjectId,
                branch: branch
            )
            if var context = projectContextByProjectId[selectedProjectId] {
                context = ProjectContext(
                    projectId: context.projectId,
                    cwd: context.cwd,
                    runtimeMode: context.runtimeMode,
                    approvalPolicy: context.approvalPolicy,
                    sandboxMode: context.sandboxMode,
                    model: context.model,
                    modelReasoningEffort: context.modelReasoningEffort,
                    trustLevel: context.trustLevel,
                    git: git
                )
                projectContextByProjectId[selectedProjectId] = context
            }
            await refreshSelectedProjectContext()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func commitGitChanges(message: String) async {
        guard isPaired, let selectedProjectId else {
            return
        }

        do {
            _ = try await apiClient.commitGitChanges(
                host: host,
                port: port,
                token: token,
                projectId: selectedProjectId,
                message: message
            )
            currentGitDiff = nil
            await refreshSelectedProjectContext()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func updateRuntimeConfig(approvalPolicy: String? = nil, sandboxMode: String? = nil) async {
        guard isPaired else {
            return
        }

        do {
            _ = try await apiClient.updateRuntimeConfig(
                host: host,
                port: port,
                token: token,
                approvalPolicy: approvalPolicy,
                sandboxMode: sandboxMode
            )
            await refreshSelectedProjectContext()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func toggleDictation() async {
        if isDictating {
            await finishDictationRecording()
            return
        }

        guard isPaired, selectedChatId != nil else {
            errorMessage = "Select a chat before starting dictation."
            return
        }

        beginDictationPreview()

        do {
            try await dictationService.start()
            isDictating = true
        } catch {
            finishDictationPreview()
            errorMessage = error.localizedDescription
        }
    }

    func beginDictationPreview() {
        dictationBaseText = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        isDictating = true
    }

    func applyDictationPreview(transcript: String) {
        let cleanedTranscript = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanedTranscript.isEmpty else {
            composerText = dictationBaseText
            return
        }

        guard !dictationBaseText.isEmpty else {
            composerText = cleanedTranscript
            return
        }

        composerText = "\(dictationBaseText) \(cleanedTranscript)"
    }

    func finishDictationPreview() {
        isDictating = false
        dictationBaseText = ""
    }

    func stopDictation() {
        dictationService.stop()
        finishDictationPreview()
    }

    private func finishDictationRecording() async {
        guard isDictating else {
            return
        }

        do {
            let clip = try dictationService.finish()
            let transcript = try await apiClient.transcribeDictation(
                host: host,
                port: port,
                token: token,
                filename: clip.filename,
                mimeType: clip.mimeType,
                audioData: clip.data,
                language: currentDictationLanguageCode
            )
            applyDictationPreview(transcript: transcript.text)
            finishDictationPreview()
        } catch {
            finishDictationPreview()
            errorMessage = error.localizedDescription
        }
    }

    private func stopLiveStatusTasks() {
        streamReconnectTask?.cancel()
        streamReconnectTask = nil
        sidebandTimelineRefreshTask?.cancel()
        sidebandTimelineRefreshTask = nil

        if let streamChatId {
            removeReconnectActivity(chatId: streamChatId)
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

    private func scheduleStreamReconnect(for chatId: String?, error: Error) {
        guard let chatId, selectedChatId == chatId, isPaired else {
            return
        }

        streamReconnectTask?.cancel()
        streamReconnectTask = Task { [weak self] in
            guard let self else { return }

            for attempt in 1...self.maximumStreamReconnectAttempts {
                guard !Task.isCancelled else { return }

                self.upsertReconnectActivity(
                    chatId: chatId,
                    attempt: attempt,
                    maximumAttempts: self.maximumStreamReconnectAttempts
                )

                try? await Task.sleep(nanoseconds: self.streamReconnectDelayNs)
                guard !Task.isCancelled, self.selectedChatId == chatId, self.isPaired else { return }

                do {
                    let task = try self.apiClient.openStream(
                        host: self.host,
                        port: self.port,
                        token: self.token,
                        chatId: chatId
                    )
                    self.streamTask?.cancel(with: .goingAway, reason: nil)
                    self.streamTask = task
                    self.streamChatId = chatId
                    self.removeReconnectActivity(chatId: chatId)
                    task.resume()
                    self.receiveNextWebSocketMessage(for: task)
                    return
                } catch {
                    if attempt == self.maximumStreamReconnectAttempts {
                        self.removeReconnectActivity(chatId: chatId)
                        self.errorMessage = error.localizedDescription
                    }
                }
            }
        }
    }

    private func startSidebandTimelineRefresh(chatId: String) {
        sidebandTimelineRefreshTask?.cancel()
        sidebandTimelineRefreshTask = Task { [weak self] in
            guard let self else { return }

            while !Task.isCancelled {
                guard self.selectedChatId == chatId, self.isPaired else {
                    return
                }

                await self.refreshTimelineActivities(chatId: chatId)
                try? await Task.sleep(nanoseconds: self.sidebandTimelineRefreshNs)
            }
        }
    }

    private func stopSidebandTimelineRefresh(for chatId: String) {
        guard selectedChatId == chatId else {
            return
        }

        sidebandTimelineRefreshTask?.cancel()
        sidebandTimelineRefreshTask = nil
    }

    private func refreshTimelineActivities(chatId: String) async {
        guard isPaired else { return }

        do {
            async let timelineTask = fetchTimeline(chatId: chatId)
            async let runStateTask = fetchChatRunState(chatId: chatId)
            let (timeline, runState) = try await (timelineTask, runStateTask)
            mergeLoadedActivities(chatId: chatId, activities: timeline.activities)
            applyRunState(runState)
            if !runState.isRunning {
                await flushQueuedMessageIfNeeded(chatId: chatId)
            }
        } catch {
            // Keep the existing live timeline stable if a sideband refresh misses once.
        }
    }

    private func connectStream(chatId: String) {
        if streamChatId == chatId, streamTask != nil {
            return
        }

        stopLiveStatusTasks()
        streamTask?.cancel(with: .goingAway, reason: nil)
        streamTask = nil
        streamChatId = nil

        do {
            let task = try apiClient.openStream(host: host, port: port, token: token, chatId: chatId)
            streamTask = task
            streamChatId = chatId
            removeReconnectActivity(chatId: chatId)
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
                    guard self.streamTask === task else {
                        return
                    }

                    self.streamTask = nil

                    if self.shouldIgnoreWebSocketError(error) {
                        return
                    }

                    self.scheduleStreamReconnect(for: self.streamChatId ?? self.selectedChatId, error: error)
                }
            case .success(let message):
                if case .string(let text) = message {
                    Task { @MainActor in
                        self.removeReconnectActivity(chatId: self.streamChatId ?? self.selectedChatId)
                        self.handleStreamText(text)
                    }
                }
                Task { @MainActor in
                    self.receiveNextWebSocketMessage(for: task)
                }
            @unknown default:
                Task { @MainActor in
                    self.receiveNextWebSocketMessage(for: task)
                }
            }
        }
    }

    private func shouldIgnoreWebSocketError(_ error: Error) -> Bool {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
            return true
        }

        let loweredDescription = nsError.localizedDescription.lowercased()
        return loweredDescription.contains("socket is not connected")
    }

    private func handleStreamText(_ text: String) {
        guard let data = text.data(using: .utf8) else {
            return
        }

        do {
            let envelope = try JSONDecoder().decode(StreamEventEnvelope.self, from: data)

            switch envelope.event {
            case "turn_started":
                applyRunStateFromTurnStarted(chatId: envelope.chatId, payload: envelope.payload)
                finishTransientActivities(chatId: envelope.chatId)
                startSidebandTimelineRefresh(chatId: envelope.chatId)
            case "item_started":
                handleStreamItemStarted(chatId: envelope.chatId, payload: envelope.payload, timestamp: envelope.timestamp)
            case "item_completed":
                handleStreamItemCompleted(chatId: envelope.chatId, payload: envelope.payload, timestamp: envelope.timestamp)
            case "message_delta":
                if let delta = findString(in: envelope.payload, keys: ["delta", "text"]) {
                    let itemId = findString(in: envelope.payload, keys: ["itemId"])
                    applyAssistantDelta(chatId: envelope.chatId, itemId: itemId, delta: delta)
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
            case "turn_completed":
                applyRunStateFromTurnCompleted(chatId: envelope.chatId, payload: envelope.payload)
                completeLiveActivities(chatId: envelope.chatId, finishedAt: Date(timeIntervalSince1970: envelope.timestamp / 1000))
                stopSidebandTimelineRefresh(for: envelope.chatId)
                Task {
                    await reloadChatTimeline(chatId: envelope.chatId)
                }
            default:
                break
            }
        } catch {
            errorMessage = "Failed to parse stream event."
        }
    }

    func applyAssistantDelta(chatId: String, itemId: String?, delta: String) {
        var messages = messagesByChat[chatId] ?? []
        let itemKey = itemId.map { "\(chatId):\($0)" }
        let phase = itemKey.flatMap { assistantMessagePhasesByItemKey[$0] } ?? "commentary"

        if let itemKey,
           let messageID = assistantMessageIDsByItemKey[itemKey],
           let index = messages.firstIndex(where: { $0.id == messageID }) {
            messages[index].text += delta
            messages[index] = ChatMessage(
                id: messages[index].id,
                role: messages[index].role,
                text: messages[index].text,
                createdAt: messages[index].createdAt,
                phase: phase,
                workedDurationSeconds: messages[index].workedDurationSeconds
            )
            messagesByChat[chatId] = messages
            return
        }

        let message = ChatMessage(
            id: UUID().uuidString,
            role: "assistant",
            text: delta,
            createdAt: Date(),
            phase: phase,
            workedDurationSeconds: nil
        )
        messages.append(message)
        messagesByChat[chatId] = messages
        if let itemKey {
            assistantMessageIDsByItemKey[itemKey] = message.id
        }
    }

    private func appendMessage(chatId: String, role: String, text: String) -> String {
        var messages = messagesByChat[chatId] ?? []
        let messageId = UUID().uuidString
        messages.append(ChatMessage(
            id: messageId,
            role: role,
            text: text,
            createdAt: Date(),
            phase: nil,
            workedDurationSeconds: nil
        ))
        messagesByChat[chatId] = messages
        return messageId
    }

    private func removeMessage(chatId: String, messageId: String) {
        messagesByChat[chatId]?.removeAll { $0.id == messageId }
    }

    private func ensureChatActivated(chatId: String) async {
        guard isPaired else { return }
        guard !activatedChatIds.contains(chatId) else { return }

        do {
            _ = try await apiClient.activateChat(host: host, port: port, token: token, chatId: chatId)
            activatedChatIds.insert(chatId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func applyLoadedMessages(chatId: String, messages: [RemoteChatMessage]) {
        messagesByChat[chatId] = messages.map {
            ChatMessage(
                id: $0.id,
                role: $0.role,
                text: $0.text,
                createdAt: Date(timeIntervalSince1970: $0.createdAt),
                phase: $0.phase,
                workedDurationSeconds: $0.workedDurationSeconds
            )
        }
        assistantMessageIDsByItemKey = assistantMessageIDsByItemKey.filter { key, _ in
            !key.hasPrefix("\(chatId):")
        }
        assistantMessagePhasesByItemKey = assistantMessagePhasesByItemKey.filter { key, _ in
            !key.hasPrefix("\(chatId):")
        }
    }

    func applyLoadedTimeline(chatId: String, timeline: RemoteChatTimeline) {
        applyLoadedMessages(chatId: chatId, messages: timeline.messages)
        activitiesByChat[chatId] = normalizeActivities(
            timeline.activities.map { activity in
                ChatActivity(
                    id: activity.id,
                    itemId: activity.itemId,
                    kind: activity.kind,
                    title: activity.title,
                    detail: activity.detail,
                    commandPreview: activity.commandPreview,
                    state: activity.state,
                    createdAt: Date(timeIntervalSince1970: activity.createdAt),
                    updatedAt: Date(timeIntervalSince1970: activity.updatedAt),
                    filePath: activity.filePath,
                    additions: activity.additions,
                    deletions: activity.deletions
                )
            }
        )
    }

    func applyRunState(_ runState: RemoteChatRunState) {
        runStateByChat[runState.chatId] = runState
    }

    func mergeLoadedActivities(chatId: String, activities: [RemoteChatActivity]) {
        let persistedActivities = activities.map { activity in
            ChatActivity(
                id: activity.id,
                itemId: activity.itemId,
                kind: activity.kind,
                title: activity.title,
                detail: activity.detail,
                commandPreview: activity.commandPreview,
                state: activity.state,
                createdAt: Date(timeIntervalSince1970: activity.createdAt),
                updatedAt: Date(timeIntervalSince1970: activity.updatedAt),
                filePath: activity.filePath,
                additions: activity.additions,
                deletions: activity.deletions
            )
        }

        let existingActivities = activitiesByChat[chatId] ?? []
        let localActivities = existingActivities.filter { activity in
            activity.kind == .reconnecting || activity.state == .inProgress
        }

        activitiesByChat[chatId] = normalizeActivities(localActivities + persistedActivities)
    }

    func applyLoadedProjectContext(projectId: String, context: ProjectContext) {
        projectContextByProjectId[projectId] = context
    }

    func chatsForProject(_ projectId: String) -> [ChatThread] {
        chatsByProjectId[projectId] ?? []
    }

    func hasLoadedChats(for projectId: String) -> Bool {
        chatsByProjectId[projectId] != nil
    }

    func loadChats(
        projectId: String,
        selectFirstChatIfNeeded: Bool = false,
        forceRefresh: Bool = false
    ) async {
        guard isPaired else { return }
        guard forceRefresh || chatsByProjectId[projectId] == nil else {
            syncSelectedProjectChats()
            if selectFirstChatIfNeeded {
                await ensureSelectedChatForCurrentProject()
            }
            return
        }

        loadingChatProjectIDs.insert(projectId)
        defer { loadingChatProjectIDs.remove(projectId) }

        do {
            let loadedChats = try await apiClient.fetchChats(
                host: host,
                port: port,
                token: token,
                projectId: projectId
            )
            applyLoadedChats(projectId: projectId, chats: loadedChats)

            if selectFirstChatIfNeeded {
                await ensureSelectedChatForCurrentProject()
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func applyLoadedChats(projectId: String, chats: [ChatThread]) {
        chatsByProjectId[projectId] = chats

        if selectedProjectId == projectId {
            self.chats = chats

            if let selectedChatId,
               !chats.contains(where: { $0.id == selectedChatId }) {
                self.selectedChatId = nil
            }
        }
    }

    private func hydrateChat(chatId: String) async {
        guard isPaired else { return }

        do {
            await ensureChatActivated(chatId: chatId)
            async let timelineTask = fetchTimeline(chatId: chatId)
            async let runStateTask = fetchChatRunState(chatId: chatId)
            let (timeline, runState) = try await (timelineTask, runStateTask)
            applyLoadedTimeline(chatId: chatId, timeline: timeline)
            applyRunState(runState)
            if !runState.isRunning {
                await flushQueuedMessageIfNeeded(chatId: chatId)
            }
            connectStream(chatId: chatId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func reloadChatTimeline(chatId: String) async {
        guard isPaired else { return }

        do {
            async let timelineTask = fetchTimeline(chatId: chatId)
            async let runStateTask = fetchChatRunState(chatId: chatId)
            let (timeline, runState) = try await (timelineTask, runStateTask)
            applyLoadedTimeline(chatId: chatId, timeline: timeline)
            applyRunState(runState)
            if !runState.isRunning {
                await flushQueuedMessageIfNeeded(chatId: chatId)
            }
        } catch {
            // Keep the current live transcript visible if the persisted timeline is not ready yet.
        }
    }

    private func fetchTimeline(chatId: String) async throws -> RemoteChatTimeline {
        try await apiClient.fetchTimeline(host: host, port: port, token: token, chatId: chatId)
    }

    private func fetchChatRunState(chatId: String) async throws -> RemoteChatRunState {
        try await apiClient.fetchChatRunState(host: host, port: port, token: token, chatId: chatId)
    }

    private func refreshChatRunState(chatId: String) async {
        guard isPaired else { return }

        do {
            let runState = try await fetchChatRunState(chatId: chatId)
            applyRunState(runState)
            if !runState.isRunning {
                await flushQueuedMessageIfNeeded(chatId: chatId)
            }
        } catch {
            // Keep the current button state stable if one refresh misses once.
        }
    }

    private func flushQueuedMessageIfNeeded(chatId: String) async {
        guard let queuedDraft = queuedComposerDraftByChat.removeValue(forKey: chatId) else {
            return
        }

        let optimisticMessageId = appendMessage(chatId: chatId, role: "user", text: queuedDraft.previewText)

        do {
            let result = try await apiClient.sendMessage(
                host: host,
                port: port,
                token: token,
                chatId: chatId,
                text: queuedDraft.text,
                attachments: queuedDraft.attachments
            )
            applyRunState(
                RemoteChatRunState(
                    chatId: chatId,
                    isRunning: result.turnId != nil,
                    activeTurnId: result.turnId
                )
            )
        } catch {
            queuedComposerDraftByChat[chatId] = queuedDraft
            removeMessage(chatId: chatId, messageId: optimisticMessageId)
            errorMessage = error.localizedDescription
        }
    }

    private func hydrateProjectContext(projectId: String) async {
        guard isPaired else { return }

        do {
            let context = try await apiClient.fetchProjectContext(
                host: host,
                port: port,
                token: token,
                projectId: projectId
            )
            applyLoadedProjectContext(projectId: projectId, context: context)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func syncSelectedProjectChats() {
        guard let selectedProjectId else {
            chats = []
            return
        }

        chats = chatsByProjectId[selectedProjectId] ?? []
    }

    private func ensureSelectedChatForCurrentProject() async {
        syncSelectedProjectChats()

        if let selectedChatId,
           chats.contains(where: { $0.id == selectedChatId }) {
            await hydrateChat(chatId: selectedChatId)
            return
        }

        selectedChatId = chats.first?.id

        if let selectedChatId {
            await hydrateChat(chatId: selectedChatId)
        }
    }

    private func prepareJPEGData(from image: UIImage) -> Data? {
        let resizedImage = resizeImageIfNeeded(image)
        let compressionQualities: [CGFloat] = [0.72, 0.6, 0.5, 0.4]

        for quality in compressionQualities {
            if let jpegData = resizedImage.jpegData(compressionQuality: quality),
               jpegData.count <= maximumImageBytes {
                return jpegData
            }
        }

        guard let fallbackData = resizedImage.jpegData(compressionQuality: 0.35) else {
            return nil
        }

        return fallbackData.count <= maximumImageBytes ? fallbackData : nil
    }

    private var currentDictationLanguageCode: String? {
        Locale.autoupdatingCurrent.language.languageCode?.identifier
    }

    private func resizeImageIfNeeded(_ image: UIImage) -> UIImage {
        let maximumDimension: CGFloat = 1_600
        let currentMaximumDimension = max(image.size.width, image.size.height)
        guard currentMaximumDimension > maximumDimension else {
            return image
        }

        let scale = maximumDimension / currentMaximumDimension
        let targetSize = CGSize(
            width: max(image.size.width * scale, 1),
            height: max(image.size.height * scale, 1)
        )

        let renderer = UIGraphicsImageRenderer(size: targetSize)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: targetSize))
        }
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

    private func extractTurnId(from payload: JSONValue) -> String? {
        guard case .object(let object) = payload else {
            return nil
        }

        if let directTurnId = object["turnId"]?.stringValue {
            return directTurnId
        }

        guard let turnValue = object["turn"],
              case .object(let turn) = turnValue
        else {
            return nil
        }

        return turn["id"]?.stringValue
    }

    private func applyRunStateFromTurnStarted(chatId: String, payload: JSONValue) {
        applyRunState(
            RemoteChatRunState(
                chatId: chatId,
                isRunning: true,
                activeTurnId: extractTurnId(from: payload)
            )
        )
    }

    private func applyRunStateFromTurnCompleted(chatId: String, payload: JSONValue) {
        let completedTurnId = extractTurnId(from: payload)
        let currentTurnId = runStateByChat[chatId]?.activeTurnId

        if currentTurnId == nil || currentTurnId == completedTurnId {
            applyRunState(
                RemoteChatRunState(
                    chatId: chatId,
                    isRunning: false,
                    activeTurnId: nil
                )
            )
        }
    }

    private func handleStreamItemStarted(chatId: String, payload: JSONValue, timestamp: TimeInterval) {
        guard let item = extractStreamItem(from: payload),
              let itemId = item["id"]?.stringValue,
              let itemType = item["type"]?.stringValue
        else {
            return
        }

        let createdAt = Date(timeIntervalSince1970: timestamp / 1000)

        if itemType == "agentMessage" {
            trackAssistantPhase(chatId: chatId, itemId: itemId, item: item)
            return
        }

        if itemType == "reasoning" {
            upsertActivity(
                chatId: chatId,
                itemId: itemId,
                kind: .thinking,
                state: .inProgress,
                detail: nil,
                commandPreview: nil,
                timestamp: createdAt
            )
            return
        }

        if itemType == "commandExecution" {
            let summary = summarizeCommandActivity(item)
            upsertActivity(
                chatId: chatId,
                itemId: itemId,
                kind: summary.kind,
                state: .inProgress,
                detail: summary.detail,
                commandPreview: summary.commandPreview,
                timestamp: createdAt
            )
        }
    }

    private func handleStreamItemCompleted(chatId: String, payload: JSONValue, timestamp: TimeInterval) {
        guard let item = extractStreamItem(from: payload),
              let itemId = item["id"]?.stringValue,
              let itemType = item["type"]?.stringValue
        else {
            return
        }

        let finishedAt = Date(timeIntervalSince1970: timestamp / 1000)

        if itemType == "agentMessage" {
            trackAssistantPhase(chatId: chatId, itemId: itemId, item: item)
            return
        }

        if itemType == "reasoning" {
            removeActivity(chatId: chatId, itemId: itemId)
            return
        }

        if itemType == "commandExecution" {
            let summary = summarizeCommandActivity(item)
            upsertActivity(
                chatId: chatId,
                itemId: itemId,
                kind: summary.kind,
                state: .completed,
                detail: summary.detail,
                commandPreview: summary.commandPreview,
                timestamp: finishedAt
            )
        }
    }

    private func extractStreamItem(from payload: JSONValue) -> [String: JSONValue]? {
        guard case .object(let object) = payload,
              let itemValue = object["item"],
              case .object(let item) = itemValue
        else {
            return nil
        }

        return item
    }

    private func summarizeCommandActivity(_ item: [String: JSONValue]) -> (kind: ChatActivityKind, detail: String?, commandPreview: String?) {
        let commandActions = item["commandActions"]?.arrayValue ?? []
        let commandSummary = summarizeCommandActions(commandActions)
        let commandPreview = item["command"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)

        return (
            kind: commandSummary.kind,
            detail: commandSummary.detail,
            commandPreview: commandSummary.detail == nil ? commandPreview : nil
        )
    }

    private func trackAssistantPhase(chatId: String, itemId: String, item: [String: JSONValue]) {
        guard let phase = item["phase"]?.stringValue else {
            return
        }

        assistantMessagePhasesByItemKey["\(chatId):\(itemId)"] = phase
    }

    private func upsertActivity(
        chatId: String,
        itemId: String,
        kind: ChatActivityKind,
        state: ChatActivityState,
        detail: String?,
        commandPreview: String?,
        timestamp: Date
    ) {
        var activities = activitiesByChat[chatId] ?? []

        if let index = activities.firstIndex(where: { $0.itemId == itemId }) {
            activities[index].title = kind.title(for: state)
            activities[index].detail = detail
            activities[index].commandPreview = commandPreview
            activities[index].state = state
            activities[index].updatedAt = timestamp
        } else {
            activities.append(
                ChatActivity(
                    id: itemId,
                    itemId: itemId,
                    kind: kind,
                    title: kind.title(for: state),
                    detail: detail,
                    commandPreview: commandPreview,
                    state: state,
                    createdAt: timestamp,
                    updatedAt: timestamp
                )
            )
        }

        activitiesByChat[chatId] = normalizeActivities(activities)
    }

    private func upsertReconnectActivity(chatId: String, attempt: Int, maximumAttempts: Int) {
        upsertActivity(
            chatId: chatId,
            itemId: "stream-reconnect",
            kind: .reconnecting,
            state: .inProgress,
            detail: "\(attempt)/\(maximumAttempts)",
            commandPreview: nil,
            timestamp: Date()
        )
    }

    private func removeActivity(chatId: String, itemId: String) {
        guard var activities = activitiesByChat[chatId] else {
            return
        }

        activities.removeAll { $0.itemId == itemId }
        activitiesByChat[chatId] = activities
    }

    private func removeReconnectActivity(chatId: String?) {
        guard let chatId else {
            return
        }

        removeActivity(chatId: chatId, itemId: "stream-reconnect")
    }

    private func finishTransientActivities(chatId: String) {
        guard var activities = activitiesByChat[chatId] else {
            return
        }

        activities.removeAll { activity in
            activity.kind == ChatActivityKind.thinking && activity.state == ChatActivityState.completed
        }
        activitiesByChat[chatId] = normalizeActivities(activities)
    }

    private func completeLiveActivities(chatId: String, finishedAt: Date) {
        guard var activities = activitiesByChat[chatId] else {
            return
        }

        for index in activities.indices {
            guard activities[index].state == .inProgress else {
                continue
            }

            if activities[index].kind == .thinking || activities[index].kind == .reconnecting {
                continue
            }

            activities[index].state = .completed
            activities[index].title = activities[index].kind.title(for: .completed)
            activities[index].updatedAt = finishedAt
        }

        activities.removeAll { $0.kind == .thinking }
        activitiesByChat[chatId] = normalizeActivities(activities)
    }

    private func normalizeActivities(_ activities: [ChatActivity]) -> [ChatActivity] {
        let deduped = Dictionary(grouping: activities) { activity in
            activity.id
        }
        .compactMap { _, entries in
            entries.max { lhs, rhs in
                if lhs.updatedAt == rhs.updatedAt {
                    return lhs.createdAt < rhs.createdAt
                }
                return lhs.updatedAt < rhs.updatedAt
            }
        }

        return deduped.sorted { lhs, rhs in
            if lhs.createdAt == rhs.createdAt {
                return lhs.id < rhs.id
            }

            return lhs.createdAt < rhs.createdAt
        }
    }
}

enum ComposerDocumentImporter {
    static let maximumTextFileBytes = 400_000
    static let maximumPDFBytes = 5_000_000
    static let maximumDocumentCharacters = 120_000

    private static let csvContentType = UTType(filenameExtension: "csv")
    private static let textFallbackExtensions: Set<String> = [
        "txt", "md", "markdown", "csv", "json", "xml", "yml", "yaml", "log",
        "js", "jsx", "ts", "tsx", "swift", "py", "rb", "go", "rs", "java",
        "kt", "kts", "css", "scss", "html", "sql", "sh", "zsh", "bash"
    ]

    static func buildAttachment(
        fileURL: URL,
        data: Data,
        contentType: UTType?
    ) throws -> ComposerAttachment {
        let mimeType = resolvedMimeType(for: fileURL, contentType: contentType)

        if isPDF(fileURL: fileURL, contentType: contentType, mimeType: mimeType) {
            guard data.count <= maximumPDFBytes else {
                throw ComposerDocumentImportError.pdfTooLarge(limitBytes: maximumPDFBytes)
            }

            let extractedText = try extractPDFText(from: data, fileName: fileURL.lastPathComponent)
            guard extractedText.count <= maximumDocumentCharacters else {
                throw ComposerDocumentImportError.documentTextTooLarge(limitCharacters: maximumDocumentCharacters)
            }

            return ComposerAttachment(
                kind: .textFile,
                displayName: fileURL.lastPathComponent,
                mimeType: mimeType,
                payload: extractedText
            )
        }

        guard isTextLike(fileURL: fileURL, contentType: contentType, mimeType: mimeType) else {
            throw ComposerDocumentImportError.unsupportedFileType
        }

        guard data.count <= maximumTextFileBytes else {
            throw ComposerDocumentImportError.textFileTooLarge(limitBytes: maximumTextFileBytes)
        }

        guard let decodedText = decodeTextFile(from: data) else {
            throw ComposerDocumentImportError.unsupportedFileType
        }

        let normalizedText = normalizeDocumentText(decodedText)
        guard !normalizedText.isEmpty else {
            throw ComposerDocumentImportError.emptyDocument
        }

        guard normalizedText.count <= maximumDocumentCharacters else {
            throw ComposerDocumentImportError.documentTextTooLarge(limitCharacters: maximumDocumentCharacters)
        }

        return ComposerAttachment(
            kind: .textFile,
            displayName: fileURL.lastPathComponent,
            mimeType: mimeType,
            payload: normalizedText
        )
    }

    private static func extractPDFText(from data: Data, fileName: String) throws -> String {
        guard let document = PDFDocument(data: data) else {
            throw ComposerDocumentImportError.unreadablePDF
        }

        let pageTexts = (0..<document.pageCount).compactMap { index -> String? in
            guard let page = document.page(at: index) else {
                return nil
            }

            let text = normalizeDocumentText(page.string ?? "")
            return text.isEmpty ? nil : text
        }

        let combinedText = normalizeDocumentText(pageTexts.joined(separator: "\n\n"))
        guard !combinedText.isEmpty else {
            throw ComposerDocumentImportError.pdfHasNoReadableText(fileName: fileName)
        }

        return combinedText
    }

    private static func decodeTextFile(from data: Data) -> String? {
        let encodings: [String.Encoding] = [
            .utf8,
            .utf16,
            .unicode,
            .windowsCP1252,
            .isoLatin1
        ]

        for encoding in encodings {
            if let text = String(data: data, encoding: encoding) {
                return text
            }
        }

        return nil
    }

    private static func normalizeDocumentText(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func resolvedMimeType(for fileURL: URL, contentType: UTType?) -> String {
        if let mimeType = contentType?.preferredMIMEType {
            return mimeType
        }

        if let mimeType = UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType {
            return mimeType
        }

        switch fileURL.pathExtension.lowercased() {
        case "pdf":
            return "application/pdf"
        case "csv":
            return "text/csv"
        default:
            return "text/plain"
        }
    }

    private static func isPDF(fileURL: URL, contentType: UTType?, mimeType: String) -> Bool {
        if let contentType, contentType.conforms(to: .pdf) {
            return true
        }

        return mimeType == "application/pdf" || fileURL.pathExtension.lowercased() == "pdf"
    }

    private static func isTextLike(fileURL: URL, contentType: UTType?, mimeType: String) -> Bool {
        if let contentType {
            if contentType.conforms(to: .text) || contentType.conforms(to: .sourceCode) {
                return true
            }

            if let csvContentType, contentType.conforms(to: csvContentType) {
                return true
            }
        }

        if mimeType.hasPrefix("text/") || mimeType == "application/json" || mimeType == "application/xml" {
            return true
        }

        return textFallbackExtensions.contains(fileURL.pathExtension.lowercased())
    }
}

enum ComposerDocumentImportError: LocalizedError {
    case unsupportedFileType
    case textFileTooLarge(limitBytes: Int)
    case pdfTooLarge(limitBytes: Int)
    case unreadablePDF
    case pdfHasNoReadableText(fileName: String)
    case emptyDocument
    case documentTextTooLarge(limitCharacters: Int)

    var errorDescription: String? {
        switch self {
        case .unsupportedFileType:
            return "Only text, code, CSV, and PDF files are supported right now."
        case .textFileTooLarge(let limitBytes):
            return "Files must be smaller than \(limitBytes / 1_000) KB right now."
        case .pdfTooLarge(let limitBytes):
            return "PDF files must be smaller than \(limitBytes / 1_000_000) MB right now."
        case .unreadablePDF:
            return "The selected PDF could not be read."
        case .pdfHasNoReadableText(let fileName):
            return "\"\(fileName)\" does not contain selectable text yet."
        case .emptyDocument:
            return "The selected file is empty."
        case .documentTextTooLarge(let limitCharacters):
            return "Files must contain less than \(limitCharacters) characters right now."
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

    var arrayValue: [JSONValue]? {
        if case .array(let value) = self {
            return value
        }
        return nil
    }
}
