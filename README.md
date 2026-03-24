# Codex Remote iOS

Unofficial, community-maintained project. Not affiliated with OpenAI.

Use your iPhone as a remote control for the local Codex runtime on your Mac.

This project gives you:

- an iPhone chat UI for Codex projects and chats
- a Mac companion service that talks to local `codex app-server`
- QR pairing over your private Tailscale network
- live chat status, approvals, Git context, and OpenAI dictation

## Before you start

This project is built for a private setup.

- Use it on your own Mac
- Use it on your own iPhone
- Keep the companion on a private Tailscale network
- Do not expose the companion directly to the public internet unless you harden it first

## System requirements

You need:

- macOS
- iPhone with iOS 17 or newer
- Node.js 20 or newer
- Codex CLI installed and already authenticated on your Mac
- Tailscale installed and logged in on Mac and iPhone
- Xcode 15 or newer
- `xcodegen` to generate the local Xcode project from `apps/ios/project.yml`

Install `xcodegen` on macOS:

```bash
brew install xcodegen
```

## 5-minute setup

### 1. Clone and install

```bash
git clone <your-repo-url>
cd <your-repo-folder>
npm install
npm run build
```

### 2. Add your OpenAI key for dictation (optional)

If you want the iPhone mic button to use OpenAI transcription, create a local env file:

```bash
cp .env.example .env.local
```

Then edit `.env.local` and add your key:

```env
OPENAI_API_KEY=your_openai_api_key_here
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-transcribe
```

If you do not need dictation yet, you can skip this step.

### 3. Start the Mac companion

```bash
npm run dev:companion
```

For local debug helpers and the closed debug loop:

```bash
npm run dev:debug
```

If Tailscale is installed, the companion will normally bind to your Tailscale IPv4 address by itself.
If you want a different bind host, set `BIND_HOST=...` before launch.

### 4. Generate and open the iPhone project

```bash
npm run ios:open
```

`apps/ios/project.yml` is the source of truth for the shared iPhone project setup.
The generated `apps/ios/CodexRemote.xcodeproj` is local-only and ignored by Git, so your personal signing changes do not pollute the repo.

## Exact Xcode steps

In Xcode:

1. Open `CodexRemote.xcodeproj`
2. Select the `CodexRemote` target
3. Open `Signing & Capabilities`
4. Choose your own Apple team
5. Pick your iPhone as the run destination
6. Press `Run`

If you want to share iPhone project changes with the repo, edit `apps/ios/project.yml` and run `npm run ios:generate`.
Do not rely on direct edits inside the generated `.xcodeproj`, because Git ignores that file on purpose.

The first time, iOS may ask for:

- Microphone permission
- Photo Library permission
- File access permission

## Tailscale setup

You need both devices in the same tailnet.

### On your Mac

1. Install Tailscale
2. Log in
3. Make sure it shows as connected

### On your iPhone

1. Install the Tailscale app
2. Log in with the same tailnet
3. Make sure it shows as connected

## Pair your iPhone with the Mac companion

In a Mac terminal, show the pairing QR:

```bash
cd apps/mac-companion
npm run pairing:show
```

Then on the iPhone:

1. Open the app
2. Scan the QR code
3. Confirm pairing on the Mac

After that, the iPhone can talk to the companion.

## How dictation works

The mic button on iPhone records audio locally.
The audio is then sent to your Mac companion.
The Mac companion sends it to OpenAI transcription with `gpt-4o-transcribe`.
The returned text is inserted into the iPhone composer.

OpenAI says the transcriptions API accepts audio files and that `gpt-4o-transcribe` supports `json` or `text` output in the speech-to-text API docs: [Speech to text](https://developers.openai.com/api/docs/guides/speech-to-text/#transcriptions)

## Common commands

Build shared packages and the companion:

```bash
npm run build
```

Run the companion:

```bash
npm run dev:companion
```

Run the companion with debug endpoints:

```bash
npm run dev:debug
```

Run the closed-loop debug flow:

```bash
npm run debug:loop
```

Install the companion as a LaunchAgent:

```bash
cd apps/mac-companion
npm run install:launchagent
```

## What the app can do today

- browse Codex projects and chats on iPhone
- open saved chat history from local Codex rollout files
- send messages, stop runs, and steer active runs
- show live status cards like thinking, exploring, file edits, and reconnecting
- queue a follow-up while a run is still active
- inspect Git context, branches, diffs, and staged commits
- switch runtime settings like approval mode and sandbox mode
- upload photos and files from iPhone
- use OpenAI dictation from the iPhone mic

## Security notes

This is an MVP for private use.

- Companion access is intended for a private Tailscale network
- By default, the companion binds to your detected Tailscale IPv4 address or to `127.0.0.1` if Tailscale is unavailable
- API routes require a device token after pairing
- Pairing requires confirmation on the Mac
- Device revocation is supported
- HTTP and WebSocket transport are allowed because the default setup assumes a private tailnet, not a public internet deployment

## Public repo note

This repo is open source.
It does **not** include:

- your local `.env` files
- your logs
- your real device tokens
- your personal OpenAI API key

You still need your own:

- Apple signing team in Xcode
- Tailscale setup
- Codex login on the Mac
- OpenAI API key for dictation

## Public release checklist

Before you switch a GitHub repo from private to public:

1. Push to a private repository first.
2. Turn on GitHub Secret Scanning and Push Protection: [GitHub Docs](https://docs.github.com/en/code-security/concepts/secret-security/about-secret-scanning)
3. Double-check that `.env`, logs, device tokens, and local runtime files are still ignored.
4. Then make the repository public.

## More docs

- Mac setup: [docs/setup-mac.md](docs/setup-mac.md)
- API routes: [docs/api.md](docs/api.md)
- Architecture: [docs/architecture.md](docs/architecture.md)
- iPhone UI notes: [apps/ios/README.md](apps/ios/README.md)

## License

MIT
