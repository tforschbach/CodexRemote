import { loadConfig } from "./config.js";
import { TokenStore } from "./auth/token-store.js";
import { PairingStore } from "./pairing/pairing-store.js";
import { CodexAppServerClient } from "./codex/client.js";
import { SessionState } from "./state/session-state.js";
import { createCompanionServer } from "./http/server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const tokenStore = new TokenStore(config.tokenStorePath);
  await tokenStore.load();

  const pairingStore = new PairingStore(config.pairingTtlSeconds);
  const codexClient = new CodexAppServerClient(config.codexCommand);
  const state = new SessionState();

  codexClient.on("stderr", (line: string) => {
    // eslint-disable-next-line no-console
    console.error(`[codex] ${line.trim()}`);
  });

  await codexClient.start();

  const server = await createCompanionServer({
    config,
    tokenStore,
    pairingStore,
    codexClient,
    state,
  });

  await server.listen();

  const protocol = config.tlsKeyPath && config.tlsCertPath ? "https/wss" : "http/ws";
  // eslint-disable-next-line no-console
  console.log(`Codex Remote companion listening on ${config.host}:${config.port} (${protocol})`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
