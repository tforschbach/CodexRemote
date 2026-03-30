# Changelog

All notable changes to this project will be documented in this file.

## [0.1.1] - 2026-03-30

### Fixed

- Stabilized iPhone chat switching so stale hydration and stream callbacks do not take over the newly opened chat.
- Kept new chats selected even when the refreshed chat list arrives late, so empty threads stay usable while run state catches up.
- Reduced heavy iPhone refresh work during an already loaded active chat by favoring lightweight run-state checks over repeated full refreshes.
- Added bounded iPhone debug logging with companion upload support to make long-loading and stream issues easier to reproduce and inspect.

### Changed

- Refined the iPhone chat UI, composer, sidebar, and dictation flow so active runs, attachments, and multi-line drafts feel more stable in daily use.
- Expanded iPhone and companion tests plus the iOS docs to cover the new mobile refresh, hydration, debug-log, and desktop-sync behavior.
