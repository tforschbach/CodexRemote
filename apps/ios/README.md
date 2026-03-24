# iOS App

SwiftUI iOS client for Codex Remote.

## UI direction

- Single-chat header that shows only the active chat title
- ChatGPT-style reading layout with compact user bubbles and full-width assistant text
- Desktop-style final answers with a `Worked for …` divider, body-sized bold text, flattened heading sizes, better Markdown spacing, blue links, and inline code highlights for easier reading on iPhone
- Minimal composer with a slimmer ChatGPT-like row, a plus-anchored attachment popover for photos/files, including PDF and CSV uploads, an inline mic, a trailing send arrow, swipe-down keyboard dismissal near the composer, and a bounded multi-line input that starts scrolling instead of turning into a tall bubble
- While a Codex run is active, the trailing control becomes a stop button until the user starts typing; with a draft present, the arrow queues the follow-up for after the run and `Steer` sends it immediately into the active turn
- Dictation records audio on iPhone and sends it through the Mac companion to OpenAI `gpt-4o-transcribe` instead of using local iOS speech recognition
- Live status feed in the chat transcript for saved commentary history, persisted `Explored …` and `Command finished` lines, desktop-style `Edited … +X -Y` file rows, `Context automatically compacted`, `Background terminal finished`, and mobile reconnect status while the stream recovers
- Session and refresh actions moved into menus instead of always-visible chips
- Edge-aligned sidebar with ChatGPT-style search/new-chat controls and Codex-style expandable project folders
- Duplicate project titles collapse into one sidebar folder so one workspace does not show up five times
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
