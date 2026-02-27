import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var viewModel: AppViewModel

    var body: some View {
        Group {
            if viewModel.isPaired {
                pairedLayout
            } else {
                PairingView()
            }
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

    private var pairedLayout: some View {
        NavigationSplitView {
            sidebar
        } detail: {
            chatPanel
        }
        .sheet(item: Binding(
            get: { viewModel.pendingApproval },
            set: { _ in }
        )) { approval in
            ApprovalSheet(approval: approval)
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Refresh") {
                    Task { await viewModel.refreshData() }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("New Chat") {
                        Task { await viewModel.startNewChat() }
                    }
                    Button("Unpair", role: .destructive) {
                        viewModel.unpair()
                    }
                } label: {
                    Label("Actions", systemImage: "ellipsis.circle")
                }
            }
        }
    }

    private var sidebar: some View {
        List {
            Section("Projects") {
                ForEach(viewModel.projects) { project in
                    Button {
                        viewModel.selectProject(project)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(project.title)
                                .font(.headline)
                            Text(project.cwd)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
            }

            Section("Chats") {
                ForEach(viewModel.chats) { chat in
                    Button {
                        viewModel.selectChat(chat)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(chat.title)
                                .font(.subheadline)
                            Text(chat.preview)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private var chatPanel: some View {
        VStack(spacing: 0) {
            if let selectedChatId = viewModel.selectedChatId {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(viewModel.messagesByChat[selectedChatId] ?? []) { message in
                            MessageBubble(message: message)
                        }
                    }
                    .padding()
                }
            } else {
                ContentUnavailableView("No Chat Selected", systemImage: "bubble.left.and.bubble.right")
            }

            Divider()

            HStack(spacing: 8) {
                TextField("Ask Codex to work on your project...", text: $viewModel.composerText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...4)

                Button("Send") {
                    Task { await viewModel.sendMessage() }
                }
                .buttonStyle(.borderedProminent)
            }
            .padding()
        }
    }
}

private struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(message.role.uppercased())
                .font(.caption2)
                .foregroundStyle(.secondary)

            Text(message.text)
                .padding(10)
                .background(message.role == "user" ? Color.blue.opacity(0.15) : Color.gray.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }
}
