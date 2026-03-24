import type { Message } from "@codex-remote/protocol";

export interface RolloutHistoryReader {
  findRolloutPath(chatId: string): Promise<string | undefined>;
  loadMessages(chatId: string): Promise<Message[]>;
}

export interface RolloutVerificationResult {
  rolloutPath?: string;
  messageCount: number;
  userMessageFound: boolean;
  userMessageCreatedAt?: number;
}

interface WaitForRolloutVerificationOptions {
  historyStore: RolloutHistoryReader;
  chatId: string;
  expectedUserMessage: string;
  timeoutMs?: number;
  intervalMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function waitForRolloutVerification(
  options: WaitForRolloutVerificationOptions,
): Promise<RolloutVerificationResult> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 250;
  const sleepFn = options.sleepFn ?? sleep;
  const deadline = Date.now() + timeoutMs;

  let latestRolloutPath: string | undefined;
  let latestMessages: Message[] = [];
  let matchedUserMessage: Message | undefined;

  while (Date.now() <= deadline) {
    latestRolloutPath = await options.historyStore.findRolloutPath(options.chatId);
    latestMessages = await options.historyStore.loadMessages(options.chatId);
    matchedUserMessage = latestMessages.find(
      (message) => message.role === "user" && message.text === options.expectedUserMessage,
    );

    if (latestRolloutPath && matchedUserMessage) {
      return {
        rolloutPath: latestRolloutPath,
        messageCount: latestMessages.length,
        userMessageFound: true,
        userMessageCreatedAt: matchedUserMessage.createdAt,
      };
    }

    await sleepFn(intervalMs);
  }

  return {
    messageCount: latestMessages.length,
    userMessageFound: false,
    ...(latestRolloutPath ? { rolloutPath: latestRolloutPath } : {}),
    ...(matchedUserMessage?.createdAt !== undefined
      ? { userMessageCreatedAt: matchedUserMessage.createdAt }
      : {}),
  };
}
