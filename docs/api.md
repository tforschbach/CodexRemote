# Companion API (MVP)

## Pairing

### `POST /v1/pairing/request`
Creates a short-lived pairing session and returns `pairingUri` + `qrDataUrl`.

### `POST /v1/pairing/confirm`
Body:

```json
{
  "pairingId": "...",
  "nonce": "...",
  "deviceName": "iPhone"
}
```

Requires local Mac confirmation prompt.

### `POST /v1/pairing/revoke`
Requires bearer token. Revokes current device token or specific device by `deviceId`.

## Data routes (require bearer token)

### `GET /v1/projects`
Returns grouped projects derived from Codex threads.

### `GET /v1/chats?projectId=...`
Returns chats sorted by latest activity.

### `POST /v1/chats`
Creates a new chat thread.

### `POST /v1/chats/{chatId}/messages`
Starts a turn with text input.

### `POST /v1/approvals/{approvalId}`
Body:

```json
{ "decision": "approve" }
```

Supported decisions: `approve`, `decline`, `allow_for_session`.

## Streaming

### `GET /v1/stream?chatId=...`
WebSocket endpoint with events:

- `turn_started`
- `message_delta`
- `item_started`
- `item_completed`
- `approval_required`
- `turn_completed`
- `error`
