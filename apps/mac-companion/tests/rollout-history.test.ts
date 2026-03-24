import { strict as assert } from "node:assert";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ChatActivity } from "@codex-remote/protocol";

import { RolloutHistoryStore } from "../src/history/rollout-history.js";

test("RolloutHistoryStore returns user messages plus assistant commentary and final answers from rollout files", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "codex-remote-rollout-history-"));
  const sessionsRoot = join(tempRoot, "2026", "03", "08");
  const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "tests",
    "fixtures",
    "sample-rollout.jsonl",
  );
  const rolloutPath = join(
    sessionsRoot,
    "rollout-2026-03-08T23-04-05-chat-history-test.jsonl",
  );

  await mkdir(sessionsRoot, { recursive: true });
  await cp(fixturePath, rolloutPath, { force: true });

  const store = new RolloutHistoryStore(tempRoot);
  const messages = await store.loadMessages("chat-history-test");

  assert.deepEqual(
    messages.map((message) => ({
      role: message.role,
      text: message.text,
      phase: message.phase,
    })),
    [
      {
        role: "user",
        text: "Can you load my history?",
        phase: undefined,
      },
      {
        role: "assistant",
        text: "I am checking the rollout file now.",
        phase: "commentary",
      },
      {
        role: "assistant",
        text: "Yes. I loaded the saved chat history.",
        phase: "final_answer",
      },
      {
        role: "user",
        text: "Please continue.",
        phase: undefined,
      },
      {
        role: "assistant",
        text: "Continuing from the same thread.",
        phase: "final_answer",
      },
    ],
  );
  assert.equal(messages[0]?.createdAt, 1_773_011_047);
  assert.equal(messages[1]?.createdAt, 1_773_011_049);
  assert.equal(messages[2]?.workedDurationSeconds, 13);
  assert.equal(messages[4]?.workedDurationSeconds, 10);
});

test("RolloutHistoryStore returns an empty list when no rollout file exists", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "codex-remote-rollout-history-empty-"));
  const store = new RolloutHistoryStore(tempRoot);

  const messages = await store.loadMessages("missing-chat");

  assert.deepEqual(messages, []);
});

test("RolloutHistoryStore exposes edited file cards from apply_patch rollout items", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "codex-remote-rollout-history-patch-"));
  const sessionsRoot = join(tempRoot, "2026", "03", "15");
  const rolloutPath = join(
    sessionsRoot,
    "rollout-2026-03-15T20-10-00-chat-patch-test.jsonl",
  );

  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(
    rolloutPath,
    [
      "{\"timestamp\":\"2026-03-15T20:10:00.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Please edit two files.\"}}",
      "{\"timestamp\":\"2026-03-15T20:10:02.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"custom_tool_call\",\"status\":\"completed\",\"call_id\":\"call_patch_1\",\"name\":\"apply_patch\",\"input\":\"*** Begin Patch\\n*** Update File: apps/ios/Sources/Views/ContentView.swift\\n@@\\n- old line\\n+ new line\\n+ another line\\n*** Update File: apps/ios/README.md\\n@@\\n- old doc\\n+ new doc\\n*** End Patch\\n\"}}",
    ].join("\n"),
    "utf8",
  );

  const store = new RolloutHistoryStore(tempRoot);
  const timeline = await store.loadTimeline("chat-patch-test");

  assert.deepEqual(
    timeline.activities.map((activity: ChatActivity) => ({
      kind: activity.kind,
      title: activity.title,
      filePath: activity.filePath,
      additions: activity.additions,
      deletions: activity.deletions,
    })),
    [
      {
        kind: "file_edited",
        title: "Edited",
        filePath: "apps/ios/Sources/Views/ContentView.swift",
        additions: 2,
        deletions: 1,
      },
      {
        kind: "file_edited",
        title: "Edited",
        filePath: "apps/ios/README.md",
        additions: 1,
        deletions: 1,
      },
    ],
  );
});

test("RolloutHistoryStore exposes context compaction and background terminal cards from rollout history", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "codex-remote-rollout-history-status-"));
  const sessionsRoot = join(tempRoot, "2026", "03", "15");
  const rolloutPath = join(
    sessionsRoot,
    "rollout-2026-03-15T20-15-00-chat-status-test.jsonl",
  );

  await mkdir(sessionsRoot, { recursive: true });
  await writeFile(
    rolloutPath,
    [
      "{\"timestamp\":\"2026-03-15T20:15:00.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"exec_command\",\"arguments\":\"{\\\"cmd\\\":\\\"xcodebuild build -project apps/ios/CodexRemote.xcodeproj\\\"}\",\"call_id\":\"call_exec_background\"}}",
      "{\"timestamp\":\"2026-03-15T20:15:01.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call_exec_background\",\"output\":\"Chunk ID: 123\\nWall time: 0.0000 seconds\\nProcess running with session ID 50701\\n\"}}",
      "{\"timestamp\":\"2026-03-15T20:15:02.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"write_stdin\",\"arguments\":\"{\\\"session_id\\\":50701,\\\"chars\\\":\\\"\\\"}\",\"call_id\":\"call_poll_background\"}}",
      "{\"timestamp\":\"2026-03-15T20:15:05.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"call_poll_background\",\"output\":\"Chunk ID: 456\\nWall time: 2.5000 seconds\\nProcess exited with code 0\\nOutput:\\nBUILD SUCCEEDED\\n\"}}",
      "{\"timestamp\":\"2026-03-15T20:15:06.000Z\",\"type\":\"compacted\",\"payload\":{\"message\":\"\",\"replacement_history\":[]}}",
      "{\"timestamp\":\"2026-03-15T20:15:06.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"context_compacted\"}}",
    ].join("\n"),
    "utf8",
  );

  const store = new RolloutHistoryStore(tempRoot);
  const timeline = await store.loadTimeline("chat-status-test");

  assert.deepEqual(
    timeline.activities.map((activity: ChatActivity) => ({
      kind: activity.kind,
      title: activity.title,
      detail: activity.detail,
      commandPreview: activity.commandPreview,
    })),
    [
      {
        kind: "background_terminal",
        title: "Background terminal finished",
        detail: "Exit code 0",
        commandPreview: "xcodebuild build -project apps/ios/CodexRemote.xcodeproj",
      },
      {
        kind: "context_compacted",
        title: "Context automatically compacted",
        detail: undefined,
        commandPreview: undefined,
      },
    ],
  );
});

test("RolloutHistoryStore can expose the rollout path for a known chat", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "codex-remote-rollout-history-path-"));
  const sessionsRoot = join(tempRoot, "2026", "03", "08");
  const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "tests",
    "fixtures",
    "sample-rollout.jsonl",
  );
  const rolloutPath = join(
    sessionsRoot,
    "rollout-2026-03-08T23-04-05-chat-history-test.jsonl",
  );

  await mkdir(sessionsRoot, { recursive: true });
  await cp(fixturePath, rolloutPath, { force: true });

  const store = new RolloutHistoryStore(tempRoot);
  const resolvedPath = await store.findRolloutPath("chat-history-test");

  assert.equal(resolvedPath, rolloutPath);
});
