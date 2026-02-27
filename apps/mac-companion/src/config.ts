import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  host: string;
  port: number;
  pairingTtlSeconds: number;
  pairingConfirmTimeoutSeconds: number;
  codexCommand: string;
  tailscaleHost: string;
  tokenStorePath: string;
  tlsKeyPath: string | undefined;
  tlsCertPath: string | undefined;
}

function parseIntOrDefault(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function loadConfig(): AppConfig {
  const home = homedir();
  return {
    host: process.env.BIND_HOST ?? "0.0.0.0",
    port: parseIntOrDefault(process.env.PORT, 8787),
    pairingTtlSeconds: parseIntOrDefault(process.env.PAIRING_TTL_SECONDS, 180),
    pairingConfirmTimeoutSeconds: parseIntOrDefault(
      process.env.PAIRING_CONFIRM_TIMEOUT_SECONDS,
      30,
    ),
    codexCommand: process.env.CODEX_COMMAND ?? "codex",
    tailscaleHost: process.env.TAILSCALE_HOST ?? `${process.env.HOSTNAME ?? "mac"}.tailnet`,
    tokenStorePath:
      process.env.TOKEN_STORE_PATH ?? join(home, ".codex-remote", "devices.json"),
    tlsKeyPath: process.env.TLS_KEY_PATH,
    tlsCertPath: process.env.TLS_CERT_PATH,
  };
}
