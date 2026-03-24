# Setup on macOS

## Prerequisites

- Codex CLI installed and authenticated
- Node.js 20+
- Tailscale connected on Mac
- Xcode 15+
- `xcodegen` installed to generate `apps/ios/CodexRemote.xcodeproj` from `apps/ios/project.yml`

## Install dependencies

```bash
npm install
npm run build
```

## Run companion manually

```bash
npm run dev:companion
```

By default, the companion binds to your detected Tailscale IPv4 address.
If Tailscale is not available, it falls back to `127.0.0.1`.

If you want to override that, set:

- `BIND_HOST=...`

For closed-loop debugging:

```bash
npm run dev:debug
```

## Run as LaunchAgent

```bash
cd apps/mac-companion
npm run install:launchagent
```

Logs are written to `logs/mac-companion.out.log` and `logs/mac-companion.err.log`.
Structured trace logs are written to `logs/companion.ndjson`.

## Build and install the iPhone app

```bash
npm run ios:open
```

`apps/ios/project.yml` is the shared source of truth.
The generated `apps/ios/CodexRemote.xcodeproj` is local-only and ignored by Git so your personal signing and device setup stay out of the repo.

In Xcode:

1. Select the `CodexRemote` target.
2. Set your Apple signing team.
3. Pick your iPhone as the run destination.
4. Press `Play`.

If you need to share iPhone project changes, edit `apps/ios/project.yml` and regenerate the project with `npm run ios:generate`.

The first dictation attempt will ask for:

- Microphone permission

## Closed-loop verification

Start the companion in debug mode first:

```bash
npm run dev:debug
```

Run the end-to-end debug loop:

```bash
npm run debug:loop
```

The loop creates a real chat through the companion, sends a unique message, and verifies through a visible Mac desktop screenshot plus OCR that the Codex desktop app shows that message.

Run this from an active logged-in macOS desktop session. The verification step needs Screen Recording permission plus enough UI automation access to activate the Codex app window.

If the report says `missing_display` or `error of type -10827`, the shell that launched the loop does not have access to the visible desktop session. Re-run it from your normal logged-in Mac desktop.

Use only one active companion while you run the proof loop. If you launch a second companion against the same local Codex runtime, `codex app-server initialize` can time out before the desktop verification starts.

Artifacts are written to `logs/e2e/`.

## What you can test on iPhone now

1. Pair with the Mac companion
2. Open an existing chat with loaded history
3. Send a follow-up message
4. Use the mic button for live dictation
5. Open `Session`
6. Inspect branch, diffs, changed files, and runtime settings
7. Switch to an existing branch
8. Commit already staged changes
9. Change approval policy or sandbox mode

## TLS (optional but recommended)

Set env variables before launch:

- `TLS_KEY_PATH=/path/to/key.pem`
- `TLS_CERT_PATH=/path/to/cert.pem`

With these values configured, companion serves HTTPS/WSS.

## Bind host defaults

- default: detected Tailscale IPv4
- fallback without Tailscale: `127.0.0.1`
- manual override: `BIND_HOST=...`

## OpenAI dictation setup

Set these before you launch the companion if you want iPhone dictation to use OpenAI transcription:

- `OPENAI_API_KEY=...`
- optional `OPENAI_TRANSCRIPTION_MODEL=gpt-4o-transcribe`
- optional `OPENAI_BASE_URL=https://api.openai.com/v1`

You can put them in `.env`, `.env.local`, or your shell environment. The companion reads `.env` and `.env.local` from the repo root automatically.
