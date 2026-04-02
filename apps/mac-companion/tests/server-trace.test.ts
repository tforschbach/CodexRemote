import { EventEmitter } from "node:events";
import { strict as assert } from "node:assert";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";

import { PairingStore } from "../src/pairing/pairing-store.js";
import { SessionState } from "../src/state/session-state.js";
import { TokenStore } from "../src/auth/token-store.js";
import { createCompanionServer } from "../src/http/server.js";
import { CompanionLogger } from "../src/logging/logger.js";
import type { AppConfig } from "../src/config.js";
import type { ChatHistoryStore } from "../src/history/rollout-history.js";
import type { ProjectContextStore } from "../src/context/project-context.js";
import { shortHash } from "../src/utils/hash.js";
import type { DesktopSyncBridge, DesktopSyncRequest, DesktopSyncResult } from "../src/desktop/live-sync.js";
import type { DictationTranscriptionInput, DictationTranscriptionResult, DictationTranscriptionService } from "../src/openai/transcription.js";
import type { ChatTimeline } from "@codex-remote/protocol";

class FakeCodexClient extends EventEmitter {
  public resumeCount = 0;
  public turnStartRequests: Array<Record<string, unknown>> = [];
  public turnSteerRequests: Array<Record<string, unknown>> = [];
  public turnInterruptRequests: Array<Record<string, unknown>> = [];
  public threadReadRequests: Array<Record<string, unknown>> = [];
  public activeThreadReadTurnId: string | null = null;
  public responses: Array<{ id: number | string; result: unknown }> = [];
  public threadListData: Array<Record<string, unknown>> = [
    {
      id: "chat-1",
      cwd: "/tmp/demo-project",
      preview: "hello",
      updatedAt: 123,
    },
  ];

  public async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method === "thread/list") {
      return {
        data: this.threadListData,
      };
    }

    if (method === "thread/resume") {
      this.resumeCount += 1;
      return { ok: true };
    }

    if (method === "thread/start") {
      return {
        thread: {
          id: "chat-new",
          cwd: typeof params?.cwd === "string" ? params.cwd : "/tmp/demo-project",
          preview: "new thread",
          updatedAt: 456,
        },
      };
    }

    if (method === "turn/start") {
      this.turnStartRequests.push((params ?? {}) as Record<string, unknown>);
      return {
        turn: {
          id: "turn-1",
        },
      };
    }

    if (method === "turn/steer") {
      this.turnSteerRequests.push((params ?? {}) as Record<string, unknown>);
      return {
        turnId: "turn-2",
      };
    }

    if (method === "turn/interrupt") {
      this.turnInterruptRequests.push((params ?? {}) as Record<string, unknown>);
      return {};
    }

    if (method === "thread/read") {
      this.threadReadRequests.push((params ?? {}) as Record<string, unknown>);
      return {
        thread: {
          status: this.activeThreadReadTurnId ? { type: "active" } : { type: "idle" },
          turns: this.activeThreadReadTurnId
            ? [{ id: this.activeThreadReadTurnId, status: "inProgress" }]
            : [],
        },
      };
    }

    throw new Error(`Unexpected method: ${method}`);
  }

  public respond(id: number | string, result: unknown): void {
    this.responses.push({ id, result });
  }
}

class FakeDesktopSyncBridge implements DesktopSyncBridge {
  public readonly calls: DesktopSyncRequest[] = [];

  public async syncChat(input: DesktopSyncRequest): Promise<DesktopSyncResult> {
    this.calls.push(input);
    return {
      attempted: true,
      refreshed: true,
      workspaceOpened: Boolean(input.cwd),
      errors: [],
    };
  }
}

class TimeoutDesktopSyncBridge implements DesktopSyncBridge {
  public readonly calls: DesktopSyncRequest[] = [];

  public async syncChat(input: DesktopSyncRequest): Promise<DesktopSyncResult> {
    this.calls.push(input);
    return {
      attempted: true,
      refreshed: false,
      workspaceOpened: false,
      errors: ["activate app failed: Command timed out after 5000 milliseconds"],
    };
  }
}

class FakeTranscriptionService implements DictationTranscriptionService {
  public readonly calls: DictationTranscriptionInput[] = [];

  public async transcribe(input: DictationTranscriptionInput): Promise<DictationTranscriptionResult> {
    this.calls.push(input);
    return {
      text: "Transcribed mobile dictation",
      model: "gpt-4o-transcribe",
    };
  }
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.off("open", handleOpen);
      socket.off("error", handleError);
    };

    const handleOpen = () => {
      cleanup();
      resolve();
    };

    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.once("open", handleOpen);
    socket.once("error", handleError);
  });
}

async function waitForSocketMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const cleanup = () => {
      socket.off("message", handleMessage);
      socket.off("error", handleError);
    };

    const handleMessage = (data: unknown) => {
      cleanup();
      try {
        const text = typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : Array.isArray(data)
              ? Buffer.concat(data).toString("utf8")
              : Buffer.from(data as ArrayBufferLike).toString("utf8");
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    };

    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.once("message", handleMessage);
    socket.once("error", handleError);
  });
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Condition was not met before timeout.");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function buildNestedObject(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let current: Record<string, unknown> = leaf;
  for (let index = 0; index < depth; index += 1) {
    current = { nested: current };
  }
  return current;
}

function buildTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    pairingTtlSeconds: 60,
    pairingConfirmTimeoutSeconds: 30,
    codexCommand: "codex",
    codexStartTimeoutMs: 15_000,
    codexHomePath: "/tmp/.codex",
    codexSessionsPath: "/tmp/.codex/sessions",
    tailscaleHost: "100.64.0.2",
    tokenStorePath: "/tmp/devices.json",
    tlsKeyPath: undefined,
    tlsCertPath: undefined,
    traceLogPath: "/tmp/companion.ndjson",
    traceLogLevel: "debug",
    enableDebugEndpoints: false,
    desktopSyncEnabled: false,
    desktopSyncReloadDelayMs: 250,
    desktopSyncCommandTimeoutMs: 5_000,
    codexMacAppName: "Codex",
    codexMacAppPath: undefined,
    codexMacBundleId: "com.openai.codex",
    openaiApiKey: undefined,
    openaiBaseUrl: "https://api.openai.com/v1",
    openaiTranscriptionModel: "gpt-4o-transcribe",
    ...overrides,
  };
}

class LaggyThreadListCodexClient extends EventEmitter {
  public async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (method === "thread/list") {
      return {
        data: [
          {
            id: "chat-1",
            cwd: "/tmp/demo-project",
            preview: "hello",
            updatedAt: 123,
          },
        ],
      };
    }

    if (method === "thread/start") {
      return {
        thread: {
          id: "chat-new",
          cwd: typeof params?.cwd === "string" ? params.cwd : "/tmp/new-project",
          preview: "new thread",
          updatedAt: 456,
        },
      };
    }

    if (method === "thread/resume") {
      return { ok: true };
    }

    throw new Error(`Unexpected method: ${method}`);
  }

  public respond(): void {
    // No-op for this test.
  }
}

class FakeHistoryStore implements ChatHistoryStore {
  public async loadMessages(chatId: string) {
    return (await this.loadTimeline(chatId)).messages;
  }

  public async loadTimeline(chatId: string): Promise<ChatTimeline> {
    return {
      messages: [
        {
          id: `${chatId}:user:1`,
          role: "user" as const,
          text: "Saved user prompt",
          createdAt: 1_773_016_247,
        },
        {
          id: `${chatId}:assistant:commentary`,
          role: "assistant" as const,
          text: "Checking the saved rollout.",
          createdAt: 1_773_016_251,
          phase: "commentary" as const,
        },
        {
          id: `${chatId}:assistant:2`,
          role: "assistant" as const,
          text: "Saved assistant answer",
          createdAt: 1_773_016_260,
          phase: "final_answer" as const,
          workedDurationSeconds: 13,
        },
      ],
      activities: [
        {
          id: `${chatId}:patch:1`,
          itemId: `${chatId}:patch:1`,
          kind: "file_edited",
          title: "Edited",
          detail: "ContentView.swift",
          createdAt: 1_773_016_255,
          updatedAt: 1_773_016_255,
          state: "completed",
          filePath: "apps/ios/Sources/Views/ContentView.swift",
          additions: 64,
          deletions: 16,
        },
        {
          id: `${chatId}:compacted:1`,
          itemId: `${chatId}:compacted:1`,
          kind: "context_compacted",
          title: "Context automatically compacted",
          createdAt: 1_773_016_256,
          updatedAt: 1_773_016_256,
          state: "completed",
        },
        {
          id: `${chatId}:background:1`,
          itemId: `${chatId}:background:1`,
          kind: "background_terminal",
          title: "Background terminal finished",
          detail: "Exit code 0",
          commandPreview: "xcodebuild build -project apps/ios/CodexRemote.xcodeproj",
          createdAt: 1_773_016_257,
          updatedAt: 1_773_016_257,
          state: "completed",
        },
      ],
    };
  }
}

class FakeProjectContextStore implements ProjectContextStore {
  public lastCheckoutBranch: string | null = null;
  public lastCommitMessage: string | null = null;
  public lastRuntimeConfigUpdate: { approvalPolicy?: string; sandboxMode?: string } | null = null;

  public async loadProjectContext(input: { projectId: string; cwd: string }) {
    return {
      projectId: input.projectId,
      cwd: input.cwd,
      runtimeMode: "local" as const,
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      model: "gpt-5.4",
      modelReasoningEffort: "xhigh",
      trustLevel: "trusted",
      git: {
        isRepository: true,
        branch: "main",
        changedFiles: 2,
        stagedFiles: 1,
        unstagedFiles: 1,
        untrackedFiles: 0,
        changedPaths: [
          {
            path: "README.md",
            indexStatus: "M",
            workingTreeStatus: " ",
          },
          {
            path: "apps/ios/Sources/Views/ContentView.swift",
            indexStatus: " ",
            workingTreeStatus: "M",
          },
        ],
      },
    };
  }

  public async loadGitBranches() {
    return [
      { name: "main", isCurrent: true },
      { name: "feature/mobile", isCurrent: false },
    ];
  }

  public async loadGitDiff(input: { path?: string }) {
    return {
      path: input.path ?? null,
      text: input.path ? `diff --git a/${input.path} b/${input.path}` : "## Combined diff",
      truncated: false,
      untrackedPaths: input.path ? [] : ["notes.md"],
    };
  }

  public async checkoutGitBranch(input: { branch: string }) {
    this.lastCheckoutBranch = input.branch;
    return {
      isRepository: true,
      branch: input.branch,
      changedFiles: 0,
      stagedFiles: 0,
      unstagedFiles: 0,
      untrackedFiles: 0,
      changedPaths: [],
    };
  }

  public async commitGitChanges(input: { message: string }) {
    this.lastCommitMessage = input.message;
    return {
      branch: "main",
      commitHash: "abc123",
      summary: input.message,
    };
  }

  public async updateRuntimeConfig(input: { approvalPolicy?: string; sandboxMode?: string }) {
    this.lastRuntimeConfigUpdate = input;
    return {
      approvalPolicy: input.approvalPolicy ?? "never",
      sandboxMode: input.sandboxMode ?? "workspace-write",
      model: "gpt-5.4",
      modelReasoningEffort: "xhigh",
    };
  }
}

