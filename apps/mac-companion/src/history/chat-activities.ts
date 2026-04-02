import { basename } from "node:path";

import type { ChatActivity, ChatActivityKind, ChatActivityState } from "@codex-remote/protocol";

interface PatchFileChange {
  path: string;
  additions: number;
  deletions: number;
  detail?: string;
}

interface RolloutResponsePayload {
  call_id?: unknown;
  input?: unknown;
  name?: unknown;
  status?: unknown;
  type?: unknown;
}

export function summarizeCommandActions(commandActions: unknown[]): {
  kind: ChatActivityKind;
  detail?: string;
} {
  let fileCount = 0;
  let searchCount = 0;

  for (const action of commandActions) {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      continue;
    }

    const typed = action as Record<string, unknown>;
    switch (typed.type) {
      case "read":
      case "listFiles":
        fileCount += 1;
        break;
      case "search":
        searchCount += 1;
        break;
      default:
        break;
    }
  }

  if (fileCount > 0 || searchCount > 0) {
    const parts = [
      fileCount > 0 ? `${fileCount} ${fileCount === 1 ? "file" : "files"}` : undefined,
      searchCount > 0 ? `${searchCount} ${searchCount === 1 ? "search" : "searches"}` : undefined,
    ].filter((part): part is string => Boolean(part));

    return {
      kind: "exploring",
      ...(parts.length > 0 ? { detail: parts.join(", ") } : {}),
    };
  }

  return { kind: "running_command" };
}

export function buildActivityTitle(kind: ChatActivityKind, state: ChatActivityState): string {
  switch (kind) {
    case "thinking":
      return state === "in_progress" ? "Thinking" : "Thought through it";
    case "exploring":
      return state === "in_progress" ? "Exploring" : "Explored";
    case "running_command":
      return state === "in_progress" ? "Running command" : "Command finished";
    case "file_edited":
      return "Edited";
    case "context_compacted":
      return "Context automatically compacted";
    case "background_terminal":
      return state === "in_progress" ? "Background terminal running" : "Background terminal finished";
    case "reconnecting":
      return state === "in_progress" ? "Reconnecting..." : "Reconnected";
    default:
      return "Working";
  }
}

export function buildContextCompactedActivity(input: {
  id: string;
  createdAtSeconds: number;
}): ChatActivity {
  return {
    id: input.id,
    itemId: input.id,
    kind: "context_compacted",
    title: buildActivityTitle("context_compacted", "completed"),
    createdAt: input.createdAtSeconds,
    updatedAt: input.createdAtSeconds,
    state: "completed",
  };
}

export function buildBackgroundTerminalActivity(input: {
  id: string;
  createdAtSeconds: number;
  commandPreview?: string | undefined;
  exitCode?: number | undefined;
}): ChatActivity {
  return {
    id: input.id,
    itemId: input.id,
    kind: "background_terminal",
    title: buildActivityTitle("background_terminal", "completed"),
    ...(typeof input.exitCode === "number" ? { detail: `Exit code ${input.exitCode}` } : {}),
    ...(input.commandPreview ? { commandPreview: input.commandPreview } : {}),
    createdAt: input.createdAtSeconds,
    updatedAt: input.createdAtSeconds,
    state: "completed",
  };
}

export function buildStatusActivity(input: {
  id: string;
  kind: ChatActivityKind;
  title: string;
  createdAtSeconds: number;
  detail?: string | undefined;
  commandPreview?: string | undefined;
}): ChatActivity {
  return {
    id: input.id,
    itemId: input.id,
    kind: input.kind,
    title: input.title,
    ...(input.detail ? { detail: input.detail } : {}),
    ...(input.commandPreview ? { commandPreview: input.commandPreview } : {}),
    createdAt: input.createdAtSeconds,
    updatedAt: input.createdAtSeconds,
    state: "completed",
  };
}

export function buildLiveCommandActivity(input: {
  itemId: string;
  commandActions?: unknown[];
  commandPreview?: string | undefined;
  createdAtMs: number;
  updatedAtMs?: number;
  state: ChatActivityState;
}): ChatActivity {
  const summary = summarizeCommandActions(input.commandActions ?? []);
  const commandPreview = typeof input.commandPreview === "string"
    ? input.commandPreview.trim()
    : "";

  return {
    id: input.itemId,
    itemId: input.itemId,
    kind: summary.kind,
    title: buildActivityTitle(summary.kind, input.state),
    ...(summary.detail ? { detail: summary.detail } : {}),
    ...(!summary.detail && commandPreview ? { commandPreview } : {}),
    createdAt: Math.floor(input.createdAtMs / 1000),
    updatedAt: Math.floor((input.updatedAtMs ?? input.createdAtMs) / 1000),
    state: input.state,
  };
}

export function mergeChatActivities(...activityLists: ChatActivity[][]): ChatActivity[] {
  const merged = new Map<string, ChatActivity>();

  for (const activities of activityLists) {
    for (const activity of activities) {
      const existing = merged.get(activity.id);
      if (!existing || existing.updatedAt <= activity.updatedAt) {
        merged.set(activity.id, activity);
      }
    }
  }

  return [...merged.values()].sort((left, right) => {
    if (left.createdAt === right.createdAt) {
      return left.id.localeCompare(right.id);
    }
    return left.createdAt - right.createdAt;
  });
}

export function mapApplyPatchPayloadToActivities(
  payload: RolloutResponsePayload,
  createdAtSeconds: number,
  lineIndex: number,
): ChatActivity[] {
  if (
    payload.type !== "custom_tool_call"
    || payload.name !== "apply_patch"
    || typeof payload.input !== "string"
  ) {
    return [];
  }

  const callId = typeof payload.call_id === "string"
    ? payload.call_id
    : `apply_patch_${lineIndex + 1}`;

  return parsePatchFileChanges(payload.input).map((change, index) => ({
    id: `${callId}:${index + 1}:${change.path}`,
    itemId: `${callId}:${change.path}`,
    kind: "file_edited",
    title: buildActivityTitle("file_edited", "completed"),
    detail: change.detail ?? basename(change.path),
    createdAt: createdAtSeconds,
    updatedAt: createdAtSeconds,
    state: "completed",
    filePath: change.path,
    additions: change.additions,
    deletions: change.deletions,
  }));
}

function parsePatchFileChanges(input: string): PatchFileChange[] {
  const changes: PatchFileChange[] = [];
  let current: PatchFileChange | null = null;

  const flush = () => {
    if (!current) {
      return;
    }
    changes.push(current);
    current = null;
  };

  for (const line of input.split("\n")) {
    if (line.startsWith("*** Update File: ")) {
      flush();
      current = {
        path: line.slice("*** Update File: ".length).trim(),
        additions: 0,
        deletions: 0,
      };
      continue;
    }

    if (line.startsWith("*** Add File: ")) {
      flush();
      current = {
        path: line.slice("*** Add File: ".length).trim(),
        additions: 0,
        deletions: 0,
        detail: "Added file",
      };
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      flush();
      changes.push({
        path: line.slice("*** Delete File: ".length).trim(),
        additions: 0,
        deletions: 0,
        detail: "Deleted file",
      });
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("*** Move to: ")) {
      current.detail = `Moved to ${line.slice("*** Move to: ".length).trim()}`;
      continue;
    }

    if (line.startsWith("+++")
      || line.startsWith("---")
      || line.startsWith("@@")
      || line.startsWith("*** End")) {
      continue;
    }

    if (line.startsWith("+")) {
      current.additions += 1;
      continue;
    }

    if (line.startsWith("-")) {
      current.deletions += 1;
    }
  }

  flush();
  return changes;
}
