import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

enum ComposerLayout {
    static let minEditorHeight: CGFloat = 28
    static let maxEditorHeight: CGFloat = 156
    static let dictationStatusHeight: CGFloat = 50
    static let cornerRadius: CGFloat = 28
    static let inputFontSize: CGFloat = 14
    static let attachmentButtonDiameter: CGFloat = 40
    static let attachmentIconSize: CGFloat = 16
    static let primaryActionButtonDiameter: CGFloat = 40
    static let sendIconSize: CGFloat = 14
    static let stopIconSize: CGFloat = 12
    static let micIconSize: CGFloat = 16
    static let micTapTargetSize: CGFloat = 24
    static let outerControlSpacing: CGFloat = 8
    static let innerControlSpacing: CGFloat = 10
    static let composerHorizontalPadding: CGFloat = 14
    static let composerVerticalPadding: CGFloat = 8
    static let placeholderTopPadding: CGFloat = 4
}

private enum RemotePalette {
    static let tint = Color(red: 0.96, green: 0.45, blue: 0.16)
    static let border = Color.primary.opacity(0.06)
    static let drawerShadow = Color.black.opacity(0.14)
    static let userBubble = Color(red: 0.98, green: 0.90, blue: 0.84)
    static let card = Color(uiColor: .systemGray6)
    static let toolbarButton = Color(uiColor: .systemGray6)
    static let composerFill = Color(uiColor: .systemGray6)
    static let userText = Color(red: 0.41, green: 0.24, blue: 0.16)
    static let activityFill = Color.primary.opacity(0.04)
    static let linkLight = Color(red: 0.30, green: 0.56, blue: 0.97)
    static let linkDark = Color(red: 0.47, green: 0.70, blue: 1.00)

    static func canvasColor(for colorScheme: ColorScheme) -> Color {
        if colorScheme == .dark {
            return Color(red: 0.08, green: 0.08, blue: 0.09)
        }

        return Color(red: 0.99, green: 0.98, blue: 0.96)
    }

    static func composerFill(for colorScheme: ColorScheme, isFocused: Bool) -> Color {
        if colorScheme == .dark {
            if isFocused {
                return Color(red: 0.19, green: 0.19, blue: 0.20)
            }

            return Color(red: 0.15, green: 0.15, blue: 0.16)
        }

        return isFocused ? Color(uiColor: .systemGray5) : Color(uiColor: .systemGray6)
    }

    static func linkColor(for colorScheme: ColorScheme) -> Color {
        colorScheme == .dark ? linkDark : linkLight
    }

    static func inlineCodeFill(for colorScheme: ColorScheme) -> Color {
        if colorScheme == .dark {
            return Color.white.opacity(0.10)
        }

        return Color.black.opacity(0.06)
    }
}

private struct RemoteCanvasBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        RemotePalette.canvasColor(for: colorScheme)
            .ignoresSafeArea()
    }
}

enum ChatSurfaceMessageStyle: Equatable {
    case userBubble
    case assistantFullWidth

    static func resolve(role: String) -> ChatSurfaceMessageStyle {
        role == "user" ? .userBubble : .assistantFullWidth
    }
}

enum ChatSurfaceCopy {
    static func composerPrompt(hasSelectedChat: Bool, isDraftingNewChat: Bool) -> String {
        if hasSelectedChat {
            return "What's next?"
        }

        if isDraftingNewChat {
            return "Write the first message..."
        }

        return "Start a new conversation or select a chat..."
    }
}

enum ChatMessageCopyFeedback {
    static let flashDurationSeconds: Double = 0.10
    static let animationDurationSeconds: Double = 0.08
}

enum ChatMessageCopyPlacement: Equatable {
    case leading
    case trailing

    static func resolve(role: String) -> ChatMessageCopyPlacement {
        role == "user" ? .trailing : .leading
    }
}

struct ChatMessageCopyPerformer {
    let copyToPasteboard: (String) -> Void
    let playConfirmation: () -> Void

    static let live = ChatMessageCopyPerformer(
        copyToPasteboard: { text in
            UIPasteboard.general.string = text
        },
        playConfirmation: {
            let generator = UIImpactFeedbackGenerator(style: .light)
            generator.prepare()
            generator.impactOccurred()
        }
    )

    func perform(text: String) {
        copyToPasteboard(text)
        playConfirmation()
    }
}

func canCopyChatMessageText(_ text: String) -> Bool {
    !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

enum ComposerPrimaryActionMode: Equatable {
    case send
    case stop
}

func resolveComposerPrimaryActionMode(
    hasSelectedChat: Bool,
    hasDraft: Bool,
    isRunActive: Bool
) -> ComposerPrimaryActionMode {
    guard hasSelectedChat else {
        return .send
    }

    if isRunActive && !hasDraft {
        return .stop
    }

    return .send
}

func resolveComposerOuterControlRowAlignment(
    composerSurfaceHeight: CGFloat,
    showsDictationStatus: Bool
) -> VerticalAlignment {
    if showsDictationStatus {
        return .center
    }

    if composerSurfaceHeight > ComposerLayout.minEditorHeight {
        return .bottom
    }

    return .center
}

func resolveComposerAccessoryFrameAlignment(showsDictationStatus: Bool) -> Alignment {
    if showsDictationStatus {
        return .center
    }

    return .bottom
}

struct SidebarProjectGroupDescriptor: Identifiable, Equatable {
    let id: String
    let title: String
    let projectIDs: [String]
    let primaryProjectID: String
    let latestUpdatedAt: TimeInterval
    let chats: [ChatThread]
}

enum SidebarProjectHeaderAction: Equatable {
    case toggleDisclosure
}

func buildSidebarProjectGroups(
    projects: [Project],
    chatsByProjectId: [String: [ChatThread]],
    selectedProjectId: String?
) -> [SidebarProjectGroupDescriptor] {
    let groupedProjects = Dictionary(grouping: projects) { project in
        project.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    return groupedProjects.values.compactMap { groupProjects in
        guard let firstProject = groupProjects.first else {
            return nil
        }

        let sortedProjects = groupProjects.sorted { lhs, rhs in
            if lhs.lastUpdatedAt == rhs.lastUpdatedAt {
                return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
            }

            return lhs.lastUpdatedAt > rhs.lastUpdatedAt
        }

        let primaryProjectID = sortedProjects.first(where: { $0.id == selectedProjectId })?.id
        ?? sortedProjects.first?.id
        ?? firstProject.id

        let mergedChats = sortedProjects
            .flatMap { chatsByProjectId[$0.id] ?? [] }
            .reduce(into: [String: ChatThread]()) { partialResult, chat in
                let existing = partialResult[chat.id]
                if existing == nil || existing!.updatedAt < chat.updatedAt {
                    partialResult[chat.id] = chat
                }
            }
            .values
            .sorted { lhs, rhs in
                if lhs.updatedAt == rhs.updatedAt {
                    return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
                }

                return lhs.updatedAt > rhs.updatedAt
            }

        let latestUpdatedAt = max(
            sortedProjects.map(\.lastUpdatedAt).max() ?? 0,
            mergedChats.map(\.updatedAt).max() ?? 0
        )

        return SidebarProjectGroupDescriptor(
            id: firstProject.title.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
            title: firstProject.title,
            projectIDs: sortedProjects.map(\.id),
            primaryProjectID: primaryProjectID,
            latestUpdatedAt: latestUpdatedAt,
            chats: mergedChats
        )
    }
    .sorted { lhs, rhs in
        if lhs.latestUpdatedAt == rhs.latestUpdatedAt {
            return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
        }

        return lhs.latestUpdatedAt > rhs.latestUpdatedAt
    }
}

func resolveSidebarProjectHeaderAction(
    group: SidebarProjectGroupDescriptor,
    selectedProjectId: String?
) -> SidebarProjectHeaderAction {
    .toggleDisclosure
}

func makeChatTranscriptScrollTrigger(chatId: String, lastTimelineItemId: String?) -> String {
    "\(chatId)::\(lastTimelineItemId ?? "bottom")"
}

func formatDictationElapsedTime(_ duration: TimeInterval) -> String {
    let totalSeconds = max(Int(duration.rounded(.down)), 0)
    let seconds = totalSeconds % 60
    let minutes = (totalSeconds / 60) % 60
    let hours = totalSeconds / 3_600

    if hours > 0 {
        return String(format: "%d:%02d:%02d", hours, minutes, seconds)
    }

    return String(format: "%02d:%02d", minutes, seconds)
}

func resolveDictationStatusTitle(
    isTranscribing: Bool,
    startedAt: Date?,
    now: Date = Date()
) -> String {
    if isTranscribing {
        return "Transcribing..."
    }

    guard let startedAt else {
        return "Recording 00:00"
    }

    return "Recording \(formatDictationElapsedTime(now.timeIntervalSince(startedAt)))"
}

func resolveDictationStatusSubtitle(isTranscribing: Bool) -> String {
    if isTranscribing {
        return "Adding to draft"
    }

    return "Tap again to stop"
}

func resolveComposerSurfaceHeight(measuredHeight: CGFloat, showsDictationStatus: Bool) -> CGFloat {
    if showsDictationStatus {
        return ComposerLayout.dictationStatusHeight
    }

    return measuredHeight
}

private let approvalPolicyOptions = [
    "untrusted",
    "on-failure",
    "on-request",
    "never"
]

private let sandboxModeOptions = [
    "read-only",
    "workspace-write",
    "danger-full-access"
]

struct ContentView: View {
    @EnvironmentObject private var viewModel: AppViewModel
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        Group {
            if viewModel.isPaired {
                if horizontalSizeClass == .compact {
                    CompactRemoteWorkspace()
                } else {
                    RegularRemoteWorkspace()
                }
            } else {
                PairingView()
            }
        }
        .tint(RemotePalette.tint)
        .background(RemoteCanvasBackground())
        .sheet(item: Binding(
            get: { viewModel.pendingApproval },
            set: { _ in }
        )) { approval in
            ApprovalSheet(approval: approval)
        }
        .alert("Error", isPresented: Binding(
            get: { viewModel.errorMessage != nil },
            set: { shouldShow in if !shouldShow { viewModel.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { }
        } message: {
            Text(viewModel.errorMessage ?? "Unknown error")
        }
    }
}

private struct CompactRemoteWorkspace: View {
    @EnvironmentObject private var viewModel: AppViewModel

    @State private var isSidebarPresented = false
    @FocusState private var composerFocused: Bool

    var body: some View {
        GeometryReader { proxy in
            let drawerWidth = min(max(proxy.size.width * 0.82, 300), 352)

            ZStack(alignment: .leading) {
                mainSurface
                    .offset(x: isSidebarPresented ? drawerWidth * 0.88 : 0)
                    .scaleEffect(isSidebarPresented ? 0.97 : 1.0, anchor: .trailing)
                    .clipShape(RoundedRectangle(cornerRadius: isSidebarPresented ? 32 : 0, style: .continuous))
                    .shadow(color: isSidebarPresented ? RemotePalette.drawerShadow : .clear, radius: 24, y: 12)
                    .overlay {
                        if isSidebarPresented {
                            Color.black.opacity(0.18)
                                .ignoresSafeArea()
                                .onTapGesture {
                                    withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                                        isSidebarPresented = false
                                    }
                                }
                        }
                    }

                RemoteSidebarPanel(isCompact: true) {
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                        isSidebarPresented = false
                    }
                }
                .frame(width: drawerWidth)
                .frame(maxHeight: .infinity)
                .offset(x: isSidebarPresented ? 0 : -drawerWidth)
            }
            .background(RemoteCanvasBackground())
            .animation(.spring(response: 0.34, dampingFraction: 0.86), value: isSidebarPresented)
        }
    }

    private var mainSurface: some View {
        VStack(spacing: 0) {
            CompactTopBar(
                isSidebarPresented: isSidebarPresented,
                onToggleSidebar: {
                    withAnimation(.spring(response: 0.34, dampingFraction: 0.86)) {
                        isSidebarPresented.toggle()
                    }
                }
            )

            ChatWorkspaceView()
        }
        .background(RemoteCanvasBackground())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            ComposerDock(isCompact: true, composerFocused: $composerFocused)
                .environmentObject(viewModel)
        }
    }
}

private struct RegularRemoteWorkspace: View {
    @EnvironmentObject private var viewModel: AppViewModel
    @FocusState private var composerFocused: Bool

    var body: some View {
        NavigationSplitView {
            RemoteSidebarPanel(isCompact: false, onDismiss: nil)
                .navigationSplitViewColumnWidth(min: 320, ideal: 360, max: 420)
        } detail: {
            VStack(spacing: 0) {
                RegularTopBar()
                ChatWorkspaceView()
            }
            .background(RemoteCanvasBackground())
            .safeAreaInset(edge: .bottom, spacing: 0) {
                ComposerDock(isCompact: false, composerFocused: $composerFocused)
                    .environmentObject(viewModel)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
            }
        }
    }
}

private struct CompactTopBar: View {
    @EnvironmentObject private var viewModel: AppViewModel

    let isSidebarPresented: Bool
    let onToggleSidebar: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            TopBarCircleButton(icon: isSidebarPresented ? "xmark" : "line.3.horizontal", action: onToggleSidebar)

            Text(viewModel.selectedChatDisplayTitle)
                .font(.system(size: 18, weight: .semibold))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)

            HeaderActionButtons()
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 14)
    }
}

