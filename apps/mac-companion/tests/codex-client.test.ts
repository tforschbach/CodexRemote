import { strict as assert } from "node:assert";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexAppServerClient, summarizeParamsForLogging } from "../src/codex/client.js";
import { CompanionLogger } from "../src/logging/logger.js";

async function createFakeCodexCommand(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-codex-client-test-"));
  const scriptPath = join(dir, "fake-codex");
  await writeFile(scriptPath, contents, "utf8");
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

test("CodexAppServerClient start fails with a clear timeout when initialize does not answer", async () => {
  const commandPath = await createFakeCodexCommand(`#!/bin/sh\nsleep 5\n`);
  const logger = new CompanionLogger(join(tmpdir(), `codex-client-timeout-${Date.now()}.ndjson`), "debug");
  const client = new CodexAppServerClient(commandPath, logger.child({ source: "codex" }), 50);

  await assert.rejects(
    client.start(),
    /initialize timed out after 50ms/,
  );

  await client.stop();
});

test("summarizeParamsForLogging keeps only metadata for text inputs", () => {
  const summary = summarizeParamsForLogging({
    threadId: "chat-1",
    input: [
      { type: "text", text: "Private prompt" },
      { type: "text", text: "Attached file body" },
      { type: "image", url: "data:image/png;base64,AAA" },
    ],
  }) as Record<string, unknown>;

  assert.equal(summary.threadId, "chat-1");
  assert.equal(summary.inputCount, 3);
  assert.deepEqual(summary.inputTypes, ["text", "text", "image"]);
  assert.equal(summary.inputTextLength, "Private prompt".length + "Attached file body".length);
  assert.equal("inputText" in summary, false);
});