test("createCompanionServer logs request trace ids for authenticated routes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-trace-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Trace Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new FakeCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/projects`, {
    headers: {
      authorization: `Bearer ${issued.token}`,
      "x-codex-trace-id": "trace-test-123",
    },
  });

  assert.equal(response.status, 200);
  await server.close();
  await logger.flush();

  const lines = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  const started = lines.find((line) => line.event === "request_started");
  const completed = lines.find((line) => line.event === "request_completed");
  const loaded = lines.find((line) => line.event === "projects_loaded");

  assert.equal(started?.traceId, "trace-test-123");
  assert.equal(completed?.traceId, "trace-test-123");
  assert.equal(loaded?.traceId, "trace-test-123");
  assert.equal(completed?.statusCode, 200);
});

test("createCompanionServer can issue local debug tokens when debug endpoints are enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-debug-token-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();

  const logger = new CompanionLogger(logPath, "debug");
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
      enableDebugEndpoints: true,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new FakeCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const debugResponse = await fetch(`http://127.0.0.1:${address.port}/v1/debug/issue-token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-trace-id": "trace-debug-token-1",
    },
    body: JSON.stringify({ deviceName: "Loop Device" }),
  });

  assert.equal(debugResponse.status, 200);
  const issued = await debugResponse.json() as { token: string; deviceId: string };
  assert.ok(issued.token);
  assert.ok(issued.deviceId);

  const authedResponse = await fetch(`http://127.0.0.1:${address.port}/v1/projects`, {
    headers: {
      authorization: `Bearer ${issued.token}`,
      "x-codex-trace-id": "trace-debug-token-2",
    },
  });

  assert.equal(authedResponse.status, 200);
  await server.close();
});

test("createCompanionServer includes the transport scheme in pairing responses", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-pairing-scheme-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();

  const logger = new CompanionLogger(logPath, "debug");
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new FakeCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const pairingResponse = await fetch(`http://127.0.0.1:${address.port}/v1/pairing/request`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: "{}",
  });

  assert.equal(pairingResponse.status, 200);
  const payload = await pairingResponse.json() as {
    scheme: string;
    pairingUri: string;
  };
  assert.equal(payload.scheme, "http");
  assert.match(payload.pairingUri, /[?&]scheme=http(?:&|$)/);

  await server.close();
});

test("createCompanionServer stores uploaded iPhone debug logs in the local logs folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-ios-log-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "iPhone Debug Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new FakeCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/debug/ios-log`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${issued.token}`,
      "content-type": "application/json",
      "x-codex-trace-id": "trace-ios-log-1",
    },
    body: JSON.stringify({
      contents: "{\"event\":\"freeze_detected\"}\n{\"event\":\"memory_warning\"}",
    }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as { data: { path: string; bytes: number } };
  assert.equal(payload.data.path, "logs/ios-device.ndjson");
  assert.ok(payload.data.bytes > 0);

  await server.close();
  await logger.flush();

  const uploadedLog = await readFile(join(dir, "ios-device.ndjson"), "utf8");
  assert.match(uploadedLog, /freeze_detected/);
  assert.match(uploadedLog, /memory_warning/);

  const traceLog = await readFile(logPath, "utf8");
  assert.match(traceLog, /ios_debug_log_uploaded/);
});