private struct RegularTopBar: View {
    @EnvironmentObject private var viewModel: AppViewModel

    var body: some View {
        HStack(alignment: .center, spacing: 18) {
            Text(viewModel.selectedChatDisplayTitle)
                .font(.system(size: 24, weight: .semibold))
                .lineLimit(1)

            Spacer(minLength: 0)

            HeaderActionButtons()
        }
        .padding(.horizontal, 24)
        .padding(.top, 16)
        .padding(.bottom, 14)
    }
}

private struct TopBarCircleButton: View {
    let icon: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if icon == "line.3.horizontal" {
                    SidebarMenuGlyph()
                } else {
                    Image(systemName: icon)
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(.primary)
                }
            }
            .frame(width: 34, height: 34, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct SidebarMenuGlyph: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Capsule()
                .fill(Color.primary)
                .frame(width: 21, height: 3)

            Capsule()
                .fill(Color.primary)
                .frame(width: 13, height: 3)
        }
        .frame(width: 24, height: 20, alignment: .leading)
    }
}

private struct HeaderActionButtons: View {
    @EnvironmentObject private var viewModel: AppViewModel
    @State private var isContextSheetPresented = false

    var body: some View {
        HStack(spacing: 10) {
            Button {
                Task { await viewModel.beginNewChatDraft() }
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 22, weight: .regular))
                    .frame(width: 40, height: 40)
            }
            .buttonStyle(.plain)

            Menu {
                Button("Session") {
                    isContextSheetPresented = true
                }

                Button("Refresh") {
                    Task { await viewModel.refreshData() }
                }

                Button("New Chat") {
                    Task { await viewModel.beginNewChatDraft() }
                }

                Button("Unpair", role: .destructive) {
                    viewModel.unpair()
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 24, weight: .semibold))
                    .frame(width: 40, height: 40)
            }
        }
        .sheet(isPresented: $isContextSheetPresented) {
            SessionContextSheet()
                .environmentObject(viewModel)
        }
    }
}

private struct RemoteSidebarPanel: View {
    @EnvironmentObject private var viewModel: AppViewModel
    @State private var searchText = ""
    @State private var expandedProjectGroupIDs = Set<String>()
    @State private var sidebarProjectGroupID: String?

    let isCompact: Bool
    let onDismiss: (() -> Void)?

    private var projectGroups: [SidebarProjectGroupDescriptor] {
        buildSidebarProjectGroups(
            projects: viewModel.projects,
            chatsByProjectId: viewModel.chatsByProjectId,
            selectedProjectId: viewModel.selectedProjectId
        )
    }

    private var filteredProjectGroups: [SidebarProjectGroupDescriptor] {
        projectGroups.filter { group in
            if normalizedSearchText.isEmpty {
                return true
            }

            if group.title.localizedCaseInsensitiveContains(normalizedSearchText) {
                return true
            }

            return filteredChats(for: group).isEmpty == false
        }
    }

    private var normalizedSearchText: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                SidebarSearchField(text: $searchText)

