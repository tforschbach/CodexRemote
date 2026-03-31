import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { parse as parseUrl } from "node:url";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import express, { type Request, type Response } from "express";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";
import {
  assertNonEmptyString,
  type ApprovalDecision,
  type ApprovalRequest,
  type ChatTimeline,
  type Message,
  type PairingConfirmRequest,
  type PairingRequestResponse,
  type StreamEvent,
} from "@codex-remote/protocol";

import type { AppConfig } from "../config.js";
import type { TokenStore } from "../auth/token-store.js";
import type { PairingStore } from "../pairing/pairing-store.js";
import { confirmPairingOnMac } from "../platform/macos-confirm.js";
import type { CodexClientBridge, CodexNotificationEvent, CodexServerRequestEvent } from "../codex/client.js";
import { buildAuthMiddleware } from "./auth.js";
import { broadcastEvent } from "./broadcast.js";
import { buildProjectsFromThreads, mapRawThread, mapRawThreadToKnownChat } from "./mapping.js";
import type { ConnectionRegistry } from "./types.js";
import type { SessionState } from "../state/session-state.js";
import type { CompanionLogger } from "../logging/logger.js";
import type { ChatHistoryStore } from "../history/rollout-history.js";
import { buildLiveCommandActivity, mergeChatActivities } from "../history/chat-activities.js";
import type { ProjectContextStore } from "../context/project-context.js";
import type { DesktopSyncBridge, DesktopSyncRequest } from "../desktop/live-sync.js";
import {
  type DictationTranscriptionService,
  OpenAITranscriptionService,
  TranscriptionServiceError,
} from "../openai/transcription.js";
import {
  buildChatTitleSeed,
  buildTurnStartInput,
  normalizeMessageText,
  parseMessageAttachments,
  type SendChatMessageBody,
} from "./message-input.js";

interface Dependencies {
  config: AppConfig;
  tokenStore: TokenStore;
  pairingStore: PairingStore;
  codexClient: CodexClientBridge;
  historyStore: ChatHistoryStore;
  contextStore: ProjectContextStore;
  state: SessionState;
  logger: CompanionLogger;
  desktopSync?: DesktopSyncBridge;
  transcriptionService?: DictationTranscriptionService;
}

interface RawThread {
  id: string;
  preview?: string;
  name?: string;
  cwd?: string;
  updatedAt?: number;
  createdAt?: number;
}

interface RawTurnState {
  id?: string;
  status?: string;
}

interface RawThreadReadResult {
  thread?: {
    status?: { type?: string };
    turns?: RawTurnState[];
  };
}

interface IOSDebugLogUploadBody {
  contents?: unknown;
}

interface StartChatBody extends SendChatMessageBody {
  cwd?: string;
  model?: string;
}

async function persistIOSDebugLog(traceLogPath: string, contents: string): Promise<{ path: string; bytes: number }> {
  const outputPath = join(dirname(traceLogPath), "ios-device.ndjson");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, contents, "utf8");
  return {
    path: "logs/ios-device.ndjson",
    bytes: Buffer.byteLength(contents, "utf8"),
  };
}

function summarizeUserTextMetadata(value: string | undefined): { hasText: boolean; textLength: number } {
  const normalized = value?.trim() ?? "";
  return {
    hasText: normalized.length > 0,
    textLength: normalized.length,
  };
}

function shouldTreatMissingRunStateAsIdle(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes("no rollout found") || message.includes("no rollout");
}

function extractChatIdFromCodexPayload(params: unknown, state: SessionState): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }

  const typed = params as Record<string, unknown>;
  if (typeof typed.threadId === "string") {
    return typed.threadId;
  }

  if (typed.turn && typeof typed.turn === "object") {
    const turn = typed.turn as Record<string, unknown>;
    if (typeof turn.threadId === "string") {
      return turn.threadId;
    }
    if (typeof turn.id === "string") {
      return state.getChatByTurn(turn.id);
    }
  }

  if (typeof typed.turnId === "string") {
    return state.getChatByTurn(typed.turnId);
  }

  return undefined;
}

function mapNotificationToStreamEvent(
  event: CodexNotificationEvent,
  state: SessionState,
): StreamEvent | null {
  const chatId = extractChatIdFromCodexPayload(event.params, state);
  if (!chatId) {
    return null;
  }

  const methodMap: Record<string, StreamEvent["event"] | undefined> = {
    "turn/started": "turn_started",
    "item/agentMessage/delta": "message_delta",
    "item/started": "item_started",
    "item/completed": "item_completed",
    "turn/completed": "turn_completed",
    error: "error",
  };

  const mappedEvent = methodMap[event.method];
  if (!mappedEvent) {
    return null;
  }

  return {
    event: mappedEvent,
    chatId,
    payload: event.params,
    timestamp: Date.now(),
  };
}

function extractNotificationStatusType(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }

  const typed = params as Record<string, unknown>;
  if (!typed.status || typeof typed.status !== "object" || Array.isArray(typed.status)) {
    return undefined;
  }

  const status = typed.status as Record<string, unknown>;
  return typeof status.type === "string" ? status.type : undefined;
}

function extractActiveTurnIdFromThreadRead(result: RawThreadReadResult): string | undefined {
  const turns = Array.isArray(result.thread?.turns) ? result.thread?.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn?.status === "inProgress" && typeof turn.id === "string") {
      return turn.id;
    }
  }

  return undefined;
}

function extractStreamItemFromParams(params: unknown): Record<string, unknown> | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }

  const typed = params as Record<string, unknown>;
  if (!typed.item || typeof typed.item !== "object" || Array.isArray(typed.item)) {
    return undefined;
  }

  return typed.item as Record<string, unknown>;
}

function syncChatActivitiesFromNotification(
  event: CodexNotificationEvent,
  state: SessionState,
  chatId: string,
  timestampMs: number,
): void {
  if (event.method === "turn/completed") {
    state.completeInProgressActivities(chatId, Math.floor(timestampMs / 1000));
    return;
  }

  if (event.method !== "item/started" && event.method !== "item/completed") {
    return;
  }

  const item = extractStreamItemFromParams(event.params);
  if (!item || item.type !== "commandExecution" || typeof item.id !== "string") {
    return;
  }

  const activity = buildLiveCommandActivity({
    itemId: item.id,
    commandActions: Array.isArray(item.commandActions) ? item.commandActions : [],
    commandPreview: typeof item.command === "string" ? item.command : undefined,
    createdAtMs: timestampMs,
    updatedAtMs: timestampMs,
    state: event.method === "item/started" ? "in_progress" : "completed",
  });

  state.upsertChatActivity(chatId, activity);
}