test("createCompanionServer activates a chat only once per companion session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-activate-chat-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Activate Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const codexClient = new FakeCodexClient();
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient,
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const headers = {
    authorization: `Bearer ${issued.token}`,
    "content-type": "application/json",
  };

  const firstResponse = await fetch(`http://127.0.0.1:${address.port}/v1/chats/chat-1/activate`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  const firstBody = await firstResponse.json() as { data: { status: string } };

  const secondResponse = await fetch(`http://127.0.0.1:${address.port}/v1/chats/chat-1/activate`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  const secondBody = await secondResponse.json() as { data: { status: string } };

  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(firstBody.data.status, "resumed");
  assert.equal(secondBody.data.status, "already_active");
  assert.equal(codexClient.resumeCount, 1);

  await server.close();
});

test("createCompanionServer keeps the known sidebar title when syncing an existing chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-desktop-sync-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Desktop Sync Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const desktopSync = new FakeDesktopSyncBridge();
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
      desktopSyncEnabled: true,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new FakeCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
    desktopSync,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const projectId = shortHash("/tmp/demo-project");
  const headers = {
    authorization: `Bearer ${issued.token}`,
    "content-type": "application/json",
  };

  try {
    const chatsResponse = await fetch(`http://127.0.0.1:${address.port}/v1/chats?projectId=${projectId}`, {
      headers,
    });
    assert.equal(chatsResponse.status, 200);

    const activateResponse = await fetch(`http://127.0.0.1:${address.port}/v1/chats/chat-1/activate`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(activateResponse.status, 200);

    const messageResponse = await fetch(`http://127.0.0.1:${address.port}/v1/chats/chat-1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "Hello from mobile" }),
    });
    assert.equal(messageResponse.status, 202);

    assert.equal(desktopSync.calls.length, 2);
    assert.deepEqual(
      desktopSync.calls.map((call) => ({
        reason: call.reason,
        chatId: call.chatId,
        cwd: call.cwd,
        chatTitle: call.chatTitle,
        projectTitle: call.projectTitle,
      })),
      [
        {
          reason: "chat_activated",
          chatId: "chat-1",
          cwd: "/tmp/demo-project",
          chatTitle: "hello",
          projectTitle: "demo-project",
        },
        {
          reason: "message_sent",
          chatId: "chat-1",
          cwd: "/tmp/demo-project",
          chatTitle: "hello",
          projectTitle: "demo-project",
        },
      ],
    );
  } finally {
    await server.close();
  }
});

test("createCompanionServer returns remembered chats when the current thread window omits a known project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-known-chats-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Known Chats Test Device" });

  const codexClient = new FakeCodexClient();
  codexClient.threadListData = [];

  const state = new SessionState();
  const projectId = shortHash("/tmp/demo-project");
  state.rememberProjects([
    {
      id: projectId,
      cwd: "/tmp/demo-project",
      title: "demo-project",
      lastUpdatedAt: 456,
    },
  ]);
  state.rememberChats([
    {
      id: "chat-remembered",
      projectId,
      cwd: "/tmp/demo-project",
      title: "Remembered chat",
      updatedAt: 456,
    },
  ]);

  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient,
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state,
    logger: new CompanionLogger(logPath, "debug"),
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const headers = {
    authorization: `Bearer ${issued.token}`,
  };

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chats?projectId=${projectId}`, {
      headers,
    });
    assert.equal(response.status, 200);
    const payload = await response.json() as { data: Array<Record<string, unknown>> };
    assert.equal(payload.data.length, 1);
    assert.equal(payload.data[0]?.id, "chat-remembered");
    assert.equal(payload.data[0]?.projectId, projectId);
    assert.equal(payload.data[0]?.title, "Remembered chat");
  } finally {
    await server.close();
  }
});

test("createCompanionServer logs desktop sync completion when the bridge returns timeout errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-desktop-sync-timeout-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Desktop Timeout Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const desktopSync = new TimeoutDesktopSyncBridge();
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
      desktopSyncEnabled: true,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new FakeCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
    desktopSync,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const projectId = shortHash("/tmp/demo-project");
  const headers = {
    authorization: `Bearer ${issued.token}`,
    "content-type": "application/json",
    "x-codex-trace-id": "trace-desktop-timeout-123",
  };

  try {
    const chatsResponse = await fetch(`http://127.0.0.1:${address.port}/v1/chats?projectId=${projectId}`, {
      headers,
    });
    assert.equal(chatsResponse.status, 200);

    const activateResponse = await fetch(`http://127.0.0.1:${address.port}/v1/chats/chat-1/activate`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(activateResponse.status, 200);

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  } finally {
    await server.close();
    await logger.flush();
  }

  const lines = (await readFile(logPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  const desktopCompleted = lines.find((line) => line.event === "desktop_sync_completed");
  assert.equal(desktopCompleted?.traceId, "trace-desktop-timeout-123");
  assert.equal(desktopCompleted?.chatId, "chat-1");
  assert.equal(desktopCompleted?.refreshed, false);
  assert.equal(desktopCompleted?.selectionStatus, undefined);
  assert.match(JSON.stringify(desktopCompleted?.errors ?? []), /timed out/);
});

test("createCompanionServer uses the first sent message as the desktop sync title for new chats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-new-chat-title-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "New Chat Title Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const desktopSync = new FakeDesktopSyncBridge();
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
      desktopSyncEnabled: true,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new FakeCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
    desktopSync,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const headers = {
    authorization: `Bearer ${issued.token}`,
    "content-type": "application/json",
  };

  try {
    const createResponse = await fetch(`http://127.0.0.1:${address.port}/v1/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: "/tmp/fresh-desktop-chat" }),
    });
    assert.equal(createResponse.status, 201);

    const createdBody = await createResponse.json() as { data: { id: string } };
    const chatId = createdBody.data.id;

    const messageResponse = await fetch(`http://127.0.0.1:${address.port}/v1/chats/${chatId}/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ text: "Fresh desktop title" }),
    });
    assert.equal(messageResponse.status, 202);

    const activateResponse = await fetch(`http://127.0.0.1:${address.port}/v1/chats/${chatId}/activate`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    assert.equal(activateResponse.status, 200);

    assert.deepEqual(
      desktopSync.calls.map((call) => ({
        reason: call.reason,
        chatId: call.chatId,
        cwd: call.cwd,
        chatTitle: call.chatTitle,
        projectTitle: call.projectTitle,
      })),
      [
        {
          reason: "message_sent",
          chatId,
          cwd: "/tmp/fresh-desktop-chat",
          chatTitle: "Fresh desktop title",
          projectTitle: "fresh-desktop-chat",
        },
        {
          reason: "chat_activated",
          chatId,
          cwd: "/tmp/fresh-desktop-chat",
          chatTitle: "Fresh desktop title",
          projectTitle: "fresh-desktop-chat",
        },
      ],
    );
  } finally {
    await server.close();
  }
});

test("createCompanionServer does not trigger desktop sync when a chat is only created", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-desktop-create-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Desktop Create Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const desktopSync = new FakeDesktopSyncBridge();
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
      desktopSyncEnabled: true,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new FakeCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
    desktopSync,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chats`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ cwd: "/tmp/debug-workspace" }),
    });

    assert.equal(response.status, 201);
    assert.equal(desktopSync.calls.length, 0);
  } finally {
    await server.close();
  }
});

test("createCompanionServer returns saved chat history from the history store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-history-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "History Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new FakeCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chats/chat-1/messages`, {
    headers: {
      authorization: `Bearer ${issued.token}`,
      "x-codex-trace-id": "trace-history-123",
    },
  });
  const body = await response.json() as {
    data: Array<{ role: string; text: string; phase?: string; workedDurationSeconds?: number }>;
  };

  try {
    assert.equal(response.status, 200);
    assert.deepEqual(
      body.data.map((message) => ({
        role: message.role,
        text: message.text,
        phase: message.phase,
      })),
      [
        {
          role: "user",
          text: "Saved user prompt",
          phase: undefined,
        },
        {
          role: "assistant",
          text: "Checking the saved rollout.",
          phase: "commentary",
        },
        {
          role: "assistant",
          text: "Saved assistant answer",
          phase: "final_answer",
        },
      ],
    );
    assert.equal(body.data[2]?.workedDurationSeconds, 13);
  } finally {
    await server.close();
  }
});

