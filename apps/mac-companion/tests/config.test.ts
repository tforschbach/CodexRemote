import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadConfig,
  resolveBindHost,
  loadEnvFileValues,
  parseEnvFileContents,
  resolvePairingHost,
  resolveRuntimeEnv,
} from "../src/config.js";

test("resolvePairingHost prefers explicit TAILSCALE_HOST", () => {
  const result = resolvePairingHost(
    {
      TAILSCALE_HOST: "100.64.0.2",
      HOSTNAME: "ignored-host",
    },
    () => {
      throw new Error("execFileSync should not be called when TAILSCALE_HOST is set");
    },
  );

  assert.equal(result, "100.64.0.2");
});

test("resolvePairingHost uses tailscale ip when available", () => {
  const result = resolvePairingHost(
    {
      HOSTNAME: "fallback-host",
    },
    () => "100.64.0.3\n",
  );

  assert.equal(result, "100.64.0.3");
});

test("resolvePairingHost falls back to HOSTNAME when tailscale is unavailable", () => {
  const result = resolvePairingHost(
    {
      HOSTNAME: "fallback-host",
    },
    () => {
      throw new Error("tailscale unavailable");
    },
  );

  assert.equal(result, "fallback-host");
});

test("resolveBindHost prefers explicit BIND_HOST", () => {
  const result = resolveBindHost(
    {
      BIND_HOST: "0.0.0.0",
      TAILSCALE_HOST: "100.64.0.2",
    },
    () => {
      throw new Error("execFileSync should not be called when BIND_HOST is set");
    },
  );

  assert.equal(result, "0.0.0.0");
});

test("resolveBindHost uses the tailscale IP by default when available", () => {
  const result = resolveBindHost(
    {},
    () => "100.64.0.3\n",
  );

  assert.equal(result, "100.64.0.3");
});

test("resolveBindHost falls back to localhost when tailscale is unavailable", () => {
  const result = resolveBindHost(
    {},
    () => {
      throw new Error("tailscale unavailable");
    },
  );

  assert.equal(result, "127.0.0.1");
});

test("loadConfig reads CODEX_START_TIMEOUT_MS when set", () => {
  const previous = process.env.CODEX_START_TIMEOUT_MS;
  process.env.CODEX_START_TIMEOUT_MS = "1234";

  try {
    const result = loadConfig();
    assert.equal(result.codexStartTimeoutMs, 1234);
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_START_TIMEOUT_MS;
    } else {
      process.env.CODEX_START_TIMEOUT_MS = previous;
    }
  }
});

test("loadConfig derives the sessions path from CODEX_HOME by default", () => {
  const previousCodexHome = process.env.CODEX_HOME;
  const previousSessionsPath = process.env.CODEX_SESSIONS_PATH;
  process.env.CODEX_HOME = "/tmp/custom-codex-home";
  delete process.env.CODEX_SESSIONS_PATH;

  try {
    const result = loadConfig();
    assert.equal(result.codexHomePath, "/tmp/custom-codex-home");
    assert.equal(result.codexSessionsPath, "/tmp/custom-codex-home/sessions");
  } finally {
    if (previousCodexHome === undefined) {
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = previousCodexHome;
    }

    if (previousSessionsPath === undefined) {
      delete process.env.CODEX_SESSIONS_PATH;
    } else {
      process.env.CODEX_SESSIONS_PATH = previousSessionsPath;
    }
  }
});

test("loadConfig enables desktop sync by default", () => {
  const previous = process.env.CODEX_DESKTOP_SYNC_ENABLED;
  delete process.env.CODEX_DESKTOP_SYNC_ENABLED;

  try {
    const result = loadConfig();
    assert.equal(result.desktopSyncEnabled, true);
    assert.equal(result.codexMacAppName, "Codex");
    assert.equal(result.desktopSyncReloadDelayMs, 250);
    assert.equal(result.desktopSyncCommandTimeoutMs, 5000);
  } finally {
    if (previous === undefined) {
      delete process.env.CODEX_DESKTOP_SYNC_ENABLED;
    } else {
      process.env.CODEX_DESKTOP_SYNC_ENABLED = previous;
    }
  }
});

