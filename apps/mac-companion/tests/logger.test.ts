import { strict as assert } from "node:assert";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CompanionLogger } from "../src/logging/logger.js";

test("CompanionLogger writes ndjson entries with merged child context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-logger-test-"));
  const logPath = join(dir, "companion.ndjson");
  const logger = new CompanionLogger(logPath, "debug");

  const httpLog = logger.child({ source: "http", traceId: "trace-123" });
  httpLog.info("request_completed", { path: "/v1/projects", statusCode: 200 });
  await logger.flush();

  const contents = await readFile(logPath, "utf8");
  const lines = contents.trim().split("\n");
  assert.equal(lines.length, 1);
  const firstLine = lines[0];
  assert.ok(firstLine);

  const record = JSON.parse(firstLine) as Record<string, unknown>;
  assert.equal(record.source, "http");
  assert.equal(record.traceId, "trace-123");
  assert.equal(record.event, "request_completed");
  assert.equal(record.path, "/v1/projects");
  assert.equal(record.statusCode, 200);
  assert.equal(record.level, "info");
});