test("createCompanionServer transcribes dictation audio through the injected transcription service", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-dictation-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Dictation Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const transcriptionService = new FakeTranscriptionService();
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new FakeCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
    transcriptionService,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/dictation/transcribe`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${issued.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      audioBase64: Buffer.from("fake-audio").toString("base64"),
      filename: "dictation.m4a",
      mimeType: "audio/m4a",
      language: "de",
    }),
  });
  const body = await response.json() as {
    data: {
      text: string;
      model: string;
    };
  };

  try {
    assert.equal(response.status, 200);
    assert.equal(body.data.text, "Transcribed mobile dictation");
    assert.equal(body.data.model, "gpt-4o-transcribe");
    assert.equal(transcriptionService.calls.length, 1);
    assert.equal(transcriptionService.calls[0]?.filename, "dictation.m4a");
    assert.equal(transcriptionService.calls[0]?.mimeType, "audio/m4a");
    assert.equal(transcriptionService.calls[0]?.language, "de");
    assert.equal(transcriptionService.calls[0]?.audioBuffer.toString("utf8"), "fake-audio");
  } finally {
    await server.close();
  }
});

test("createCompanionServer keeps user text out of companion logs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-log-privacy-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");
  const promptText = "Private prompt that must stay out of logs";
  const transcriptText = "Transcribed mobile dictation";

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Log Privacy Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const transcriptionService = new FakeTranscriptionService();
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new FakeCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
    transcriptionService,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const messageResponse = await fetch(`http://127.0.0.1:${address.port}/v1/chats/chat-1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: promptText,
        attachments: [],
      }),
    });

    const dictationResponse = await fetch(`http://127.0.0.1:${address.port}/v1/dictation/transcribe`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        audioBase64: Buffer.from("fake-audio").toString("base64"),
        filename: "dictation.m4a",
        mimeType: "audio/m4a",
        language: "de",
      }),
    });

    assert.equal(messageResponse.status, 202);
    assert.equal(dictationResponse.status, 200);

    await logger.flush();
    const contents = await readFile(logPath, "utf8");
    assert.doesNotMatch(contents, new RegExp(promptText));
    assert.doesNotMatch(contents, new RegExp(transcriptText));

    const records = contents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const messageLog = records.find((record) => record.event === "message_received");
    assert.ok(messageLog);
    assert.equal(messageLog.textLength, promptText.length);
    assert.equal(messageLog.hasText, true);
    assert.equal("text" in messageLog, false);

    const dictationLog = records.find((record) => record.event === "dictation_transcribed");
    assert.ok(dictationLog);
    assert.equal(dictationLog.transcriptLength, transcriptText.length);
    assert.equal("text" in dictationLog, false);
  } finally {
    await server.close();
  }
});

test("createCompanionServer returns the persisted chat timeline with edited file cards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-timeline-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Timeline Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new FakeCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chats/chat-1/timeline`, {
    headers: {
      authorization: `Bearer ${issued.token}`,
    },
  });
  const body = await response.json() as {
    data: {
      messages: Array<{ role: string; text: string; phase?: string }>;
      activities: Array<{
        kind: string;
        title?: string;
        detail?: string;
        commandPreview?: string;
        filePath?: string;
        additions?: number;
        deletions?: number;
      }>;
    };
  };

  try {
    assert.equal(response.status, 200);
    assert.equal(body.data.messages.length, 3);
    assert.deepEqual(
      body.data.activities.map((activity) => ({
        kind: activity.kind,
        title: activity.title,
        detail: activity.detail,
        commandPreview: activity.commandPreview,
        filePath: activity.filePath,
        additions: activity.additions,
        deletions: activity.deletions,
      })),
      [
        {
          kind: "file_edited",
          title: "Edited",
          detail: "ContentView.swift",
          commandPreview: undefined,
          filePath: "apps/ios/Sources/Views/ContentView.swift",
          additions: 64,
          deletions: 16,
        },
        {
          kind: "context_compacted",
          title: "Context automatically compacted",
          detail: undefined,
          commandPreview: undefined,
          filePath: undefined,
          additions: undefined,
          deletions: undefined,
        },
        {
          kind: "background_terminal",
          title: "Background terminal finished",
          detail: "Exit code 0",
          commandPreview: "xcodebuild build -project apps/ios/CodexRemote.xcodeproj",
          filePath: undefined,
          additions: undefined,
          deletions: undefined,
        },
      ],
    );
  } finally {
    await server.close();
  }
});

