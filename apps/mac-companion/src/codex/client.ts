import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

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

export class CodexAppServerClient extends EventEmitter {
  private readonly codexCommand: string;
  private process: ChildProcessWithoutNullStreams | undefined;
  private requestId = 1;
  private readonly pendingRequests = new Map<number | string, PendingRequest>();

  public constructor(codexCommand: string) {
    super();
    this.codexCommand = codexCommand;
  }

  public async start(): Promise<void> {
    this.process = spawn(this.codexCommand, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stderr.on("data", (chunk) => {
      this.emit("stderr", chunk.toString());
    });

    this.process.on("exit", (code) => {
      const error = new Error(`codex app-server exited with code ${code ?? "unknown"}`);
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

    await this.initialize();
  }

  public async stop(): Promise<void> {
    if (!this.process) {
      return;
    }
    this.process.kill();
    this.process = undefined;
  }

  public async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.requestId++;
    const payload: JsonRpcMessage = { id, method, params };

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });

    this.send(payload);
    return promise;
  }

  public notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  public respond(id: number | string, result: unknown): void {
    this.send({ id, result });
  }

  private async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: {
        name: "codex_remote_companion",
        title: "Codex Remote Mac Companion",
        version: "0.1.0",
      },
    });
    this.notify("initialized", {});
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
        pending.reject(new Error(parsed.error.message ?? "Unknown JSON-RPC error"));
        return;
      }
      pending.resolve(parsed.result);
      return;
    }

    if (parsed.method && parsed.id !== undefined) {
      this.emit("serverRequest", {
        id: parsed.id,
        method: parsed.method,
        params: parsed.params,
      } satisfies CodexServerRequestEvent);
      return;
    }

    if (parsed.method) {
      this.emit("notification", {
        method: parsed.method,
        params: parsed.params,
      } satisfies CodexNotificationEvent);
    }
  }
}