                Button {
                    Task {
                        await viewModel.beginNewChatDraft(projectId: activeProjectID)
                        onDismiss?()
                    }
                } label: {
                    Image(systemName: "square.and.pencil")
                        .font(.system(size: 22, weight: .regular))
                        .foregroundStyle(.primary)
                        .frame(width: 56, height: 56)
                        .background(RemotePalette.card, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(activeProjectID == nil)
                .opacity(activeProjectID == nil ? 0.55 : 1.0)
            }
            .padding(.horizontal, isCompact ? 18 : 14)
            .padding(.top, isCompact ? 14 : 12)
            .padding(.bottom, 16)

            ScrollView(showsIndicators: false) {
                if filteredProjectGroups.isEmpty {
                    SidebarEmptySearchState(searchText: normalizedSearchText)
                        .padding(.horizontal, 14)
                } else {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(filteredProjectGroups) { group in
                            SidebarProjectDisclosure(
                                group: group,
                                chats: filteredChats(for: group),
                                isExpanded: isExpanded(group),
                                isFocused: group.projectIDs.contains(activeProjectID ?? ""),
                                isLoading: group.projectIDs.contains(where: { viewModel.loadingChatProjectIDs.contains($0) }),
                                selectedChatId: viewModel.selectedChatId,
                                onToggle: {
                                    toggleProjectGroup(group)
                                },
                                onSelectChat: { chat in
                                    sidebarProjectGroupID = group.id
                                    expandedProjectGroupIDs.insert(group.id)
                                    viewModel.selectChat(chat)
                                    onDismiss?()
                                }
                            )
                        }
                    }
                    .padding(.horizontal, 10)
                }
            }
            .padding(.bottom, 18)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(uiColor: .systemBackground))
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(RemotePalette.border)
                .frame(width: 1)
        }
        .onAppear {
            if let selectedProjectId = viewModel.selectedProjectId,
               let selectedGroup = projectGroups.first(where: { $0.projectIDs.contains(selectedProjectId) }) {
                expandedProjectGroupIDs.insert(selectedGroup.id)
            }

            if sidebarProjectGroupID == nil {
                sidebarProjectGroupID = selectedGroupID
            }
        }
        .onChange(of: viewModel.selectedProjectId) { _, newValue in
            guard let newValue,
                  let group = projectGroups.first(where: { $0.projectIDs.contains(newValue) }) else {
                return
            }
            sidebarProjectGroupID = group.id
            expandedProjectGroupIDs.insert(group.id)
        }
        .onChange(of: searchText) { oldValue, newValue in
            let oldTrimmed = oldValue.trimmingCharacters(in: .whitespacesAndNewlines)
            let newTrimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)

            guard oldTrimmed.isEmpty, !newTrimmed.isEmpty else {
                return
            }

            Task {
                for project in viewModel.projects where !viewModel.hasLoadedChats(for: project.id) {
                    await viewModel.loadChats(projectId: project.id)
                }
            }
        }
    }

    private var selectedGroupID: String? {
        guard let selectedProjectId = viewModel.selectedProjectId else {
            return filteredProjectGroups.first?.id
        }

        return projectGroups.first(where: { $0.projectIDs.contains(selectedProjectId) })?.id
        ?? filteredProjectGroups.first?.id
    }

    private var activeProjectID: String? {
        if let sidebarProjectGroupID,
           let group = projectGroups.first(where: { $0.id == sidebarProjectGroupID }) {
            return group.primaryProjectID
        }

        return projectGroups.first(where: { $0.id == selectedGroupID })?.primaryProjectID
        ?? filteredProjectGroups.first?.primaryProjectID
    }

    private func filteredChats(for group: SidebarProjectGroupDescriptor) -> [ChatThread] {
        let projectChats = group.chats

        guard normalizedSearchText.isEmpty == false else {
            return projectChats
        }

        if group.title.localizedCaseInsensitiveContains(normalizedSearchText) {
            return projectChats
        }

        return projectChats.filter { chat in
            chat.title.localizedCaseInsensitiveContains(normalizedSearchText)
            || chat.preview.localizedCaseInsensitiveContains(normalizedSearchText)
        }
    }

    private func isExpanded(_ group: SidebarProjectGroupDescriptor) -> Bool {
        if normalizedSearchText.isEmpty == false {
            return true
        }

        return expandedProjectGroupIDs.contains(group.id)
    }

    private func toggleProjectGroup(_ group: SidebarProjectGroupDescriptor) {
        switch resolveSidebarProjectHeaderAction(
            group: group,
            selectedProjectId: viewModel.selectedProjectId
        ) {
        case .toggleDisclosure:
            toggleExpandedProjectGroup(group)
        }
    }

    private func toggleExpandedProjectGroup(_ group: SidebarProjectGroupDescriptor) {
        sidebarProjectGroupID = group.id

        if expandedProjectGroupIDs.contains(group.id) {
            expandedProjectGroupIDs.remove(group.id)
            return
        }

        expandedProjectGroupIDs.insert(group.id)

        Task {
            for projectID in group.projectIDs {
                await viewModel.loadChats(projectId: projectID)
            }
        }
    }
}

private struct SidebarSearchField: View {
    @Binding var text: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(.secondary)

            TextField("Search", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 17))
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        .background(RemotePalette.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}

private struct SidebarProjectDisclosure: View {
    let group: SidebarProjectGroupDescriptor
    let chats: [ChatThread]
    let isExpanded: Bool
    let isFocused: Bool
    let isLoading: Bool
    let selectedChatId: String?
    let onToggle: () -> Void
    let onSelectChat: (ChatThread) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(action: onToggle) {
                HStack(spacing: 12) {
                    Image(systemName: isExpanded ? "folder.fill" : "folder")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(isExpanded ? RemotePalette.tint : .secondary)

                    Text(group.title)
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(isFocused ? Color.black.opacity(0.05) : Color.clear)
                )
            }
            .buttonStyle(.plain)

            if isExpanded {
                VStack(alignment: .leading, spacing: 2) {
                    if isLoading {
                        Text("Loading chats…")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                            .padding(.leading, 44)
                            .padding(.vertical, 6)
                    } else if chats.isEmpty {
                        Text("No chats yet")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                            .padding(.leading, 44)
                            .padding(.vertical, 6)
                    } else {
                        ForEach(chats) { chat in
                            SidebarChatLeaf(
                                chat: chat,
                                isSelected: selectedChatId == chat.id,
                                action: { onSelectChat(chat) }
                            )
                        }
                    }
                }
                .padding(.leading, 12)
            }
        }
    }
}

private struct SidebarChatLeaf: View {
    let chat: ChatThread
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 10) {
                Text(chat.title)
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Spacer(minLength: 8)

                Text(shortRelativeTimestamp(since: chat.updatedAt))
                    .font(.system(size: 12, weight: .regular))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(isSelected ? Color.black.opacity(0.06) : Color.clear)
            )
        }
        .buttonStyle(.plain)
    }
}

private struct SidebarEmptySearchState: View {
    let searchText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(searchText.isEmpty ? "No projects yet" : "No matches")
                .font(.headline)

