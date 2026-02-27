import { basename } from "node:path";

import type { ChatThread, Project } from "@codex-remote/protocol";

import { shortHash } from "../utils/hash.js";

interface RawThread {
  id: string;
  preview?: string;
  name?: string;
  cwd?: string;
  updatedAt?: number;
  createdAt?: number;
}

export function mapRawThread(raw: RawThread): ChatThread {
  const cwd = raw.cwd ?? "unknown";
  const projectId = shortHash(cwd);
  return {
    id: raw.id,
    projectId,
    title: raw.name ?? raw.preview ?? "Untitled chat",
    preview: raw.preview ?? "",
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