function syncTurnStateFromNotification(
  event: CodexNotificationEvent,
  state: SessionState,
  traceId: string | undefined,
): void {
  const chatId = extractChatIdFromCodexPayload(event.params, state);
  const turnId = extractTurnIdFromCodexPayload(event.params);

  if (event.method === "turn/started" && chatId && turnId) {
    state.setTurnChat(turnId, chatId, traceId);
    return;
  }

  if (event.method === "turn/completed" && turnId) {
    state.clearTurn(turnId);
    return;
  }

  if (event.method !== "thread/status/changed" || !chatId) {
    return;
  }

  if (extractNotificationStatusType(event.params) !== "active") {
    state.clearActiveTurnForChat(chatId);
  }
}

function mapApprovalSummary(serverEvent: CodexServerRequestEvent): {
  kind: ApprovalRequest["kind"];
  summary: string;
} {
  const params = (serverEvent.params ?? {}) as Record<string, unknown>;

  if (serverEvent.method.includes("commandExecution")) {
    const command = typeof params.command === "string" ? params.command : "Command execution request";
    return { kind: "command", summary: command };
  }

  const reason = typeof params.reason === "string" ? params.reason : "File change approval request";
  return { kind: "fileChange", summary: reason };
}

function normalizeDecision(decision: ApprovalDecision): string {
  switch (decision) {
    case "approve":
      return "accept";
    case "decline":
      return "decline";
    case "allow_for_session":
      return "acceptForSession";
    default:
      return "decline";
  }
}

function isPlaceholderChatTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase();
  return normalized === ""
    || normalized === "untitled chat"
    || normalized === "new thread";
}

async function loadProjectsForRequest(
  deps: Dependencies,
  traceId: string | undefined,
): Promise<ReturnType<typeof buildProjectsFromThreads>> {
  const result = (await deps.codexClient.request("thread/list", {
    sortKey: "updated_at",
    limit: 200,
  }, { traceId })) as { data?: RawThread[] };

  const listedProjects = buildProjectsFromThreads(result.data ?? []);
  deps.state.rememberProjects(listedProjects);
  deps.state.rememberChats((result.data ?? []).map(mapRawThreadToKnownChat));

  const merged = new Map<string, ReturnType<typeof buildProjectsFromThreads>[number]>();
  for (const project of deps.state.listKnownProjects()) {
    merged.set(project.id, project);
  }
  for (const project of listedProjects) {
    const existing = merged.get(project.id);
    if (!existing) {
      merged.set(project.id, project);
      continue;
    }
    existing.cwd = project.cwd;
    existing.title = project.title;
    existing.lastUpdatedAt = Math.max(existing.lastUpdatedAt, project.lastUpdatedAt);
  }

  return [...merged.values()].sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt);
}

function findProjectById(
  projects: ReturnType<typeof buildProjectsFromThreads>,
  projectId: string,
) {
  return projects.find((candidate) => candidate.id === projectId);
}

async function activateChatSession(
  deps: Dependencies,
  chatId: string,
  traceId: string | undefined,
): Promise<"already_active" | "resumed" | "no_rollout"> {
  if (deps.state.isChatActive(chatId)) {
    return "already_active";
  }

  try {
    await deps.codexClient.request("thread/resume", { threadId: chatId }, { traceId, chatId });
    deps.state.markChatActive(chatId);
    return "resumed";
  } catch (error) {
    if (shouldTreatMissingRunStateAsIdle(error)) {
      return "no_rollout";
    }
    throw error;
  }
}

async function loadChatRunState(
  deps: Dependencies,
  chatId: string,
  traceId: string | undefined,
): Promise<{ isRunning: boolean; activeTurnId?: string }> {
  const knownTurnId = deps.state.getActiveTurnId(chatId);
  if (knownTurnId) {
    return {
      isRunning: true,
      activeTurnId: knownTurnId,
    };
  }

  let result: RawThreadReadResult;
  try {
    result = (await deps.codexClient.request("thread/read", {
      threadId: chatId,
      includeTurns: true,
    }, { traceId, chatId })) as RawThreadReadResult;
  } catch (error) {
    if (shouldTreatMissingRunStateAsIdle(error)) {
      deps.state.clearActiveTurnForChat(chatId);
      return { isRunning: false };
    }
    throw error;
  }

  const activeTurnId = extractActiveTurnIdFromThreadRead(result);
  if (activeTurnId) {
    deps.state.setTurnChat(activeTurnId, chatId, traceId);
    return {
      isRunning: true,
      activeTurnId,
    };
  }

  if (result.thread?.status?.type !== "active") {
    deps.state.clearActiveTurnForChat(chatId);
  }

  return { isRunning: false };
}

async function createChatThread(
  deps: Dependencies,
  input: { cwd?: string; model?: string },
  traceId: string | undefined,
): Promise<RawThread> {
  const result = (await deps.codexClient.request("thread/start", {
    cwd: input.cwd,
    model: input.model,
  }, { traceId })) as { thread?: RawThread };

  if (!result.thread) {
    throw new Error("Failed to create thread");
  }

  deps.state.rememberProjects(buildProjectsFromThreads([result.thread]));
  deps.state.rememberChat(mapRawThreadToKnownChat(result.thread));
  deps.state.markChatActive(result.thread.id);
  return result.thread;
}

