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

Body:

```json
{
  "cwd": "/Users/example/project"
}
```

The companion remembers the new project immediately so the mobile flow does not race `thread/list`.

### `POST /v1/chats/{chatId}/activate`
Marks a chat as the active session before the iPhone starts streaming or sending follow-up turns.

Response:

```json
{
  "data": {
    "chatId": "...",
    "status": "already_active"
  }
}
```

Supported status values:

- `already_active`
- `resumed`
- `no_rollout`

### `GET /v1/chats/{chatId}/messages`
Returns persisted chat history from local Codex rollout files under `~/.codex/sessions`.

Final assistant answers can include `workedDurationSeconds`, which the iPhone client uses to show a `Worked for …` divider above the final response.

### `GET /v1/chats/{chatId}/timeline`
Returns the mobile chat timeline as:

- persisted rollout messages
- saved commentary history
- live and completed activity cards such as `Explored`, `Command finished`, `Edited file +X -Y`, `Context automatically compacted`, and `Background terminal finished`

Notes:

- `Context automatically compacted` and `Background terminal finished` come from visible Codex rollout history, so they survive chat reloads.
- Mobile reconnect state such as `Reconnecting...` is emitted by the iPhone client while the WebSocket stream retries and does not depend on persisted rollout history.
- WebSocket auth uses the bearer token in the `Authorization` header. The stream URL only carries `chatId`.

### `GET /v1/chats/{chatId}/run-state`
Returns whether the selected chat currently has a running turn and, if available, the active turn id.

Response:

```json
{
  "data": {
    "chatId": "...",
    "isRunning": true,
    "activeTurnId": "turn-123"
  }
}
```

### `POST /v1/dictation/transcribe`
Transcribes recorded iPhone dictation through OpenAI audio transcriptions.

Body:

```json
{
  "audioBase64": "base64-encoded-audio",
  "filename": "dictation.m4a",
  "mimeType": "audio/m4a",
  "language": "de"
}
```

Response:

```json
{
  "data": {
    "text": "Transcribed text",
    "model": "gpt-4o-transcribe"
  }
}
```

Notes:

- The companion reads `OPENAI_API_KEY` from `.env`, `.env.local`, or the process environment.
- `OPENAI_TRANSCRIPTION_MODEL` defaults to `gpt-4o-transcribe`.
- `OPENAI_BASE_URL` defaults to `https://api.openai.com/v1`.

### `POST /v1/chats/{chatId}/messages`
Starts a turn with text input.

Body:

```json
{
  "text": "Please inspect the latest diff."
}
```

Response:

```json
{
  "data": {
    "chatId": "...",
    "turnId": "turn-123"
  }
}
```

### `POST /v1/chats/{chatId}/steer`
Sends immediate follow-up input into the active turn.

Body:

```json
{
  "text": "Search in apps/ios first."
}
```

Notes:

- If the chat still has an active turn, the companion calls Codex `turn/steer`.
- If the run has already ended in the meantime, the companion falls back to a normal `turn/start` so the user does not lose the follow-up.

### `POST /v1/chats/{chatId}/stop`
Interrupts the current active turn.

Response:

```json
{
  "data": {
    "chatId": "...",
    "interrupted": true,
    "turnId": "turn-123"
  }
}
```

### `GET /v1/projects/{projectId}/context`
Returns local Codex runtime context plus Git summary for the selected project.

Response shape:

```json
{
  "data": {
    "projectId": "...",
    "cwd": "/Users/example/project",
    "runtimeMode": "local",
    "approvalPolicy": "on-request",
    "sandboxMode": "workspace-write",
    "model": "gpt-5-codex",
    "modelReasoningEffort": "high",
    "trustLevel": "trusted",
    "git": {
      "isRepository": true,
      "branch": "main",
      "changedFiles": 2,
      "stagedFiles": 1,
      "unstagedFiles": 1,
      "untrackedFiles": 0,
      "changedPaths": []
    }
  }
}
```

### `GET /v1/projects/{projectId}/git/branches`
Returns all local branches in the selected repository.

### `GET /v1/projects/{projectId}/git/diff`
Returns a combined Git diff.

Optional query:

- `path=README.md` for a single file diff

Notes:

- The response includes staged and unstaged patch text.
- Untracked files are listed separately.
- Large patch output is truncated and marked with `truncated: true`.

### `POST /v1/projects/{projectId}/git/checkout`
Checks out an existing local branch.

Body:

```json
{
  "branch": "feature/mobile-shell"
}
```

### `POST /v1/projects/{projectId}/git/commit`
Creates a Git commit from already staged changes.

Body:

```json
{
  "message": "Refine remote mobile shell"
}
```

If nothing is staged, the route returns a `400` error.

### `PATCH /v1/runtime/config`
Updates top-level runtime settings in `~/.codex/config.toml`.

Body:

```json
{
  "approvalPolicy": "on-request",
  "sandboxMode": "workspace-write"
}
```

Supported `approvalPolicy` values:

- `untrusted`
- `on-failure`
- `on-request`
- `never`

Supported `sandboxMode` values:

- `read-only`
- `workspace-write`
- `danger-full-access`

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