test("createCompanionServer merges live explored cards into the chat timeline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-live-timeline-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Live Timeline Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const state = new SessionState();
  state.setTurnChat("turn-live-1", "chat-1", "trace-live-1");

  const codexClient = new FakeCodexClient();
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient,
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state,
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  codexClient.emit("notification", {
    method: "item/started",
    params: {
      turnId: "turn-live-1",
      item: {
        id: "command-item-1",
        type: "commandExecution",
        command: "rg --files apps/ios",
        commandActions: [
          { type: "read" },
          { type: "search" },
        ],
      },
    },
  });
  codexClient.emit("notification", {
    method: "item/completed",
    params: {
      turnId: "turn-live-1",
      item: {
        id: "command-item-1",
        type: "commandExecution",
        command: "rg --files apps/ios",
        commandActions: [
          { type: "read" },
          { type: "search" },
        ],
      },
    },
  });

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/chats/chat-1/timeline`, {
    headers: {
      authorization: `Bearer ${issued.token}`,
    },
  });
  const body = await response.json() as {
    data: {
      activities: Array<{ title: string; detail?: string; state: string }>;
    };
  };

  try {
    assert.equal(response.status, 200);
    assert.ok(
      body.data.activities.some((activity) => (
        activity.title === "Explored"
        && activity.detail === "1 file, 1 search"
        && activity.state === "completed"
      )),
    );
  } finally {
    await server.close();
  }
});

test("createCompanionServer forwards image and text-file attachments into turn/start input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-message-attachments-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Message Attachments Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const codexClient = new FakeCodexClient();
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient,
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chats/chat-1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "Please inspect the upload",
        attachments: [
          {
            type: "image",
            name: "photo.jpg",
            mimeType: "image/jpeg",
            dataUrl: "data:image/jpeg;base64,AAA",
          },
          {
            type: "text_file",
            name: "notes.txt",
            mimeType: "text/plain",
            text: "Hello from file",
          },
        ],
      }),
    });

    assert.equal(response.status, 202);
    assert.equal(codexClient.turnStartRequests.length, 1);
    assert.deepEqual(codexClient.turnStartRequests[0], {
      threadId: "chat-1",
      input: [
        { type: "text", text: "Please inspect the upload" },
        { type: "image", url: "data:image/jpeg;base64,AAA" },
        {
          type: "text",
          text: "Attached file: notes.txt\n\n--- BEGIN FILE ---\nHello from file\n--- END FILE ---",
        },
      ],
    });
  } finally {
    await server.close();
  }
});

test("createCompanionServer returns the active run state for a chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-run-state-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Run State Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const codexClient = new FakeCodexClient();
  codexClient.activeThreadReadTurnId = "turn-active-1";
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient,
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chats/chat-1/run-state`, {
      headers: {
        authorization: `Bearer ${issued.token}`,
      },
    });
    const body = await response.json() as {
      data: {
        chatId: string;
        isRunning: boolean;
        activeTurnId?: string;
      };
    };

    assert.equal(response.status, 200);
    assert.equal(body.data.chatId, "chat-1");
    assert.equal(body.data.isRunning, true);
    assert.equal(body.data.activeTurnId, "turn-active-1");
    assert.equal(codexClient.threadReadRequests.length, 1);
  } finally {
    await server.close();
  }
});

test("createCompanionServer interrupts the active turn through the stop route", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-stop-turn-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Stop Turn Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const codexClient = new FakeCodexClient();
  const state = new SessionState();
  state.setTurnChat("turn-live-1", "chat-1", "trace-stop-turn");
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient,
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state,
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chats/chat-1/stop`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
      },
    });
    const body = await response.json() as {
      data: {
        interrupted: boolean;
        turnId?: string;
      };
    };

    assert.equal(response.status, 200);
    assert.equal(body.data.interrupted, true);
    assert.equal(body.data.turnId, "turn-live-1");
    assert.deepEqual(codexClient.turnInterruptRequests[0], {
      threadId: "chat-1",
      turnId: "turn-live-1",
    });
    assert.equal(state.getActiveTurnId("chat-1"), undefined);
  } finally {
    await server.close();
  }
});

test("createCompanionServer steers the active turn through turn/steer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-steer-turn-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Steer Turn Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const codexClient = new FakeCodexClient();
  const state = new SessionState();
  state.setTurnChat("turn-live-1", "chat-1", "trace-steer-turn");
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient,
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state,
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chats/chat-1/steer`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "Please look in apps/ios first",
        attachments: [],
      }),
    });
    const body = await response.json() as {
      data: {
        turnId?: string;
        mode: string;
      };
    };

    assert.equal(response.status, 202);
    assert.equal(body.data.mode, "steered");
    assert.equal(body.data.turnId, "turn-2");
    assert.deepEqual(codexClient.turnSteerRequests[0], {
      threadId: "chat-1",
      input: [
        { type: "text", text: "Please look in apps/ios first" },
      ],
      expectedTurnId: "turn-live-1",
    });
    assert.equal(state.getActiveTurnId("chat-1"), "turn-2");
  } finally {
    await server.close();
  }
});

