export type ApprovalDecision = "approve" | "decline" | "allow_for_session" | "allow_always";

export interface Project {
  id: string;
  cwd: string;
  title: string;
  lastUpdatedAt: number;
}

export interface ChatThread {
  id: string;
  projectId: string;
  title: string;
  preview: string;
  updatedAt: number;
}

export type MessageRole = "user" | "assistant" | "system";

export interface Message {
  id: string;
  role: MessageRole;
  text: string;
  createdAt: number;
  phase?: "commentary" | "final_answer";
  workedDurationSeconds?: number;
}

export type ChatActivityKind =
  | "thinking"
  | "exploring"
  | "running_command"
  | "file_edited"
  | "context_compacted"
  | "background_terminal"
  | "reconnecting";

export type ChatActivityState = "in_progress" | "completed";

export interface ChatActivity {
  id: string;
  itemId: string;
  kind: ChatActivityKind;
  title: string;
  detail?: string;
  commandPreview?: string;
  createdAt: number;
  updatedAt: number;
  state: ChatActivityState;
  filePath?: string;
  additions?: number;
  deletions?: number;
}

export interface ChatTimeline {
  messages: Message[];
  activities: ChatActivity[];
}

export type ApprovalKind = "command" | "fileChange" | "mcp";

export type ApprovalMode = "approval" | "mcp_elicitation";

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  mode: ApprovalMode;
  title: string;
  summary: string;
  riskLevel: "low" | "medium" | "high";
  createdAt: number;
  serverName?: string;
  supportsSessionAllow: boolean;
  supportsAlwaysAllow: boolean;
}

export interface PairingRequestResponse {
  pairingId: string;
  nonce: string;
  expiresAt: number;
  pairingUri: string;
  qrDataUrl: string;
}

export interface PairingConfirmRequest {
  pairingId: string;
  nonce: string;
  deviceName: string;
  devicePublicKey?: string;
}

export interface PairingConfirmResponse {
  deviceId: string;
  token: string;
}

export type StreamEventName =
  | "turn_started"
  | "message_delta"
  | "item_started"
  | "item_completed"
  | "approval_required"
  | "turn_completed"
  | "error";

export interface StreamEvent<T = unknown> {
  event: StreamEventName;
  chatId: string;
  payload: T;
  timestamp: number;
}

export function assertNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected non-empty string for ${fieldName}`);
  }
  return value;
}
