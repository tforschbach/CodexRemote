import { randomUUID } from "node:crypto";

import type { ApprovalKind, ChatActivity } from "@codex-remote/protocol";

export interface PendingApproval {
  approvalId: string;
  jsonRpcId: number | string;
  chatId: string;
  kind: ApprovalKind;
  summary: string;
  createdAt: number;
}

export interface KnownProject {
  id: string;
  cwd: string;
  title: string;
  lastUpdatedAt: number;
}

export interface KnownChat {
  id: string;
  projectId: string;
  cwd: string;
  title: string;
  updatedAt: number;
}

export class SessionState {
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly turnToChat = new Map<string, string>();
  private readonly turnToTrace = new Map<string, string>();
  private readonly activeTurnByChat = new Map<string, string>();
  private readonly sessionAllowChats = new Set<string>();
  private readonly activeChats = new Set<string>();
  private readonly knownProjects = new Map<string, KnownProject>();
  private readonly knownChats = new Map<string, KnownChat>();
  private readonly activitiesByChat = new Map<string, Map<string, ChatActivity>>();

  public createApproval(input: Omit<PendingApproval, "approvalId" | "createdAt">): PendingApproval {
    const pending: PendingApproval = {
      approvalId: randomUUID(),
      createdAt: Date.now(),
      ...input,
    };
    this.pendingApprovals.set(pending.approvalId, pending);
    return pending;
  }

  public popApproval(approvalId: string): PendingApproval | undefined {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      return undefined;
    }
    this.pendingApprovals.delete(approvalId);
    return pending;
  }

  public setTurnChat(turnId: string, chatId: string, traceId?: string): void {
    this.turnToChat.set(turnId, chatId);
    this.activeTurnByChat.set(chatId, turnId);
    this.activeChats.add(chatId);
    if (traceId) {
      this.turnToTrace.set(turnId, traceId);
    }
  }

  public getActiveTurnId(chatId: string): string | undefined {
    return this.activeTurnByChat.get(chatId);
  }

  public clearTurn(turnId: string): void {
    const chatId = this.turnToChat.get(turnId);
    this.turnToChat.delete(turnId);
    this.turnToTrace.delete(turnId);

    if (!chatId) {
      return;
    }

    if (this.activeTurnByChat.get(chatId) === turnId) {
      this.activeTurnByChat.delete(chatId);
      this.activeChats.delete(chatId);
    }
  }

  public clearActiveTurnForChat(chatId: string): void {
    const turnId = this.activeTurnByChat.get(chatId);
    if (turnId) {
      this.turnToTrace.delete(turnId);
    }
    this.activeTurnByChat.delete(chatId);
    this.activeChats.delete(chatId);
  }

  public getChatByTurn(turnId: string): string | undefined {
    return this.turnToChat.get(turnId);
  }

  public getTraceByTurn(turnId: string): string | undefined {
    return this.turnToTrace.get(turnId);
  }

  public enableSessionAllow(chatId: string): void {
    this.sessionAllowChats.add(chatId);
  }

  public isSessionAllowEnabled(chatId: string): boolean {
    return this.sessionAllowChats.has(chatId);
  }

  public markChatActive(chatId: string): void {
    this.activeChats.add(chatId);
  }

  public isChatActive(chatId: string): boolean {
    return this.activeChats.has(chatId);
  }

  public rememberProject(project: KnownProject): void {
    const existing = this.knownProjects.get(project.id);
    if (!existing) {
      this.knownProjects.set(project.id, project);
      return;
    }

    existing.cwd = project.cwd;
    existing.title = project.title;
    existing.lastUpdatedAt = Math.max(existing.lastUpdatedAt, project.lastUpdatedAt);
  }

  public rememberProjects(projects: KnownProject[]): void {
    for (const project of projects) {
      this.rememberProject(project);
    }
  }

  public getKnownProject(projectId: string): KnownProject | undefined {
    return this.knownProjects.get(projectId);
  }

  public listKnownProjects(): KnownProject[] {
    return [...this.knownProjects.values()];
  }

  public rememberChat(chat: KnownChat): void {
    const existing = this.knownChats.get(chat.id);
    if (!existing) {
      this.knownChats.set(chat.id, chat);
      return;
    }

    existing.projectId = chat.projectId;
    existing.cwd = chat.cwd;
    existing.title = chat.title;
    existing.updatedAt = Math.max(existing.updatedAt, chat.updatedAt);
  }

  public rememberChats(chats: KnownChat[]): void {
    for (const chat of chats) {
      this.rememberChat(chat);
    }
  }

  public getKnownChat(chatId: string): KnownChat | undefined {
    return this.knownChats.get(chatId);
  }

  public listKnownChats(): KnownChat[] {
    return [...this.knownChats.values()];
  }

  public upsertChatActivity(chatId: string, activity: ChatActivity): void {
    const activities = this.activitiesByChat.get(chatId) ?? new Map<string, ChatActivity>();
    const existing = activities.get(activity.id);
    if (!existing || existing.updatedAt <= activity.updatedAt) {
      activities.set(activity.id, existing ? {
        ...activity,
        createdAt: existing.createdAt,
      } : activity);
    }
    this.activitiesByChat.set(chatId, activities);
  }

  public removeChatActivity(chatId: string, activityId: string): void {
    const activities = this.activitiesByChat.get(chatId);
    if (!activities) {
      return;
    }

    activities.delete(activityId);
    if (activities.size === 0) {
      this.activitiesByChat.delete(chatId);
    }
  }

  public completeInProgressActivities(chatId: string, updatedAt: number): void {
    const activities = this.activitiesByChat.get(chatId);
    if (!activities) {
      return;
    }

    for (const [activityId, activity] of activities.entries()) {
      if (activity.state !== "in_progress") {
        continue;
      }

      activities.set(activityId, {
        ...activity,
        title: activity.kind === "exploring" ? "Explored" : "Command finished",
        state: "completed",
        updatedAt,
      });
    }
  }

  public listChatActivities(chatId: string): ChatActivity[] {
    const activities = this.activitiesByChat.get(chatId);
    if (!activities) {
      return [];
    }

    return [...activities.values()].sort((left, right) => {
      if (left.createdAt === right.createdAt) {
        return left.id.localeCompare(right.id);
      }
      return left.createdAt - right.createdAt;
    });
  }
}
