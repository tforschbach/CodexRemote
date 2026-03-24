import test from "node:test";
import assert from "node:assert/strict";

import { mapRawThread, mapRawThreadToKnownChat } from "../src/http/mapping.js";

test("thread mapping falls back to a placeholder title when name and preview are blank", () => {
  const rawThread = {
    id: "thread-1",
    name: "   ",
    preview: "",
    cwd: "/tmp/project",
    createdAt: 100,
  };

  const mappedThread = mapRawThread(rawThread);
  const knownChat = mapRawThreadToKnownChat(rawThread);

  assert.equal(mappedThread.title, "Untitled chat");
  assert.equal(mappedThread.preview, "");
  assert.equal(knownChat.title, "Untitled chat");
});