            Text(searchText.isEmpty ? "Pair a Mac and open a workspace to see projects here." : "Try another project or chat name.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 18)
        .background(Color.black.opacity(0.03), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

func shortRelativeTimestamp(since updatedAt: TimeInterval) -> String {
    let seconds = max(0, Int(Date().timeIntervalSince1970 - updatedAt))

    if seconds < 3_600 {
        return "\(max(1, seconds / 60))m"
    }

    if seconds < 86_400 {
        return "\(seconds / 3_600)h"
    }

    if seconds < 604_800 {
        return "\(seconds / 86_400)d"
    }

    if seconds < 2_592_000 {
        return "\(seconds / 604_800)w"
    }

    return "\(seconds / 2_592_000)mo"
}

func formatWorkedDuration(_ seconds: TimeInterval) -> String {
    let rounded = max(1, Int(seconds.rounded()))
    let hours = rounded / 3_600
    let minutes = (rounded % 3_600) / 60
    let remainderSeconds = rounded % 60

    if hours > 0 {
        if remainderSeconds == 0 {
            return "\(hours)h \(minutes)m"
        }

        return "\(hours)h \(minutes)m \(remainderSeconds)s"
    }

    if minutes > 0 {
        return "\(minutes)m \(remainderSeconds)s"
    }

    return "\(remainderSeconds)s"
}

func normalizeHeadingMarkdown(_ markdown: String) -> String {
    markdown
        .components(separatedBy: "\n")
        .map { line in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("#") else { return line }

            let text = trimmed.replacingOccurrences(of: #"^#+\s*"#, with: "", options: .regularExpression)
            guard !text.isEmpty else { return line }
            return "**\(text)**"
        }
        .joined(separator: "\n")
}

private enum FinalAnswerBlock: Equatable {
    case heading(String)
    case paragraph(String)
    case bulletList([String])
    case numberedList([String])
    case codeBlock(String)
}

private enum ListBlockKind {
    case bullet
    case numbered
}

private enum FinalAnswerRenderCache {
    private static let maximumEntries = 96
    private static var blocksByText: [String: [FinalAnswerBlock]] = [:]
    private static var blockKeys: [String] = []
    private static var attributedByKey: [String: AttributedString] = [:]
    private static var attributedKeys: [String] = []

    static func blocks(for text: String) -> [FinalAnswerBlock] {
        if let cached = blocksByText[text] {
            return cached
        }

        let parsed = parseFinalAnswerBlocksUncached(text)
        storeBlocks(parsed, for: text)
        return parsed
    }

    static func attributedText(for markdown: String, colorScheme: ColorScheme) -> AttributedString {
        let cacheKey = "\(colorScheme == .dark ? "dark" : "light")::\(markdown)"
        if let cached = attributedByKey[cacheKey] {
            return cached
        }

        let rendered = buildMarkdownAttributedTextUncached(markdown, colorScheme: colorScheme)
        storeAttributedText(rendered, for: cacheKey)
        return rendered
    }

    private static func storeBlocks(_ blocks: [FinalAnswerBlock], for key: String) {
        blocksByText[key] = blocks
        blockKeys.removeAll { $0 == key }
        blockKeys.append(key)

        while blockKeys.count > maximumEntries {
            let removedKey = blockKeys.removeFirst()
            blocksByText.removeValue(forKey: removedKey)
        }
    }

    private static func storeAttributedText(_ attributed: AttributedString, for key: String) {
        attributedByKey[key] = attributed
        attributedKeys.removeAll { $0 == key }
        attributedKeys.append(key)

        while attributedKeys.count > maximumEntries {
            let removedKey = attributedKeys.removeFirst()
            attributedByKey.removeValue(forKey: removedKey)
        }
    }
}

func normalizeParagraphLineBreaks(_ markdown: String) -> String {
    let lines = markdown.components(separatedBy: "\n")
    var normalized: [String] = []
    var paragraph = ""
    var inCodeFence = false

    func flushParagraph() {
        guard !paragraph.isEmpty else { return }
        normalized.append(paragraph)
        paragraph = ""
    }

    func startsStructuredBlock(_ trimmed: String) -> Bool {
        if trimmed.hasPrefix("```") || trimmed.hasPrefix(">") {
            return true
        }

        if trimmed.range(of: #"^[-*+]\s"#, options: .regularExpression) != nil {
            return true
        }

        if trimmed.range(of: #"^\d+\.\s"#, options: .regularExpression) != nil {
            return true
        }

        return false
    }

    for line in lines {
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        if trimmed.hasPrefix("```") {
            flushParagraph()
            normalized.append(line)
            inCodeFence.toggle()
            continue
        }

        if inCodeFence {
            normalized.append(line)
            continue
        }

        if trimmed.isEmpty {
            flushParagraph()
            normalized.append("")
            continue
        }

        if startsStructuredBlock(trimmed) {
            flushParagraph()
            normalized.append(line)
            continue
        }

        if paragraph.isEmpty {
            paragraph = trimmed
        } else {
            paragraph += " " + trimmed
        }
    }

    flushParagraph()
    return normalized.joined(separator: "\n")
}

func normalizeFinalAnswerMarkdown(_ markdown: String) -> String {
    let paragraphNormalized = normalizeParagraphLineBreaks(normalizeHeadingMarkdown(markdown))
    let lines = paragraphNormalized.components(separatedBy: "\n")
    var normalized: [String] = []
    var inCodeFence = false

    func appendBlankLineIfNeeded() {
        if normalized.last?.isEmpty != true {
            normalized.append("")
        }
    }

    for line in lines {
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        if trimmed.hasPrefix("```") {
            appendBlankLineIfNeeded()
            normalized.append(trimmed)
            inCodeFence.toggle()
            continue
        }

        if inCodeFence {
            normalized.append(line)
            continue
        }

        if trimmed.isEmpty {
            appendBlankLineIfNeeded()
            continue
        }

        if let bulletRange = trimmed.range(of: #"^[-*+]\s+"#, options: .regularExpression) {
            let content = trimmed[bulletRange.upperBound...].trimmingCharacters(in: .whitespaces)
            appendBlankLineIfNeeded()
            normalized.append("• \(content)")
            continue
        }

        if trimmed.range(of: #"^\d+\.\s+"#, options: .regularExpression) != nil {
            appendBlankLineIfNeeded()
            normalized.append(trimmed)
            continue
        }

        if trimmed.hasPrefix(">") {
            appendBlankLineIfNeeded()
            normalized.append(trimmed)
            continue
        }

        normalized.append(trimmed)
    }

    while normalized.last?.isEmpty == true {
        normalized.removeLast()
    }

    return normalizeInlineMarkdownSpacing(normalized.joined(separator: "\n"))
}

private func parseFinalAnswerBlocksUncached(_ text: String) -> [FinalAnswerBlock] {
    let lines = text
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .components(separatedBy: "\n")

    var blocks: [FinalAnswerBlock] = []
    var paragraphLines: [String] = []
    var listKind: ListBlockKind?
    var listItems: [String] = []
    var codeLines: [String] = []
    var inCodeFence = false

    func flushParagraph() {
        guard !paragraphLines.isEmpty else { return }
        let paragraph = normalizeInlineMarkdownSpacing(paragraphLines.joined(separator: " "))
        blocks.append(.paragraph(paragraph))
        paragraphLines.removeAll()
    }

    func flushList() {
        guard !listItems.isEmpty, let activeListKind = listKind else { return }
        let normalizedItems = listItems.map(normalizeInlineMarkdownSpacing)
        switch activeListKind {
        case .bullet:
            blocks.append(.bulletList(normalizedItems))
        case .numbered:
            blocks.append(.numberedList(normalizedItems))
        }
        listKind = nil
        listItems.removeAll()
    }

    func flushCode() {
        guard !codeLines.isEmpty else { return }
        blocks.append(.codeBlock(codeLines.joined(separator: "\n")))
        codeLines.removeAll()
    }

    for rawLine in lines {
        let trimmed = rawLine.trimmingCharacters(in: .whitespaces)

        if trimmed.hasPrefix("```") {
            flushParagraph()
            flushList()
            if inCodeFence {
                flushCode()
            }
            inCodeFence.toggle()
            continue
        }

        if inCodeFence {
            codeLines.append(rawLine)
            continue
        }

        if trimmed.isEmpty {
            flushParagraph()
            flushList()
            continue
        }

        if trimmed.hasPrefix("#") {
            flushParagraph()
            flushList()
            let heading = trimmed.replacingOccurrences(of: #"^#+\s*"#, with: "", options: .regularExpression)
            if !heading.isEmpty {
                blocks.append(.heading(normalizeInlineMarkdownSpacing(heading)))
            }
            continue
        }

        if let bulletRange = trimmed.range(of: #"^[-*+]\s+"#, options: .regularExpression) {
            flushParagraph()
            if listKind != .bullet {
                flushList()
                listKind = .bullet
            }
            listItems.append(String(trimmed[bulletRange.upperBound...]).trimmingCharacters(in: .whitespaces))
            continue
        }

        if let numberedRange = trimmed.range(of: #"^\d+\.\s+"#, options: .regularExpression) {
            flushParagraph()
            if listKind != .numbered {
                flushList()
                listKind = .numbered
            }
            listItems.append(String(trimmed[numberedRange.upperBound...]).trimmingCharacters(in: .whitespaces))
            continue
        }

        flushList()
        paragraphLines.append(trimmed)
    }

    flushParagraph()
    flushList()
    flushCode()

    return blocks
}

private func parseFinalAnswerBlocks(_ text: String) -> [FinalAnswerBlock] {
    FinalAnswerRenderCache.blocks(for: text)
}

func normalizeInlineMarkdownSpacing(_ markdown: String) -> String {
    let pattern = #"`[^`\n]+`|\[[^\]]+\]\([^)]+\)"#
    guard let regex = try? NSRegularExpression(pattern: pattern) else {
        return markdown
    }

    let nsMarkdown = markdown as NSString
    let matches = regex.matches(in: markdown, range: NSRange(location: 0, length: nsMarkdown.length))
    var normalized = markdown

    for match in matches.reversed() {
        guard match.range.location != NSNotFound else { continue }

        let tokenStart = normalized.index(normalized.startIndex, offsetBy: match.range.location)
        let tokenEnd = normalized.index(tokenStart, offsetBy: match.range.length)

        if tokenEnd < normalized.endIndex {
            let next = normalized[tokenEnd]
            if !next.isWhitespace && !")],.;:!?".contains(next) {
                normalized.insert(" ", at: tokenEnd)
            }
        }

        if tokenStart > normalized.startIndex {
            let previousIndex = normalized.index(before: tokenStart)
            let previous = normalized[previousIndex]
            if !previous.isWhitespace && previous != "(" && previous != "[" {
                normalized.insert(" ", at: tokenStart)
            }
        }
    }

    return normalized
}

private func buildMarkdownAttributedTextUncached(_ markdown: String, colorScheme: ColorScheme) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .full,
        failurePolicy: .returnPartiallyParsedIfPossible
    )
    let normalizedMarkdown = normalizeInlineMarkdownSpacing(markdown)
    var attributed = (try? AttributedString(markdown: normalizedMarkdown, options: options)) ?? AttributedString(normalizedMarkdown)
    let fullRange = attributed.startIndex..<attributed.endIndex

    attributed[fullRange].font = .system(size: 16)
    attributed[fullRange].foregroundColor = colorScheme == .dark ? .white : .black

    for run in attributed.runs {
        let range = run.range
        let inlineIntent = run.inlinePresentationIntent

        if inlineIntent?.contains(.code) == true {
            attributed[range].font = .system(size: 16, weight: .medium, design: .monospaced)
            attributed[range].foregroundColor = colorScheme == .dark ? .white : Color(red: 0.20, green: 0.22, blue: 0.25)
            attributed[range].backgroundColor = RemotePalette.inlineCodeFill(for: colorScheme)
        } else if inlineIntent?.contains(.stronglyEmphasized) == true {
            attributed[range].font = .system(size: 16, weight: .semibold)
        } else {
            attributed[range].font = .system(size: 16)
        }

        if run.link != nil {
            attributed[range].foregroundColor = RemotePalette.linkColor(for: colorScheme)
        }
    }

    return attributed
}

func buildMarkdownAttributedText(_ markdown: String, colorScheme: ColorScheme) -> AttributedString {
    FinalAnswerRenderCache.attributedText(for: markdown, colorScheme: colorScheme)
}

private struct ChatWorkspaceView: View {
    @EnvironmentObject private var viewModel: AppViewModel

    var body: some View {
        Group {
            if viewModel.selectedChat != nil,
               let selectedChatId = viewModel.selectedChatId {
                ChatTranscriptView(chatId: selectedChatId)
                    .id(selectedChatId)
            } else if viewModel.isNewChatDraftActive {
                NewChatDraftStateView()
            } else {
                EmptyConversationState()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct ChatTranscriptView: View {
    @EnvironmentObject private var viewModel: AppViewModel

    let chatId: String

    private let bottomAnchor = "chat-bottom-anchor"

    var body: some View {
        let messages = viewModel.messagesByChat[chatId] ?? []
        let activities = viewModel.activitiesByChat[chatId] ?? []
        let timelineItems = buildChatTimeline(messages: messages, activities: activities)
        let scrollTrigger = makeChatTranscriptScrollTrigger(
            chatId: chatId,
            lastTimelineItemId: timelineItems.last?.id
        )

        ScrollViewReader { proxy in
            ScrollView(showsIndicators: false) {
                LazyVStack(alignment: .leading, spacing: 28) {
                    if timelineItems.isEmpty {
                        EmptyChatThreadState()
                    } else {
                        ForEach(timelineItems) { item in
                            switch item {
                            case .message(let message):
                                MessageRow(message: message)
                                    .id(item.id)
                            case .activity(let activity):
                                ActivityRow(activity: activity)
                                    .id(item.id)
                            }
                        }
                    }

                    if let pendingApproval = viewModel.pendingApproval {
                        PendingApprovalBanner(approval: pendingApproval)
                    }

                    Color.clear
                        .frame(height: 8)
                        .id(bottomAnchor)
                }
                .padding(.horizontal, 18)
                .padding(.top, 12)
                .padding(.bottom, 28)
            }
            .scrollDismissesKeyboard(.interactively)
            .onAppear {
                scrollToBottom(with: proxy)
            }
            .onChange(of: scrollTrigger) { _, _ in
                scrollToBottom(with: proxy)
            }
        }
    }

    private func scrollToBottom(with proxy: ScrollViewProxy) {
        proxy.scrollTo(bottomAnchor, anchor: .bottom)
    }
}

private struct EmptyConversationState: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Spacer()

            Image(systemName: "sidebar.left")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(RemotePalette.tint)

            Text("Pick a project or chat")
                .font(.system(size: 30, weight: .bold, design: .rounded))

            Text("Browse projects in the sidebar, or start a new conversation to choose a project and write the first message before the thread is created.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(.horizontal, 24)
        .padding(.bottom, 120)
    }
}

private struct NewChatDraftStateView: View {
    @EnvironmentObject private var viewModel: AppViewModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Spacer()

            Image(systemName: "square.and.pencil")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(RemotePalette.tint)

            Text("New conversation")
                .font(.system(size: 30, weight: .bold, design: .rounded))

            Text("Choose a project here, then write the first message below. The thread will be created when you send it.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)

            if viewModel.projects.isEmpty {
                Text("No projects are available yet. Open a workspace on your Mac first.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.top, 4)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Project")
                        .font(.headline)

                    Picker(
                        "Project",
                        selection: Binding(
                            get: { viewModel.draftProjectId ?? viewModel.projects.first?.id ?? "" },
                            set: { newValue in
                                Task {
                                    await viewModel.updateDraftProject(projectId: newValue)
                                }
                            }
                        )
                    ) {
                        ForEach(viewModel.projects) { project in
                            Text(project.title).tag(project.id)
                        }
                    }
                    .pickerStyle(.menu)

                    if let draftProject = viewModel.draftProject {
                        Text(draftProject.cwd)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
                .padding(18)
                .frame(maxWidth: 420, alignment: .leading)
                .background(RemotePalette.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .padding(.horizontal, 24)
        .padding(.bottom, 120)
    }
}

private struct EmptyChatThreadState: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("No messages yet")
                .font(.headline)
            Text("Send the first message from your phone to continue this Codex thread.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RemotePalette.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

private struct PendingApprovalBanner: View {
    let approval: ApprovalRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)
                Text("Approval required")
                    .font(.headline)
            }

            Text(approval.summary)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(Color.orange.opacity(0.28), lineWidth: 1)
        )
    }
}

private struct MessageRow: View {
    @Environment(\.colorScheme) private var colorScheme

    let message: ChatMessage

    private var style: ChatSurfaceMessageStyle {
        ChatSurfaceMessageStyle.resolve(role: message.role)
    }

    private var copyPlacement: ChatMessageCopyPlacement {
        ChatMessageCopyPlacement.resolve(role: message.role)
    }

    var body: some View {
        Group {
            switch style {
            case .userBubble:
                HStack {
                    Spacer(minLength: 44)

                    VStack(alignment: .trailing, spacing: 6) {
                        Text(message.text)
                            .font(.body)
                            .foregroundStyle(RemotePalette.userText)
                            .multilineTextAlignment(.leading)
                            .padding(.horizontal, 18)
                            .padding(.vertical, 14)
                            .background(RemotePalette.userBubble, in: RoundedRectangle(cornerRadius: 28, style: .continuous))
                            .frame(maxWidth: 320, alignment: .trailing)

                        MessageCopyButton(
                            text: message.text,
                            placement: copyPlacement
                        )
                        .frame(maxWidth: 320, alignment: .trailing)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)

            case .assistantFullWidth:
                if message.phase == "final_answer" {
                    FinalAnswerMessageRow(
                        message: message,
                        colorScheme: colorScheme
                    )
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(message.text)
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.leading)
                            .lineSpacing(5)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)

                        MessageCopyButton(
                            text: message.text,
                            placement: copyPlacement
                        )
                    }
                }
            }
        }
    }
}

private struct MessageCopyButton: View {
    let text: String
    let placement: ChatMessageCopyPlacement

    @State private var didCopy = false
    @State private var resetTask: Task<Void, Never>?

    private var frameAlignment: Alignment {
        placement == .leading ? .leading : .trailing
    }

    var body: some View {
        if canCopyChatMessageText(text) {
            Button {
                handleCopy()
            } label: {
                Image(systemName: didCopy ? "doc.on.doc.fill" : "doc.on.doc")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(didCopy ? RemotePalette.tint : .secondary)
                    .frame(width: 28, height: 28)
                    .background(
                        Circle()
                            .fill(didCopy ? RemotePalette.tint.opacity(0.14) : Color.clear)
                    )
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity, alignment: frameAlignment)
            .accessibilityLabel("Copy message")
            .accessibilityHint("Copies this message to the clipboard.")
            .onDisappear {
                resetTask?.cancel()
                resetTask = nil
            }
        }
    }

    private func handleCopy() {
        ChatMessageCopyPerformer.live.perform(text: text)

        resetTask?.cancel()
        withAnimation(.easeInOut(duration: ChatMessageCopyFeedback.animationDurationSeconds)) {
            didCopy = true
        }

        resetTask = Task {
            try? await Task.sleep(for: .seconds(ChatMessageCopyFeedback.flashDurationSeconds))
            await MainActor.run {
                withAnimation(.easeInOut(duration: ChatMessageCopyFeedback.animationDurationSeconds)) {
                    didCopy = false
                }
            }
        }
    }
}

private struct FinalAnswerMessageRow: View {
    let message: ChatMessage
    let colorScheme: ColorScheme

    private var blocks: [FinalAnswerBlock] {
        parseFinalAnswerBlocks(message.text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let workedDurationSeconds = message.workedDurationSeconds, workedDurationSeconds > 0 {
                WorkedDurationDivider(text: "Worked for \(formatWorkedDuration(workedDurationSeconds))")
            }

            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let text):
                    Text(text)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(colorScheme == .dark ? .white : .black)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)

                case .paragraph(let text):
                    Text(buildMarkdownAttributedText(text, colorScheme: colorScheme))
                        .multilineTextAlignment(.leading)
                        .lineSpacing(7)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)

                case .bulletList(let items):
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                            HStack(alignment: .top, spacing: 10) {
                                Text("•")
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundStyle(colorScheme == .dark ? .white : .black)
                                Text(buildMarkdownAttributedText(item, colorScheme: colorScheme))
                                    .multilineTextAlignment(.leading)
                                    .lineSpacing(7)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .textSelection(.enabled)
                            }
                        }
                    }

                case .numberedList(let items):
                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                            HStack(alignment: .top, spacing: 10) {
                                Text("\(index + 1).")
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundStyle(colorScheme == .dark ? .white : .black)
                                Text(buildMarkdownAttributedText(item, colorScheme: colorScheme))
                                    .multilineTextAlignment(.leading)
                                    .lineSpacing(7)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .textSelection(.enabled)
                            }
                        }
                    }

                case .codeBlock(let code):
                    Text(code)
                        .font(.system(size: 15, weight: .medium, design: .monospaced))
                        .foregroundStyle(colorScheme == .dark ? .white : .black)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RemotePalette.inlineCodeFill(for: colorScheme), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .textSelection(.enabled)
                }
            }

            MessageCopyButton(
                text: message.text,
                placement: .leading
            )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct WorkedDurationDivider: View {
    let text: String

    var body: some View {
        HStack(spacing: 14) {
            Rectangle()
                .fill(RemotePalette.border)
                .frame(height: 1)

            Text(text)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
                .fixedSize()

            Rectangle()
                .fill(RemotePalette.border)
                .frame(height: 1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

func resolvedFileEditDisplayPath(for activity: ChatActivity) -> String {
    guard let filePath = activity.filePath, !filePath.isEmpty else {
        return activity.detail ?? "Updated file"
    }

    return filePath
}

func resolvedFileEditDisplayName(for activity: ChatActivity) -> String {
    (resolvedFileEditDisplayPath(for: activity) as NSString).lastPathComponent
}

private struct ActivityRow: View {
    let activity: ChatActivity

    var body: some View {
        Group {
            if activity.kind == .fileEdited {
                FileEditActivityRow(activity: activity)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ActivityStatusLine(activity: activity)

                    if let detail = activity.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.system(size: 16))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if let commandPreview = activity.commandPreview, !commandPreview.isEmpty {
                        Text(commandPreview)
                            .font(.system(size: 14, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct FileEditActivityRow: View {
    @Environment(\.colorScheme) private var colorScheme

    let activity: ChatActivity

    private var displayPath: String {
        resolvedFileEditDisplayPath(for: activity)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Edited")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.secondary)

                FileEditCounts(activity: activity)
            }

            Text(displayPath)
                .font(.system(size: 16, weight: .medium))
                .foregroundStyle(RemotePalette.linkColor(for: colorScheme))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct FileEditCounts: View {
    let activity: ChatActivity

    var body: some View {
        HStack(spacing: 8) {
            if let additions = activity.additions {
                Text("+\(additions)")
                    .font(.system(size: 15, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.green)
            }

            if let deletions = activity.deletions {
                Text("-\(deletions)")
                    .font(.system(size: 15, weight: .semibold, design: .monospaced))
                    .foregroundStyle(Color.red)
            }
        }
    }
}

private struct ActivityStatusLine: View {
    let activity: ChatActivity

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(activity.title)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)
                .lineLimit(2)

            if activity.state == .inProgress {
                Capsule(style: .continuous)
                    .fill(RemotePalette.tint.opacity(0.22))
                    .frame(width: 96, height: 3)
                    .overlay(alignment: .leading) {
                        Capsule(style: .continuous)
                            .fill(RemotePalette.tint)
                            .frame(width: 42, height: 3)
                    }
                .frame(height: 3)
                .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ComposerAttachmentButton: View {
    let isEnabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(.system(size: ComposerLayout.attachmentIconSize, weight: .medium))
                .foregroundStyle(.primary)
                .frame(width: ComposerLayout.attachmentButtonDiameter, height: ComposerLayout.attachmentButtonDiameter)
                .background(RemotePalette.toolbarButton, in: Circle())
                .opacity(isEnabled ? 1 : 0.55)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
    }
}

private struct ComposerSendButton: View {
    let canSend: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.up")
                .font(.system(size: ComposerLayout.sendIconSize, weight: .bold))
                .foregroundStyle(canSend ? .white : Color.secondary.opacity(0.7))
                .frame(width: ComposerLayout.primaryActionButtonDiameter, height: ComposerLayout.primaryActionButtonDiameter)
                .background(canSend ? RemotePalette.tint : RemotePalette.toolbarButton, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
    }
}

private struct ComposerStopButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "stop.fill")
                .font(.system(size: ComposerLayout.stopIconSize, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: ComposerLayout.primaryActionButtonDiameter, height: ComposerLayout.primaryActionButtonDiameter)
                .background(RemotePalette.tint, in: Circle())
        }
        .buttonStyle(.plain)
    }
}

private struct ComposerSteerButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text("Steer")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(RemotePalette.tint)
                .padding(.horizontal, 12)
                .frame(height: 36)
                .background(RemotePalette.toolbarButton, in: Capsule())
        }
        .buttonStyle(.plain)
    }
}

private struct ComposerMicButton: View {
    let isActive: Bool
    let isBusy: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: isBusy ? "hourglass" : (isActive ? "waveform" : "mic.fill"))
                .font(.system(size: ComposerLayout.micIconSize, weight: .semibold))
                .foregroundStyle(isActive ? RemotePalette.tint : .secondary)
                .frame(width: ComposerLayout.micTapTargetSize, height: ComposerLayout.micTapTargetSize)
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
    }
}

private struct DictationStatusWaveform: View {
    let date: Date

    var body: some View {
        HStack(alignment: .center, spacing: 4) {
            ForEach(0..<5, id: \.self) { index in
                Capsule(style: .continuous)
                    .fill(index == 2 ? RemotePalette.tint : RemotePalette.tint.opacity(0.42))
                    .frame(width: 4, height: waveHeight(for: index))
            }
        }
        .frame(width: 40, height: 28)
    }

    private func waveHeight(for index: Int) -> CGFloat {
        let phase = date.timeIntervalSinceReferenceDate * 4.6 + Double(index) * 0.7
        let normalized = (sin(phase) + 1) * 0.5
        return 8 + normalized * 16
    }
}

private struct DictationComposerStatusView: View {
    let isTranscribing: Bool
    let startedAt: Date?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.2)) { context in
            HStack(spacing: 12) {
                if isTranscribing {
                    ProgressView()
                        .tint(RemotePalette.tint)
                        .controlSize(.small)
                        .frame(width: 40, height: 28)
                } else {
                    DictationStatusWaveform(date: context.date)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(resolveDictationStatusTitle(
                        isTranscribing: isTranscribing,
                        startedAt: startedAt,
                        now: context.date
                    ))
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)

                    Text(resolveDictationStatusSubtitle(isTranscribing: isTranscribing))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }

                Spacer(minLength: 0)
            }
            .padding(.vertical, 6)
        }
    }
}

