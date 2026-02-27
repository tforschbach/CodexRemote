# iOS App

SwiftUI iOS client for Codex Remote.

## Local development

```bash
brew install xcodegen
xcodegen generate
open CodexRemote.xcodeproj
```

## Pairing flow

1. Start the Mac companion service.
2. Create a pairing request (`POST /v1/pairing/request`) from a local UI/script.
3. Render the returned `pairingUri` as a QR code on Mac.
4. Scan from the iOS app and confirm pairing on Mac.
