# Contributing

Thanks for contributing to Codex Remote iOS.

## Development workflow

1. Create a branch.
2. Keep changes focused and small.
3. Add or update tests for behavior changes.
4. Update docs for user-visible changes.
5. Run local checks:

```bash
npm run lint
npm run build
npm test
```

## Pull request expectations

- Describe the problem and solution clearly.
- Include screenshots for iOS UI changes.
- List test coverage for changed behavior.

## Code style

- TypeScript strict mode in companion/protocol packages
- Swift style aligned with SwiftLint defaults (if installed)
- English for user-facing app text and docs
- For shared iOS project setup, edit `apps/ios/project.yml`; the generated `apps/ios/CodexRemote.xcodeproj` is local-only and ignored by Git
