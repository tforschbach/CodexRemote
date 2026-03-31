import Foundation
import OSLog
import PDFKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

private struct QueuedComposerDraft {
    let text: String
    let attachments: [ComposerAttachment]
    let previewText: String
}

func shouldConnectHydratedChatStream(chatId: String, selectedChatId: String?) -> Bool {
    selectedChatId == chatId
}

func shouldApplyStreamEnvelope(eventChatId: String, selectedChatId: String?, streamChatId: String?) -> Bool {
    eventChatId == selectedChatId && eventChatId == streamChatId
}

func shouldHydrateSelectedChatAfterRefresh(
    chatId: String,
    hasLoadedMessages: Bool,
    hasLoadedActivities: Bool,
    runState: RemoteChatRunState?,
    streamChatId: String?,
    hasActiveStreamTask: Bool
) -> Bool {
    if !hasLoadedMessages && !hasLoadedActivities && runState == nil {
        return true
    }

    if streamChatId == chatId && hasActiveStreamTask {
        return false
    }

    if runState?.isRunning == true {
        return true
    }

    return false
}

func shouldPauseLiveWork(for phase: ScenePhase) -> Bool {
    phase == .background
}

func shouldResumeLiveWorkAfterPhaseChange(
    previousPhase: ScenePhase,
    newPhase: ScenePhase,
    isPaired: Bool
) -> Bool {
    isPaired && previousPhase == .background && newPhase == .active
}

func shouldPerformRefreshData(
    isPaired: Bool,
    scenePhase: ScenePhase,
    isRefreshing: Bool
) -> Bool {
    isPaired && !shouldPauseLiveWork(for: scenePhase) && !isRefreshing
}

func shouldLoadChats(
    forceRefresh: Bool,
    hasLoadedChats: Bool,
    isAlreadyLoading: Bool
) -> Bool {
    guard !isAlreadyLoading else {
        return false
    }

    return forceRefresh || !hasLoadedChats
}

enum PollingRefreshAction: String {
    case fullRefresh
    case selectedChatStatus
    case skip
}

func determinePollingRefreshAction(
    isPaired: Bool,
    scenePhase: ScenePhase,
    selectedChatId: String?,
    hasLoadedMessages: Bool,
    hasLoadedActivities: Bool,
    streamChatId: String?,
    hasActiveStreamTask: Bool,
    pollIteration: Int,
    fullRefreshInterval: Int
) -> PollingRefreshAction {
    guard isPaired, !shouldPauseLiveWork(for: scenePhase) else {
        return .skip
    }

    guard let selectedChatId else {
        return .fullRefresh
    }

    let hasCachedSelectedChat = hasLoadedMessages || hasLoadedActivities
    guard hasCachedSelectedChat else {
        return .fullRefresh
    }

    if fullRefreshInterval > 0,
       pollIteration > 0,
       pollIteration % fullRefreshInterval == 0 {
        return .fullRefresh
    }

    if streamChatId == selectedChatId, hasActiveStreamTask {
        return .skip
    }

    return .selectedChatStatus
}

func mergeLoadedChatsPreservingSelectedChat(
    projectId: String,
    fetchedChats: [ChatThread],
    selectedProjectId: String?,
    selectedChatId: String?,
    locallyKnownChats: [ChatThread]
) -> [ChatThread] {
    guard selectedProjectId == projectId,
          let selectedChatId,
          !fetchedChats.contains(where: { $0.id == selectedChatId }),
          let locallyKnownSelectedChat = locallyKnownChats.first(where: {
              $0.id == selectedChatId && $0.projectId == projectId
          }) else {
        return fetchedChats
    }

    return [locallyKnownSelectedChat] + fetchedChats
}

func fallbackRunStateForHydrationError(chatId: String, error: Error) -> RemoteChatRunState? {
    guard error.localizedDescription.contains("Failed to load chat run state") else {
        return nil
    }

    return RemoteChatRunState(chatId: chatId, isRunning: false, activeTurnId: nil)
}

func currentDebugLogDeviceModelCode() -> String {
    var systemInfo = utsname()
    uname(&systemInfo)

    let identifier = Mirror(reflecting: systemInfo.machine).children.reduce(into: "") { partialResult, element in
        guard let value = element.value as? Int8, value != 0 else {
            return
        }

        partialResult.append(Character(UnicodeScalar(UInt8(value))))
    }

    return identifier.isEmpty ? "unknown" : identifier
}

func currentDebugLogDeviceKind() -> String {
#if targetEnvironment(simulator)
    return "simulator"
#else
    return "device"
#endif
}

