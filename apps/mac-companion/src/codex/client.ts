import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import type { CompanionLogContext } from "../logging/logger.js";

interface JsonRpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  traceId: string | undefined;
}

export interface CodexRequestMeta {
  traceId?: string | undefined;
  chatId?: string | undefined;
}

export interface CodexNotificationEvent {
  method: string;
  params: unknown;
}

export interface CodexServerRequestEvent {
  id: number | string;
  method: string;
  params: unknown;
}

export interface CodexClientBridge {
  request(method: string, params?: unknown, meta?: CodexRequestMeta): Promise<unknown>;
  respond(id: number | string, result: unknown): void;
  on(event: "notification", listener: (event: CodexNotificationEvent) => void): this;
  on(event: "serverRequest", listener: (event: CodexServerRequestEvent) => void): this;
}

export class CodexAppServerClient extends EventEmitter {
  private readonly codexCommand: string;
  private readonly logger: CompanionLogContext | undefined;
  private readonly startTimeoutMs: number;
  private process: ChildProcessWithoutNullStreams | undefined;
  private requestId = 1;
  private readonly pendingRequests = new Map<number | string, PendingRequest>();

  public constructor(codexCommand: string, logger?: CompanionLogContext, startTimeoutMs = 15_000) {
    super();
    this.codexCommand = codexCommand;
    this.logger = logger;
    this.startTimeoutMs = startTimeoutMs;
  }

  public async start(): Promise<void> {
    this.process = spawn(this.codexCommand, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.logger?.info("spawned", {
      command: this.codexCommand,
      args: ["app-server"],
      startTimeoutMs: this.startTimeoutMs,
    });

    this.process.stderr.on("data", (chunk) => {
      this.emit("stderr", chunk.toString());
    });

    this.process.on("exit", (code) => {
      const error = new Error(`codex app-server exited with code ${code ?? "unknown"}`);
      this.logger?.error("process_exit", { code: code ?? "unknown", pendingRequests: this.pendingRequests.size });
      for (const pending of this.pendingRequests.values()) {
        pending.reject(error);
      }
      this.pendingRequests.clear();
      this.emit("exit", code);
    });

    const rl = readline.createInterface({ input: this.process.stdout });
    rl.on("line", (line) => {
      this.handleIncomingLine(line);
    });

    try {
      await this.initialize();
    } catch (error) {
      this.logger?.error("initialize_failed", { error });
      this.process.kill();
      this.process = undefined;
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (!this.process) {
      return;
    }
    this.logger?.info("stop_requested");
    this.process.kill();
    this.process = undefined;
  }

  public async request(method: string, params?: unknown, meta: CodexRequestMeta = {}): Promise<unknown> {
    const id = this.requestId++;
    const payload: JsonRpcMessage = { id, method, params };

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject, method, traceId: meta.traceId });
    });

    this.logger?.debug("request_sent", {
      traceId: meta.traceId,
      requestId: id,
      method,
      chatId: meta.chatId,
      params: summarizeParamsForLogging(params),
    });
    this.send(payload);
    return promise;
  }

  public notify(method: string, params?: unknown): void {
    this.logger?.debug("notification_sent", {
      method,
      params: summarizeParamsForLogging(params),
    });
    this.send({ method, params });
  }

  public respond(id: number | string, result: unknown): void {
    this.logger?.debug("response_sent", {
      requestId: id,
      result: summarizeParamsForLogging(result),
    });
    this.send({ id, result });
  }

  private async initialize(): Promise<void> {
    this.logger?.info("initialize_started", { startTimeoutMs: this.startTimeoutMs });
    await withTimeout(
      this.request("initialize", {
        clientInfo: {
          name: "codex_remote_companion",
          title: "Codex Remote Mac Companion",
          version: "0.1.4",
        },
      }),
      this.startTimeoutMs,
      `codex app-server initialize timed out after ${this.startTimeoutMs}ms`,
    );
    this.notify("initialized", {});
    this.logger?.info("initialize_completed");
  }

  private send(payload: JsonRpcMessage): void {
    if (!this.process) {
      throw new Error("codex app-server process is not running");
    }
    this.process.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleIncomingLine(line: string): void {
    let parsed: JsonRpcMessage;
    try {
      parsed = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.logger?.warn("parse_error", { line });
      this.emit("parseError", line);
      return;
    }

    if (parsed.id !== undefined && ("result" in parsed || "error" in parsed)) {
      const pending = this.pendingRequests.get(parsed.id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(parsed.id);

      if (parsed.error) {
        this.logger?.warn("request_failed", {
          traceId: pending.traceId,
          requestId: parsed.id,
          method: pending.method,
          error: parsed.error.message ?? "Unknown JSON-RPC error",
        });
        pending.reject(new Error(parsed.error.message ?? "Unknown JSON-RPC error"));
        return;
      }
      this.logger?.debug("response_received", {
        traceId: pending.traceId,
        requestId: parsed.id,
        method: pending.method,
        result: summarizeParamsForLogging(parsed.result),
      });
      pending.resolve(parsed.result);
      return;
    }

    if (parsed.method && parsed.id !== undefined) {
      this.logger?.debug("server_request_received", {
        requestId: parsed.id,
        method: parsed.method,
        params: summarizeParamsForLogging(parsed.params),
      });
      this.emit("serverRequest", {
        id: parsed.id,
        method: parsed.method,
        params: parsed.params,
      } satisfies CodexServerRequestEvent);
      return;
    }

    if (parsed.method) {
      this.logger?.debug("notification_received", {
        method: parsed.method,
        params: summarizeParamsForLogging(parsed.params),
      });
      this.emit("notification", {
        method: parsed.method,
        params: parsed.params,
      } satisfies CodexNotificationEvent);
    }
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function summarizeStringMetadata(value: string): { length: number } {
  const normalized = value.replace(/\s+/g, " ").trim();
  return { length: normalized.length };
}

export function summarizeParamsForLogging(value: unknown): unknown {
  if (typeof value === "string") {
    return summarizeStringMetadata(value);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const typed = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};

  for (const key of ["threadId", "turnId", "command", "reason", "cwd", "sortKey", "limit"]) {
    if (typed[key] !== undefined) {
      summary[key] = typed[key];
    }
  }

  if (Array.isArray(typed.input) && typed.input.length > 0) {
    summary.inputCount = typed.input.length;

    const inputTypes: string[] = [];
    let inputTextLength = 0;

    for (const entry of typed.input) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const input = entry as Record<string, unknown>;
      if (typeof input.type === "string") {
        inputTypes.push(input.type);
      }
      if (typeof input.text === "string") {
        inputTextLength += input.text.length;
      }
    }

    if (inputTypes.length > 0) {
      summary.inputTypes = inputTypes;
    }
    if (inputTextLength > 0) {
      summary.inputTextLength = inputTextLength;
    }
  }

  if (typed.turn && typeof typed.turn === "object") {
    const turn = typed.turn as Record<string, unknown>;
    summary.turn = {
      id: turn.id,
      threadId: turn.threadId,
    };
  }

  if (Object.keys(summary).length > 0) {
    return summary;
  }

  return {
    keys: Object.keys(typed).sort(),
  };
}
