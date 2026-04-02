# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]
## [0.1.6] - 2026-04-02

### Fixed

- Split the iPhone ATS settings by build type so Release now uses the default App Transport Security policy, rejects plaintext companion pairings, and clears old insecure pairings instead of continuing over `http`/`ws`.
- Mobile assistant commentary now renders Markdown emphasis like the desktop transcript instead of showing literal `**` markers, and saved rollout history now includes web-search plus MCP tool-call activity lines that were previously missing on iPhone.
- Open approvals are now re-hydrated for the active iPhone chat even when the approval first appeared on desktop, and they clear again once the companion sees the turn continue after that approval is handled elsewhere.
- New iPhone builds now treat a missing `pending-approval` route on older Mac companion builds as "no open approval" instead of failing chat hydration with a `404`.
- The Mac companion now keeps `/v1/chats` aligned with the remembered project list, so iPhone startup can still re-open a known project chat even when the current `thread/list` window no longer includes that project.
- Fixed iPhone query-based API requests so project-filtered chat loads and Git diff requests now send real URL query items instead of folding `?projectId=...` or `?path=...` into the path and triggering companion `404`s.

## [0.1.5] - 2026-04-02

### Changed

- Replaced the iPhone approval sheet with a compact inline approval step inside the active chat transcript, including a scope dropdown on the left and `Cancel`/`Approve` actions on the right so approvals no longer cover the full screen.

### Fixed

- Pairing now carries the companion transport scheme and the iPhone client now uses `https`/`wss` automatically when the Mac companion is running with TLS, so bearer tokens are no longer forced onto plaintext transport whenever secure transport is available.
- Hardened MCP approval param parsing in the Mac companion so deeply nested or cyclic payloads no longer recurse without limits and take down the approval flow.

## [0.1.4] - 2026-04-02

### Added

- Added MCP approval support on iPhone so mobile now surfaces server access prompts from the Mac companion with `Allow once`, `Allow for this chat`, `Always Allow`, and `Cancel`.

### Changed

- Scoped mobile MCP auto-allow decisions to the matching server/tool fingerprint and persisted `Always Allow` choices on the Mac companion so they survive restarts.

## [0.1.3] - 2026-04-01

### Fixed

- Stopped large iPhone chats from rewriting the visible transcript when only background timeline counts changed, which reduces white flashes while a response is still running.
- Deferred sideband timeline merges for already-trimmed live iPhone chats until the turn ends, which keeps the visible transcript from flashing white while Codex is still thinking.
- Made the composer mic switch into recording mode before the keyboard finishes dismissing, so the waveform control no longer lags behind the tap.

### Changed

- Added right-swipe open and left-swipe close gestures for the compact iPhone sidebar so one-handed navigation does not depend on the top-left menu button.

## [0.1.2] - 2026-04-01

### Fixed

- Bounded iPhone chat hydration to a recent timeline window for very large threads and stopped stale chat hydrations from applying after the user already switched away, which reduces freezes and restarts during rapid chat switching.

## [0.1.1] - 2026-03-30

### Fixed

- Stabilized iPhone chat switching so stale hydration and stream callbacks do not take over the newly opened chat.
- Kept new chats selected even when the refreshed chat list arrives late, so empty threads stay usable while run state catches up.
- Reduced heavy iPhone refresh work during an already loaded active chat by favoring lightweight run-state checks over repeated full refreshes.
- Added bounded iPhone debug logging with companion upload support to make long-loading and stream issues easier to reproduce and inspect.

### Changed

- Refined the iPhone chat UI, composer, sidebar, and dictation flow so active runs, attachments, and multi-line drafts feel more stable in daily use.
- Expanded iPhone and companion tests plus the iOS docs to cover the new mobile refresh, hydration, debug-log, and desktop-sync behavior.
