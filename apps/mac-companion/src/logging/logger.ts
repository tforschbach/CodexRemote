import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  source: string;
  event: string;
  traceId?: string;
  [key: string]: unknown;
}

interface LogRecord extends LogFields {
  timestamp: string;
  level: LogLevel;
}

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function serializeValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map((entry) => serializeValue(entry));
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      const serialized = serializeValue(nested);
      if (serialized !== undefined) {
        result[key] = serialized;
      }
    }
    return result;
  }

  return String(value);
}

export class CompanionLogContext {
  private readonly defaults: Record<string, unknown>;
  private readonly logger: CompanionLogger;

  public constructor(logger: CompanionLogger, defaults: Record<string, unknown>) {
    this.logger = logger;
    this.defaults = defaults;
  }

  public child(defaults: Record<string, unknown>): CompanionLogContext {
    return new CompanionLogContext(this.logger, { ...this.defaults, ...defaults });
  }

  public debug(event: string, fields: Record<string, unknown> = {}): void {
    this.logger.debug({ ...this.defaults, ...fields, event } as LogFields);
  }

  public info(event: string, fields: Record<string, unknown> = {}): void {
    this.logger.info({ ...this.defaults, ...fields, event } as LogFields);
  }

  public warn(event: string, fields: Record<string, unknown> = {}): void {
    this.logger.warn({ ...this.defaults, ...fields, event } as LogFields);
  }

  public error(event: string, fields: Record<string, unknown> = {}): void {
    this.logger.error({ ...this.defaults, ...fields, event } as LogFields);
  }
}

export class CompanionLogger {
  private readonly path: string;
  private readonly minLevel: LogLevel;
  private writeChain = Promise.resolve();

  public constructor(path: string, minLevel: LogLevel) {
    this.path = path;
    this.minLevel = minLevel;
  }

  public child(defaults: Record<string, unknown>): CompanionLogContext {
    return new CompanionLogContext(this, defaults);
  }

  public debug(fields: LogFields): void {
    this.write("debug", fields);
  }

  public info(fields: LogFields): void {
    this.write("info", fields);
  }

  public warn(fields: LogFields): void {
    this.write("warn", fields);
  }

  public error(fields: LogFields): void {
    this.write("error", fields);
  }

  public async flush(): Promise<void> {
    await this.writeChain;
  }

  private write(level: LogLevel, fields: LogFields): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.minLevel]) {
      return;
    }

    const record = serializeValue({
      timestamp: new Date().toISOString(),
      level,
      ...fields,
    }) as LogRecord;

    const line = JSON.stringify(record);
    this.echo(level, record, line);

    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, `${line}\n`, "utf8");
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error("[logger] failed to persist log line", error);
      });
  }

  private echo(level: LogLevel, record: LogRecord, line: string): void {
    const prefix = `[${level}] ${record.source}:${record.event}`;
    if (level === "error") {
      // eslint-disable-next-line no-console
      console.error(prefix, line);
      return;
    }

    if (level === "warn") {
      // eslint-disable-next-line no-console
      console.warn(prefix, line);
      return;
    }

    // eslint-disable-next-line no-console
    console.log(prefix, line);
  }
}

export function summarizeText(value: string, maxLength = 120): { preview: string; length: number } {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return { preview: normalized, length: normalized.length };
  }
  return {
    preview: `${normalized.slice(0, maxLength - 1)}...`,
    length: normalized.length,
  };
}
