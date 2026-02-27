import { randomBytes, randomUUID } from "node:crypto";

export interface PairingSession {
  pairingId: string;
  nonce: string;
  expiresAt: number;
}

export class PairingStore {
  private readonly ttlMs: number;
  private readonly sessions = new Map<string, PairingSession>();

  public constructor(ttlSeconds: number) {
    this.ttlMs = ttlSeconds * 1000;
  }

  public createSession(): PairingSession {
    const session: PairingSession = {
      pairingId: randomUUID(),
      nonce: randomBytes(16).toString("hex"),
      expiresAt: Date.now() + this.ttlMs,
    };
    this.sessions.set(session.pairingId, session);
    return session;
  }

  public consumeSession(pairingId: string, nonce: string): PairingSession | null {
    this.cleanupExpired();
    const session = this.sessions.get(pairingId);
    if (!session) {
      return null;
    }
    if (session.expiresAt < Date.now() || session.nonce !== nonce) {
      return null;
    }
    this.sessions.delete(pairingId);
    return session;
  }

  public cleanupExpired(): void {
    const now = Date.now();
    for (const [pairingId, session] of this.sessions.entries()) {
      if (session.expiresAt <= now) {
        this.sessions.delete(pairingId);
      }
    }
  }
}