export async function createCompanionServer(deps: Dependencies): Promise<{
  listen: () => Promise<void>;
  close: () => Promise<void>;
  address: () => AddressInfo | string | null;
}> {
  const app = express();
  app.use(express.json({ limit: "40mb" }));
  const transcriptionService = deps.transcriptionService ?? new OpenAITranscriptionService(deps.config);

  const connectionsByChat: ConnectionRegistry = new Map();

  const authMiddleware = buildAuthMiddleware(deps.tokenStore);
  const httpLog = deps.logger.child({ source: "http" });
  const chatLog = deps.logger.child({ source: "chat" });
  const streamLog = deps.logger.child({ source: "stream" });
  const desktopLog = deps.logger.child({ source: "desktop" });

  function buildDesktopSyncRequest(
    chatId: string,
    traceId: string | undefined,
    reason: DesktopSyncRequest["reason"],
    overrides: Partial<Pick<DesktopSyncRequest, "chatTitle" | "cwd" | "projectTitle" | "fallbackChatTitle">> = {},
  ): DesktopSyncRequest {
    const knownChat = deps.state.getKnownChat(chatId);
    const knownProject = knownChat ? deps.state.getKnownProject(knownChat.projectId) : undefined;
    const fallbackChat = knownChat && reason === "message_sent"
      ? deps.state
        .listKnownChats()
        .filter((candidate) => (
          candidate.projectId === knownChat.projectId
          && candidate.id !== knownChat.id
          && !isPlaceholderChatTitle(candidate.title)
        ))
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]
      : undefined;

    return {
      traceId,
      chatId,
      cwd: overrides.cwd ?? knownChat?.cwd,
      chatTitle: overrides.chatTitle ?? knownChat?.title,
      fallbackChatTitle: overrides.fallbackChatTitle ?? fallbackChat?.title,
      projectTitle:
        overrides.projectTitle
        ?? knownProject?.title
        ?? (knownChat?.cwd ? basename(knownChat.cwd) : undefined),
      reason,
    };
  }

  function triggerDesktopSync(input: DesktopSyncRequest): void {
    if (!deps.desktopSync) {
      return;
    }

    desktopLog.debug("desktop_sync_started", {
      traceId: input.traceId,
      chatId: input.chatId,
      reason: input.reason,
      cwd: input.cwd,
    });

    void deps.desktopSync.syncChat(input)
      .then((result) => {
        if (!result.attempted) {
          desktopLog.debug("desktop_sync_skipped", {
            traceId: input.traceId,
            chatId: input.chatId,
            reason: input.reason,
          });
          return;
        }

        const level = result.refreshed ? "info" : "warn";
        desktopLog[level]("desktop_sync_completed", {
          traceId: input.traceId,
          chatId: input.chatId,
          reason: input.reason,
          cwd: input.cwd,
          chatTitle: input.chatTitle,
          projectTitle: input.projectTitle,
          refreshed: result.refreshed,
          workspaceOpened: result.workspaceOpened,
          selectionStatus: result.selectionStatus,
          errors: result.errors,
        });
      })
      .catch((error) => {
        desktopLog.warn("desktop_sync_failed", {
          traceId: input.traceId,
          chatId: input.chatId,
          reason: input.reason,
          cwd: input.cwd,
          chatTitle: input.chatTitle,
          projectTitle: input.projectTitle,
          error,
        });
      });
  }

  app.use((request, response, next) => {
    const traceId = request.header("x-codex-trace-id")?.trim() || randomUUID();
    const startedAt = Date.now();

    response.locals.traceId = traceId;
    response.setHeader("x-codex-trace-id", traceId);

    httpLog.info("request_started", {
      traceId,
      method: request.method,
      path: request.path,
      query: summarizeQuery(request.query),
    });

    response.on("finish", () => {
      httpLog.info("request_completed", {
        traceId,
        method: request.method,
        path: request.path,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
        deviceId: response.locals.auth?.deviceId,
      });
    });

    next();
  });

  app.get("/health", (_request, response) => {
    response.json({ ok: true, service: "codex-remote-mac-companion" });
  });

  if (deps.config.enableDebugEndpoints) {
    app.post("/v1/debug/issue-token", async (request, response) => {
      if (!isLoopbackRequest(request)) {
        httpLog.warn("debug_token_denied_non_local", {
          traceId: getTraceId(response),
          remoteAddress: request.socket.remoteAddress,
        });
        response.status(403).json({ error: "Debug token issuance is restricted to localhost" });
        return;
      }

      const body = request.body as { deviceName?: string; devicePublicKey?: string };
      const deviceName = body.deviceName?.trim() || "Codex Debug Loop";
      const issued = await deps.tokenStore.issueDeviceToken({
        deviceName,
        ...(body.devicePublicKey ? { devicePublicKey: body.devicePublicKey } : {}),
      });

      httpLog.warn("debug_token_issued", {
        traceId: getTraceId(response),
        deviceId: issued.deviceId,
        deviceName,
      });
      response.json(issued);
    });
  }

  app.post("/v1/debug/ios-log", authMiddleware, async (request, response) => {
    const traceId = request.header("x-codex-trace-id") ?? undefined;
    const body = (request.body ?? {}) as IOSDebugLogUploadBody;
    const contents = typeof body.contents === "string"
      ? body.contents.trim()
      : "";

    if (!contents) {
      httpLog.warn("ios_debug_log_invalid", {
        traceId,
        deviceId: response.locals.auth.deviceId,
      });
      response.status(400).json({ error: "Debug log contents are required" });
      return;
    }

    const result = await persistIOSDebugLog(deps.config.traceLogPath, `${contents}\n`);
    httpLog.info("ios_debug_log_uploaded", {
      traceId,
      deviceId: response.locals.auth.deviceId,
      bytes: result.bytes,
      lineCount: contents.split("\n").length,
      path: result.path,
    });
    response.status(200).json({ data: result });
  });

  app.post("/v1/pairing/request", async (_request, response) => {
    const session = deps.pairingStore.createSession();
    const pairingUri = `codexremote://pair?host=${encodeURIComponent(deps.config.tailscaleHost)}&port=${deps.config.port}&pairingId=${session.pairingId}&nonce=${session.nonce}`;
    const qrDataUrl = await QRCode.toDataURL(pairingUri);

    const body: PairingRequestResponse = {
      pairingId: session.pairingId,
      nonce: session.nonce,
      expiresAt: session.expiresAt,
      pairingUri,
      qrDataUrl,
    };

    httpLog.info("pairing_request_created", {
      traceId: getTraceId(response),
      pairingId: session.pairingId,
      expiresAt: session.expiresAt,
      host: deps.config.tailscaleHost,
      port: deps.config.port,
    });
    response.json(body);
  });

  app.post("/v1/pairing/confirm", async (request, response) => {
    try {
      const body = request.body as Partial<PairingConfirmRequest>;
      const pairingId = assertNonEmptyString(body.pairingId, "pairingId");
      const nonce = assertNonEmptyString(body.nonce, "nonce");
      const deviceName = assertNonEmptyString(body.deviceName, "deviceName");
      const traceId = getTraceId(response);

      httpLog.info("pairing_confirm_received", {
        traceId,
        pairingId,
        deviceName,
      });

      const consumed = deps.pairingStore.consumeSession(pairingId, nonce);
      if (!consumed) {
        httpLog.warn("pairing_confirm_invalid", { traceId, pairingId, deviceName });
        response.status(400).json({ error: "Invalid or expired pairing session" });
        return;
      }

      const allowed = await confirmPairingOnMac({
        deviceName,
        pairingId,
        timeoutSeconds: deps.config.pairingConfirmTimeoutSeconds,
      });

      if (!allowed) {
        httpLog.warn("pairing_confirm_denied", { traceId, pairingId, deviceName });
        response.status(403).json({ error: "Pairing denied or timed out" });
        return;
      }

      const issued = await deps.tokenStore.issueDeviceToken(
        body.devicePublicKey
          ? { deviceName, devicePublicKey: body.devicePublicKey }
          : { deviceName },
      );

      httpLog.info("pairing_confirm_issued", {
        traceId,
        pairingId,
        deviceName,
        deviceId: issued.deviceId,
      });
      response.json(issued);
    } catch (error) {
      httpLog.error("pairing_confirm_error", {
        traceId: getTraceId(response),
        error,
      });
      response.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/v1/pairing/revoke", authMiddleware, async (request, response) => {
    const body = request.body as { deviceId?: string };
    if (body.deviceId) {
      const revoked = await deps.tokenStore.revokeDevice(body.deviceId);
      httpLog.info("device_revoked", {
        traceId: getTraceId(response),
        requestedByDeviceId: response.locals.auth?.deviceId,
        revokedDeviceId: body.deviceId,
        revoked,
      });
      response.json({ revoked });
      return;
    }

    const header = request.header("authorization") ?? "";
    const token = header.slice("Bearer ".length).trim();
    const revoked = await deps.tokenStore.revokeByToken(token);
    httpLog.info("device_revoked_by_token", {
      traceId: getTraceId(response),
      requestedByDeviceId: response.locals.auth?.deviceId,
      revoked,
    });
    response.json({ revoked });
  });

  app.get("/v1/projects", authMiddleware, async (_request, response) => {
    const traceId = getTraceId(response);
    const projects = await loadProjectsForRequest(deps, traceId);
    httpLog.info("projects_loaded", {
      traceId,
      deviceId: response.locals.auth?.deviceId,
      projectCount: projects.length,
    });
    response.json({ data: projects });
  });

  app.get("/v1/chats", authMiddleware, async (request, response) => {
    const projectId = typeof request.query.projectId === "string" ? request.query.projectId : undefined;
    const traceId = getTraceId(response);

    const result = (await deps.codexClient.request("thread/list", {
      sortKey: "updated_at",
      limit: 200,
    }, { traceId })) as { data?: RawThread[] };

    deps.state.rememberChats((result.data ?? []).map(mapRawThreadToKnownChat));
    const chats = (result.data ?? []).map(mapRawThread);
    const filtered = projectId ? chats.filter((chat) => chat.projectId === projectId) : chats;

    httpLog.info("chats_loaded", {
      traceId,
      deviceId: response.locals.auth?.deviceId,
      projectId,
      chatCount: filtered.length,
    });
    response.json({ data: filtered.sort((a, b) => b.updatedAt - a.updatedAt) });
  });

  app.get("/v1/projects/:projectId/context", authMiddleware, async (request, response) => {
    const projectId = assertNonEmptyString(request.params.projectId, "projectId");
    const traceId = getTraceId(response);

    const projects = await loadProjectsForRequest(deps, traceId);
    const project = findProjectById(projects, projectId);
    if (!project) {
      httpLog.warn("project_context_missing_project", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        projectId,
      });
      response.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const context = await deps.contextStore.loadProjectContext({
        projectId,
        cwd: project.cwd,
      });
      httpLog.info("project_context_loaded", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        projectId,
        cwd: project.cwd,
        gitChangedFiles: context.git.changedFiles,
        branch: context.git.branch,
      });
      response.json({ data: context });
    } catch (error) {
      httpLog.error("project_context_failed", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        projectId,
        cwd: project.cwd,
        error,
      });
      response.status(500).json({ error: "Failed to load project context" });
    }
  });

  app.get("/v1/projects/:projectId/git/branches", authMiddleware, async (request, response) => {
    const projectId = assertNonEmptyString(request.params.projectId, "projectId");
    const traceId = getTraceId(response);
    const projects = await loadProjectsForRequest(deps, traceId);
    const project = findProjectById(projects, projectId);

    if (!project) {
      response.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const branches = await deps.contextStore.loadGitBranches({ cwd: project.cwd });
      httpLog.info("git_branches_loaded", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        projectId,
        cwd: project.cwd,
        branchCount: branches.length,
      });
      response.json({ data: branches });
    } catch (error) {
      httpLog.error("git_branches_failed", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        projectId,
        cwd: project.cwd,
        error,
      });
      response.status(400).json({ error: (error as Error).message });
    }
  });

  app.get("/v1/projects/:projectId/git/diff", authMiddleware, async (request, response) => {
    const projectId = assertNonEmptyString(request.params.projectId, "projectId");
    const traceId = getTraceId(response);
    const path = typeof request.query.path === "string" && request.query.path.trim()
      ? request.query.path.trim()
      : undefined;
    const projects = await loadProjectsForRequest(deps, traceId);
    const project = findProjectById(projects, projectId);

    if (!project) {
      response.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const diff = await deps.contextStore.loadGitDiff({
        cwd: project.cwd,
        ...(path ? { path } : {}),
      });
      httpLog.info("git_diff_loaded", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        projectId,
        cwd: project.cwd,
        path,
        truncated: diff.truncated,
      });
      response.json({ data: diff });
    } catch (error) {
      httpLog.error("git_diff_failed", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        projectId,
        cwd: project.cwd,
        path,
        error,
      });
      response.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/v1/projects/:projectId/git/checkout", authMiddleware, async (request, response) => {
    const projectId = assertNonEmptyString(request.params.projectId, "projectId");
    const traceId = getTraceId(response);
    const branch = assertNonEmptyString((request.body as { branch?: string }).branch, "branch");
    const projects = await loadProjectsForRequest(deps, traceId);
    const project = findProjectById(projects, projectId);

    if (!project) {
      response.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const git = await deps.contextStore.checkoutGitBranch({
        cwd: project.cwd,
        branch,
      });
      httpLog.info("git_branch_checked_out", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        projectId,
        cwd: project.cwd,
        branch,
      });
      response.json({ data: git });
    } catch (error) {
      httpLog.error("git_checkout_failed", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        projectId,
        cwd: project.cwd,
        branch,
        error,
      });
      response.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/v1/projects/:projectId/git/commit", authMiddleware, async (request, response) => {
    const projectId = assertNonEmptyString(request.params.projectId, "projectId");
    const traceId = getTraceId(response);
    const message = assertNonEmptyString((request.body as { message?: string }).message, "message");
    const projects = await loadProjectsForRequest(deps, traceId);
    const project = findProjectById(projects, projectId);

    if (!project) {
      response.status(404).json({ error: "Project not found" });
      return;
    }

    try {
      const committed = await deps.contextStore.commitGitChanges({
        cwd: project.cwd,
        message,
      });
      httpLog.info("git_commit_created", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        projectId,
        cwd: project.cwd,
        branch: committed.branch,
        commitHash: committed.commitHash,
      });
      response.json({ data: committed });
    } catch (error) {
      httpLog.error("git_commit_failed", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        projectId,
        cwd: project.cwd,
        error,
      });
      response.status(400).json({ error: (error as Error).message });
    }
  });

  app.patch("/v1/runtime/config", authMiddleware, async (request, response) => {
    const traceId = getTraceId(response);
    const body = request.body as { approvalPolicy?: string; sandboxMode?: string };
    const approvalPolicy = typeof body.approvalPolicy === "string" ? body.approvalPolicy : undefined;
    const sandboxMode = typeof body.sandboxMode === "string" ? body.sandboxMode : undefined;

    if (approvalPolicy === undefined && sandboxMode === undefined) {
      response.status(400).json({ error: "At least one runtime setting is required" });
      return;
    }

    try {
      const config = await deps.contextStore.updateRuntimeConfig({
        ...(approvalPolicy ? { approvalPolicy } : {}),
        ...(sandboxMode ? { sandboxMode } : {}),
      });
      httpLog.info("runtime_config_updated", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        approvalPolicy: config.approvalPolicy,
        sandboxMode: config.sandboxMode,
      });
      response.json({ data: config });
    } catch (error) {
      httpLog.error("runtime_config_update_failed", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        approvalPolicy,
        sandboxMode,
        error,
      });
      response.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/v1/chats", authMiddleware, async (request, response) => {
    const body = request.body as { cwd?: string; model?: string };
    const traceId = getTraceId(response);

    try {
      const thread = await createChatThread(deps, body, traceId);

      chatLog.info("chat_created", {
        traceId,
        chatId: thread.id,
        cwd: body.cwd,
        model: body.model,
      });
      response.status(201).json({ data: mapRawThread(thread) });
    } catch (error) {
      chatLog.error("chat_create_failed", {
        traceId,
        cwd: body.cwd,
        model: body.model,
        error,
      });
      response.status(500).json({ error: "Failed to create thread" });
    }
  });

  app.post("/v1/chats/start", authMiddleware, async (request, response) => {
    const traceId = getTraceId(response);
    let text: string | undefined;
    let attachments: ReturnType<typeof parseMessageAttachments>;
    let turnInput: ReturnType<typeof buildTurnStartInput>;
    let body: StartChatBody;

    try {
      body = request.body as StartChatBody;
      text = normalizeMessageText(body.text);
      attachments = parseMessageAttachments(body.attachments);
      turnInput = buildTurnStartInput(text, attachments);
    } catch (error) {
      chatLog.warn("chat_start_payload_invalid", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        error,
      });
      response.status(400).json({ error: (error as Error).message });
      return;
    }

    try {
      const thread = await createChatThread(deps, body, traceId);
      const turnResult = (await deps.codexClient.request("turn/start", {
        threadId: thread.id,
        input: turnInput,
      }, { traceId, chatId: thread.id })) as { turn?: { id?: string } };

      const turnId = turnResult.turn?.id;
      if (turnId) {
        deps.state.setTurnChat(turnId, thread.id, traceId);
      }

      const knownChat = deps.state.getKnownChat(thread.id);
      if (knownChat) {
        deps.state.rememberChat({
          ...knownChat,
          title:
            isPlaceholderChatTitle(knownChat.title)
            ? buildChatTitleSeed(text, attachments)
            : knownChat.title,
          updatedAt: Date.now(),
        });
      }
      const responseTitle = deps.state.getKnownChat(thread.id)?.title;
      const responseThread: RawThread = {
        ...thread,
        updatedAt: Date.now(),
        ...(responseTitle ? { name: responseTitle } : {}),
      };
      const responseChat = mapRawThread(responseThread);

      chatLog.info("chat_started_with_first_message", {
        traceId,
        chatId: thread.id,
        turnId,
        cwd: body.cwd,
        model: body.model,
        deviceId: response.locals.auth?.deviceId,
        ...summarizeUserTextMetadata(text),
        attachmentCount: attachments.length,
      });
      triggerDesktopSync(buildDesktopSyncRequest(thread.id, traceId, "message_sent"));
      response.status(201).json({
        data: {
          chat: responseChat,
          turnId,
        },
      });
    } catch (error) {
      chatLog.error("chat_start_with_first_message_failed", {
        traceId,
        cwd: body.cwd,
        model: body.model,
        deviceId: response.locals.auth?.deviceId,
        error,
      });
      response.status(500).json({ error: "Failed to start chat from the first message" });
    }
  });

  app.post("/v1/chats/:chatId/activate", authMiddleware, async (request, response) => {
    const chatId = assertNonEmptyString(request.params.chatId, "chatId");
    const traceId = getTraceId(response);

    try {
      const status = await activateChatSession(deps, chatId, traceId);
      chatLog.info("chat_activated", {
        traceId,
        chatId,
        status,
        deviceId: response.locals.auth?.deviceId,
      });
      triggerDesktopSync(buildDesktopSyncRequest(chatId, traceId, "chat_activated"));
      response.json({
        data: {
          chatId,
          status,
        },
      });
    } catch (error) {
      chatLog.error("chat_activate_failed", {
        traceId,
        chatId,
        deviceId: response.locals.auth?.deviceId,
        error,
      });
      response.status(502).json({ error: (error as Error).message });
    }
  });

  app.get("/v1/chats/:chatId/messages", authMiddleware, async (request, response) => {
    const chatId = assertNonEmptyString(request.params.chatId, "chatId");
    const traceId = getTraceId(response);

    try {
      const messages = await deps.historyStore.loadMessages(chatId);
      chatLog.info("chat_history_loaded", {
        traceId,
        chatId,
        deviceId: response.locals.auth?.deviceId,
        messageCount: messages.length,
      });
      response.json({ data: messages satisfies Message[] });
    } catch (error) {
      chatLog.error("chat_history_failed", {
        traceId,
        chatId,
        deviceId: response.locals.auth?.deviceId,
        error,
      });
      response.status(500).json({ error: "Failed to load chat history" });
    }
  });

  app.get("/v1/chats/:chatId/timeline", authMiddleware, async (request, response) => {
    const chatId = assertNonEmptyString(request.params.chatId, "chatId");
    const traceId = getTraceId(response);

    try {
      const storedTimeline = await deps.historyStore.loadTimeline(chatId);
      const liveActivities = deps.state.listChatActivities(chatId);
      const timeline: ChatTimeline = {
        messages: storedTimeline.messages,
        activities: mergeChatActivities(storedTimeline.activities, liveActivities),
      };

      chatLog.info("chat_timeline_loaded", {
        traceId,
        chatId,
        deviceId: response.locals.auth?.deviceId,
        messageCount: timeline.messages.length,
        activityCount: timeline.activities.length,
      });
      response.json({ data: timeline });
    } catch (error) {
      chatLog.error("chat_timeline_failed", {
        traceId,
        chatId,
        deviceId: response.locals.auth?.deviceId,
        error,
      });
      response.status(500).json({ error: "Failed to load chat timeline" });
    }
  });

  app.get("/v1/chats/:chatId/run-state", authMiddleware, async (request, response) => {
    const chatId = assertNonEmptyString(request.params.chatId, "chatId");
    const traceId = getTraceId(response);

    try {
      const runState = await loadChatRunState(deps, chatId, traceId);
      chatLog.info("chat_run_state_loaded", {
        traceId,
        chatId,
        deviceId: response.locals.auth?.deviceId,
        isRunning: runState.isRunning,
        activeTurnId: runState.activeTurnId,
      });
      response.json({ data: {
        chatId,
        isRunning: runState.isRunning,
        activeTurnId: runState.activeTurnId,
      } });
    } catch (error) {
      chatLog.error("chat_run_state_failed", {
        traceId,
        chatId,
        deviceId: response.locals.auth?.deviceId,
        error,
      });
      response.status(500).json({ error: "Failed to load chat run state" });
    }
  });

  app.post("/v1/chats/:chatId/messages", authMiddleware, async (request, response) => {
    const chatId = assertNonEmptyString(request.params.chatId, "chatId");
    const traceId = getTraceId(response);
    let text: string | undefined;
    let attachments: ReturnType<typeof parseMessageAttachments>;
    let turnInput: ReturnType<typeof buildTurnStartInput>;

    try {
      const body = request.body as SendChatMessageBody;
      text = normalizeMessageText(body.text);
      attachments = parseMessageAttachments(body.attachments);
      turnInput = buildTurnStartInput(text, attachments);
    } catch (error) {
      chatLog.warn("message_payload_invalid", {
        traceId,
        chatId,
        deviceId: response.locals.auth?.deviceId,
        error,
      });
      response.status(400).json({ error: (error as Error).message });
      return;
    }

    chatLog.info("message_received", {
      traceId,
      chatId,
      deviceId: response.locals.auth?.deviceId,
      ...summarizeUserTextMetadata(text),
      attachmentCount: attachments.length,
    });

    try {
      const activationStatus = await activateChatSession(deps, chatId, traceId);
      chatLog.debug("chat_activation_checked", {
        traceId,
        chatId,
        activationStatus,
      });
    } catch (error) {
      chatLog.warn("thread_resume_failed", {
        traceId,
        chatId,
        error,
      });
    }

    const turnResult = (await deps.codexClient.request("turn/start", {
      threadId: chatId,
      input: turnInput,
    }, { traceId, chatId })) as { turn?: { id?: string } };

    const turnId = turnResult.turn?.id;
    deps.state.markChatActive(chatId);
    const knownChat = deps.state.getKnownChat(chatId);
    if (knownChat) {
      deps.state.rememberChat({
        ...knownChat,
        title:
          isPlaceholderChatTitle(knownChat.title)
          ? buildChatTitleSeed(text, attachments)
          : knownChat.title,
        updatedAt: Date.now(),
      });
    }
    if (turnId) {
      deps.state.setTurnChat(turnId, chatId, traceId);
    }

    chatLog.info("turn_started", {
      traceId,
      chatId,
      turnId,
    });
    triggerDesktopSync(buildDesktopSyncRequest(chatId, traceId, "message_sent"));
    response.status(202).json({
      data: {
        chatId,
        turnId,
      },
    });
  });

  app.post("/v1/chats/:chatId/stop", authMiddleware, async (request, response) => {
    const chatId = assertNonEmptyString(request.params.chatId, "chatId");
    const traceId = getTraceId(response);

    try {
      const runState = await loadChatRunState(deps, chatId, traceId);
      if (!runState.activeTurnId) {
        chatLog.info("turn_stop_noop", {
          traceId,
          chatId,
          deviceId: response.locals.auth?.deviceId,
        });
        response.json({ data: {
          chatId,
          interrupted: false,
        } });
        return;
      }

      await deps.codexClient.request("turn/interrupt", {
        threadId: chatId,
        turnId: runState.activeTurnId,
      }, { traceId, chatId });
      deps.state.clearTurn(runState.activeTurnId);

      chatLog.info("turn_interrupt_requested", {
        traceId,
        chatId,
        turnId: runState.activeTurnId,
        deviceId: response.locals.auth?.deviceId,
      });
      response.json({ data: {
        chatId,
        interrupted: true,
        turnId: runState.activeTurnId,
      } });
    } catch (error) {
      chatLog.error("turn_interrupt_failed", {
        traceId,
        chatId,
        deviceId: response.locals.auth?.deviceId,
        error,
      });
      response.status(500).json({ error: "Failed to stop the active turn" });
    }
  });

  app.post("/v1/chats/:chatId/steer", authMiddleware, async (request, response) => {
    const chatId = assertNonEmptyString(request.params.chatId, "chatId");
    const traceId = getTraceId(response);
    let text: string | undefined;
    let attachments: ReturnType<typeof parseMessageAttachments>;
    let turnInput: ReturnType<typeof buildTurnStartInput>;

    try {
      const body = request.body as SendChatMessageBody;
      text = normalizeMessageText(body.text);
      attachments = parseMessageAttachments(body.attachments);
      turnInput = buildTurnStartInput(text, attachments);
    } catch (error) {
      chatLog.warn("steer_payload_invalid", {
        traceId,
        chatId,
        deviceId: response.locals.auth?.deviceId,
        error,
      });
      response.status(400).json({ error: (error as Error).message });
      return;
    }

    try {
      const activationStatus = await activateChatSession(deps, chatId, traceId);
      chatLog.debug("steer_activation_checked", {
        traceId,
        chatId,
        activationStatus,
      });
    } catch (error) {
      chatLog.warn("steer_thread_resume_failed", {
        traceId,
        chatId,
        error,
      });
    }

    try {
      const runState = await loadChatRunState(deps, chatId, traceId);
      let turnId: string | undefined;
      let deliveryMode: "steered" | "started" = "started";

      if (runState.activeTurnId) {
        const result = (await deps.codexClient.request("turn/steer", {
          threadId: chatId,
          input: turnInput,
          expectedTurnId: runState.activeTurnId,
        }, { traceId, chatId })) as { turnId?: string };
        turnId = result.turnId;
        deliveryMode = "steered";
      } else {
        const result = (await deps.codexClient.request("turn/start", {
          threadId: chatId,
          input: turnInput,
        }, { traceId, chatId })) as { turn?: { id?: string } };
        turnId = result.turn?.id;
      }

      deps.state.markChatActive(chatId);
      const knownChat = deps.state.getKnownChat(chatId);
      if (knownChat) {
        deps.state.rememberChat({
          ...knownChat,
          title:
            isPlaceholderChatTitle(knownChat.title)
            ? buildChatTitleSeed(text, attachments)
            : knownChat.title,
          updatedAt: Date.now(),
        });
      }
      if (turnId) {
        deps.state.setTurnChat(turnId, chatId, traceId);
      }

      chatLog.info("turn_steer_requested", {
        traceId,
        chatId,
        turnId,
        deliveryMode,
        deviceId: response.locals.auth?.deviceId,
        ...summarizeUserTextMetadata(text),
        attachmentCount: attachments.length,
      });
      triggerDesktopSync(buildDesktopSyncRequest(chatId, traceId, "message_sent"));
      response.status(202).json({ data: {
        chatId,
        turnId,
        mode: deliveryMode,
      } });
    } catch (error) {
      chatLog.error("turn_steer_failed", {
        traceId,
        chatId,
        deviceId: response.locals.auth?.deviceId,
        error,
      });
      response.status(500).json({ error: "Failed to steer the active turn" });
    }
  });

  app.post("/v1/dictation/transcribe", authMiddleware, async (request, response) => {
    const traceId = getTraceId(response);
    const body = request.body as {
      audioBase64?: unknown;
      filename?: unknown;
      mimeType?: unknown;
      language?: unknown;
    };

    try {
      const audioBase64 = assertNonEmptyString(body.audioBase64, "audioBase64");
      const filename = assertNonEmptyString(body.filename, "filename");
      const mimeType = assertNonEmptyString(body.mimeType, "mimeType");
      const language = typeof body.language === "string" && body.language.trim().length > 0
        ? body.language.trim()
        : undefined;
      const audioBuffer = Buffer.from(audioBase64, "base64");

      if (audioBuffer.length === 0) {
        throw new Error("Audio recording is empty.");
      }

      const result = await transcriptionService.transcribe({
        audioBuffer,
        filename,
        mimeType,
        ...(language ? { language } : {}),
      });

      chatLog.info("dictation_transcribed", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        filename,
        mimeType,
        bytes: audioBuffer.length,
        language,
        transcriptLength: result.text.length,
        model: result.model,
      });

      response.json({ data: result });
    } catch (error) {
      const statusCode = error instanceof TranscriptionServiceError ? error.statusCode : 400;
      chatLog.warn("dictation_transcribe_failed", {
        traceId,
        deviceId: response.locals.auth?.deviceId,
        error,
      });
      response.status(statusCode).json({ error: (error as Error).message });
    }
  });

  app.post("/v1/approvals/:approvalId", authMiddleware, async (request, response) => {
    const approvalId = assertNonEmptyString(request.params.approvalId, "approvalId");
    const body = request.body as { decision?: ApprovalDecision };
    const decision = assertNonEmptyString(body.decision, "decision") as ApprovalDecision;
    const traceId = getTraceId(response);

    const pending = deps.state.popApproval(approvalId);
    if (!pending) {
      chatLog.warn("approval_not_found", { traceId, approvalId, decision });
      response.status(404).json({ error: "Approval request not found" });
      return;
    }

    if (decision === "allow_for_session") {
      deps.state.enableSessionAllow(pending.chatId);
    }

    deps.codexClient.respond(pending.jsonRpcId, normalizeDecision(decision));
    chatLog.info("approval_responded", {
      traceId,
      approvalId,
      chatId: pending.chatId,
      decision,
      sessionAllowEnabled: decision === "allow_for_session",
    });

    response.json({ ok: true });
  });

  let server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>;
  if (deps.config.tlsKeyPath && deps.config.tlsCertPath) {
    const [key, cert] = await Promise.all([
      readFile(deps.config.tlsKeyPath),
      readFile(deps.config.tlsCertPath),
    ]);
    server = createHttpsServer({ key, cert }, app);
  } else {
    server = createHttpServer(app);
    // eslint-disable-next-line no-console
    console.warn("[security] TLS is not configured. Use Tailscale-only network access.");
  }

  const wsServer = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (request, socket, head) => {
    const { pathname, query } = parseUrl(request.url ?? "", true);
    const traceId =
      (typeof request.headers["x-codex-trace-id"] === "string" && request.headers["x-codex-trace-id"]) ||
      randomUUID();
    if (pathname !== "/v1/stream") {
      streamLog.warn("upgrade_rejected_path", { traceId, pathname });
      socket.destroy();
      return;
    }

    const tokenFromHeader = request.headers.authorization?.toString().startsWith("Bearer ")
      ? request.headers.authorization.toString().slice("Bearer ".length)
      : undefined;
    const token = tokenFromHeader;
    const chatId = typeof query.chatId === "string" ? query.chatId : undefined;

    if (!token || !chatId) {
      streamLog.warn("upgrade_missing_auth", { traceId, chatId });
      socket.destroy();
      return;
    }

    const valid = await deps.tokenStore.validateToken(token);
    if (!valid) {
      streamLog.warn("upgrade_invalid_token", { traceId, chatId });
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (ws) => {
      const set = connectionsByChat.get(chatId) ?? new Set();
      set.add(ws);
      connectionsByChat.set(chatId, set);
      streamLog.info("socket_opened", {
        traceId,
        chatId,
        deviceId: valid.deviceId,
        connectionCount: set.size,
      });

      ws.on("close", () => {
        const current = connectionsByChat.get(chatId);
        if (!current) {
          return;
        }
        current.delete(ws);
        streamLog.info("socket_closed", {
          traceId,
          chatId,
          deviceId: valid.deviceId,
          connectionCount: current.size,
        });
        if (current.size === 0) {
          connectionsByChat.delete(chatId);
        }
      });
    });
  });

  deps.codexClient.on("notification", (event: CodexNotificationEvent) => {
    const turnId = extractTurnIdFromCodexPayload(event.params);
    const traceId = turnId ? deps.state.getTraceByTurn(turnId) : undefined;
    syncTurnStateFromNotification(event, deps.state, traceId);
    const streamEvent = mapNotificationToStreamEvent(event, deps.state);
    streamLog.debug("codex_notification", {
      traceId,
      method: event.method,
      chatId: streamEvent?.chatId,
      turnId,
    });
    if (!streamEvent) {
      return;
    }
    deps.state.markChatActive(streamEvent.chatId);
    syncChatActivitiesFromNotification(event, deps.state, streamEvent.chatId, streamEvent.timestamp);
    broadcastEvent(connectionsByChat, streamEvent);
    streamLog.info("event_broadcast", {
      traceId,
      event: streamEvent.event,
      chatId: streamEvent.chatId,
      connectionCount: connectionsByChat.get(streamEvent.chatId)?.size ?? 0,
    });
  });

  deps.codexClient.on("serverRequest", (event: CodexServerRequestEvent) => {
    if (
      event.method !== "item/commandExecution/requestApproval" &&
      event.method !== "item/fileChange/requestApproval"
    ) {
      return;
    }

    const params = (event.params ?? {}) as Record<string, unknown>;
    const chatId =
      typeof params.threadId === "string"
        ? params.threadId
        : typeof params.turnId === "string"
          ? deps.state.getChatByTurn(params.turnId)
          : undefined;
    const traceId =
      typeof params.turnId === "string" ? deps.state.getTraceByTurn(params.turnId) : undefined;

    if (!chatId) {
      chatLog.warn("approval_request_missing_chat", {
        traceId,
        method: event.method,
        requestId: event.id,
      });
      deps.codexClient.respond(event.id, "decline");
      return;
    }

    if (deps.state.isSessionAllowEnabled(chatId)) {
      chatLog.info("approval_auto_accepted", {
        traceId,
        chatId,
        method: event.method,
      });
      deps.codexClient.respond(event.id, "accept");
      return;
    }

    const mapped = mapApprovalSummary(event);
    const pending = deps.state.createApproval({
      jsonRpcId: event.id,
      chatId,
      kind: mapped.kind,
      summary: mapped.summary,
    });

    const approvalEvent: StreamEvent = {
      event: "approval_required",
      chatId,
      payload: {
        id: pending.approvalId,
        kind: pending.kind,
        summary: pending.summary,
        riskLevel: pending.kind === "command" ? "high" : "medium",
        createdAt: pending.createdAt,
      } satisfies ApprovalRequest,
      timestamp: Date.now(),
    };

    chatLog.info("approval_requested", {
      traceId,
      chatId,
      approvalId: pending.approvalId,
      kind: pending.kind,
      summary: pending.summary,
    });
    broadcastEvent(connectionsByChat, approvalEvent);
  });

  return {
    listen: async () => {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(deps.config.port, deps.config.host, () => {
          resolve();
        });
      });
    },
    close: async () => {
      for (const sockets of connectionsByChat.values()) {
        for (const socket of sockets) {
          socket.close();
        }
      }
      await new Promise<void>((resolve) => {
        wsServer.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    address: () => server.address(),
  };
}

function getTraceId(response: Response): string | undefined {
  return typeof response.locals.traceId === "string" ? response.locals.traceId : undefined;
}

function summarizeQuery(query: Request["query"]): Record<string, unknown> {
  const entries = Object.entries(query);
  if (entries.length === 0) {
    return {};
  }

  return Object.fromEntries(entries.map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : value]));
}

function extractTurnIdFromCodexPayload(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }

  const typed = params as Record<string, unknown>;
  if (typeof typed.turnId === "string") {
    return typed.turnId;
  }

  if (typed.turn && typeof typed.turn === "object") {
    const turn = typed.turn as Record<string, unknown>;
    if (typeof turn.id === "string") {
      return turn.id;
    }
  }

  return undefined;
}

function isLoopbackRequest(request: Request): boolean {
  const remoteAddress = request.socket.remoteAddress ?? "";
  return (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1"
  );
}
