import type { StreamEvent } from "@codex-remote/protocol";

import type { ConnectionRegistry } from "./types.js";

export function broadcastEvent(
  connectionsByChat: ConnectionRegistry,
  event: StreamEvent,
): void {
  const sockets = connectionsByChat.get(event.chatId);
  if (!sockets) {
    return;
  }

  const payload = JSON.stringify(event);
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(payload);
    }
  }
}