@MainActor
final class AppViewModel: ObservableObject {
    private let maximumImageBytes = 850_000
    private let maximumStreamReconnectAttempts = 5
    private let streamReconnectDelayNs: UInt64 = 1_200_000_000
    private let sidebandTimelineRefreshNs: UInt64 = 3_000_000_000
    private let pollingIntervalNs: UInt64 = 15_000_000_000
    private let focusedChatFullRefreshInterval = 4
    private let verboseDebugLogDuration: TimeInterval = 30 * 60
    private let debugLogUploadSignatureDefaultsKey = "com.codexremote.ios.debug-log-last-uploaded-signature"
    private let debugLogVerboseUntilDefaultsKey = "com.codexremote.ios.debug-log-verbose-until"
    private let debugLogAutoSendDefaultsKey = "com.codexremote.ios.debug-log-auto-send"
    private let logger = Logger(subsystem: "com.codexremote.ios", category: "chat")
    private let apiClient: any APIClientProtocol
    private let debugLogStore: AppDebugLogStore
    private let userDefaults: UserDefaults

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
    @Published var isTranscribingDictation = false
    @Published var dictationStartedAt: Date?
    @Published var loadingChatProjectIDs = Set<String>()

    @Published var selectedProjectId: String?
    @Published var selectedChatId: String?
    @Published var isNewChatDraftActive = false
    @Published var draftProjectId: String?
    @Published var composerText: String = ""
    @Published var composerAttachments: [ComposerAttachment] = []
    @Published var pendingApproval: ApprovalRequest?

    @Published var isPairingSheetPresented = false
    @Published var scanResultText: String = ""
    @Published var errorMessage: String?
    @Published var debugLogSyncStatusMessage: String?
    @Published var debugLogAutoSendEnabled: Bool

    private var streamTask: URLSessionWebSocketTask?
    private var streamChatId: String?
    private var streamReconnectTask: Task<Void, Never>?
    private var sidebandTimelineRefreshTask: Task<Void, Never>?
    private var chatHydrationTask: Task<Void, Never>?
    private var pollingTask: Task<Void, Never>?
    private var pollingIteration = 0
    private var currentScenePhase: ScenePhase = .active
    private var isRefreshingData = false
    private var activatedChatIds = Set<String>()
    private var queuedComposerDraftByChat: [String: QueuedComposerDraft] = [:]
    private var assistantMessageIDsByItemKey: [String: String] = [:]
    private var assistantMessagePhasesByItemKey: [String: String] = [:]
    private let dictationService: LiveDictationService
    private var dictationBaseText = ""

    init(
        apiClient: any APIClientProtocol = APIClient(),
        debugLogStore: AppDebugLogStore = AppDebugLogStore(),
        userDefaults: UserDefaults = .standard,
        dictationService: LiveDictationService? = nil
    ) {
        self.apiClient = apiClient
        self.debugLogStore = debugLogStore
        self.userDefaults = userDefaults
        self.dictationService = dictationService ?? LiveDictationService()
        self.debugLogAutoSendEnabled = userDefaults.bool(forKey: debugLogAutoSendDefaultsKey)
    }

    var isPaired: Bool {
        !host.isEmpty && !token.isEmpty
    }

    var selectedProject: Project? {
        projects.first(where: { $0.id == selectedProjectId })
    }

