# Security Policy

## Reporting a vulnerability

Please do not open public issues for sensitive vulnerabilities.

Report privately by email to `thomas@thomas-forschbach.com` with:
- Impact summary
- Reproduction steps
- Affected versions/commit
- Suggested mitigation (if known)

## Security boundaries (MVP)

- Companion service is intended to run on trusted personal Mac devices.
- Network access should be restricted to your Tailscale tailnet.
- Pairing requires local on-Mac confirmation.
- Auth tokens are device-bound and revocable.
