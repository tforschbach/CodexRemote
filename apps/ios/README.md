# iOS App

SwiftUI iOS client for Codex Remote.

## UI direction

- Single-chat header that shows only the active chat title
- ChatGPT-style reading layout with compact user bubbles and full-width assistant text
- User and assistant messages expose a small copy icon beneath the bubble or response, aligned to the same side as the message, and tapping it copies the full text with a light iPhone haptic plus a very short tint flash on the icon
- Desktop-style final answers with a `Worked for …` divider, body-sized bold text, flattened heading sizes, better Markdown spacing, blue links, and inline code highlights for easier reading on iPhone
- Minimal composer with a slimmer ChatGPT-like row, 14 pt input and placeholder text, matched 40 pt outer controls, tighter and more even internal spacing, a plus-anchored attachment popover for photos/files, including PDF and CSV uploads, a smaller inline mic that stays pinned to the bottom-right even when the draft grows to multiple lines, plus and trailing send/stop controls that stay aligned with the bottom edge once the draft expands, swipe-down keyboard dismissal near the composer, and a bounded multi-line input that starts scrolling instead of turning into a tall bubble
- While dictation is recording, the composer replaces the idle placeholder with a live timer and a small waveform, keeps the field compact even if the draft already contains text, keeps that waveform visually centered instead of dropping it to the bottom edge, and lets the user stop by tapping anywhere in that status area; after stop, it briefly shows a short transcribing state until the text lands in the draft
- While a Codex run is active, the trailing control becomes a stop button until the user starts typing; with a draft present, the arrow queues the follow-up for after the run and `Steer` sends it immediately into the active turn
- Dictation records audio on iPhone and sends it through the Mac companion to OpenAI `gpt-4o-transcribe` instead of using local iOS speech recognition
- Live status feed in the chat transcript for saved commentary history, persisted `Explored …` and `Command finished` lines, desktop-style `Edited … +X -Y` file rows, `Context automatically compacted`, `Background terminal finished`, and mobile reconnect status while the stream recovers
- Session and refresh actions moved into menus instead of always-visible chips
- Edge-aligned sidebar with ChatGPT-style search/new-chat controls and Codex-style expandable project folders
- On iPhone, tapping any project folder header only expands or collapses its chats; it never auto-opens the first chat for that project
- On iPhone, the app stays locked to portrait instead of rotating into landscape
- Opening another chat jumps back to the latest message, even when a different chat is still running in the background
- Switching away from a running chat drops stale stream callbacks so the newly opened chat stays responsive
- Session view keeps a bounded on-device debug log in `Caches`, runs in `Basic` mode by default, offers a temporary `Verbose` mode for stream and hydration debugging, and can export or copy the latest log into `logs/ios-device.ndjson` on the paired Mac companion either manually or through an explicit auto-send toggle
- Background refresh no longer re-hydrates the already open chat while its live stream is still attached
- When the app moves to the iPhone background, it now pauses polling, hydration, and the live stream instead of continuing network work off-screen; when the app becomes active again, it performs one refresh and resumes only the live work that is still needed
- While a chat is already open and loaded on iPhone, the 15-second polling loop no longer does a full project refresh every time; live chats skip those full refreshes, idle chats fall back to light run-state checks, and a full refresh only returns occasionally to keep the sidebar in sync
- Creating a new chat keeps that new thread selected even if the chat list refresh arrives late, and a brand-new empty thread stays open if run-state is not ready yet
- Duplicate project titles collapse into one sidebar folder so one workspace does not show up five times
- Very large chats now show a recent timeline window first on iPhone instead of trying to render the full history during chat switches, which keeps the app responsive while you move between threads
- Large live chats avoid rewriting the visible transcript when only background item counts change, which reduces white flashes while Codex is still thinking
- Large live chats also defer sideband activity timeline merges while the stream is still attached, so the visible transcript stays stable until the turn finishes and the full timeline can reload once
- The compact iPhone sidebar can now open with a right swipe and close with a left swipe, so one-handed navigation no longer depends on reaching the top-left button
- Tapping the compact mic while the keyboard is open now flips the composer into recording mode before the keyboard animation finishes, so the waveform button no longer lags behind and drops late
- Dark mode uses a solid dark canvas instead of a light gradient

## Local development

```bash
npm run ios:open
```

`apps/ios/project.yml` is the shared source of truth.
The generated `CodexRemote.xcodeproj` is local-only and ignored by Git.
If you change `apps/ios/project.yml`, regenerate the project first:

```bash
npm run ios:generate
```

If you make project-level changes in Xcode that should be shared, move them back into `apps/ios/project.yml`.

## Pairing flow

1. Start the Mac companion service.
2. Create a pairing request (`POST /v1/pairing/request`) from a local UI/script.
3. Render the returned `pairingUri` as a QR code on Mac.
4. Scan from the iOS app and confirm pairing on Mac.
