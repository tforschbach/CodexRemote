import { randomUUID } from "node:crypto";

import type { ApprovalKind } from "@codex-remote/protocol";

export interface PendingApproval {
  approvalId: string;
  jsonRpcId: number | string;
  chatId: string;
  kind: ApprovalKind;
  summary: string;
  createdAt: number;
}

export class SessionState {
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly turnToChat = new Map<string, string>();
  private readonly sessionAllowChats = new Set<string>();

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

  public setTurnChat(turnId: string, chatId: string): void {
    this.turnToChat.set(turnId, chatId);
  }

  public getChatByTurn(turnId: string): string | undefined {
    return this.turnToChat.get(turnId);
  }

  public enableSessionAllow(chatId: string): void {
    this.sessionAllowChats.add(chatId);
  }

  public isSessionAllowEnabled(chatId: string): boolean {
    return this.sessionAllowChats.has(chatId);
  }
}
