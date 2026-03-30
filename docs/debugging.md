# Closed-loop Debugging

## Goal

Codex Remote should be debuggable without guessing. Every important action should leave evidence in logs and, for desktop verification, in visible UI artifacts.

## Logs

- `logs/companion.ndjson`: structured NDJSON trace log for companion HTTP, WebSocket, and JSON-RPC traffic. It keeps technical metadata only and should not store user message bodies or dictation transcripts.
- `logs/ios-device.ndjson`: latest uploaded iPhone debug log copied from the iOS app Session view
- `logs/mac-companion.out.log`: stdout from the LaunchAgent/manual process
- `logs/mac-companion.err.log`: stderr from the LaunchAgent/manual process
- `logs/e2e/`: debug-loop JSON reports, screenshots, and desktop verification reports

The companion trace log now also includes desktop sync events:

- `desktop_sync_started`
- `desktop_sync_completed`
- `desktop_sync_failed`

## One-command loop

Start the companion in debug mode first:

```bash
npm run dev:debug
```

```bash
npm run debug:loop
```

Run the loop from an active logged-in macOS desktop session. The desktop verification step needs macOS screen capture access and enough UI automation permission to bring Codex to the front.

The loop does the following:

1. Issues a local debug device token.
2. Calls the live companion API.
3. Creates a real chat for the Git exercise.
4. Creates a temporary Git workspace under `/tmp` by default.
5. Loads project context, branches, combined diff, and file diff through the companion.
6. Checks out an existing branch and creates a real commit from staged changes.
7. Round-trips the current runtime config values through `PATCH /v1/runtime/config`.
8. Creates a second real chat in the selected visible project when the Git exercise runs in a temp workspace.
9. Sends a unique debug message to the visible-project chat.
10. Waits for WebSocket events.
11. Activates the Codex desktop app.
12. Brings the visible Codex window to the latest part of the current chat.
13. Takes a screenshot.
14. OCR-checks that the unique text is visibly present in the desktop UI.
15. Confirms that the exact unique user message was persisted into the matching Codex rollout file under `~/.codex/sessions`.
16. Writes a report to `logs/e2e/`.

This split is intentional:

- Git mutation checks run in a temporary workspace so the debug loop does not touch your real repository.
- The desktop visibility proof runs in the real project that matches the current repo cwd by default.
- When that project already has chats, the loop reuses the newest chat there instead of jumping to an unrelated project.

If screenshot capture or OCR setup fails, the attempt report now includes a failure stage plus a short diagnosis so you can tell environment problems apart from companion regressions.
If the final desktop verifier process itself hangs, the debug loop now kills that process after a fixed timeout and still writes the main `debug-loop-*.json` report.
By default, the loop now passes on the strongest deterministic proof this repo controls:

- stream events came back from the real companion path
- the target Codex rollout file exists
- the exact unique user message is present in that rollout

The visible desktop OCR check is still captured in every report, but it is advisory by default because the current Codex desktop app does not always live-refresh external chat writes into the visible sidebar.

## Useful environment variables

- `COMPANION_URL=http://127.0.0.1:8787`
- `COMPANION_ENABLE_DEBUG_ENDPOINTS=1`
- `DEBUG_PROJECT_ID=...`
- `DEBUG_PROJECT_MATCH=codex mobile app`
- `DEBUG_MESSAGE=...`
- `DEBUG_TIMEOUT_MS=20000`
- `DEBUG_USE_TEMP_GIT_WORKSPACE=1`
- `CODEX_MAC_APP_NAME=Codex`
- `CODEX_MAC_APP_PATH=/Applications/Codex.app`
- `CODEX_MAC_BUNDLE_ID=com.openai.codex`
- `CODEX_DESKTOP_SYNC_ENABLED=1`
- `CODEX_DESKTOP_SYNC_DELAY_MS=250`
- `CODEX_DESKTOP_SYNC_COMMAND_TIMEOUT_MS=5000`
- `DESKTOP_VERIFY_DELAY_MS=1800`
- `DESKTOP_VERIFY_COMMAND_TIMEOUT_MS=15000`
- `ROLLOUT_VERIFY_TIMEOUT_MS=5000`
- `DEBUG_REQUIRE_VISIBLE_UI=1`
- `COMPANION_TRACE_LOG_LEVEL=debug`
- `CODEX_START_TIMEOUT_MS=15000`