test("loadConfig reads desktop sync overrides when set", () => {
  const previousEnabled = process.env.CODEX_DESKTOP_SYNC_ENABLED;
  const previousDelay = process.env.CODEX_DESKTOP_SYNC_DELAY_MS;
  const previousTimeout = process.env.CODEX_DESKTOP_SYNC_COMMAND_TIMEOUT_MS;
  const previousAppName = process.env.CODEX_MAC_APP_NAME;
  const previousAppPath = process.env.CODEX_MAC_APP_PATH;
  const previousBundleId = process.env.CODEX_MAC_BUNDLE_ID;

  process.env.CODEX_DESKTOP_SYNC_ENABLED = "0";
  process.env.CODEX_DESKTOP_SYNC_DELAY_MS = "900";
  process.env.CODEX_DESKTOP_SYNC_COMMAND_TIMEOUT_MS = "3200";
  process.env.CODEX_MAC_APP_NAME = "Codex Beta";
  process.env.CODEX_MAC_APP_PATH = "/Applications/Codex Beta.app";
  process.env.CODEX_MAC_BUNDLE_ID = "com.openai.codex.beta";

  try {
    const result = loadConfig();
    assert.equal(result.desktopSyncEnabled, false);
    assert.equal(result.desktopSyncReloadDelayMs, 900);
    assert.equal(result.desktopSyncCommandTimeoutMs, 3200);
    assert.equal(result.codexMacAppName, "Codex Beta");
    assert.equal(result.codexMacAppPath, "/Applications/Codex Beta.app");
    assert.equal(result.codexMacBundleId, "com.openai.codex.beta");
  } finally {
    if (previousEnabled === undefined) {
      delete process.env.CODEX_DESKTOP_SYNC_ENABLED;
    } else {
      process.env.CODEX_DESKTOP_SYNC_ENABLED = previousEnabled;
    }

    if (previousDelay === undefined) {
      delete process.env.CODEX_DESKTOP_SYNC_DELAY_MS;
    } else {
      process.env.CODEX_DESKTOP_SYNC_DELAY_MS = previousDelay;
    }

    if (previousTimeout === undefined) {
      delete process.env.CODEX_DESKTOP_SYNC_COMMAND_TIMEOUT_MS;
    } else {
      process.env.CODEX_DESKTOP_SYNC_COMMAND_TIMEOUT_MS = previousTimeout;
    }

    if (previousAppName === undefined) {
      delete process.env.CODEX_MAC_APP_NAME;
    } else {
      process.env.CODEX_MAC_APP_NAME = previousAppName;
    }

    if (previousAppPath === undefined) {
      delete process.env.CODEX_MAC_APP_PATH;
    } else {
      process.env.CODEX_MAC_APP_PATH = previousAppPath;
    }

    if (previousBundleId === undefined) {
      delete process.env.CODEX_MAC_BUNDLE_ID;
    } else {
      process.env.CODEX_MAC_BUNDLE_ID = previousBundleId;
    }
  }
});

test("parseEnvFileContents ignores comments and strips wrapping quotes", () => {
  const parsed = parseEnvFileContents(`
# comment
OPENAI_API_KEY="secret-key"
OPENAI_TRANSCRIPTION_MODEL='gpt-4o-transcribe'
IGNORED_LINE
`);

  assert.deepEqual(parsed, {
    OPENAI_API_KEY: "secret-key",
    OPENAI_TRANSCRIPTION_MODEL: "gpt-4o-transcribe",
  });
});

test("resolveRuntimeEnv merges .env values under explicit process env", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codex-remote-config-env-"));
  await writeFile(join(repoRoot, ".env"), "OPENAI_API_KEY=from-env\nOPENAI_TRANSCRIPTION_MODEL=gpt-4o-mini-transcribe\n");
  await writeFile(join(repoRoot, ".env.local"), "OPENAI_TRANSCRIPTION_MODEL=gpt-4o-transcribe\n");

  const resolved = resolveRuntimeEnv({
    OPENAI_API_KEY: "from-process",
  }, repoRoot);

  assert.equal(resolved.OPENAI_API_KEY, "from-process");
  assert.equal(resolved.OPENAI_TRANSCRIPTION_MODEL, "gpt-4o-transcribe");
});

test("loadConfig reads OpenAI transcription settings from env files", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "codex-remote-config-openai-"));
  await writeFile(join(repoRoot, ".env"), "OPENAI_API_KEY=repo-key\nOPENAI_BASE_URL=https://example.test/v1\n");
  const env = resolveRuntimeEnv({}, repoRoot);

  const result = loadConfig(env, repoRoot);

  assert.equal(result.openaiApiKey, "repo-key");
  assert.equal(result.openaiBaseUrl, "https://example.test/v1");
  assert.equal(result.openaiTranscriptionModel, "gpt-4o-transcribe");
});
