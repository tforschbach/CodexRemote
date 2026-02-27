import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { parse as parseUrl } from "node:url";
import { readFile } from "node:fs/promises";

import express from "express";
import QRCode from "qrcode";
import { WebSocketServer } from "ws";
import {
  assertNonEmptyString,
  type ApprovalDecision,
  type ApprovalRequest,
  type PairingConfirmRequest,
  type PairingRequestResponse,
  type StreamEvent,
} from "@codex-remote/protocol";

import type { AppConfig } from "../config.js";
import type { TokenStore } from "../auth/token-store.js";
import type { PairingStore } from "../pairing/pairing-store.js";
import { confirmPairingOnMac } from "../platform/macos-confirm.js";
import type { CodexAppServerClient, CodexNotificationEvent, CodexServerRequestEvent } from "../codex/client.js";
import { buildAuthMiddleware } from "./auth.js";
import { broadcastEvent } from "./broadcast.js";
import { buildProjectsFromThreads, mapRawThread } from "./mapping.js";
import type { ConnectionRegistry } from "./types.js";
import type { SessionState } from "../state/session-state.js";

interface Dependencies {
  config: AppConfig;
  tokenStore: TokenStore;
  pairingStore: PairingStore;
  codexClient: CodexAppServerClient;
  state: SessionState;
}

interface RawThread {
  id: string;
  preview?: string;
  name?: string;
  cwd?: string;
  updatedAt?: number;
  createdAt?: number;
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

export async function createCompanionServer(deps: Dependencies): Promise<{
  listen: () => Promise<void>;
}> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const connectionsByChat: ConnectionRegistry = new Map();

  const authMiddleware = buildAuthMiddleware(deps.tokenStore);

  app.get("/health", (_request, response) => {
    response.json({ ok: true, service: "codex-remote-mac-companion" });
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

    response.json(body);
  });

  app.post("/v1/pairing/confirm", async (request, response) => {
    try {
      const body = request.body as Partial<PairingConfirmRequest>;
      const pairingId = assertNonEmptyString(body.pairingId, "pairingId");
      const nonce = assertNonEmptyString(body.nonce, "nonce");
      const deviceName = assertNonEmptyString(body.deviceName, "deviceName");

      const consumed = deps.pairingStore.consumeSession(pairingId, nonce);
      if (!consumed) {
        response.status(400).json({ error: "Invalid or expired pairing session" });
        return;
      }

      const allowed = await confirmPairingOnMac({
        deviceName,
        pairingId,
        timeoutSeconds: deps.config.pairingConfirmTimeoutSeconds,
      });

      if (!allowed) {
        response.status(403).json({ error: "Pairing denied or timed out" });
        return;
      }

      const issued = await deps.tokenStore.issueDeviceToken(
        body.devicePublicKey
          ? { deviceName, devicePublicKey: body.devicePublicKey }
          : { deviceName },
      );

      response.json(issued);
    } catch (error) {
      response.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/v1/pairing/revoke", authMiddleware, async (request, response) => {
    const body = request.body as { deviceId?: string };
    if (body.deviceId) {
      const revoked = await deps.tokenStore.revokeDevice(body.deviceId);
      response.json({ revoked });
      return;
    }

    const header = request.header("authorization") ?? "";
    const token = header.slice("Bearer ".length).trim();
    const revoked = await deps.tokenStore.revokeByToken(token);
    response.json({ revoked });
  });

  app.get("/v1/projects", authMiddleware, async (_request, response) => {
    const result = (await deps.codexClient.request("thread/list", {
      sortKey: "updated_at",
      limit: 200,
    })) as { data?: RawThread[] };

    const projects = buildProjectsFromThreads(result.data ?? []);
    response.json({ data: projects });
  });

  app.get("/v1/chats", authMiddleware, async (request, response) => {
    const projectId = typeof request.query.projectId === "string" ? request.query.projectId : undefined;

    const result = (await deps.codexClient.request("thread/list", {
      sortKey: "updated_at",
      limit: 200,
    })) as { data?: RawThread[] };

    const chats = (result.data ?? []).map(mapRawThread);
    const filtered = projectId ? chats.filter((chat) => chat.projectId === projectId) : chats;

    response.json({ data: filtered.sort((a, b) => b.updatedAt - a.updatedAt) });
  });

  app.post("/v1/chats", authMiddleware, async (request, response) => {
    const body = request.body as { cwd?: string; model?: string };

    const result = (await deps.codexClient.request("thread/start", {
      cwd: body.cwd,
      model: body.model,
    })) as { thread?: RawThread };

    if (!result.thread) {
      response.status(500).json({ error: "Failed to create thread" });
      return;
    }

    response.status(201).json({ data: mapRawThread(result.thread) });
  });

  app.post("/v1/chats/:chatId/messages", authMiddleware, async (request, response) => {
    const chatId = assertNonEmptyString(request.params.chatId, "chatId");
    const body = request.body as { text?: string };
    const text = assertNonEmptyString(body.text, "text");

    try {
      await deps.codexClient.request("thread/resume", { threadId: chatId });
    } catch {
      // Ignore resume errors and try turn/start directly.
    }

    const turnResult = (await deps.codexClient.request("turn/start", {
      threadId: chatId,
      input: [{ type: "text", text }],
    })) as { turn?: { id?: string } };

    const turnId = turnResult.turn?.id;
    if (turnId) {
      deps.state.setTurnChat(turnId, chatId);
    }

    response.status(202).json({
      data: {
        chatId,
        turnId,
      },
    });
  });

  app.post("/v1/approvals/:approvalId", authMiddleware, async (request, response) => {
    const approvalId = assertNonEmptyString(request.params.approvalId, "approvalId");
    const body = request.body as { decision?: ApprovalDecision };
    const decision = assertNonEmptyString(body.decision, "decision") as ApprovalDecision;

    const pending = deps.state.popApproval(approvalId);
    if (!pending) {
      response.status(404).json({ error: "Approval request not found" });
      return;
    }

    if (decision === "allow_for_session") {
      deps.state.enableSessionAllow(pending.chatId);
    }

    deps.codexClient.respond(pending.jsonRpcId, normalizeDecision(decision));

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
    if (pathname !== "/v1/stream") {
      socket.destroy();
      return;
    }

    const tokenFromHeader = request.headers.authorization?.toString().startsWith("Bearer ")
      ? request.headers.authorization.toString().slice("Bearer ".length)
      : undefined;

    const tokenFromQuery = typeof query.token === "string" ? query.token : undefined;
    const token = tokenFromHeader ?? tokenFromQuery;
    const chatId = typeof query.chatId === "string" ? query.chatId : undefined;

    if (!token || !chatId) {
      socket.destroy();
      return;
    }

    const valid = await deps.tokenStore.validateToken(token);
    if (!valid) {
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (ws) => {
      const set = connectionsByChat.get(chatId) ?? new Set();
      set.add(ws);
      connectionsByChat.set(chatId, set);

      ws.on("close", () => {
        const current = connectionsByChat.get(chatId);
        if (!current) {
          return;
        }
        current.delete(ws);
        if (current.size === 0) {
          connectionsByChat.delete(chatId);
        }
      });
    });
  });

  deps.codexClient.on("notification", (event: CodexNotificationEvent) => {
    const streamEvent = mapNotificationToStreamEvent(event, deps.state);
    if (!streamEvent) {
      return;
    }
    broadcastEvent(connectionsByChat, streamEvent);
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

    if (!chatId) {
      deps.codexClient.respond(event.id, "decline");
      return;
    }

    if (deps.state.isSessionAllowEnabled(chatId)) {
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
  };
}