private struct ComposerAttachmentChip: View {
    let attachment: ComposerAttachment
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: attachment.kind.iconName)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(RemotePalette.tint)

            Text(attachment.displayName)
                .font(.system(size: 13, weight: .medium))
                .lineLimit(1)

            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(RemotePalette.card, in: Capsule())
        .overlay(
            Capsule()
                .stroke(RemotePalette.border, lineWidth: 1)
        )
    }
}

private struct ComposerDock: View {
    @EnvironmentObject private var viewModel: AppViewModel
    @Environment(\.colorScheme) private var colorScheme

    let isCompact: Bool
    @FocusState.Binding var composerFocused: Bool
    @State private var isAttachmentMenuPresented = false
    @State private var isPhotoPickerPresented = false
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var isFileImporterPresented = false
    @State private var isKeyboardDismissDragActive = false
    @State private var composerMeasuredHeight: CGFloat = ComposerLayout.minEditorHeight

    private var showsDictationStatus: Bool {
        viewModel.isDictating || viewModel.isTranscribingDictation
    }

    private var hasDraft: Bool {
        let hasText = !viewModel.composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return hasText || !viewModel.composerAttachments.isEmpty
    }

    private var canSend: Bool {
        viewModel.canComposeInCurrentContext && hasDraft
    }

