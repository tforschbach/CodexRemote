import { basename } from "node:path";

import type { ChatThread, Project } from "@codex-remote/protocol";

import type { KnownChat } from "../state/session-state.js";
import { shortHash } from "../utils/hash.js";

export interface RawThread {
  id: string;
  preview?: string;
  name?: string;
  cwd?: string;
  updatedAt?: number;
  createdAt?: number;
}

function resolveThreadTitle(raw: Pick<RawThread, "name" | "preview">): string {
  const normalizedName = raw.name?.trim();
  if (normalizedName) {
    return normalizedName;
  }

  const normalizedPreview = raw.preview?.trim();
  if (normalizedPreview) {
    return normalizedPreview;
  }

  return "Untitled chat";
}

export function mapRawThread(raw: RawThread): ChatThread {
  const cwd = raw.cwd ?? "unknown";
  const projectId = shortHash(cwd);
  return {
    id: raw.id,
    projectId,
    title: resolveThreadTitle(raw),
    preview: raw.preview ?? "",
    updatedAt: raw.updatedAt ?? raw.createdAt ?? Date.now(),
  };
}

export function mapRawThreadToKnownChat(raw: RawThread): KnownChat {
  const cwd = raw.cwd ?? "unknown";
  const projectId = shortHash(cwd);
  return {
    id: raw.id,
    projectId,
    cwd,
    title: resolveThreadTitle(raw),
    updatedAt: raw.updatedAt ?? raw.createdAt ?? Date.now(),
  };
}

export function buildProjectsFromThreads(threads: Array<RawThread>): Project[] {
  const grouped = new Map<string, Project>();

  for (const thread of threads) {
    const cwd = thread.cwd ?? "unknown";
    const id = shortHash(cwd);
    const existing = grouped.get(id);
    const updatedAt = thread.updatedAt ?? thread.createdAt ?? Date.now();

    if (!existing) {
      grouped.set(id, {
        id,
        cwd,
        title: cwd === "unknown" ? "No Project" : basename(cwd),
        lastUpdatedAt: updatedAt,
      });
      continue;
    }

    existing.lastUpdatedAt = Math.max(existing.lastUpdatedAt, updatedAt);
  }

  return [...grouped.values()].sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt);
}
