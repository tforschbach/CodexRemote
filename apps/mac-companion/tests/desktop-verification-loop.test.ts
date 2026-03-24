import { strict as assert } from "node:assert";
import test from "node:test";

import { runDesktopVerificationLoop } from "../src/debug-loop/desktop-verification.js";

test("desktop verification loop passes command timeout to the verifier process", async () => {
  const calls: Array<{
    file: string;
    args: string[];
    options: {
      cwd: string;
      timeout: number;
      killSignal: "SIGKILL";
    };
  }> = [];

  const result = await runDesktopVerificationLoop({
    nodePath: process.execPath,
    macCompanionDir: "/tmp/mac-companion",
    logsDir: "/tmp/logs",
    traceId: "debug-timeout-pass-through",
    uniqueMessage: "hello",
    projectTitle: "Codex Mobile App",
    chatTitle: "Remote-Steuerung Codex Mobile App",
    desktopVerifyDelayMs: 100,
    commandTimeoutMs: 12345,
    appName: "Codex",
    appPath: "",
    bundleId: "",
    attempts: 1,
  }, {
    execFileAsyncFn: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: "{\"matched\":true}" };
    },
  });

  assert.equal(result.desktopVerification?.matched, true);
  assert.equal(result.lastDesktopError, "");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.file, process.execPath);
  assert.equal(calls[0]?.options.cwd, "/tmp/mac-companion");
  assert.equal(calls[0]?.options.timeout, 12345);
  assert.equal(calls[0]?.options.killSignal, "SIGKILL");
  assert.ok(calls[0]?.args.includes("--project-title"));
  assert.ok(calls[0]?.args.includes("Codex Mobile App"));
  assert.ok(calls[0]?.args.includes("--chat-title"));
  assert.ok(calls[0]?.args.includes("Remote-Steuerung Codex Mobile App"));
});

test("desktop verification loop synthesizes a failure report when the verifier times out before writing a report", async () => {
  const timeoutError = Object.assign(new Error("Command timed out after 15000ms"), {
    killed: true,
    signal: "SIGKILL",
  });
  let sleepCalls = 0;

  const result = await runDesktopVerificationLoop({
    nodePath: process.execPath,
    macCompanionDir: "/tmp/mac-companion",
    logsDir: "/tmp/logs",
    traceId: "debug-timeout-synthetic",
    uniqueMessage: "hello",
    projectTitle: "Codex Mobile App",
    chatTitle: "Remote-Steuerung Codex Mobile App",
    desktopVerifyDelayMs: 100,
    commandTimeoutMs: 15000,
    appName: "Codex",
    appPath: "",
    bundleId: "",
    attempts: 2,
    retryDelayMs: 1,
  }, {
    execFileAsyncFn: async () => {
      throw timeoutError;
    },
    readJSONFileFn: async () => null,
    sleepFn: async () => {
      sleepCalls += 1;
    },
  });

  assert.equal(result.desktopVerification?.matched, false);
  assert.equal(result.desktopVerification?.failure?.stage, "verifier_timeout");
  assert.match(result.desktopVerification?.failure?.message ?? "", /15000ms/);
  assert.match(result.lastDesktopError, /timed out/i);
  assert.equal(sleepCalls, 1);
});