    private var primaryActionMode: ComposerPrimaryActionMode {
        resolveComposerPrimaryActionMode(
            hasSelectedChat: viewModel.selectedChatId != nil,
            hasDraft: hasDraft,
            isRunActive: viewModel.selectedChatIsRunning
        )
    }

    private var composerSurfaceHeight: CGFloat {
        resolveComposerSurfaceHeight(
            measuredHeight: composerMeasuredHeight,
            showsDictationStatus: showsDictationStatus
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if viewModel.selectedChatHasQueuedFollowUp {
                Text("Queued for after this run")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
            }

            if !viewModel.composerAttachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(viewModel.composerAttachments) { attachment in
                            ComposerAttachmentChip(attachment: attachment) {
                                viewModel.removeComposerAttachment(id: attachment.id)
                            }
                        }
                    }
                }
            }

            HStack(
                alignment: resolveComposerOuterControlRowAlignment(
                    composerSurfaceHeight: composerSurfaceHeight,
                    showsDictationStatus: showsDictationStatus
                ),
                spacing: ComposerLayout.outerControlSpacing
            ) {
                ComposerAttachmentButton(isEnabled: viewModel.canComposeInCurrentContext) {
                    isAttachmentMenuPresented = true
                }
                .popover(
                    isPresented: $isAttachmentMenuPresented,
                    attachmentAnchor: .rect(.bounds),
                    arrowEdge: .bottom
                ) {
                    AttachmentPickerPopover(
                        choosePhotos: {
                            isAttachmentMenuPresented = false
                            isPhotoPickerPresented = true
                        },
                        chooseFiles: {
                            isAttachmentMenuPresented = false
                            isFileImporterPresented = true
                        }
                    )
                    .presentationCompactAdaptation(.popover)
                }

                HStack(alignment: .bottom, spacing: ComposerLayout.innerControlSpacing) {
                    ZStack(alignment: .topLeading) {
                        if showsDictationStatus {
                            DictationComposerStatusView(
                                isTranscribing: viewModel.isTranscribingDictation,
                                startedAt: viewModel.dictationStartedAt
                            )
                            .allowsHitTesting(false)
                        } else if viewModel.composerText.isEmpty {
                            Text(ChatSurfaceCopy.composerPrompt(
                                hasSelectedChat: viewModel.selectedChatId != nil,
                                isDraftingNewChat: viewModel.isNewChatDraftActive
                            ))
                                .font(.system(size: ComposerLayout.inputFontSize))
                                .foregroundStyle(.secondary)
                                .padding(.top, ComposerLayout.placeholderTopPadding)
                                .allowsHitTesting(false)
                        }

                        ComposerTextView(
                            text: $viewModel.composerText,
                            measuredHeight: $composerMeasuredHeight,
                            isFocused: Binding(
                                get: { composerFocused },
                                set: { composerFocused = $0 }
                            ),
                            maxHeight: ComposerLayout.maxEditorHeight
                        )
                        .opacity(showsDictationStatus ? 0.01 : 1)
                        .allowsHitTesting(!showsDictationStatus)
                        .accessibilityHidden(showsDictationStatus)
                    }
                    .frame(height: composerSurfaceHeight)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        guard viewModel.isDictating else {
                            return
                        }

                        composerFocused = false
                        dismissKeyboard()
                        Task {
                            await viewModel.toggleDictation()
                        }
                    }

                    ComposerMicButton(
                        isActive: viewModel.isDictating,
                        isBusy: viewModel.isTranscribingDictation
                    ) {
                        composerFocused = false
                        dismissKeyboard()
                        Task {
                            await viewModel.toggleDictation()
                        }
                    }
                    .frame(
                        height: composerSurfaceHeight,
                        alignment: resolveComposerAccessoryFrameAlignment(showsDictationStatus: showsDictationStatus)
                    )
                }
                .padding(.horizontal, ComposerLayout.composerHorizontalPadding)
                .padding(.vertical, ComposerLayout.composerVerticalPadding)
                .background(
                    RemotePalette.composerFill(for: colorScheme, isFocused: composerFocused),
                    in: RoundedRectangle(cornerRadius: ComposerLayout.cornerRadius, style: .continuous)
                )

                switch primaryActionMode {
                case .send:
                    if viewModel.selectedChatIsRunning && hasDraft {
                        ComposerSteerButton {
                            Task { await viewModel.steerMessage() }
                        }
                    }
                    ComposerSendButton(canSend: canSend) {
                        Task {
                            if viewModel.selectedChatIsRunning {
                                viewModel.queueMessage()
                            } else {
                                await viewModel.sendMessage()
                            }
                        }
                    }
                case .stop:
                    ComposerStopButton {
                        Task { await viewModel.stopSelectedTurn() }
                    }
                }
            }
        }
        .padding(.horizontal, isCompact ? 16 : 0)
        .padding(.top, 8)
        .padding(.bottom, isCompact ? 10 : 0)
        .background(RemotePalette.canvasColor(for: colorScheme))
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Color.primary.opacity(0.06))
                .frame(height: 1)
        }
        .contentShape(Rectangle())
        .simultaneousGesture(
            DragGesture(minimumDistance: 14, coordinateSpace: .local)
                .onChanged { value in
                    guard composerFocused else {
                        return
                    }

                    guard value.translation.height > 10,
                          value.translation.height > abs(value.translation.width)
                    else {
                        return
                    }

                    isKeyboardDismissDragActive = true
                }
                .onEnded { value in
                    defer { isKeyboardDismissDragActive = false }

                    guard composerFocused || isKeyboardDismissDragActive else {
                        return
                    }

                    guard value.translation.height > 28,
                          value.translation.height > abs(value.translation.width)
                    else {
                        return
                    }

                    composerFocused = false
                    dismissKeyboard()
                }
        )
        .photosPicker(
            isPresented: $isPhotoPickerPresented,
            selection: $selectedPhotoItems,
            maxSelectionCount: 5,
            matching: .images
        )
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            handleFileImport(result)
        }
        .onChange(of: selectedPhotoItems) { _, items in
            Task {
                await handleSelectedPhotos(items)
            }
        }
    }

    @MainActor
    private func handleFileImport(_ result: Result<[URL], Error>) {
        do {
            let urls = try result.get()
            for url in urls {
                try viewModel.addDocumentAttachment(from: url)
            }
        } catch {
            let nsError = error as NSError
            if nsError.domain == NSCocoaErrorDomain && nsError.code == NSUserCancelledError {
                return
            }

            viewModel.errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func handleSelectedPhotos(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        defer { selectedPhotoItems = [] }

        for (index, item) in items.enumerated() {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else {
                    continue
                }

                let fileExtension = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                let suggestedName = "Photo \(viewModel.composerAttachments.count + index + 1).\(fileExtension)"
                try viewModel.addImageAttachment(data: data, suggestedName: suggestedName)
            } catch {
                viewModel.errorMessage = error.localizedDescription
                return
            }
        }
    }
}