test("createCompanionServer returns project context from the local context store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-project-context-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Context Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new FakeCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const projectId = shortHash("/tmp/demo-project");

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/projects/${projectId}/context`, {
    headers: {
      authorization: `Bearer ${issued.token}`,
      "x-codex-trace-id": "trace-project-context-123",
    },
  });
  const body = await response.json() as {
    data: {
      runtimeMode: string;
      approvalPolicy: string;
      sandboxMode: string;
      model: string;
      trustLevel: string;
      git: {
        branch: string;
        changedFiles: number;
      };
    };
  };

  try {
    assert.equal(response.status, 200);
    assert.equal(body.data.runtimeMode, "local");
    assert.equal(body.data.approvalPolicy, "never");
    assert.equal(body.data.sandboxMode, "workspace-write");
    assert.equal(body.data.model, "gpt-5.4");
    assert.equal(body.data.trustLevel, "trusted");
    assert.equal(body.data.git.branch, "main");
    assert.equal(body.data.git.changedFiles, 2);
  } finally {
    await server.close();
  }
});

test("createCompanionServer exposes git action routes from the local context store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-git-routes-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Git Route Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const contextStore = new FakeProjectContextStore();
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new FakeCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore,
    state: new SessionState(),
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const projectId = shortHash("/tmp/demo-project");
  const headers = {
    authorization: `Bearer ${issued.token}`,
    "content-type": "application/json",
  };

  try {
    const branchesResponse = await fetch(`http://127.0.0.1:${address.port}/v1/projects/${projectId}/git/branches`, {
      headers,
    });
    const diffResponse = await fetch(`http://127.0.0.1:${address.port}/v1/projects/${projectId}/git/diff?path=README.md`, {
      headers,
    });
    const checkoutResponse = await fetch(`http://127.0.0.1:${address.port}/v1/projects/${projectId}/git/checkout`, {
      method: "POST",
      headers,
      body: JSON.stringify({ branch: "feature/mobile" }),
    });
    const commitResponse = await fetch(`http://127.0.0.1:${address.port}/v1/projects/${projectId}/git/commit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "Remote commit" }),
    });

    const branchesBody = await branchesResponse.json() as { data: Array<{ name: string; isCurrent: boolean }> };
    const diffBody = await diffResponse.json() as { data: { path: string; text: string } };
    const checkoutBody = await checkoutResponse.json() as { data: { branch: string } };
    const commitBody = await commitResponse.json() as { data: { commitHash: string; summary: string } };

    assert.equal(branchesResponse.status, 200);
    assert.deepEqual(branchesBody.data, [
      { name: "main", isCurrent: true },
      { name: "feature/mobile", isCurrent: false },
    ]);
    assert.equal(diffResponse.status, 200);
    assert.equal(diffBody.data.path, "README.md");
    assert.match(diffBody.data.text, /README\.md/);
    assert.equal(checkoutResponse.status, 200);
    assert.equal(checkoutBody.data.branch, "feature/mobile");
    assert.equal(contextStore.lastCheckoutBranch, "feature/mobile");
    assert.equal(commitResponse.status, 200);
    assert.equal(commitBody.data.commitHash, "abc123");
    assert.equal(commitBody.data.summary, "Remote commit");
    assert.equal(contextStore.lastCommitMessage, "Remote commit");
  } finally {
    await server.close();
  }
});

test("createCompanionServer updates runtime config through the local context store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-runtime-config-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Runtime Config Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const contextStore = new FakeProjectContextStore();
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new FakeCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore,
    state: new SessionState(),
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/runtime/config`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        approvalPolicy: "on-request",
        sandboxMode: "danger-full-access",
      }),
    });
    const body = await response.json() as { data: { approvalPolicy: string; sandboxMode: string } };

    assert.equal(response.status, 200);
    assert.equal(body.data.approvalPolicy, "on-request");
    assert.equal(body.data.sandboxMode, "danger-full-access");
    assert.deepEqual(contextStore.lastRuntimeConfigUpdate, {
      approvalPolicy: "on-request",
      sandboxMode: "danger-full-access",
    });
  } finally {
    await server.close();
  }
});

test("createCompanionServer keeps a newly created project available before thread/list catches up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-project-race-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Project Race Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient: new LaggyThreadListCodexClient(),
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state: new SessionState(),
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const headers = {
    authorization: `Bearer ${issued.token}`,
    "content-type": "application/json",
  };

  try {
    const createdResponse = await fetch(`http://127.0.0.1:${address.port}/v1/chats`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: "/tmp/new-project" }),
    });
    const createdBody = await createdResponse.json() as { data: { projectId: string } };

    const contextResponse = await fetch(`http://127.0.0.1:${address.port}/v1/projects/${createdBody.data.projectId}/context`, {
      headers: {
        authorization: `Bearer ${issued.token}`,
      },
    });

    assert.equal(createdResponse.status, 201);
    assert.equal(contextResponse.status, 200);
  } finally {
    await server.close();
  }
});

test("createCompanionServer forwards MCP approvals to iPhone and persists always-allow scopes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-mcp-approval-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");
  const approvalPreferencesPath = join(dir, "approval-preferences.json");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "MCP Approval Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const codexClient = new FakeCodexClient();
  const state = new SessionState(approvalPreferencesPath);
  await state.load();

  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient,
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state,
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/stream?chatId=chat-1`, {
    headers: {
      authorization: `Bearer ${issued.token}`,
    },
  });

  try {
    await waitForSocketOpen(socket);

    codexClient.emit("serverRequest", {
      id: 41,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "chat-1",
        serverName: "OpenAI Developer Docs MCP Server",
        toolName: "fetch_openai_doc",
        message: "OpenAI wants to call the OpenAI Developer Docs MCP server.",
      },
    });

    const event = await waitForSocketMessage(socket);
    assert.equal(event.event, "approval_required");

    const payload = event.payload as Record<string, unknown>;
    const approvalId = payload.id;
    assert.equal(payload.kind, "mcp");
    assert.equal(payload.mode, "mcp_elicitation");
    assert.equal(payload.title, "MCP Server Access");
    assert.equal(payload.serverName, "OpenAI Developer Docs MCP Server");
    assert.equal(payload.supportsSessionAllow, true);
    assert.equal(payload.supportsAlwaysAllow, true);
    assert.equal(typeof approvalId, "string");

    const pendingApprovalResponse = await fetch(
      `http://127.0.0.1:${address.port}/v1/chats/chat-1/pending-approval`,
      {
        headers: {
          authorization: `Bearer ${issued.token}`,
        },
      },
    );
    const pendingApprovalBody = await pendingApprovalResponse.json() as {
      data: Record<string, unknown> | null;
    };

    assert.equal(pendingApprovalResponse.status, 200);
    assert.equal(pendingApprovalBody.data?.id, approvalId);
    assert.equal(pendingApprovalBody.data?.mode, "mcp_elicitation");

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/approvals/${approvalId as string}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "allow_always" }),
    });

    assert.equal(response.status, 200);
    await waitForCondition(() => codexClient.responses.length === 1);
    assert.deepEqual(codexClient.responses[0], {
      id: 41,
      result: { action: "accept" },
    });

    const preferences = JSON.parse(await readFile(approvalPreferencesPath, "utf8")) as {
      alwaysAllowScopeKeys: string[];
    };
    assert.deepEqual(preferences.alwaysAllowScopeKeys, [
      "mcp:openai-developer-docs-mcp-server:fetch-openai-doc",
    ]);

    codexClient.emit("serverRequest", {
      id: 42,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "chat-1",
        serverName: "OpenAI Developer Docs MCP Server",
        toolName: "fetch_openai_doc",
        message: "OpenAI wants to call the OpenAI Developer Docs MCP server.",
      },
    });

    await waitForCondition(() => codexClient.responses.length === 2);
    assert.deepEqual(codexClient.responses[1], {
      id: 42,
      result: { action: "accept" },
    });
  } finally {
    socket.close();
    await server.close();
  }
});

