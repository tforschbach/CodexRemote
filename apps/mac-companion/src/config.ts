import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { LogLevel } from "./logging/logger.js";

export interface AppConfig {
  host: string;
  port: number;
  pairingTtlSeconds: number;
  pairingConfirmTimeoutSeconds: number;
  codexCommand: string;
  codexStartTimeoutMs: number;
  codexHomePath: string;
  codexSessionsPath: string;
  tailscaleHost: string;
  tokenStorePath: string;
  tlsKeyPath: string | undefined;
  tlsCertPath: string | undefined;
  traceLogPath: string;
  traceLogLevel: LogLevel;
  enableDebugEndpoints: boolean;
  desktopSyncEnabled: boolean;
  desktopSyncReloadDelayMs: number;
  desktopSyncCommandTimeoutMs: number;
  codexMacAppName: string;
  codexMacAppPath: string | undefined;
  codexMacBundleId: string | undefined;
  openaiApiKey: string | undefined;
  openaiBaseUrl: string;
  openaiTranscriptionModel: string;
}

type EnvLike = NodeJS.ProcessEnv;
type ExecFileSyncText = (file: string, args: readonly string[], options: {
  encoding: "utf8";
  stdio: ["ignore", "pipe", "ignore"];
}) => string;

function resolveTailscaleIPv4(
  env: EnvLike,
  execFileSyncImpl: ExecFileSyncText = execFileSync as ExecFileSyncText,
): string | undefined {
  const cliCandidates = [
    env.TAILSCALE_CLI_PATH,
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "tailscale",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of cliCandidates) {
    try {
      const output = execFileSyncImpl(candidate, ["ip", "-4"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const ip = output
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);

      if (ip) {
        return ip;
      }
    } catch {
      // Fall back to safer defaults when the Tailscale CLI is unavailable.
    }
  }

  return undefined;
}

export function resolvePairingHost(
  env: EnvLike,
  execFileSyncImpl: ExecFileSyncText = execFileSync as ExecFileSyncText,
): string {
  if (env.TAILSCALE_HOST) {
    return env.TAILSCALE_HOST;
  }

  const tailscaleIp = resolveTailscaleIPv4(env, execFileSyncImpl);
  if (tailscaleIp) {
    return tailscaleIp;
  }

  return env.HOSTNAME ?? "mac";
}

export function resolveBindHost(
  env: EnvLike,
  execFileSyncImpl: ExecFileSyncText = execFileSync as ExecFileSyncText,
): string {
  if (env.BIND_HOST) {
    return env.BIND_HOST;
  }

  if (env.TAILSCALE_BIND_HOST) {
    return env.TAILSCALE_BIND_HOST;
  }

  if (env.TAILSCALE_HOST) {
    return env.TAILSCALE_HOST;
  }

  return resolveTailscaleIPv4(env, execFileSyncImpl) ?? "127.0.0.1";
}

function parseIntOrDefault(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function parseLogLevel(value: string | undefined): LogLevel {
  switch (value) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return value;
    default:
      return "info";
  }
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function parseEnvFileContents(contents: string): Record<string, string> {
  const parsed: Record<string, string> = {};

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    parsed[key] = stripWrappingQuotes(rawValue);
  }

  return parsed;
}

export function loadEnvFileValues(repoRoot: string): Record<string, string> {
  const merged: Record<string, string> = {};

  for (const filename of [".env", ".env.local"]) {
    const filePath = join(repoRoot, filename);
    if (!existsSync(filePath)) {
      continue;
    }

    Object.assign(merged, parseEnvFileContents(readFileSync(filePath, "utf8")));
  }

  return merged;
}

export function resolveRuntimeEnv(
  env: EnvLike = process.env,
  repoRoot = resolveRepoRoot(),
): EnvLike {
  return {
    ...loadEnvFileValues(repoRoot),
    ...env,
  };
}

function hasWorkspaceConfig(dir: string): boolean {
  const packagePath = join(dir, "package.json");
  if (!existsSync(packagePath)) {
    return false;
  }

  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { workspaces?: unknown };
    return Array.isArray(parsed.workspaces);
  } catch {
    return false;
  }
}

export function resolveRepoRoot(currentDir = dirname(fileURLToPath(import.meta.url))): string {
  let searchDir = resolve(currentDir);

  for (let depth = 0; depth < 6; depth += 1) {
    if (hasWorkspaceConfig(searchDir)) {
      return searchDir;
    }

    const parentDir = resolve(searchDir, "..");
    if (parentDir === searchDir) {
      break;
    }
    searchDir = parentDir;
  }

  return process.cwd();
}

export function loadConfig(
  env: EnvLike = resolveRuntimeEnv(),
  repoRoot = resolveRepoRoot(),
): AppConfig {
  const home = homedir();
  const codexHomePath = env.CODEX_HOME ?? join(home, ".codex");
  return {
    host: resolveBindHost(env),
    port: parseIntOrDefault(env.PORT, 8787),
    pairingTtlSeconds: parseIntOrDefault(env.PAIRING_TTL_SECONDS, 180),
    pairingConfirmTimeoutSeconds: parseIntOrDefault(
      env.PAIRING_CONFIRM_TIMEOUT_SECONDS,
      30,
    ),
    codexCommand: env.CODEX_COMMAND ?? "codex",
    codexStartTimeoutMs: parseIntOrDefault(env.CODEX_START_TIMEOUT_MS, 15_000),
    codexHomePath,
    codexSessionsPath: env.CODEX_SESSIONS_PATH ?? join(codexHomePath, "sessions"),
    tailscaleHost: resolvePairingHost(env),
    tokenStorePath:
      env.TOKEN_STORE_PATH ?? join(home, ".codex-remote", "devices.json"),
    tlsKeyPath: env.TLS_KEY_PATH,
    tlsCertPath: env.TLS_CERT_PATH,
    traceLogPath:
      env.COMPANION_TRACE_LOG_PATH ?? join(repoRoot, "logs", "companion.ndjson"),
    traceLogLevel: parseLogLevel(env.COMPANION_TRACE_LOG_LEVEL),
    enableDebugEndpoints: env.COMPANION_ENABLE_DEBUG_ENDPOINTS === "1",
    desktopSyncEnabled: env.CODEX_DESKTOP_SYNC_ENABLED !== "0",
    desktopSyncReloadDelayMs: parseIntOrDefault(env.CODEX_DESKTOP_SYNC_DELAY_MS, 250),
    desktopSyncCommandTimeoutMs: parseIntOrDefault(
      env.CODEX_DESKTOP_SYNC_COMMAND_TIMEOUT_MS,
      5_000,
    ),
    codexMacAppName: env.CODEX_MAC_APP_NAME ?? "Codex",
    codexMacAppPath: env.CODEX_MAC_APP_PATH,
    codexMacBundleId: env.CODEX_MAC_BUNDLE_ID,
    openaiApiKey: env.OPENAI_API_KEY,
    openaiBaseUrl: env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    openaiTranscriptionModel: env.OPENAI_TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe",
  };
}
