import XCTest
import UniformTypeIdentifiers
import UIKit
@testable import CodexRemote

final class CodexRemoteTests: XCTestCase {
    func testJSONValueDecodesObject() throws {
        let json = """
        {
          "event": "message_delta",
          "chatId": "chat-1",
          "payload": {"delta": "hello"},
          "timestamp": 1
        }
        """.data(using: .utf8)!

        let envelope = try JSONDecoder().decode(StreamEventEnvelope.self, from: json)

        XCTAssertEqual(envelope.event, "message_delta")
        XCTAssertEqual(envelope.chatId, "chat-1")
    }

    func testInfoPlistAllowsCompanionTransport() throws {
        let testsFileURL = URL(fileURLWithPath: #filePath)
        let plistURL = testsFileURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/App/Info.plist")

        let plist = try XCTUnwrap(NSDictionary(contentsOf: plistURL) as? [String: Any])
        let ats = try XCTUnwrap(plist["NSAppTransportSecurity"] as? [String: Any])
        let allowsArbitraryLoads = try XCTUnwrap(ats["NSAllowsArbitraryLoads"] as? Bool)

        XCTAssertTrue(allowsArbitraryLoads)
    }

    func testInfoPlistProvidesLaunchScreenConfiguration() throws {
        let testsFileURL = URL(fileURLWithPath: #filePath)
        let plistURL = testsFileURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/App/Info.plist")

        let plist = try XCTUnwrap(NSDictionary(contentsOf: plistURL) as? [String: Any])
        let launchScreen = try XCTUnwrap(plist["UILaunchScreen"] as? [String: Any])

        XCTAssertEqual(launchScreen.count, 0)
    }

    func testInfoPlistProvidesMicrophoneUsageDescription() throws {
        let testsFileURL = URL(fileURLWithPath: #filePath)
        let plistURL = testsFileURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/App/Info.plist")

        let plist = try XCTUnwrap(NSDictionary(contentsOf: plistURL) as? [String: Any])
        let microphoneUsage = try XCTUnwrap(plist["NSMicrophoneUsageDescription"] as? String)

        XCTAssertFalse(microphoneUsage.isEmpty)
        XCTAssertNil(plist["NSSpeechRecognitionUsageDescription"])
    }

    func testInfoPlistProvidesPhotoLibraryUsageDescription() throws {
        let testsFileURL = URL(fileURLWithPath: #filePath)
        let plistURL = testsFileURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/App/Info.plist")

        let plist = try XCTUnwrap(NSDictionary(contentsOf: plistURL) as? [String: Any])
        let photoLibraryUsage = try XCTUnwrap(plist["NSPhotoLibraryUsageDescription"] as? String)

        XCTAssertFalse(photoLibraryUsage.isEmpty)
    }

    func testWebSocketURLIncludesOnlyChatQueryParameter() throws {
        let client = APIClient()

        let url = try XCTUnwrap(client.buildWebSocketURL(
            host: "100.64.0.2",
            port: 8787,
            chatId: "chat-123"
        ))
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))

        XCTAssertEqual(components.scheme, "ws")
        XCTAssertEqual(components.host, "100.64.0.2")
        XCTAssertEqual(components.port, 8787)
        XCTAssertTrue(components.queryItems?.contains(URLQueryItem(name: "chatId", value: "chat-123")) == true)
        XCTAssertEqual(components.queryItems?.count, 1)
    }

    func testChatThreadDecodesForNavigationSelection() throws {
        let json = """
        {
          "id": "chat-123",
          "projectId": "project-1",
          "title": "Current chat",
          "preview": "Preview text",
          "updatedAt": 123
        }
        """.data(using: .utf8)!

        let chat = try JSONDecoder().decode(ChatThread.self, from: json)

        XCTAssertEqual(chat.id, "chat-123")
        XCTAssertEqual(chat.title, "Current chat")
    }

    func testBuildComposerDraftPreviewIncludesAttachmentSummaries() {
        let preview = buildComposerDraftPreview(text: "Please inspect this", attachments: [
            ComposerAttachment(
                kind: .image,
                displayName: "photo.jpg",
                mimeType: "image/jpeg",
                payload: "data:image/jpeg;base64,AAA"
            ),
            ComposerAttachment(
                kind: .textFile,
                displayName: "notes.txt",
                mimeType: "text/plain",
                payload: "Hello"
            )
        ])

        XCTAssertEqual(
            preview,
            "Please inspect this\n\nAttached photo: photo.jpg\n\nAttached file: notes.txt"
        )
    }

    func testComposerDocumentImporterAcceptsCSVFiles() throws {
        let data = "name,value\nalpha,1\nbeta,2".data(using: .utf8)!
        let attachment = try ComposerDocumentImporter.buildAttachment(
            fileURL: URL(fileURLWithPath: "/tmp/report.csv"),
            data: data,
            contentType: UTType(filenameExtension: "csv")
        )

        XCTAssertEqual(attachment.kind, .textFile)
        XCTAssertEqual(attachment.displayName, "report.csv")
        XCTAssertTrue(attachment.mimeType.contains("csv") || attachment.mimeType.hasPrefix("text/"))
        XCTAssertTrue(attachment.payload.contains("alpha,1"))
    }

    func testComposerDocumentImporterExtractsTextFromPDF() throws {
        let pdfData = makePDFData(text: "Quarterly summary")
        let attachment = try ComposerDocumentImporter.buildAttachment(
            fileURL: URL(fileURLWithPath: "/tmp/summary.pdf"),
            data: pdfData,
            contentType: .pdf
        )

        XCTAssertEqual(attachment.kind, .textFile)
        XCTAssertEqual(attachment.displayName, "summary.pdf")
        XCTAssertEqual(attachment.mimeType, "application/pdf")
        XCTAssertTrue(attachment.payload.contains("Quarterly summary"))
    }

    func testSummarizeCommandActionsBuildsExplorationSummary() {
        let summary = summarizeCommandActions([
            .object(["type": .string("read")]),
            .object(["type": .string("listFiles")]),
            .object(["type": .string("search")]),
        ])

        XCTAssertEqual(summary.kind, .exploring)
        XCTAssertEqual(summary.detail, "2 files, 1 search")
    }

    func testBuildChatTimelinePlacesActivitiesBeforeMessagesAtSameTimestamp() {
        let timestamp = Date(timeIntervalSince1970: 42)
        let timeline = buildChatTimeline(
            messages: [
                ChatMessage(
                    id: "msg-1",
                    role: "assistant",
                    text: "Commentary text",
                    createdAt: timestamp,
                    phase: "commentary",
                    workedDurationSeconds: nil
                )
            ],
            activities: [
                ChatActivity(
                    id: "activity-1",
                    itemId: "activity-1",
                    kind: .thinking,
                    title: "Thinking",
                    detail: nil,
                    commandPreview: nil,
                    state: .inProgress,
                    createdAt: timestamp,
                    updatedAt: timestamp
                )
            ]
        )

        XCTAssertEqual(timeline.map(\.id), [
            "activity:activity-1",
            "message:msg-1",
        ])
    }

    func testRemoteChatTimelineDecodesEditedFileActivity() throws {
        let json = """
        {
          "data": {
            "messages": [],
            "activities": [
              {
                "id": "patch-1",
                "itemId": "patch-1",
                "kind": "file_edited",
                "title": "Edited",
                "detail": "ContentView.swift",
                "commandPreview": null,
                "createdAt": 1773016247,
                "updatedAt": 1773016247,
                "state": "completed",
                "filePath": "apps/ios/Sources/Views/ContentView.swift",
                "additions": 64,
                "deletions": 16
              }
            ]
          }
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(DataEnvelope<RemoteChatTimeline>.self, from: json)

        XCTAssertEqual(decoded.data.activities.first?.kind, .fileEdited)
        XCTAssertEqual(decoded.data.activities.first?.filePath, "apps/ios/Sources/Views/ContentView.swift")
        XCTAssertEqual(decoded.data.activities.first?.additions, 64)
        XCTAssertEqual(decoded.data.activities.first?.deletions, 16)
    }

    func testFileEditedActivityUsesEditedTitle() {
        XCTAssertEqual(ChatActivityKind.fileEdited.title(for: .completed), "Edited")
    }

    func testResolvedFileEditDisplayPathPrefersFilePath() {
        let activity = ChatActivity(
            id: "patch-1",
            itemId: "patch-1",
            kind: .fileEdited,
            title: "Edited",
            detail: "Fallback detail",
            commandPreview: nil,
            state: .completed,
            createdAt: Date(timeIntervalSince1970: 1),
            updatedAt: Date(timeIntervalSince1970: 1),
            filePath: "apps/ios/Sources/Views/ContentView.swift",
            additions: 12,
            deletions: 3
        )

        XCTAssertEqual(
            resolvedFileEditDisplayPath(for: activity),
            "apps/ios/Sources/Views/ContentView.swift"
        )
        XCTAssertEqual(resolvedFileEditDisplayName(for: activity), "ContentView.swift")
    }

    func testResolvedFileEditDisplayPathFallsBackToDetail() {
        let activity = ChatActivity(
            id: "patch-2",
            itemId: "patch-2",
            kind: .fileEdited,
            title: "Edited",
            detail: "README.md",
            commandPreview: nil,
            state: .completed,
            createdAt: Date(timeIntervalSince1970: 1),
            updatedAt: Date(timeIntervalSince1970: 1),
            filePath: nil,
            additions: 1,
            deletions: 1
        )

        XCTAssertEqual(resolvedFileEditDisplayPath(for: activity), "README.md")
        XCTAssertEqual(resolvedFileEditDisplayName(for: activity), "README.md")
    }

    func testTimelineDecodesContextCompactedAndBackgroundTerminalActivities() throws {
        let json = """
        {
          "data": {
            "messages": [],
            "activities": [
              {
                "id": "compact-1",
                "itemId": "compact-1",
                "kind": "context_compacted",
                "title": "Context automatically compacted",
                "detail": null,
                "commandPreview": null,
                "createdAt": 1773016248,
                "updatedAt": 1773016248,
                "state": "completed",
                "filePath": null,
                "additions": null,
                "deletions": null
              },
              {
                "id": "background-1",
                "itemId": "background-1",
                "kind": "background_terminal",
                "title": "Background terminal finished",
                "detail": "Exit code 0",
                "commandPreview": "xcodebuild build -project apps/ios/CodexRemote.xcodeproj",
                "createdAt": 1773016249,
                "updatedAt": 1773016249,
                "state": "completed",
                "filePath": null,
                "additions": null,
                "deletions": null
              }
            ]
          }
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(DataEnvelope<RemoteChatTimeline>.self, from: json)

        XCTAssertEqual(decoded.data.activities[0].kind, .contextCompacted)
        XCTAssertEqual(decoded.data.activities[1].kind, .backgroundTerminal)
        XCTAssertEqual(decoded.data.activities[1].commandPreview, "xcodebuild build -project apps/ios/CodexRemote.xcodeproj")
    }

    func testRemoteChatRunStateDecodesActiveTurn() throws {
        let json = """
        {
          "data": {
            "chatId": "chat-1",
            "isRunning": true,
            "activeTurnId": "turn-99"
          }
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(DataEnvelope<RemoteChatRunState>.self, from: json)

        XCTAssertEqual(decoded.data.chatId, "chat-1")
        XCTAssertEqual(decoded.data.isRunning, true)
        XCTAssertEqual(decoded.data.activeTurnId, "turn-99")
    }

    func testReconnectActivityUsesDesktopStyleTitle() {
        XCTAssertEqual(ChatActivityKind.reconnecting.title(for: .inProgress), "Reconnecting...")
    }

    func testFormatWorkedDurationMatchesDesktopStyle() {
        XCTAssertEqual(formatWorkedDuration(86), "1m 26s")
        XCTAssertEqual(formatWorkedDuration(7), "7s")
        XCTAssertEqual(formatWorkedDuration(3_905), "1h 5m 5s")
    }

    func testNormalizeFinalAnswerMarkdownPreservesParagraphAndListSpacing() {
        let markdown = """
        Das passt genau zu deinem Befund:
        waehrend des Schreibens sieht der Text okay aus
        nach dem finalen Render kleben Woerter zusammen

        Also:
        - Heading-Groessen flachmachen
        - Absatzumbrueche sauber machen
        - danach Inline-Code/Links abstaenden
        """

        XCTAssertEqual(
            normalizeFinalAnswerMarkdown(markdown),
            """
            Das passt genau zu deinem Befund: waehrend des Schreibens sieht der Text okay aus nach dem finalen Render kleben Woerter zusammen

            Also:

            • Heading-Groessen flachmachen

            • Absatzumbrueche sauber machen

            • danach Inline-Code/Links abstaenden
            """
        )
    }

    func testNormalizeInlineMarkdownSpacingAddsPaddingAroundCodeAndLinks() {
        let markdown = "nach:`Example Name``exampleuser`typischen [project.pbxproj:408](/tmp/project.pbxproj:408)project.pbxproj:409"

        XCTAssertEqual(
            normalizeInlineMarkdownSpacing(markdown),
            "nach: `Example Name` `exampleuser` typischen [project.pbxproj:408](/tmp/project.pbxproj:408) project.pbxproj:409"
        )
    }

    func testNormalizeInlineMarkdownSpacingKeepsPunctuationTight() {
        let markdown = "Value `CODE_SIGN_STYLE`."

        XCTAssertEqual(
            normalizeInlineMarkdownSpacing(markdown),
            "Value `CODE_SIGN_STYLE`."
        )
    }

    func testNormalizeHeadingMarkdownDemotesHeadingsToBoldParagraphs() {
        XCTAssertEqual(
            normalizeHeadingMarkdown("## Meine Empfehlung\nText"),
            "**Meine Empfehlung**\nText"
        )
    }

    func testNormalizeParagraphLineBreaksPreservesSpacesInsideParagraphs() {
        let markdown = """
        PNG
        schick mir den Pfad

        - Bullet one
        - Bullet two
        """

        XCTAssertEqual(
            normalizeParagraphLineBreaks(markdown),
            """
            PNG schick mir den Pfad

            - Bullet one
            - Bullet two
            """
        )
    }

    func testProjectContextDecodesGitMetadata() throws {
        let json = """
        {
          "data": {
            "projectId": "project-1",
            "cwd": "/tmp/project-1",
            "runtimeMode": "local",
            "approvalPolicy": "never",
            "sandboxMode": "workspace-write",
            "model": "gpt-5.4",
            "modelReasoningEffort": "xhigh",
            "trustLevel": "trusted",
            "git": {
              "isRepository": true,
              "branch": "main",
              "changedFiles": 2,
              "stagedFiles": 1,
              "unstagedFiles": 1,
              "untrackedFiles": 0,
              "changedPaths": [
                {
                  "path": "README.md",
                  "indexStatus": "M",
                  "workingTreeStatus": " "
                }
              ]
            }
          }
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(DataEnvelope<ProjectContext>.self, from: json)

        XCTAssertEqual(decoded.data.runtimeMode, "local")
        XCTAssertEqual(decoded.data.git.branch, "main")
        XCTAssertEqual(decoded.data.git.changedPaths.first?.path, "README.md")
    }

    func testGitBranchAndDiffDecodeForSessionControls() throws {
        let branchesJSON = """
        {
          "data": [
            { "name": "main", "isCurrent": true },
            { "name": "feature/mobile", "isCurrent": false }
          ]
        }
        """.data(using: .utf8)!

        let diffJSON = """
        {
          "data": {
            "path": "README.md",
            "text": "diff --git a/README.md b/README.md",
            "truncated": false,
            "untrackedPaths": []
          }
        }
        """.data(using: .utf8)!

        let branches = try JSONDecoder().decode(DataEnvelope<[GitBranch]>.self, from: branchesJSON)
        let diff = try JSONDecoder().decode(DataEnvelope<GitDiff>.self, from: diffJSON)

        XCTAssertEqual(branches.data.count, 2)
        XCTAssertEqual(branches.data.first?.name, "main")
        XCTAssertEqual(diff.data.path, "README.md")
        XCTAssertTrue(diff.data.text.contains("README.md"))
    }

    func testRuntimeConfigDecodesForEditableSessionValues() throws {
        let json = """
        {
          "data": {
            "approvalPolicy": "on-request",
            "sandboxMode": "danger-full-access",
            "model": "gpt-5.4",
            "modelReasoningEffort": "xhigh"
          }
        }
        """.data(using: .utf8)!

        let decoded = try JSONDecoder().decode(DataEnvelope<RuntimeConfig>.self, from: json)

        XCTAssertEqual(decoded.data.approvalPolicy, "on-request")
        XCTAssertEqual(decoded.data.sandboxMode, "danger-full-access")
    }

    @MainActor
    func testAssistantDeltasMergeIntoSingleMessageForSameStreamItem() {
        let viewModel = AppViewModel()

        viewModel.applyAssistantDelta(chatId: "chat-1", itemId: "item-1", delta: "Hel")
        viewModel.applyAssistantDelta(chatId: "chat-1", itemId: "item-1", delta: "lo")

        let messages = viewModel.messagesByChat["chat-1"] ?? []
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?.role, "assistant")
        XCTAssertEqual(messages.first?.text, "Hello")
    }

    @MainActor
    func testLoadedHistoryReplacesChatMessagesWithSavedThreadState() {
        let viewModel = AppViewModel()
        viewModel.applyAssistantDelta(chatId: "chat-1", itemId: "item-1", delta: "Temp")

        viewModel.applyLoadedMessages(chatId: "chat-1", messages: [
            RemoteChatMessage(
                id: "user-1",
                role: "user",
                text: "Saved prompt",
                createdAt: 1_773_016_247,
                phase: nil,
                workedDurationSeconds: nil
            ),
            RemoteChatMessage(
                id: "assistant-1",
                role: "assistant",
                text: "Saved answer",
                createdAt: 1_773_016_260,
                phase: "final_answer",
                workedDurationSeconds: 13
            )
        ])

        let messages = viewModel.messagesByChat["chat-1"] ?? []
        XCTAssertEqual(messages.count, 2)
        XCTAssertEqual(messages[0].id, "user-1")
        XCTAssertEqual(messages[0].text, "Saved prompt")
        XCTAssertEqual(messages[1].phase, "final_answer")
        XCTAssertEqual(messages[1].text, "Saved answer")
        XCTAssertEqual(messages[1].workedDurationSeconds, 13)
    }

    @MainActor
    func testLoadedChatsAreCachedPerProjectForSidebarFolders() {
        let viewModel = AppViewModel()
        viewModel.selectedProjectId = "project-1"

        viewModel.applyLoadedChats(projectId: "project-1", chats: [
            ChatThread(
                id: "chat-1",
                projectId: "project-1",
                title: "Folder chat",
                preview: "Preview",
                updatedAt: 1
            )
        ])

        XCTAssertTrue(viewModel.hasLoadedChats(for: "project-1"))
        XCTAssertEqual(viewModel.chatsForProject("project-1").count, 1)
        XCTAssertEqual(viewModel.chats.count, 1)
    }

    @MainActor
    func testSelectedChatResolvesFromCachedProjectFolders() {
        let viewModel = AppViewModel()
        viewModel.applyLoadedChats(projectId: "project-1", chats: [
            ChatThread(
                id: "chat-1",
                projectId: "project-1",
                title: "Folder chat",
                preview: "Preview",
                updatedAt: 1
            )
        ])
        viewModel.selectedChatId = "chat-1"

        XCTAssertEqual(viewModel.selectedChat?.title, "Folder chat")
    }

    func testSidebarProjectGroupsMergeDuplicateProjectTitles() {
        let groups = buildSidebarProjectGroups(
            projects: [
                Project(id: "project-1", cwd: "/tmp/one", title: "fludge", lastUpdatedAt: 10),
                Project(id: "project-2", cwd: "/tmp/two", title: "fludge", lastUpdatedAt: 20),
                Project(id: "project-3", cwd: "/tmp/three", title: "Codex Mobile App", lastUpdatedAt: 30)
            ],
            chatsByProjectId: [
                "project-1": [ChatThread(id: "chat-1", projectId: "project-1", title: "Older", preview: "", updatedAt: 11)],
                "project-2": [ChatThread(id: "chat-2", projectId: "project-2", title: "Newer", preview: "", updatedAt: 21)]
            ],
            selectedProjectId: nil
        )

        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups.first?.title, "Codex Mobile App")

        let fludgeGroup = groups.first(where: { $0.title == "fludge" })
        XCTAssertNotNil(fludgeGroup)
        XCTAssertEqual(fludgeGroup?.projectIDs.count, 2)
        XCTAssertEqual(fludgeGroup?.chats.map(\.id), ["chat-2", "chat-1"])
        XCTAssertEqual(fludgeGroup?.primaryProjectID, "project-2")
    }

    func testSidebarProjectGroupsPreferSelectedProjectAsPrimaryTarget() {
        let groups = buildSidebarProjectGroups(
            projects: [
                Project(id: "project-1", cwd: "/tmp/one", title: "fludge", lastUpdatedAt: 10),
                Project(id: "project-2", cwd: "/tmp/two", title: "fludge", lastUpdatedAt: 20)
            ],
            chatsByProjectId: [:],
            selectedProjectId: "project-1"
        )

        XCTAssertEqual(groups.first?.primaryProjectID, "project-1")
    }

    func testSidebarProjectHeaderActionSwitchesProjectsWhenAnotherGroupIsTapped() {
        let group = SidebarProjectGroupDescriptor(
            id: "cloud-computer-use",
            title: "Cloud Computer Use",
            projectIDs: ["project-2"],
            primaryProjectID: "project-2",
            latestUpdatedAt: 20,
            chats: []
        )

        XCTAssertEqual(
            resolveSidebarProjectHeaderAction(group: group, selectedProjectId: "project-1"),
            .switchProject(projectId: "project-2")
        )
    }

    func testSidebarProjectHeaderActionOnlyTogglesTheCurrentGroup() {
        let group = SidebarProjectGroupDescriptor(
            id: "thomasforschbach-com",
            title: "thomasforschbach.com",
            projectIDs: ["project-1", "project-3"],
            primaryProjectID: "project-1",
            latestUpdatedAt: 20,
            chats: []
        )

        XCTAssertEqual(
            resolveSidebarProjectHeaderAction(group: group, selectedProjectId: "project-3"),
            .toggleDisclosure
        )
    }

    func testChatTranscriptScrollTriggerChangesWhenChatChanges() {
        XCTAssertNotEqual(
            makeChatTranscriptScrollTrigger(chatId: "chat-1", lastTimelineItemId: "item-1"),
            makeChatTranscriptScrollTrigger(chatId: "chat-2", lastTimelineItemId: "item-1")
        )
    }

    func testChatTranscriptScrollTriggerChangesWhenTimelineTailChanges() {
        XCTAssertNotEqual(
            makeChatTranscriptScrollTrigger(chatId: "chat-1", lastTimelineItemId: "item-1"),
            makeChatTranscriptScrollTrigger(chatId: "chat-1", lastTimelineItemId: "item-2")
        )
    }

    func testHydratedChatStreamConnectsOnlyForSelectedChat() {
        XCTAssertTrue(shouldConnectHydratedChatStream(chatId: "chat-2", selectedChatId: "chat-2"))
        XCTAssertFalse(shouldConnectHydratedChatStream(chatId: "chat-2", selectedChatId: "chat-3"))
    }

    @MainActor
    func testSelectingProjectClearsStaleSelectedChat() {
        let viewModel = AppViewModel()
        viewModel.selectedChatId = "chat-1"

        viewModel.selectProject(Project(
            id: "project-2",
            cwd: "/tmp/project-2",
            title: "Project Two",
            lastUpdatedAt: 1
        ))

        XCTAssertEqual(viewModel.selectedProjectId, "project-2")
        XCTAssertNil(viewModel.selectedChatId)
    }

    @MainActor
    func testSelectionDisplayTitlesReflectCurrentProjectAndChat() {
        let viewModel = AppViewModel()
        viewModel.projects = [
            Project(
                id: "project-1",
                cwd: "/tmp/project-1",
                title: "Remote Control",
                lastUpdatedAt: 1
            )
        ]
        viewModel.chats = [
            ChatThread(
                id: "chat-1",
                projectId: "project-1",
                title: "Fix mobile shell",
                preview: "Latest thread",
                updatedAt: 1
            )
        ]
        viewModel.selectedProjectId = "project-1"
        viewModel.selectedChatId = "chat-1"

        XCTAssertEqual(viewModel.selectedProjectDisplayTitle, "Remote Control")
        XCTAssertEqual(viewModel.selectedChatDisplayTitle, "Fix mobile shell")
    }

    @MainActor
    func testSelectedChatDisplayTitlePrefersVisibleProjectChatsOverCachedCopies() {
        let viewModel = AppViewModel()
        viewModel.chats = [
            ChatThread(
                id: "chat-1",
                projectId: "project-1",
                title: "Fresh visible title",
                preview: "Visible thread",
                updatedAt: 2
            )
        ]
        viewModel.applyLoadedChats(projectId: "project-1", chats: [
            ChatThread(
                id: "chat-1",
                projectId: "project-1",
                title: "Stale cached title",
                preview: "Cached thread",
                updatedAt: 1
            )
        ])
        viewModel.chats = [
            ChatThread(
                id: "chat-1",
                projectId: "project-1",
                title: "Fresh visible title",
                preview: "Visible thread",
                updatedAt: 2
            )
        ]
        viewModel.selectedChatId = "chat-1"

        XCTAssertEqual(viewModel.selectedChatDisplayTitle, "Fresh visible title")
    }

    @MainActor
    func testConnectionStatusLabelChangesWhenApprovalIsPending() {
        let viewModel = AppViewModel()
        viewModel.host = "100.64.0.2"
        viewModel.token = "device-token"

        XCTAssertEqual(viewModel.connectionStatusLabel, "Live on your Mac")

        viewModel.pendingApproval = ApprovalRequest(
            id: "approval-1",
            kind: "command",
            summary: "Run a command",
            riskLevel: "medium",
            createdAt: 1
        )

        XCTAssertEqual(viewModel.connectionStatusLabel, "Approval required")
    }

    @MainActor
    func testLoadedProjectContextUpdatesSelectedProjectSummary() {
        let viewModel = AppViewModel()
        viewModel.selectedProjectId = "project-1"

        viewModel.applyLoadedProjectContext(projectId: "project-1", context: ProjectContext(
            projectId: "project-1",
            cwd: "/tmp/project-1",
            runtimeMode: "local",
            approvalPolicy: "never",
            sandboxMode: "workspace-write",
            model: "gpt-5.4",
            modelReasoningEffort: "xhigh",
            trustLevel: "trusted",
            git: GitContext(
                isRepository: true,
                branch: "main",
                changedFiles: 3,
                stagedFiles: 1,
                unstagedFiles: 1,
                untrackedFiles: 1,
                changedPaths: []
            )
        ))

        XCTAssertEqual(viewModel.runtimeModeLabel, "Local")
        XCTAssertEqual(viewModel.approvalPolicyLabel, "Never")
        XCTAssertEqual(viewModel.branchLabel, "main")
        XCTAssertEqual(viewModel.trustLevelLabel, "Trusted")
    }

    @MainActor
    func testMergingLoadedActivitiesKeepsReconnectStatusAndAddsPersistedDesktopCards() {
        let viewModel = AppViewModel()
        let now = Date(timeIntervalSince1970: 42)

        viewModel.activitiesByChat["chat-1"] = [
            ChatActivity(
                id: "stream-reconnect",
                itemId: "stream-reconnect",
                kind: .reconnecting,
                title: "Reconnecting...",
                detail: "2/5",
                commandPreview: nil,
                state: .inProgress,
                createdAt: now,
                updatedAt: now
            )
        ]

        viewModel.mergeLoadedActivities(chatId: "chat-1", activities: [
            RemoteChatActivity(
                id: "compact-1",
                itemId: "compact-1",
                kind: .contextCompacted,
                title: "Context automatically compacted",
                detail: nil,
                commandPreview: nil,
                createdAt: 43,
                updatedAt: 43,
                state: .completed,
                filePath: nil,
                additions: nil,
                deletions: nil
            ),
            RemoteChatActivity(
                id: "background-1",
                itemId: "background-1",
                kind: .backgroundTerminal,
                title: "Background terminal finished",
                detail: "Exit code 0",
                commandPreview: "xcodebuild build -project apps/ios/CodexRemote.xcodeproj",
                createdAt: 44,
                updatedAt: 44,
                state: .completed,
                filePath: nil,
                additions: nil,
                deletions: nil
            )
        ])

        let activities = viewModel.activitiesByChat["chat-1"] ?? []
        XCTAssertEqual(activities.map(\.kind), [.reconnecting, .contextCompacted, .backgroundTerminal])
        XCTAssertEqual(activities.first?.detail, "2/5")
        XCTAssertEqual(activities.last?.commandPreview, "xcodebuild build -project apps/ios/CodexRemote.xcodeproj")
    }

    @MainActor
    func testDictationPreviewMergesTranscriptIntoComposer() {
        let viewModel = AppViewModel()
        viewModel.composerText = "Please"

        viewModel.beginDictationPreview()
        viewModel.applyDictationPreview(transcript: "check the logs")

        XCTAssertEqual(viewModel.composerText, "Please check the logs")
        XCTAssertTrue(viewModel.isDictating)

        viewModel.finishDictationPreview()
        XCTAssertFalse(viewModel.isDictating)
    }

    @MainActor
    func testQueueMessageClearsComposerAndMarksQueuedState() {
        let viewModel = AppViewModel()
        viewModel.selectedChatId = "chat-1"
        viewModel.composerText = "Please keep going after this run"

        viewModel.queueMessage()

        XCTAssertEqual(viewModel.composerText, "")
        XCTAssertTrue(viewModel.selectedChatHasQueuedFollowUp)
    }

    func testChatSurfaceUsesBubbleOnlyForUserMessages() {
        XCTAssertEqual(ChatSurfaceMessageStyle.resolve(role: "user"), .userBubble)
        XCTAssertEqual(ChatSurfaceMessageStyle.resolve(role: "assistant"), .assistantFullWidth)
        XCTAssertEqual(ChatSurfaceMessageStyle.resolve(role: "system"), .assistantFullWidth)
    }

    func testChatSurfaceComposerPromptMatchesNewCompactLayout() {
        XCTAssertEqual(ChatSurfaceCopy.composerPrompt(hasSelectedChat: true), "What's next?")
        XCTAssertEqual(ChatSurfaceCopy.composerPrompt(hasSelectedChat: false), "Select a chat to continue...")
    }

    func testComposerPrimaryActionUsesStopOnlyForEmptyDraftDuringActiveRun() {
        XCTAssertEqual(
            resolveComposerPrimaryActionMode(
                hasSelectedChat: true,
                hasDraft: false,
                isRunActive: true
            ),
            .stop
        )
        XCTAssertEqual(
            resolveComposerPrimaryActionMode(
                hasSelectedChat: true,
                hasDraft: true,
                isRunActive: true
            ),
            .send
        )
        XCTAssertEqual(
            resolveComposerPrimaryActionMode(
                hasSelectedChat: true,
                hasDraft: false,
                isRunActive: false
            ),
            .send
        )
    }

    func testSidebarTimestampStaysCompactForRecentChats() {
        let now = Date().timeIntervalSince1970

        XCTAssertEqual(shortRelativeTimestamp(since: now - 90), "1m")
        XCTAssertEqual(shortRelativeTimestamp(since: now - 7_200), "2h")
        XCTAssertEqual(shortRelativeTimestamp(since: now - 172_800), "2d")
    }
}

private func makePDFData(text: String) -> Data {
    let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 320, height: 480))

    return renderer.pdfData { context in
        context.beginPage()

        let attributes: [NSAttributedString.Key: Any] = [
            .font: UIFont.systemFont(ofSize: 18, weight: .regular)
        ]

        NSString(string: text).draw(
            at: CGPoint(x: 24, y: 36),
            withAttributes: attributes
        )
    }
}