test("createCompanionServer lets late mobile hydration load pending approvals and clears them once work resumes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-pending-approval-state-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Pending Approval State Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const codexClient = new FakeCodexClient();
  const state = new SessionState();

  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient,
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state,
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/stream?chatId=chat-1`, {
    headers: {
      authorization: `Bearer ${issued.token}`,
    },
  });

  try {
    await waitForSocketOpen(socket);

    codexClient.emit("serverRequest", {
      id: 61,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "chat-1",
        serverName: "OpenAI Developer Docs MCP Server",
        toolName: "search_openai_docs",
        message: "OpenAI wants to search the OpenAI Developer Docs MCP server.",
      },
    });

    const approvalRequiredEvent = await waitForSocketMessage(socket);
    assert.equal(approvalRequiredEvent.event, "approval_required");
    const approvalPayload = approvalRequiredEvent.payload as Record<string, unknown>;
    const approvalId = approvalPayload.id;
    assert.equal(typeof approvalId, "string");

    const pendingApprovalResponse = await fetch(
      `http://127.0.0.1:${address.port}/v1/chats/chat-1/pending-approval`,
      {
        headers: {
          authorization: `Bearer ${issued.token}`,
        },
      },
    );
    const pendingApprovalBody = await pendingApprovalResponse.json() as {
      data: Record<string, unknown> | null;
    };

    assert.equal(pendingApprovalResponse.status, 200);
    assert.equal(pendingApprovalBody.data?.id, approvalId);

    codexClient.emit("notification", {
      method: "item/started",
      params: {
        turn: {
          id: "turn-approval-resumed",
          threadId: "chat-1",
        },
      },
    });

    const clearedEvent = await waitForSocketMessage(socket);
    assert.equal(clearedEvent.event, "approval_cleared");
    assert.deepEqual(clearedEvent.payload, { ids: [approvalId] });

    const clearedApprovalResponse = await fetch(
      `http://127.0.0.1:${address.port}/v1/chats/chat-1/pending-approval`,
      {
        headers: {
          authorization: `Bearer ${issued.token}`,
        },
      },
    );
    const clearedApprovalBody = await clearedApprovalResponse.json() as {
      data: Record<string, unknown> | null;
    };

    assert.equal(clearedApprovalResponse.status, 200);
    assert.equal(clearedApprovalBody.data, null);
  } finally {
    socket.close();
    await server.close();
  }
});

test("createCompanionServer survives deeply nested MCP approval params", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-mcp-nested-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Nested MCP Approval Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const codexClient = new FakeCodexClient();
  const state = new SessionState();

  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient,
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state,
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/stream?chatId=chat-1`, {
    headers: {
      authorization: `Bearer ${issued.token}`,
    },
  });

  try {
    await waitForSocketOpen(socket);

    codexClient.emit("serverRequest", {
      id: 51,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "chat-1",
        payload: buildNestedObject(20_000, {
          serverName: "Too Deep To Read",
          toolName: "fetch_openai_doc",
        }),
      },
    });

    const event = await waitForSocketMessage(socket);
    assert.equal(event.event, "approval_required");

    const payload = event.payload as Record<string, unknown>;
    assert.equal(payload.kind, "mcp");
    assert.equal(payload.summary, "Allow access to an MCP server request.");
    assert.equal(payload.supportsAlwaysAllow, false);

    await logger.flush();
    const traceLog = await readFile(logPath, "utf8");
    assert.doesNotMatch(traceLog, /approval_request_mapping_failed/);
  } finally {
    socket.close();
    await server.close();
  }
});

test("createCompanionServer survives cyclic MCP approval params", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-server-mcp-cycle-test-"));
  const tokenPath = join(dir, "tokens.json");
  const logPath = join(dir, "companion.ndjson");

  const tokenStore = new TokenStore(tokenPath);
  await tokenStore.load();
  const issued = await tokenStore.issueDeviceToken({ deviceName: "Cyclic MCP Approval Test Device" });

  const logger = new CompanionLogger(logPath, "debug");
  const codexClient = new FakeCodexClient();
  const state = new SessionState();

  const server = await createCompanionServer({
    config: buildTestConfig({
      tokenStorePath: tokenPath,
      traceLogPath: logPath,
    }),
    tokenStore,
    pairingStore: new PairingStore(60),
    codexClient,
    historyStore: new FakeHistoryStore(),
    contextStore: new FakeProjectContextStore(),
    state,
    logger,
  });

  await server.listen();
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/v1/stream?chatId=chat-1`, {
    headers: {
      authorization: `Bearer ${issued.token}`,
    },
  });

  const cyclicPayload: Record<string, unknown> = {};
  cyclicPayload.self = cyclicPayload;

  try {
    await waitForSocketOpen(socket);

    codexClient.emit("serverRequest", {
      id: 52,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "chat-1",
        payload: cyclicPayload,
      },
    });

    const event = await waitForSocketMessage(socket);
    assert.equal(event.event, "approval_required");

    const payload = event.payload as Record<string, unknown>;
    assert.equal(payload.kind, "mcp");
    assert.equal(payload.summary, "Allow access to an MCP server request.");
    assert.equal(payload.supportsAlwaysAllow, false);

    await logger.flush();
    const traceLog = await readFile(logPath, "utf8");
    assert.doesNotMatch(traceLog, /approval_request_mapping_failed/);
  } finally {
    socket.close();
    await server.close();
  }
});