    var draftProject: Project? {
        guard let draftProjectId else {
            return nil
        }

        return projects.first(where: { $0.id == draftProjectId })
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

    var canComposeInCurrentContext: Bool {
        if selectedChatId != nil {
            return true
        }

        return isNewChatDraftActive && resolveDraftProjectId() != nil
    }

    var selectedProjectDisplayTitle: String {
        if let draftProject {
            return draftProject.title
        }

        return selectedProject?.title ?? "Choose a project"
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

    var debugLogShareURL: URL {
        debugLogStore.fileURL
    }

    var debugLogFileName: String {
        debugLogStore.fileURL.lastPathComponent
    }

    var debugLogMacPathLabel: String {
        "logs/ios-device.ndjson"
    }

    var debugLogMode: AppDebugLogMode {
        let now = Date()
        let mode = effectiveDebugLogMode(verboseUntil: debugLogVerboseUntil, now: now)

        if mode == .basic,
           let verboseUntil = debugLogVerboseUntil,
           verboseUntil <= now {
            debugLogVerboseUntil = nil
        }

        return mode
    }

    var debugLogModeLabel: String {
        debugLogMode.displayName
    }

    var debugLogModeSummary: String {
        switch debugLogMode {
        case .basic:
            return "Basic keeps a small local event log for app state, refreshes, selections, and failures. It does not store chat text."
        case .verbose:
            return "Verbose adds extra stream and hydration steps for 30 minutes. Use it only while reproducing a bug."
        }
    }

    var debugLogVerboseUntilLabel: String? {
        guard let verboseUntil = activeDebugLogVerboseUntil else {
            return nil
        }

        return DateFormatter.localizedString(from: verboseUntil, dateStyle: .none, timeStyle: .short)
    }

    var debugLogAutoSendStatusLabel: String {
        debugLogAutoSendEnabled ? "On" : "Off"
    }

    var debugLogAutoSendSummary: String {
        debugLogAutoSendEnabled
        ? "Changed logs are copied to the paired Mac automatically after refresh."
        : "Logs stay on the iPhone until you export them or send them to the Mac manually."
    }

    var debugLogPrivacySummary: String {
        "The log keeps event names, IDs, app version, iOS version, and device model. It should not contain chat text, prompts, or tokens."
    }

    private var activeDebugLogVerboseUntil: Date? {
        let now = Date()
        guard let verboseUntil = debugLogVerboseUntil else {
            return nil
        }

        if verboseUntil <= now {
            debugLogVerboseUntil = nil
            return nil
        }

        return verboseUntil
    }

    private var debugLogVerboseUntil: Date? {
        get {
            userDefaults.object(forKey: debugLogVerboseUntilDefaultsKey) as? Date
        }
        set {
            if let newValue {
                userDefaults.set(newValue, forKey: debugLogVerboseUntilDefaultsKey)
            } else {
                userDefaults.removeObject(forKey: debugLogVerboseUntilDefaultsKey)
            }
        }
    }

    private var lastUploadedDebugLogSignature: String? {
        get {
            userDefaults.string(forKey: debugLogUploadSignatureDefaultsKey)
        }
        set {
            if let newValue {
                userDefaults.set(newValue, forKey: debugLogUploadSignatureDefaultsKey)
            } else {
                userDefaults.removeObject(forKey: debugLogUploadSignatureDefaultsKey)
            }
        }
    }

    private func recordDebugLog(
        _ event: String,
        level: AppDebugLogLevel = .info,
        minimumMode: AppDebugLogMode = .basic,
        details: [String: String] = [:]
    ) {
        guard debugLogMode.includes(minimumMode) else {
            return
        }

        let normalizedDetails = details.reduce(into: [String: String]()) { partialResult, item in
            if item.value.isEmpty == false {
                partialResult[item.key] = item.value
            }
        }
        let sanitizedDetails = sanitizeDebugLogDetails(event: event, details: normalizedDetails)
        debugLogStore.log(level: level, event: event, details: sanitizedDetails)
    }

    private func debugLogRuntimeContext() -> [String: String] {
        [
            "appVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
            "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
            "systemVersion": UIDevice.current.systemVersion,
            "deviceModel": currentDebugLogDeviceModelCode(),
            "deviceKind": currentDebugLogDeviceKind(),
            "loggingMode": debugLogMode.rawValue,
            "autoSendToMac": debugLogAutoSendEnabled ? "true" : "false",
        ]
    }

    private func pairingDebugDetails(host: String, port: Int) -> [String: String] {
        var details = debugLogRuntimeContext()
        details["host"] = host
        details["port"] = String(port)
        return details
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
        debugLogAutoSendEnabled = userDefaults.bool(forKey: debugLogAutoSendDefaultsKey)
        _ = activeDebugLogVerboseUntil
        recordDebugLog("bootstrap_started", details: debugLogRuntimeContext())
        host = KeychainStore.load("host") ?? ""
        if let rawPort = KeychainStore.load("port"), let parsed = Int(rawPort) {
            port = parsed
        }
        token = KeychainStore.load("token") ?? ""

        guard isPaired else {
            recordDebugLog("bootstrap_idle_unpaired")
            return
        }

        await refreshData()
        await syncDebugLogToMacIfNeeded()
        if !shouldPauseLiveWork(for: currentScenePhase) {
            startPolling()
        }
        recordDebugLog("bootstrap_completed", details: [
            "loggingMode": debugLogMode.rawValue,
            "projectCount": String(projects.count),
            "selectedProjectId": selectedProjectId ?? "none",
            "selectedChatId": selectedChatId ?? "none",
        ])
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
            if !shouldPauseLiveWork(for: currentScenePhase) {
                startPolling()
            }
            recordDebugLog("pairing_confirmed", details: pairingDebugDetails(host: hostValue, port: selectedPort))
        } catch {
            var details = pairingDebugDetails(host: hostValue, port: selectedPort)
            details["error"] = error.localizedDescription
            recordDebugLog("pairing_failed", level: .error, details: details)
            errorMessage = error.localizedDescription
        }
    }

    func unpair() {
        stopDictation()
        cancelChatHydration()
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
        isNewChatDraftActive = false
        draftProjectId = nil
        composerAttachments = []
        loadingChatProjectIDs = []
        activatedChatIds = []
        queuedComposerDraftByChat = [:]
        assistantMessageIDsByItemKey = [:]
        assistantMessagePhasesByItemKey = [:]

        KeychainStore.delete("host")
        KeychainStore.delete("port")
        KeychainStore.delete("token")
        recordDebugLog("unpair_completed")
    }

    func refreshData() async {
        guard shouldPerformRefreshData(
            isPaired: isPaired,
            scenePhase: currentScenePhase,
            isRefreshing: isRefreshingData
        ) else {
            if isPaired {
                recordDebugLog("refresh_data_skipped", level: .debug, minimumMode: .verbose, details: [
                    "scenePhase": debugLogScenePhaseLabel(currentScenePhase),
                    "reason": isRefreshingData ? "already_refreshing" : "background",
                ])
            }
            return
        }

        isRefreshingData = true
        defer { isRefreshingData = false }

        do {
            recordDebugLog("refresh_data_started", details: [
                "selectedProjectId": selectedProjectId ?? "none",
                "selectedChatId": selectedChatId ?? "none",
            ])
            projects = try await apiClient.fetchProjects(host: host, port: port, token: token)

            if let selectedProjectId,
               !projects.contains(where: { $0.id == selectedProjectId }) {
                self.selectedProjectId = nil
            }
            if let draftProjectId,
               !projects.contains(where: { $0.id == draftProjectId }) {
                self.draftProjectId = nil
                self.isNewChatDraftActive = false
            }

            if selectedProjectId == nil {
                selectedProjectId = projects.first?.id
            }
            if isNewChatDraftActive && draftProjectId == nil {
                draftProjectId = resolveDraftProjectId()
            }

            if let selectedProjectId {
                await hydrateProjectContext(projectId: selectedProjectId)
                await loadChats(projectId: selectedProjectId, selectFirstChatIfNeeded: !isNewChatDraftActive)
            } else {
                chats = []
            }
            recordDebugLog("refresh_data_completed", details: [
                "projectCount": String(projects.count),
                "selectedProjectId": selectedProjectId ?? "none",
                "selectedChatId": selectedChatId ?? "none",
            ])
        } catch {
            recordDebugLog("refresh_data_failed", level: .error, details: [
                "error": error.localizedDescription,
            ])
            errorMessage = error.localizedDescription
        }
    }

    func selectProject(_ project: Project) {
        stopDictation()
        cancelChatHydration()
        stopLiveStatusTasks()
        logger.info("select_project id=\(project.id, privacy: .public)")
        recordDebugLog("select_project", details: [
            "projectId": project.id,
        ])
        composerAttachments = []
        isNewChatDraftActive = false
        draftProjectId = nil
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
        cancelChatHydration()
        stopLiveStatusTasks()
        logger.info("select_chat id=\(chat.id, privacy: .public) project=\(chat.projectId, privacy: .public)")
        recordDebugLog("select_chat", details: [
            "chatId": chat.id,
            "projectId": chat.projectId,
        ])
        if isNewChatDraftActive {
            composerText = ""
        }
        composerAttachments = []
        isNewChatDraftActive = false
        draftProjectId = nil
        selectedProjectId = chat.projectId
        selectedChatId = chat.id
        chats = chatsByProjectId[chat.projectId] ?? []
        startChatHydration(chatId: chat.id)
    }

    private func resolveDraftProjectId(explicitProjectId: String? = nil) -> String? {
        explicitProjectId
        ?? draftProjectId
        ?? selectedProjectId
        ?? projects.first?.id
    }

    func beginNewChatDraft(projectId: String? = nil) async {
        guard isPaired else { return }

        let targetProjectId = resolveDraftProjectId(explicitProjectId: projectId)

        cancelChatHydration()
        stopLiveStatusTasks()
        logger.info("begin_new_chat_draft project=\(targetProjectId ?? "none", privacy: .public)")
        recordDebugLog("begin_new_chat_draft", details: [
            "projectId": targetProjectId ?? "none",
        ])
        composerText = ""
        composerAttachments = []
        isNewChatDraftActive = true
        draftProjectId = targetProjectId
        selectedProjectId = targetProjectId
        selectedChatId = nil
        if let targetProjectId {
            chats = chatsByProjectId[targetProjectId] ?? []
        } else {
            chats = []
        }

        guard let targetProjectId else {
            return
        }

        if !hasLoadedChats(for: targetProjectId) {
            await loadChats(projectId: targetProjectId, selectFirstChatIfNeeded: false)
        }
        await hydrateProjectContext(projectId: targetProjectId)
    }

    func updateDraftProject(projectId: String) async {
        guard isNewChatDraftActive else {
            return
        }

        draftProjectId = projectId
        selectedProjectId = projectId
        chats = chatsByProjectId[projectId] ?? []
        if !hasLoadedChats(for: projectId) {
            await loadChats(projectId: projectId, selectFirstChatIfNeeded: false)
        }
        await hydrateProjectContext(projectId: projectId)
    }

    func sendMessage(shouldStartLiveWork: Bool = true) async {
        let draftText = composerText
        let draftAttachments = composerAttachments
        let previewText = buildComposerDraftPreview(text: draftText, attachments: draftAttachments)
        let trimmedText = draftText.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedText.isEmpty || !draftAttachments.isEmpty else { return }

        if isNewChatDraftActive {
            await sendFirstDraftMessage(
                draftText: draftText,
                trimmedText: trimmedText,
                draftAttachments: draftAttachments,
                previewText: previewText,
                shouldStartLiveWork: shouldStartLiveWork
            )
            return
        }

        guard let chatId = selectedChatId else { return }

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

    private func sendFirstDraftMessage(
        draftText: String,
        trimmedText: String,
        draftAttachments: [ComposerAttachment],
        previewText: String,
        shouldStartLiveWork: Bool
    ) async {
        guard let targetProjectId = resolveDraftProjectId(),
              let cwd = projects.first(where: { $0.id == targetProjectId })?.cwd else {
            errorMessage = "Choose a project before starting a new conversation."
            return
        }

        stopDictation()
        composerText = ""
        composerAttachments = []

        do {
            let result = try await apiClient.startChat(
                host: host,
                port: port,
                token: token,
                cwd: cwd,
                text: trimmedText,
                attachments: draftAttachments
            )

            isNewChatDraftActive = false
            draftProjectId = nil
            selectedProjectId = result.chat.projectId
            rememberChat(result.chat)
            selectedChatId = result.chat.id
            activatedChatIds.insert(result.chat.id)
            chats = chatsByProjectId[result.chat.projectId] ?? []
            messagesByChat[result.chat.id] = []
            _ = appendMessage(chatId: result.chat.id, role: "user", text: previewText)
            applyRunState(
                RemoteChatRunState(
                    chatId: result.chat.id,
                    isRunning: result.turnId != nil,
                    activeTurnId: result.turnId
                )
            )

            guard shouldStartLiveWork else {
                return
            }

            if result.turnId != nil {
                connectStream(chatId: result.chat.id)
            } else {
                startChatHydration(chatId: result.chat.id)
            }
        } catch {
            composerText = draftText
            composerAttachments = draftAttachments
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
        if isTranscribingDictation {
            return
        }

        if isDictating {
            await finishDictationRecording()
            return
        }

        guard isPaired, canComposeInCurrentContext else {
            errorMessage = "Select a project or chat before starting dictation."
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
        isTranscribingDictation = false
        dictationStartedAt = Date()
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
        isTranscribingDictation = false
        dictationBaseText = ""
        dictationStartedAt = nil
    }

    func stopDictation() {
        dictationService.stop()
        finishDictationPreview()
    }

    func recordScenePhaseChange(_ phase: ScenePhase) {
        let previousPhase = currentScenePhase
        currentScenePhase = phase

        recordDebugLog("scene_phase_changed", minimumMode: .verbose, details: [
            "phase": debugLogScenePhaseLabel(phase),
        ])

        if shouldPauseLiveWork(for: phase) {
            stopPolling()
            cancelChatHydration()
            stopLiveStatusTasks()
            recordDebugLog("background_live_work_paused", details: [
                "selectedChatId": selectedChatId ?? "none",
            ])
            return
        }

        guard shouldResumeLiveWorkAfterPhaseChange(
            previousPhase: previousPhase,
            newPhase: phase,
            isPaired: isPaired
        ) else {
            return
        }

        recordDebugLog("background_live_work_resumed", details: [
            "selectedChatId": selectedChatId ?? "none",
        ])
        Task { [weak self] in
            guard let self else { return }
            await self.refreshData()
            self.startPolling()
        }
    }

    func recordMemoryWarning() {
        recordDebugLog("memory_warning", level: .warning)
    }

    func useBasicDebugLogging() {
        debugLogVerboseUntil = nil
        recordDebugLog("debug_log_mode_changed", details: [
            "mode": AppDebugLogMode.basic.rawValue,
        ])
    }

    func enableVerboseDebugLogging() {
        let verboseUntil = Date().addingTimeInterval(verboseDebugLogDuration)
        debugLogVerboseUntil = verboseUntil
        recordDebugLog("debug_log_mode_changed", details: [
            "mode": AppDebugLogMode.verbose.rawValue,
            "expiresAt": ISO8601DateFormatter().string(from: verboseUntil),
        ])
    }

    func setDebugLogAutoSendEnabled(_ enabled: Bool) {
        debugLogAutoSendEnabled = enabled
        userDefaults.set(enabled, forKey: debugLogAutoSendDefaultsKey)

        if enabled == false {
            debugLogSyncStatusMessage = nil
        }

        recordDebugLog("debug_log_auto_send_changed", details: [
            "enabled": enabled ? "true" : "false",
        ])
    }

    func copyDebugLogToClipboard() {
        UIPasteboard.general.string = debugLogStore.readContents()
    }

    func clearDebugLog() {
        debugLogStore.clear()
        lastUploadedDebugLogSignature = nil
        debugLogSyncStatusMessage = nil
        recordDebugLog("debug_log_cleared")
    }

    func uploadDebugLogToMac(force: Bool) async {
        guard isPaired else {
            if force {
                debugLogSyncStatusMessage = "Pair the iPhone app with the Mac companion first."
            }
            return
        }

        let contents = debugLogStore.readContents()
        guard shouldUploadDebugLog(
            contents: contents,
            lastUploadedSignature: lastUploadedDebugLogSignature,
            force: force
        ) else {
            if force {
                debugLogSyncStatusMessage = "No new local debug log to send."
            }
            return
        }

        let normalized = contents.trimmingCharacters(in: .whitespacesAndNewlines)
        let signature = makeAppDebugLogSignature(normalized)

        do {
            let result = try await apiClient.uploadDebugLog(
                host: host,
                port: port,
                token: token,
                contents: normalized + "\n"
            )
            lastUploadedDebugLogSignature = signature
            debugLogSyncStatusMessage = "Copied to \(result.path)."
        } catch {
            if force {
                debugLogSyncStatusMessage = error.localizedDescription
            }
        }
    }

    private func syncDebugLogToMacIfNeeded() async {
        guard debugLogAutoSendEnabled else {
            return
        }

        await uploadDebugLogToMac(force: false)
    }

    private func finishDictationRecording() async {
        guard isDictating else {
            return
        }

        isDictating = false
        dictationStartedAt = nil
        isTranscribingDictation = true

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
            isTranscribingDictation = false
            dictationBaseText = ""
        } catch {
            isTranscribingDictation = false
            dictationBaseText = ""
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

        if let streamTask {
            logger.debug("disconnect_stream chat=\(self.streamChatId ?? "unknown", privacy: .public)")
            recordDebugLog("disconnect_stream", level: .debug, minimumMode: .verbose, details: [
                "chatId": self.streamChatId ?? "unknown",
            ])
            streamTask.cancel(with: .goingAway, reason: nil)
        }
        streamTask = nil
        streamChatId = nil
    }

    private func cancelChatHydration() {
        if let chatHydrationTask {
            logger.debug("cancel_hydrate_chat")
            recordDebugLog("cancel_hydrate_chat", level: .debug, minimumMode: .verbose)
            chatHydrationTask.cancel()
        }
        chatHydrationTask = nil
    }

    private func startChatHydration(chatId: String) {
        cancelChatHydration()
        chatHydrationTask = Task { [weak self] in
            guard let self else { return }
            await self.hydrateChat(chatId: chatId)
        }
    }

    private func stopPolling() {
        pollingTask?.cancel()
        pollingTask = nil
        pollingIteration = 0
    }

    private func startPolling() {
        stopPolling()
        pollingIteration = 0
        pollingTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: pollingIntervalNs)
                guard !Task.isCancelled else {
                    return
                }
                pollingIteration += 1
                await performPollingRefresh()
            }
        }
    }

    private func performPollingRefresh() async {
        let action = determinePollingRefreshAction(
            isPaired: isPaired,
            scenePhase: currentScenePhase,
            selectedChatId: selectedChatId,
            hasLoadedMessages: selectedChatId.flatMap { messagesByChat[$0] } != nil,
            hasLoadedActivities: selectedChatId.flatMap { activitiesByChat[$0] } != nil,
            streamChatId: streamChatId,
            hasActiveStreamTask: streamTask != nil,
            pollIteration: pollingIteration,
            fullRefreshInterval: focusedChatFullRefreshInterval
        )

        recordDebugLog("polling_tick", level: .debug, minimumMode: .verbose, details: [
            "action": action.rawValue,
            "selectedChatId": selectedChatId ?? "none",
            "iteration": String(pollingIteration),
        ])

        switch action {
        case .fullRefresh:
            await refreshData()
        case .selectedChatStatus:
            guard let selectedChatId else {
                return
            }
            await refreshFocusedChatStatus(chatId: selectedChatId)
        case .skip:
            return
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

        do {
            let task = try apiClient.openStream(host: host, port: port, token: token, chatId: chatId)
            streamTask = task
            streamChatId = chatId
            logger.debug("connect_stream chat=\(chatId, privacy: .public)")
            recordDebugLog("connect_stream", level: .debug, minimumMode: .verbose, details: [
                "chatId": chatId,
            ])
            removeReconnectActivity(chatId: chatId)
            task.resume()
            receiveNextWebSocketMessage(for: task)
        } catch {
            recordDebugLog("connect_stream_failed", level: .error, details: [
                "chatId": chatId,
                "error": error.localizedDescription,
            ])
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
                        guard self.streamTask === task else {
                            return
                        }

                        self.removeReconnectActivity(chatId: self.streamChatId ?? self.selectedChatId)
                        self.handleStreamText(text)
                    }
                }
                Task { @MainActor in
                    guard self.streamTask === task else {
                        return
                    }

                    self.receiveNextWebSocketMessage(for: task)
                }
            @unknown default:
                Task { @MainActor in
                    guard self.streamTask === task else {
                        return
                    }

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
            guard shouldApplyStreamEnvelope(
                eventChatId: envelope.chatId,
                selectedChatId: selectedChatId,
                streamChatId: streamChatId
            ) else {
                logger.debug(
                    "stream_event_ignored event_chat=\(envelope.chatId, privacy: .public) selected=\(self.selectedChatId ?? "none", privacy: .public) stream=\(self.streamChatId ?? "none", privacy: .public)"
                )
                recordDebugLog("stream_event_ignored", level: .debug, minimumMode: .verbose, details: [
                    "event": envelope.event,
                    "eventChatId": envelope.chatId,
                    "selectedChatId": self.selectedChatId ?? "none",
                    "streamChatId": self.streamChatId ?? "none",
                ])
                return
            }

            if envelope.event != "message_delta" {
                recordDebugLog("stream_event", level: .debug, minimumMode: .verbose, details: [
                    "event": envelope.event,
                    "chatId": envelope.chatId,
                ])
            }

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
            recordDebugLog("stream_event_parse_failed", level: .error, details: [
                "error": error.localizedDescription,
            ])
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
        let hasLoadedChats = chatsByProjectId[projectId] != nil
        let isAlreadyLoading = loadingChatProjectIDs.contains(projectId)

        guard shouldLoadChats(
            forceRefresh: forceRefresh,
            hasLoadedChats: hasLoadedChats,
            isAlreadyLoading: isAlreadyLoading
        ) else {
            if isAlreadyLoading {
                recordDebugLog("load_chats_skipped", level: .debug, minimumMode: .verbose, details: [
                    "projectId": projectId,
                    "reason": "already_loading",
                ])
                return
            }

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
        let mergedChats = mergeLoadedChatsPreservingSelectedChat(
            projectId: projectId,
            fetchedChats: chats,
            selectedProjectId: selectedProjectId,
            selectedChatId: selectedChatId,
            locallyKnownChats: allChats
        )
        chatsByProjectId[projectId] = mergedChats

        if selectedProjectId == projectId {
            self.chats = mergedChats

            if let selectedChatId,
               !mergedChats.contains(where: { $0.id == selectedChatId }) {
                self.selectedChatId = nil
            }
        }
    }

    private func hydrateChat(chatId: String) async {
        guard isPaired else { return }

        do {
            logger.debug("hydrate_chat_started chat=\(chatId, privacy: .public)")
            recordDebugLog("hydrate_chat_started", level: .debug, minimumMode: .verbose, details: [
                "chatId": chatId,
            ])
            await ensureChatActivated(chatId: chatId)
            guard !Task.isCancelled else {
                logger.debug("hydrate_chat_cancelled_before_fetch chat=\(chatId, privacy: .public)")
                recordDebugLog("hydrate_chat_cancelled_before_fetch", level: .debug, minimumMode: .verbose, details: [
                    "chatId": chatId,
                ])
                return
            }
            async let timelineTask = fetchTimeline(chatId: chatId)
            async let runStateTask = fetchChatRunState(chatId: chatId)
            let timeline = try await timelineTask
            let runState: RemoteChatRunState
            do {
                runState = try await runStateTask
            } catch {
                guard let fallbackRunState = fallbackRunStateForHydrationError(chatId: chatId, error: error) else {
                    throw error
                }
                logger.debug("hydrate_chat_run_state_fallback chat=\(chatId, privacy: .public)")
                recordDebugLog("hydrate_chat_run_state_fallback", level: .debug, details: [
                    "chatId": chatId,
                    "error": error.localizedDescription,
                ])
                runState = fallbackRunState
            }
            guard !Task.isCancelled else {
                logger.debug("hydrate_chat_cancelled_after_fetch chat=\(chatId, privacy: .public)")
                recordDebugLog("hydrate_chat_cancelled_after_fetch", level: .debug, minimumMode: .verbose, details: [
                    "chatId": chatId,
                ])
                return
            }
            applyLoadedTimeline(chatId: chatId, timeline: timeline)
            applyRunState(runState)
            if !runState.isRunning {
                await flushQueuedMessageIfNeeded(chatId: chatId)
            }

            guard shouldConnectHydratedChatStream(chatId: chatId, selectedChatId: selectedChatId) else {
                logger.debug("hydrate_chat_stale_selection chat=\(chatId, privacy: .public) selected=\(self.selectedChatId ?? "none", privacy: .public)")
                recordDebugLog("hydrate_chat_stale_selection", level: .debug, minimumMode: .verbose, details: [
                    "chatId": chatId,
                    "selectedChatId": self.selectedChatId ?? "none",
                ])
                return
            }

            connectStream(chatId: chatId)
        } catch {
            guard shouldConnectHydratedChatStream(chatId: chatId, selectedChatId: selectedChatId) else {
                logger.debug("hydrate_chat_error_ignored chat=\(chatId, privacy: .public) selected=\(self.selectedChatId ?? "none", privacy: .public)")
                recordDebugLog("hydrate_chat_error_ignored", level: .debug, minimumMode: .verbose, details: [
                    "chatId": chatId,
                    "selectedChatId": self.selectedChatId ?? "none",
                    "error": error.localizedDescription,
                ])
                return
            }

            logger.error("hydrate_chat_failed chat=\(chatId, privacy: .public) error=\(error.localizedDescription, privacy: .public)")
            recordDebugLog("hydrate_chat_failed", level: .error, details: [
                "chatId": chatId,
                "error": error.localizedDescription,
            ])
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

    private func refreshFocusedChatStatus(chatId: String) async {
        guard isPaired, selectedChatId == chatId else {
            return
        }

        do {
            let runState = try await fetchChatRunState(chatId: chatId)
            applyRunState(runState)

            if runState.isRunning {
                if streamChatId != chatId || streamTask == nil {
                    startChatHydration(chatId: chatId)
                }
                return
            }

            await flushQueuedMessageIfNeeded(chatId: chatId)
        } catch {
            // Keep the current chat visible if one lightweight status check misses once.
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

    private func rememberChat(_ chat: ChatThread) {
        var projectChats = chatsByProjectId[chat.projectId] ?? []
        projectChats.removeAll(where: { $0.id == chat.id })
        projectChats.insert(chat, at: 0)
        projectChats.sort(by: { $0.updatedAt > $1.updatedAt })
        chatsByProjectId[chat.projectId] = projectChats

        if selectedProjectId == chat.projectId {
            chats = projectChats
        }
    }

    private func ensureSelectedChatForCurrentProject() async {
        syncSelectedProjectChats()

        if isNewChatDraftActive {
            selectedChatId = nil
            return
        }

        if let selectedChatId,
           chats.contains(where: { $0.id == selectedChatId }) {
            let shouldHydrate = shouldHydrateSelectedChatAfterRefresh(
                chatId: selectedChatId,
                hasLoadedMessages: messagesByChat[selectedChatId] != nil,
                hasLoadedActivities: activitiesByChat[selectedChatId] != nil,
                runState: runStateByChat[selectedChatId],
                streamChatId: streamChatId,
                hasActiveStreamTask: streamTask != nil
            )

            if shouldHydrate {
                startChatHydration(chatId: selectedChatId)
            } else {
                recordDebugLog("selected_chat_hydration_skipped", level: .debug, minimumMode: .verbose, details: [
                    "chatId": selectedChatId,
                    "reason": "live_stream_or_cached_timeline",
                ])
            }
            return
        }

        selectedChatId = chats.first?.id

        if let selectedChatId {
            startChatHydration(chatId: selectedChatId)
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
