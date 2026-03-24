import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChatTitleSeed,
  buildMessagePreview,
  buildTurnStartInput,
  parseMessageAttachments,
} from "../src/http/message-input.js";

test("buildTurnStartInput keeps text first and appends image/text-file attachments", () => {
  const attachments = parseMessageAttachments([
    {
      type: "image",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      dataUrl: "data:image/jpeg;base64,AAA",
    },
    {
      type: "text_file",
      name: "notes.txt",
      mimeType: "text/plain",
      text: "Hello from file",
    },
  ]);

  assert.deepEqual(
    buildTurnStartInput("Please review these", attachments),
    [
      { type: "text", text: "Please review these" },
      { type: "image", url: "data:image/jpeg;base64,AAA" },
      {
        type: "text",
        text: "Attached file: notes.txt\n\n--- BEGIN FILE ---\nHello from file\n--- END FILE ---",
      },
    ],
  );
});

test("buildMessagePreview summarizes attachments when no user text exists", () => {
  const attachments = parseMessageAttachments([
    {
      type: "image",
      name: "photo.jpg",
      mimeType: "image/jpeg",
      dataUrl: "data:image/jpeg;base64,AAA",
    },
    {
      type: "text_file",
      name: "notes.txt",
      mimeType: "text/plain",
      text: "Hello from file",
    },
  ]);

  assert.equal(
    buildMessagePreview(undefined, attachments),
    "Attached photo: photo.jpg\nAttached file: notes.txt",
  );
  assert.equal(buildChatTitleSeed(undefined, attachments), "Attachments: 2");
});

test("buildTurnStartInput rejects empty messages", () => {
  assert.throws(
    () => buildTurnStartInput(undefined, []),
    /Expected text or attachments/,
  );
});
