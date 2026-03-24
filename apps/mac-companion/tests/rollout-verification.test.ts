import { strict as assert } from "node:assert";
import test from "node:test";

import { waitForRolloutVerification } from "../src/debug-loop/rollout-verification.js";

test("waitForRolloutVerification returns rollout proof once the user message appears", async () => {
  let attempts = 0;

  const result = await waitForRolloutVerification({
    historyStore: {
      async findRolloutPath() {
        return attempts >= 1 ? "/tmp/rollout.jsonl" : undefined;
      },
      async loadMessages() {
        attempts += 1;
        if (attempts < 2) {
          return [];
        }

        return [
          {
            id: "chat:user:1",
            role: "user",
            text: "codex-remote-debug-proof",
            createdAt: 1_773_300_000,
          },
        ];
      },
    },
    chatId: "chat-proof",
    expectedUserMessage: "codex-remote-debug-proof",
    timeoutMs: 10,
    intervalMs: 0,
    sleepFn: async () => undefined,
  });

  assert.equal(result.rolloutPath, "/tmp/rollout.jsonl");
  assert.equal(result.userMessageFound, true);
  assert.equal(result.messageCount, 1);
  assert.equal(result.userMessageCreatedAt, 1_773_300_000);
});

test("waitForRolloutVerification returns the last seen rollout state when the message never appears", async () => {
  const result = await waitForRolloutVerification({
    historyStore: {
      async findRolloutPath() {
        return "/tmp/rollout.jsonl";
      },
      async loadMessages() {
        return [
          {
            id: "chat:user:1",
            role: "user",
            text: "older message",
            createdAt: 1_773_300_111,
          },
        ];
      },
    },
    chatId: "chat-proof",
    expectedUserMessage: "missing",
    timeoutMs: 0,
    intervalMs: 0,
    sleepFn: async () => undefined,
  });

  assert.equal(result.rolloutPath, "/tmp/rollout.jsonl");
  assert.equal(result.userMessageFound, false);
  assert.equal(result.messageCount, 1);
});
