# Architecture

## Components

- **iOS app (SwiftUI):** UI for projects, chats, conversation, approvals, pairing.
- **Mac companion (Node/TypeScript):** Local service that connects to `codex app-server` and exposes mobile-safe APIs.
- **Codex app-server:** Local Codex runtime bridge using JSON-RPC over stdio.

## Runtime flow

1. iOS app pairs with companion using QR payload (`codexremote://pair?...`).
2. Companion validates pairing nonce and asks user confirmation on Mac.
3. Companion issues a device token.
4. iOS app calls REST APIs with bearer token.
5. iOS app receives streaming updates from `/v1/stream`.

## Security model

- Private network assumption: Tailscale tailnet.
- Device token required for all non-pairing routes.
- Pairing requires local GUI confirmation on Mac.
- Token can be revoked.

## Session allow approvals

When user chooses `allow_for_session`, companion marks the chat session as allowed and auto-accepts future approvals for that chat session.
