import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { TokenStore } from "../src/auth/token-store.js";

test("TokenStore issues and validates tokens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-token-test-"));
  const store = new TokenStore(join(dir, "tokens.json"));
  await store.load();

  const issued = await store.issueDeviceToken({ deviceName: "iPhone" });
  const valid = await store.validateToken(issued.token);

  assert.ok(valid);
  assert.equal(valid?.deviceId, issued.deviceId);
});

test("TokenStore revokeByToken revokes access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-token-test-"));
  const store = new TokenStore(join(dir, "tokens.json"));
  await store.load();

  const issued = await store.issueDeviceToken({ deviceName: "iPhone" });
  const revoked = await store.revokeByToken(issued.token);
  const valid = await store.validateToken(issued.token);

  assert.equal(revoked, true);
  assert.equal(valid, null);
});
