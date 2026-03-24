import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ChatActivity, ChatTimeline, Message } from "@codex-remote/protocol";

import {
  buildBackgroundTerminalActivity,
  buildContextCompactedActivity,
  mapApplyPatchPayloadToActivities,
  mergeChatActivities,
} from "./chat-activities.js";

export interface ChatHistoryStore {
  loadMessages(chatId: string): Promise<Message[]>;
  loadTimeline(chatId: string): Promise<ChatTimeline>;
}

interface RolloutLine {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

interface RolloutFunctionCallState {
  callId: string;
  name: string;
  arguments?: string;
}

export class RolloutHistoryStore implements ChatHistoryStore {
  private readonly sessionsRoot: string;
  private readonly rolloutPathByChat = new Map<string, string | null>();

  public constructor(sessionsRoot: string) {
    this.sessionsRoot = sessionsRoot;
  }

  public async loadMessages(chatId: string): Promise<Message[]> {
    return (await this.loadTimeline(chatId)).messages;
  }

  public async loadTimeline(chatId: string): Promise<ChatTimeline> {
    const rolloutPath = await this.findRolloutPath(chatId);
    if (!rolloutPath) {
      return {
        messages: [],
        activities: [],
      };
    }

    const contents = await readFile(rolloutPath, "utf8");
    const messages: Message[] = [];
    const activities: ChatActivity[] = [];
    const functionCallsById = new Map<string, RolloutFunctionCallState>();
    const backgroundCommandsBySessionId = new Map<string, string>();

    for (const [index, line] of contents.split("\n").entries()) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: RolloutLine;
      try {
        parsed = JSON.parse(trimmed) as RolloutLine;
      } catch {
        continue;
      }

      const message = mapRolloutLineToMessage(chatId, index, parsed);
      if (message) {
        messages.push(message);
      }

      rememberRolloutFunctionCall(parsed, functionCallsById);

      const rolloutActivities = mapRolloutLineToActivities(
        index,
        parsed,
        functionCallsById,
        backgroundCommandsBySessionId,
      );
      if (rolloutActivities.length > 0) {
        activities.push(...rolloutActivities);
      }
    }

    return {
      messages: attachWorkedDurations(messages),
      activities: mergeChatActivities(activities),
    };
  }

  public async findRolloutPath(chatId: string): Promise<string | undefined> {
    return this.resolveRolloutPath(chatId);
  }

  private async resolveRolloutPath(chatId: string): Promise<string | undefined> {
    const cached = this.rolloutPathByChat.get(chatId);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    const suffix = `${chatId}.jsonl`;
    const pendingDirectories = [this.sessionsRoot];

    while (pendingDirectories.length > 0) {
      const directory = pendingDirectories.pop();
      if (!directory) {
        continue;
      }

      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          pendingDirectories.push(fullPath);
          continue;
        }

        if (entry.isFile() && entry.name.endsWith(suffix) && entry.name.startsWith("rollout-")) {
          this.rolloutPathByChat.set(chatId, fullPath);
          return fullPath;
        }
      }
    }

    this.rolloutPathByChat.set(chatId, null);
    return undefined;
  }
}

function mapRolloutLineToMessage(
  chatId: string,
  index: number,
  line: RolloutLine,
): Message | null {
  if (line.type === "event_msg") {
    return mapEventMessage(chatId, index, line);
  }

  if (line.type === "response_item") {
    return mapResponseItem(chatId, index, line);
  }

  return null;
}

function mapRolloutLineToActivities(
  index: number,
  line: RolloutLine,
  functionCallsById: Map<string, RolloutFunctionCallState>,
  backgroundCommandsBySessionId: Map<string, string>,
): ChatActivity[] {
  const payload = asRecord(line.payload);
  const timestampKey = typeof line.timestamp === "string"
    ? line.timestamp
    : `line_${index + 1}`;
  const createdAtSeconds = parseCreatedAtSeconds(line.timestamp);

  if (line.type === "compacted") {
    return [
      buildContextCompactedActivity({
        id: `context_compacted:${timestampKey}`,
        createdAtSeconds,
      }),
    ];
  }

  if (line.type === "event_msg" && payload?.type === "context_compacted") {
    return [
      buildContextCompactedActivity({
        id: `context_compacted:${timestampKey}`,
        createdAtSeconds,
      }),
    ];
  }

  if (line.type !== "response_item" || !payload) {
    return [];
  }

  const activities = mapApplyPatchPayloadToActivities(payload, createdAtSeconds, index);
  const backgroundActivity = mapRolloutFunctionCallOutputToActivity(
    payload,
    createdAtSeconds,
    functionCallsById,
    backgroundCommandsBySessionId,
  );

  if (backgroundActivity) {
    activities.push(backgroundActivity);
  }

  return activities;
}

function mapEventMessage(
  chatId: string,
  index: number,
  line: RolloutLine,
): Message | null {
  const payload = asRecord(line.payload);
  if (!payload || payload.type !== "user_message") {
    return null;
  }

  if (typeof payload.message !== "string" || payload.message.trim().length === 0) {
    return null;
  }

  return {
    id: `${chatId}:user:${index + 1}`,
    role: "user",
    text: payload.message,
    createdAt: parseCreatedAtSeconds(line.timestamp),
  };
}

