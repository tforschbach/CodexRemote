import { assertNonEmptyString } from "@codex-remote/protocol";

export interface ImageMessageAttachment {
  type: "image";
  name: string;
  mimeType: string;
  dataUrl: string;
}

export interface TextFileMessageAttachment {
  type: "text_file";
  name: string;
  mimeType: string;
  text: string;
}

export type MessageAttachment = ImageMessageAttachment | TextFileMessageAttachment;

export interface SendChatMessageBody {
  text?: string;
  attachments?: MessageAttachment[];
}

export type CodexTurnStartInput =
  | { type: "text"; text: string }
  | { type: "image"; url: string };

function assertPlainObject(value: unknown, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected object for ${fieldName}`);
  }

  return value as Record<string, unknown>;
}

export function normalizeMessageText(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error("Expected string for text");
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseMessageAttachments(value: unknown): MessageAttachment[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("Expected array for attachments");
  }

  return value.map((attachment, index) => {
    const parsed = assertPlainObject(attachment, `attachments[${index}]`);
    const type = assertNonEmptyString(parsed.type, `attachments[${index}].type`);
    const name = assertNonEmptyString(parsed.name, `attachments[${index}].name`);
    const mimeType = assertNonEmptyString(parsed.mimeType, `attachments[${index}].mimeType`);

    if (type === "image") {
      const dataUrl = assertNonEmptyString(parsed.dataUrl, `attachments[${index}].dataUrl`);
      if (!dataUrl.startsWith("data:image/")) {
        throw new Error(`Expected image data URL for attachments[${index}].dataUrl`);
      }

      return {
        type: "image",
        name,
        mimeType,
        dataUrl,
      };
    }

    if (type === "text_file") {
      return {
        type: "text_file",
        name,
        mimeType,
        text: assertNonEmptyString(parsed.text, `attachments[${index}].text`),
      };
    }

    throw new Error(`Unsupported attachment type: ${type}`);
  });
}

function buildTextFileTurnInputText(attachment: TextFileMessageAttachment): string {
  return [
    `Attached file: ${attachment.name}`,
    "",
    "--- BEGIN FILE ---",
    attachment.text,
    "--- END FILE ---",
  ].join("\n");
}

export function buildTurnStartInput(
  text: string | undefined,
  attachments: MessageAttachment[],
): CodexTurnStartInput[] {
  const input: CodexTurnStartInput[] = [];

  if (text) {
    input.push({ type: "text", text });
  }

  for (const attachment of attachments) {
    if (attachment.type === "image") {
      input.push({
        type: "image",
        url: attachment.dataUrl,
      });
      continue;
    }

    input.push({
      type: "text",
      text: buildTextFileTurnInputText(attachment),
    });
  }

  if (input.length === 0) {
    throw new Error("Expected text or attachments");
  }

  return input;
}

export function buildMessagePreview(text: string | undefined, attachments: MessageAttachment[]): string {
  const lines = attachments.map((attachment) => (
    attachment.type === "image"
      ? `Attached photo: ${attachment.name}`
      : `Attached file: ${attachment.name}`
  ));

  if (text && lines.length === 0) {
    return text;
  }

  if (!text && lines.length > 0) {
    return lines.join("\n");
  }

  return [text, ...lines].join("\n\n");
}

export function buildChatTitleSeed(text: string | undefined, attachments: MessageAttachment[]): string {
  if (text) {
    return text;
  }

  const [attachment] = attachments;
  if (attachments.length === 1 && attachment) {
    return attachment.type === "image"
      ? `Photo: ${attachment.name}`
      : `File: ${attachment.name}`;
  }

  return `Attachments: ${attachments.length}`;
}