private struct AttachmentPickerPopover: View {
    let choosePhotos: () -> Void
    let chooseFiles: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button(action: choosePhotos) {
                Label("Choose Photos", systemImage: "photo.on.rectangle.angled")
                    .font(.system(size: 15, weight: .medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.plain)

            Divider()

            Button(action: chooseFiles) {
                Label("Choose Files", systemImage: "doc")
                    .font(.system(size: 15, weight: .medium))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.plain)
        }
        .frame(width: 190)
        .padding(6)
    }
}

private struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var measuredHeight: CGFloat
    @Binding var isFocused: Bool

    let maxHeight: CGFloat

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.delegate = context.coordinator
        textView.backgroundColor = .clear
        textView.font = UIFont.systemFont(ofSize: ComposerLayout.inputFontSize)
        textView.textColor = .label
        textView.isScrollEnabled = false
        textView.keyboardDismissMode = .interactive
        textView.textContainerInset = UIEdgeInsets(top: 4, left: 0, bottom: 4, right: 0)
        textView.textContainer.lineFragmentPadding = 0
        textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let dismissPan = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handleDismissPan(_:)))
        dismissPan.cancelsTouchesInView = false
        dismissPan.delegate = context.coordinator
        textView.addGestureRecognizer(dismissPan)

        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        if textView.text != text {
            textView.text = text
        }

        recalculateHeight(for: textView)
    }

    private func recalculateHeight(for textView: UITextView) {
        let fittingWidth = max(textView.bounds.width, 120)
        let targetSize = CGSize(width: fittingWidth, height: .greatestFiniteMagnitude)
        let fittingSize = textView.sizeThatFits(targetSize)
        let height = min(max(fittingSize.height, ComposerLayout.minEditorHeight), maxHeight)
        let shouldScroll = fittingSize.height > maxHeight + 0.5

        if textView.isScrollEnabled != shouldScroll {
            textView.isScrollEnabled = shouldScroll
        }

        if abs(measuredHeight - height) > 0.5 {
            DispatchQueue.main.async {
                measuredHeight = height
            }
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
        private let parent: ComposerTextView
        private var didTriggerDismissForCurrentPan = false

        init(_ parent: ComposerTextView) {
            self.parent = parent
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            parent.recalculateHeight(for: textView)
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            if !parent.isFocused {
                parent.isFocused = true
            }
            parent.recalculateHeight(for: textView)
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if parent.isFocused {
                parent.isFocused = false
            }
            parent.recalculateHeight(for: textView)
        }

        @objc func handleDismissPan(_ gesture: UIPanGestureRecognizer) {
            guard let textView = gesture.view as? UITextView else {
                return
            }

            let translation = gesture.translation(in: textView)

            switch gesture.state {
            case .began:
                didTriggerDismissForCurrentPan = false
            case .changed:
                guard textView.isFirstResponder, !didTriggerDismissForCurrentPan else {
                    return
                }

                guard translation.y > 18, translation.y > abs(translation.x) else {
                    return
                }

                didTriggerDismissForCurrentPan = true
                textView.resignFirstResponder()
                parent.isFocused = false
            case .ended, .cancelled, .failed:
                didTriggerDismissForCurrentPan = false
            default:
                break
            }
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            true
        }
    }
}

private func dismissKeyboard() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}

private struct StatusPill: View {
    let icon: String
    let text: String

    var body: some View {
        Label(text, systemImage: icon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.white.opacity(0.6), in: Capsule())
            .overlay(
                Capsule()
                    .stroke(RemotePalette.border, lineWidth: 1)
            )
    }
}

