# Codex Remote iOS

Codex Remote iOS is an open-source project that lets you remotely control your local Codex runtime on your Mac from your iPhone.

## What this MVP includes

- iOS app with a chat-focused UI (projects + chats + active conversation)
- Mac companion service (Node/TypeScript)
- Bridge to local `codex app-server`
- QR-based pairing with on-Mac confirmation
- Token-based authentication for API and streaming
- Approvals flow (`approve`, `decline`, `allow_for_session`)

## Architecture

- `apps/mac-companion`: Local bridge service on your Mac
- `apps/ios`: SwiftUI iOS app
- `packages/protocol`: Shared API contracts for companion service
- `docs`: Setup and architecture documentation

## Quick start (development)

1. Install prerequisites on macOS:
- Node.js 20+
- Codex CLI installed and authenticated
- Tailscale installed and logged in
- Xcode 15+
- `xcodegen` (`brew install xcodegen`)

2. Install dependencies:

```bash
npm install
```

3. Build protocol + companion:

```bash
npm run build
```

4. Run the companion service:

```bash
npm run dev:companion
```

5. Show a pairing QR on your Mac:

```bash
cd apps/mac-companion
npm run pairing:show
```

6. Generate iOS project:

```bash
cd apps/ios
xcodegen generate
open CodexRemote.xcodeproj
```

## LaunchAgent install (auto-start on login)

```bash
cd apps/mac-companion
npm run install:launchagent
```

## Security model (MVP)

- Access intended for private Tailscale network only
- App token required for all non-pairing APIs
- Pairing requires local Mac confirmation dialog
- Device revocation supported (`/v1/pairing/revoke`)

## License

MIT