function mapResponseItem(
  chatId: string,
  index: number,
  line: RolloutLine,
): Message | null {
  const payload = asRecord(line.payload);
  if (!payload || payload.type !== "message" || payload.role !== "assistant") {
    return null;
  }

  if (payload.phase && payload.phase !== "final_answer" && payload.phase !== "commentary") {
    return null;
  }

  const text = extractAssistantText(payload.content);
  if (!text) {
    return null;
  }

  const message: Message = {
    id: `${chatId}:assistant:${index + 1}`,
    role: "assistant",
    text,
    createdAt: parseCreatedAtSeconds(line.timestamp),
  };

  if (payload.phase === "final_answer" || payload.phase === "commentary") {
    message.phase = payload.phase;
  }

  return message;
}

function attachWorkedDurations(messages: Message[]): Message[] {
  let latestUserCreatedAt: number | undefined;

  return messages.map((message) => {
    if (message.role === "user") {
      latestUserCreatedAt = message.createdAt;
      return message;
    }

    if (message.role !== "assistant" || message.phase !== "final_answer" || latestUserCreatedAt === undefined) {
      return message;
    }

    const workedDurationSeconds = Math.max(0, Math.round(message.createdAt - latestUserCreatedAt));
    return workedDurationSeconds > 0
      ? {
        ...message,
        workedDurationSeconds,
      }
      : message;
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function rememberRolloutFunctionCall(
  line: RolloutLine,
  functionCallsById: Map<string, RolloutFunctionCallState>,
): void {
  if (line.type !== "response_item") {
    return;
  }

  const payload = asRecord(line.payload);
  if (!payload || payload.type !== "function_call") {
    return;
  }

  if (typeof payload.call_id !== "string" || typeof payload.name !== "string") {
    return;
  }

  functionCallsById.set(payload.call_id, {
    callId: payload.call_id,
    name: payload.name,
    ...(typeof payload.arguments === "string" ? { arguments: payload.arguments } : {}),
  });
}

function mapRolloutFunctionCallOutputToActivity(
  payload: Record<string, unknown>,
  createdAtSeconds: number,
  functionCallsById: Map<string, RolloutFunctionCallState>,
  backgroundCommandsBySessionId: Map<string, string>,
): ChatActivity | null {
  if (payload.type !== "function_call_output" || typeof payload.call_id !== "string") {
    return null;
  }

  const functionCall = functionCallsById.get(payload.call_id);
  if (!functionCall) {
    return null;
  }

  const output = typeof payload.output === "string" ? payload.output : "";
  if (!output) {
    return null;
  }

  if (functionCall.name === "exec_command") {
    const sessionId = parseBackgroundSessionId(output);
    const commandPreview = extractFunctionArgumentString(functionCall.arguments, "cmd");
    if (sessionId && commandPreview) {
      backgroundCommandsBySessionId.set(sessionId, commandPreview);
    }
    return null;
  }

  if (functionCall.name !== "write_stdin") {
    return null;
  }

  if (!/Process exited with code\s+-?\d+/i.test(output)) {
    return null;
  }

  const sessionId = extractFunctionArgumentNumber(functionCall.arguments, "session_id");
  const commandPreview = sessionId
    ? backgroundCommandsBySessionId.get(String(sessionId))
    : undefined;
  const exitCode = parseExitCode(output);

  return buildBackgroundTerminalActivity({
    id: payload.call_id,
    createdAtSeconds,
    commandPreview,
    ...(typeof exitCode === "number" ? { exitCode } : {}),
  });
}

function extractFunctionArgumentString(argumentsText: string | undefined, fieldName: string): string | undefined {
  if (!argumentsText) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(argumentsText) as Record<string, unknown>;
    return typeof parsed[fieldName] === "string" ? parsed[fieldName] : undefined;
  } catch {
    return undefined;
  }
}

function extractFunctionArgumentNumber(argumentsText: string | undefined, fieldName: string): number | undefined {
  if (!argumentsText) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(argumentsText) as Record<string, unknown>;
    return typeof parsed[fieldName] === "number" ? parsed[fieldName] : undefined;
  } catch {
    return undefined;
  }
}

function parseBackgroundSessionId(output: string): string | undefined {
  const match = /Process running with session ID\s+(\d+)/i.exec(output);
  return match?.[1];
}

function parseExitCode(output: string): number | undefined {
  const match = /Process exited with code\s+(-?\d+)/i.exec(output);
  if (!match?.[1]) {
    return undefined;
  }

  const parsed = Number.parseInt(match[1], 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  const parts = content
    .map((entry) => extractContentPart(entry))
    .filter((entry): entry is string => entry.length > 0);

  return parts.join("\n\n").trim();
}

function extractContentPart(value: unknown): string {
  const typed = asRecord(value);
  if (!typed) {
    return "";
  }

  if (typeof typed.text === "string") {
    return typed.text;
  }

  return "";
}

function parseCreatedAtSeconds(value: unknown): number {
  if (typeof value !== "string") {
    return Math.floor(Date.now() / 1000);
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return Math.floor(Date.now() / 1000);
  }

  return Math.floor(parsed / 1000);
}
