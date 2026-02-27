# Setup on macOS

## Prerequisites

- Codex CLI installed and authenticated
- Node.js 20+
- Tailscale connected on Mac

## Install dependencies

```bash
npm install
npm run build
```

## Run companion manually

```bash
npm run dev:companion
```

## Run as LaunchAgent

```bash
cd apps/mac-companion
npm run install:launchagent
```

Logs are written to `logs/mac-companion.out.log` and `logs/mac-companion.err.log`.

## TLS (optional but recommended)

Set env variables before launch:

- `TLS_KEY_PATH=/path/to/key.pem`
- `TLS_CERT_PATH=/path/to/cert.pem`

With these values configured, companion serves HTTPS/WSS.