private struct SessionContextSheet: View {
    @EnvironmentObject private var viewModel: AppViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var isBranchSheetPresented = false
    @State private var isCommitSheetPresented = false
    @State private var isDiffSheetPresented = false
    @State private var didCopyDebugLog = false

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: false) {
                VStack(alignment: .leading, spacing: 18) {
                    ContextCard(title: "Runtime") {
                        ContextValueRow(label: "Mode", value: viewModel.runtimeModeLabel)
                        ContextValueRow(label: "Approvals", value: viewModel.approvalPolicyLabel)
                        ContextValueRow(label: "Sandbox", value: viewModel.sandboxModeLabel)
                        ContextValueRow(label: "Model", value: viewModel.selectedProjectContext?.model ?? "Unknown model")
                        ContextValueRow(label: "Reasoning", value: viewModel.selectedProjectContext?.modelReasoningEffort ?? "Unknown effort")
                        ContextValueRow(label: "Trust", value: viewModel.trustLevelLabel)

                        Divider()

                        SessionActionButton(title: "Change approvals", subtitle: viewModel.approvalPolicyLabel) {
                            Menu {
                                ForEach(approvalPolicyOptions, id: \.self) { option in
                                    Button(formatRuntimeValue(option)) {
                                        Task {
                                            await viewModel.updateRuntimeConfig(approvalPolicy: option)
                                        }
                                    }
                                }
                            } label: {
                                Label("Select", systemImage: "chevron.up.chevron.down")
                            }
                        }

                        SessionActionButton(title: "Change sandbox", subtitle: viewModel.sandboxModeLabel) {
                            Menu {
                                ForEach(sandboxModeOptions, id: \.self) { option in
                                    Button(formatRuntimeValue(option)) {
                                        Task {
                                            await viewModel.updateRuntimeConfig(sandboxMode: option)
                                        }
                                    }
                                }
                            } label: {
                                Label("Select", systemImage: "chevron.up.chevron.down")
                            }
                        }
                    }

                    ContextCard(title: "Project") {
                        ContextValueRow(label: "Workspace", value: viewModel.selectedProjectDisplayTitle)
                        ContextValueRow(label: "Path", value: viewModel.selectedProjectContext?.cwd ?? "No project selected")
                        ContextValueRow(label: "Connection", value: viewModel.connectionStatusLabel)
                    }

                    ContextCard(title: "Debug Log") {
                        ContextValueRow(label: "File", value: viewModel.debugLogFileName)
                        ContextValueRow(label: "Mac copy", value: viewModel.debugLogMacPathLabel)
                        ContextValueRow(label: "Mode", value: viewModel.debugLogModeLabel)
                        ContextValueRow(label: "Auto-send", value: viewModel.debugLogAutoSendStatusLabel)

                        if let debugLogVerboseUntilLabel = viewModel.debugLogVerboseUntilLabel {
                            ContextValueRow(label: "Verbose until", value: debugLogVerboseUntilLabel)
                        }

                        Text(viewModel.debugLogModeSummary)
                            .font(.footnote)
                            .foregroundStyle(.secondary)

                        Text(viewModel.debugLogAutoSendSummary)
                            .font(.footnote)
                            .foregroundStyle(.secondary)

                        Text(viewModel.debugLogPrivacySummary)
                            .font(.footnote)
                            .foregroundStyle(.secondary)

                        HStack(spacing: 12) {
                            Button("Use Basic") {
                                viewModel.useBasicDebugLogging()
                            }
                            .buttonStyle(.bordered)
                            .disabled(viewModel.debugLogMode == .basic)

                            Button("Verbose 30 min") {
                                viewModel.enableVerboseDebugLogging()
                            }
                            .buttonStyle(.borderedProminent)
                        }

                        Toggle(
                            "Auto-send changed logs to Mac after refresh",
                            isOn: Binding(
                                get: { viewModel.debugLogAutoSendEnabled },
                                set: { viewModel.setDebugLogAutoSendEnabled($0) }
                            )
                        )

                        HStack(spacing: 12) {
                            Button("Send to Mac") {
                                Task {
                                    await viewModel.uploadDebugLogToMac(force: true)
                                }
                            }
                            .buttonStyle(.borderedProminent)

                            ShareLink(item: viewModel.debugLogShareURL) {
                                Label("Export Log", systemImage: "square.and.arrow.up")
                            }
                            .buttonStyle(.bordered)

                            Button("Copy Log") {
                                viewModel.copyDebugLogToClipboard()
                                didCopyDebugLog = true
                            }
                            .buttonStyle(.bordered)

                            Button("Clear", role: .destructive) {
                                viewModel.clearDebugLog()
                                didCopyDebugLog = false
                            }
                            .buttonStyle(.bordered)
                        }

                        if didCopyDebugLog {
                            Text("Log copied to the clipboard.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }

                        if let debugLogSyncStatusMessage = viewModel.debugLogSyncStatusMessage {
                            Text(debugLogSyncStatusMessage)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }

                    ContextCard(title: "Git") {
                        if let git = viewModel.selectedProjectContext?.git, git.isRepository {
                            ContextValueRow(label: "Branch", value: git.branch ?? "HEAD")
                            ContextValueRow(label: "Changed files", value: String(git.changedFiles))
                            ContextValueRow(label: "Staged", value: String(git.stagedFiles))
                            ContextValueRow(label: "Unstaged", value: String(git.unstagedFiles))
                            ContextValueRow(label: "Untracked", value: String(git.untrackedFiles))

                            Divider()

                            SessionActionButton(title: "Switch branch", subtitle: git.branch ?? "HEAD") {
                                Button {
                                    Task {
                                        await viewModel.loadGitBranches()
                                        isBranchSheetPresented = true
                                    }
                                } label: {
                                    Label("Open", systemImage: "arrow.triangle.branch")
                                }
                            }

                            SessionActionButton(title: "View combined diff", subtitle: git.changedFiles == 0 ? "No changes" : "\(git.changedFiles) changed files") {
                                Button {
                                    Task {
                                        await viewModel.loadGitDiff(path: nil)
                                        isDiffSheetPresented = viewModel.currentGitDiff != nil
                                    }
                                } label: {
                                    Label("Open", systemImage: "doc.plaintext")
                                }
                                .disabled(git.changedFiles == 0)
                            }

                            SessionActionButton(title: "Commit staged changes", subtitle: git.stagedFiles == 0 ? "Nothing staged" : "\(git.stagedFiles) staged files") {
                                Button {
                                    isCommitSheetPresented = true
                                } label: {
                                    Label("Commit", systemImage: "checkmark.circle")
                                }
                                .disabled(git.stagedFiles == 0)
                            }

                            if git.changedPaths.isEmpty {
                                Text("No changed files.")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            } else {
                                VStack(alignment: .leading, spacing: 10) {
                                    ForEach(git.changedPaths.prefix(20)) { file in
                                        VStack(alignment: .leading, spacing: 4) {
                                            HStack(alignment: .top, spacing: 12) {
                                                VStack(alignment: .leading, spacing: 4) {
                                                    HStack(spacing: 8) {
                                                        Text(file.indexStatus + file.workingTreeStatus)
                                                            .font(.caption.monospaced())
                                                            .foregroundStyle(RemotePalette.tint)
                                                        Text(file.path)
                                                            .font(.subheadline.weight(.medium))
                                                            .lineLimit(2)
                                                    }
                                                }

                                                Spacer(minLength: 0)

                                                Button("Diff") {
                                                    Task {
                                                        await viewModel.loadGitDiff(path: file.path)
                                                        isDiffSheetPresented = viewModel.currentGitDiff != nil
                                                    }
                                                }
                                                .buttonStyle(.borderless)
                                                .font(.caption.weight(.semibold))
                                            }
                                        }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(12)
                                        .background(RemotePalette.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                                    }
                                }
                            }
                        } else {
                            Text("This project is not a Git repository.")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Button("Refresh Context") {
                        Task {
                            await viewModel.refreshSelectedProjectContext()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                }
                .padding(20)
            }
            .background(RemoteCanvasBackground())
            .navigationTitle("Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .sheet(isPresented: $isBranchSheetPresented) {
            BranchPickerSheet(isPresented: $isBranchSheetPresented)
                .environmentObject(viewModel)
        }
        .sheet(isPresented: $isDiffSheetPresented) {
            GitDiffSheet(isPresented: $isDiffSheetPresented)
                .environmentObject(viewModel)
        }
        .sheet(isPresented: $isCommitSheetPresented) {
            CommitSheet(isPresented: $isCommitSheetPresented)
                .environmentObject(viewModel)
        }
    }
}

private struct ContextCard<Content: View>: View {
    let title: String
    let content: Content

    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(.headline)

            content
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(RemotePalette.border, lineWidth: 1)
        )
    }
}

private struct ContextValueRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 92, alignment: .leading)

            Text(value)
                .font(.subheadline)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
    }
}

private struct SessionActionButton<Accessory: View>: View {
    let title: String
    let subtitle: String
    let accessory: Accessory

    init(title: String, subtitle: String, @ViewBuilder accessory: () -> Accessory) {
        self.title = title
        self.subtitle = subtitle
        self.accessory = accessory()
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)

            accessory
        }
        .padding(14)
        .background(RemotePalette.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

private struct BranchPickerSheet: View {
    @EnvironmentObject private var viewModel: AppViewModel
    @Binding var isPresented: Bool

    var body: some View {
        NavigationStack {
            List(viewModel.gitBranches) { branch in
                Button {
                    Task {
                        await viewModel.checkoutGitBranch(branch.name)
                        if viewModel.errorMessage == nil {
                            isPresented = false
                        }
                    }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: branch.isCurrent ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(branch.isCurrent ? RemotePalette.tint : .secondary)
                        Text(branch.name)
                            .foregroundStyle(.primary)
                        Spacer()
                    }
                }
            }
            .navigationTitle("Branches")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        isPresented = false
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct GitDiffSheet: View {
    @EnvironmentObject private var viewModel: AppViewModel
    @Binding var isPresented: Bool

    var body: some View {
        NavigationStack {
            ScrollView(showsIndicators: true) {
                Text(viewModel.currentGitDiff?.text ?? "No diff loaded.")
                    .font(.system(.footnote, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(20)
                    .textSelection(.enabled)
            }
            .background(Color(uiColor: .systemBackground))
            .navigationTitle(viewModel.currentGitDiff?.path ?? "Combined Diff")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        isPresented = false
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct CommitSheet: View {
    @EnvironmentObject private var viewModel: AppViewModel
    @Binding var isPresented: Bool
    @State private var message = ""

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("Git commit only includes staged files. Unstaged and untracked files stay untouched.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                TextField("Commit message", text: $message, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(2...4)

                Button("Commit staged changes") {
                    Task {
                        await viewModel.commitGitChanges(message: message)
                        if viewModel.errorMessage == nil {
                            isPresented = false
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Spacer()
            }
            .padding(20)
            .navigationTitle("Commit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        isPresented = false
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }
}

private func formatRuntimeValue(_ rawValue: String) -> String {
    rawValue
        .replacingOccurrences(of: "_", with: " ")
        .replacingOccurrences(of: "-", with: " ")
        .capitalized
}