If LaunchServices is flaky on the Mac, set `CODEX_MAC_APP_PATH` so desktop verification can fall back to the bundle path and executable instead of relying only on the app name.
If the app is not under `/Applications`, the verifier also tries `~/Applications` and Spotlight discovery.
If a desktop helper command hangs, the companion now times that command out and records the timeout in `desktop_sync_completed.errors` instead of waiting forever without a closing sync event.
`desktop_sync_completed.selectionStatus` now tells you whether the bridge reached the chat through the desktop deeplink (`deeplink_opened_chat`), only selected it normally (`selected_chat`), or reached it again after a window reload (`reload_selected_chat`).

## Trace correlation

The companion sets and propagates `x-codex-trace-id`. The same trace id appears in:

- HTTP request start/completion entries
- JSON-RPC requests to `codex app-server`
- WebSocket broadcast entries
- debug-loop reports

## Chat activation

Before the iPhone treats a selected chat as live, it calls `POST /v1/chats/{chatId}/activate`.

- `already_active`: the current companion session already has that chat active
- `resumed`: `thread/resume` succeeded
- `no_rollout`: Codex did not have a rollout to resume, so the client can stay stable without guessing

After chat activate and message send, the companion now also runs a best-effort desktop sync:

1. remember the chat's workspace path and visible labels from `thread/list` or `thread/start`
2. activate Codex Desktop
3. open the running desktop app directly on the known chat through `codex://threads/<chatId>`
4. reveal the latest content in the active chat
5. if the deep link cannot be opened, fall back to the known project/chat selection in the visible sidebar
6. if that still looks stale, reload the front window and try the selection once more

This is not a perfect session bridge yet. It is the cleanest current bridge because Codex Desktop does not expose a direct "show this chat now" API to the companion.
The bridge intentionally does not call `codex app <workspace>` anymore, because that could open a fresh empty chat in the right project instead of showing the already active chat.
The generated AppleScript is now compile-checked in the macOS test suite so parser errors fail fast before another manual Ghostty run.
The desktop refresh script now prefers the left-most matching UI element, so Codex clicks the sidebar entry instead of a same-named heading in the main pane.
The live-sync path now prefers a real Codex desktop deep link over sidebar clicking, because the installed Codex app supports `codex://threads/<conversationId>` and that is the closest thing to a native "show this conversation now" entry point.
After a `message_sent` sync, the bridge now also sends a short repeated "scroll to bottom" step so the newest message becomes visible in the already opened chat pane instead of staying above the fold.
When the deep link cannot be opened, the bridge falls back to the old non-destructive sidebar path: normal selection first, then a brief hop to another known sidebar chat and back, and only then a front-window reload. This is intentional: quitting Codex interrupts local threads, so the live-sync path now stays non-destructive even when the visible chat pane goes stale.
If you need the debug loop to fail on a missed visible UI match again, set `DEBUG_REQUIRE_VISIBLE_UI=1`.

## Chat history

When the iPhone opens an existing chat, it now calls `GET /v1/chats/{chatId}/messages`.

- Source of truth: local Codex rollout files in `~/.codex/sessions`
- User messages come from persisted `event_msg.user_message` entries
- Assistant history comes from persisted `response_item.message` entries with `role=assistant` and `phase=final_answer`

This keeps the mobile chat history on the same local data basis as the desktop app instead of rebuilding history from only the live stream.

## Git and runtime control evidence

The debug loop now proves these write flows too:

- `GET /v1/projects/:projectId/git/branches`
- `GET /v1/projects/:projectId/git/diff`
- `POST /v1/projects/:projectId/git/checkout`
- `POST /v1/projects/:projectId/git/commit`
- `PATCH /v1/runtime/config`

The report stores previews of the diff output, the checked-out branch, the commit hash, and the runtime config round-trip result.

## Desktop proof requirements

For the visible desktop verification to be a real proof instead of a best effort, all of these must be true at the same time:

1. The debug loop must run inside a real logged-in macOS desktop session.
2. The process that launches `npm run debug:loop` must have Screen Recording permission.
3. That same process must have enough Accessibility or Automation permission to activate Codex.app.
4. Codex.app must already be running and visible in that same user session.
5. Only one companion should own the local `codex app-server` startup path during the proof run.

If a second companion starts while another Codex runtime is already active, `initialize` can time out before the loop even reaches the visible UI checks. In that case, stop the extra companion process and retry with a single active companion.

## How to read a desktop failure quickly

- `screen_recording_permission`: the process cannot capture the screen
- `automation_permission`: the process cannot automate the UI
- `missing_display`: the process does not have access to the live desktop session

If you see `missing_display` together with `error of type -10827`, the loop is almost certainly running outside the real logged-in desktop session or without access to that session.
