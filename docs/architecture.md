# Architecture

## Components

- **iOS app (SwiftUI):** UI for projects, chats, conversation, approvals, pairing, dictation, and session controls.
- **Mac companion (Node/TypeScript):** Local service that connects to `codex app-server`, reads local Codex/Git state, exposes mobile-safe APIs, and triggers a best-effort sync of the visible Codex Desktop app.
- **Codex app-server:** Local Codex runtime bridge using JSON-RPC over stdio.

## Runtime flow

1. iOS app pairs with companion using QR payload (`codexremote://pair?...`).
2. Companion validates pairing nonce and asks user confirmation on Mac.
3. Companion issues a device token plus the active transport scheme (`http` or `https`).
4. iOS app stores that scheme with the paired host and calls REST APIs with bearer token over the same transport.
5. iOS app derives `ws` or `wss` for the live stream from that stored scheme.
6. iOS app activates a selected chat before follow-up work.
7. Companion remembers the selected chat's project/chat labels and nudges Codex Desktop to select that visible sidebar entry.
8. iOS app loads persisted history from local Codex rollout files, including saved assistant commentary plus tool/search activity rows that mirror the desktop transcript more closely.
9. iOS app also re-hydrates any still-open approval for the selected chat so desktop-first approval prompts are not lost when mobile connects later.
10. iOS app receives streaming updates from `/v1/stream`, including approval-open and approval-cleared events.

## Local state sources

- **Threads/projects:** `codex app-server` `thread/*` APIs
- **Persisted history:** local rollout files in `~/.codex/sessions`
- **Runtime config:** `~/.codex/config.toml`
- **Git context:** direct `git` commands in the selected project working tree

## Desktop sync bridge

The visible Codex Desktop app does not currently expose a direct "open this exact chat in the running UI" API to the companion.

Because of that, the companion now does the best clean thing it can once a real visible chat context exists:

1. remember which workspace belongs to the chat
2. activate the running Codex Desktop app
3. try to select the known project/chat in the visible sidebar, then reveal the latest content

Recommendation: yes, keep this bridge for now, because it reduces restart-only behavior without pretending we already have a true live desktop-session API.
The bridge should not open a workspace over CLI during live sync, because that can create a new empty chat in the visible desktop app instead of keeping the current chat context.

## Mobile control surface

The iPhone app now has four separate control areas:

1. **Drawer:** projects plus chats
2. **Conversation:** full-screen chat view with live stream
3. **Composer dock:** text input, send, and dictation
4. **Session sheet:** runtime settings, Git branch, changed files, diffs, and staged commit flow

Git write actions are intentionally narrow:

- checkout only switches to an existing branch
- commit only uses already staged changes
- diff output is read from the real repository state

Runtime setting writes are also narrow:

- only top-level `approval_policy`
- only top-level `sandbox_mode`
- all other `config.toml` content is preserved

## Security model

- Private network assumption: Tailscale tailnet.
- Device token required for all non-pairing routes.
- Pairing requires local GUI confirmation on Mac.
- Token can be revoked.
- Pairing now carries the companion transport scheme so the iPhone can use `https`/`wss` automatically when the companion is configured with TLS instead of forcing plaintext `http`/`ws`.
- Release iPhone builds now reject plaintext companion pairings and rely on ATS-default transport rules, while Debug builds keep a separate local-development plist that still permits plaintext HTTP for non-TLS companion work.

## Session allow approvals

When user chooses `allow_for_session`, companion marks the chat session as allowed and auto-accepts future approvals for that chat session.

For MCP approvals, the companion now scopes that session allow to the same MCP server/tool fingerprint instead of opening the whole chat to every approval type.

## Always allow approvals

When user chooses `allow_always` for an MCP approval, the companion persists that MCP server/tool fingerprint in a local JSON file next to the device token store and auto-accepts future matching approvals after restart.

## Closed-loop verification

The project now has an end-to-end debug loop that proves the main production path with real artifacts:

1. issue token
2. create chat
3. load context
4. exercise Git routes in a temporary repository
5. round-trip runtime config writes
6. send a real message
7. collect stream events
8. try visible desktop verification through screenshot + OCR

The remaining hard external dependency is the visible desktop proof. That step only passes when the loop runs inside a real logged-in macOS desktop session with Screen Recording and Accessibility/Automation permissions.
