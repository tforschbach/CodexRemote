import type { WebSocket } from "ws";

export interface AuthedRequestContext {
  deviceId: string;
  token: string;
}

export type ConnectionRegistry = Map<string, Set<WebSocket>>;
