import type { Request, Response, NextFunction } from "express";

import type { TokenStore } from "../auth/token-store.js";

export function buildAuthMiddleware(tokenStore: TokenStore) {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const header = request.header("authorization");
    if (!header || !header.toLowerCase().startsWith("bearer ")) {
      response.status(401).json({ error: "Missing bearer token" });
      return;
    }

    const token = header.slice("Bearer ".length).trim();
    if (!token) {
      response.status(401).json({ error: "Invalid bearer token" });
      return;
    }

    const device = await tokenStore.validateToken(token);
    if (!device) {
      response.status(401).json({ error: "Invalid token" });
      return;
    }

    response.locals.auth = { deviceId: device.deviceId, token };
    next();
  };
}
