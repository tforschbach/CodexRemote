import { loadConfig } from "./config.js";
import { TokenStore } from "./auth/token-store.js";
import { PairingStore } from "./pairing/pairing-store.js";
import { CodexAppServerClient } from "./codex/client.js";
import { SessionState } from "./state/session-state.js";
import { createCompanionServer } from "./http/server.js";
import { CompanionLogger } from "./logging/logger.js";
import { RolloutHistoryStore } from "./history/rollout-history.js";
import { LocalProjectContextStore } from "./context/project-context.js";
import { MacDesktopSyncBridge, NoopDesktopSyncBridge } from "./desktop/live-sync.js";
import { dirname, join } from "node:path";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = new CompanionLogger(config.traceLogPath, config.traceLogLevel);
  const appLog = logger.child({ source: "companion" });

  const tokenStore = new TokenStore(config.tokenStorePath);
  await tokenStore.load();

  const pairingStore = new PairingStore(config.pairingTtlSeconds);
  const codexClient = new CodexAppServerClient(
    config.codexCommand,
    logger.child({ source: "codex" }),
    config.codexStartTimeoutMs,
  );
  const historyStore = new RolloutHistoryStore(config.codexSessionsPath);
  const contextStore = new LocalProjectContextStore(config.codexHomePath);
  const approvalPreferencesPath = join(dirname(config.tokenStorePath), "approval-preferences.json");
  const state = new SessionState(approvalPreferencesPath);
  await state.load();
  const desktopSync = config.desktopSyncEnabled
    ? new MacDesktopSyncBridge({
      enabled: config.desktopSyncEnabled,
      appName: config.codexMacAppName,
      appPath: config.codexMacAppPath,
      bundleId: config.codexMacBundleId,
      reloadDelayMs: config.desktopSyncReloadDelayMs,
      commandTimeoutMs: config.desktopSyncCommandTimeoutMs,
    })
    : new NoopDesktopSyncBridge();

  codexClient.on("stderr", (line: string) => {
    appLog.warn("codex_stderr", { line: line.trim() });
  });

  appLog.info("startup", {
    host: config.host,
    port: config.port,
    codexStartTimeoutMs: config.codexStartTimeoutMs,
    traceLogPath: config.traceLogPath,
    tlsEnabled: Boolean(config.tlsKeyPath && config.tlsCertPath),
  });

  await codexClient.start();

  const server = await createCompanionServer({
    config,
    tokenStore,
    pairingStore,
    codexClient,
    historyStore,
    contextStore,
    state,
    logger,
    desktopSync,
  });

  await server.listen();

  const protocol = config.tlsKeyPath && config.tlsCertPath ? "https/wss" : "http/ws";
  appLog.info("listening", { bindHost: config.host, bindPort: config.port, protocol });
  // eslint-disable-next-line no-console
  console.log(`Codex Remote companion listening on ${config.host}:${config.port} (${protocol})`);

  const shutdown = async (signal: string) => {
    appLog.info("shutdown_requested", { signal });
    await server.close();
    await codexClient.stop();
    await logger.flush();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
