# Mac Companion

Local bridge service that exposes a mobile-safe API on top of local `codex app-server`.

## Commands

```bash
npm run dev
npm run build
npm run start
npm run pairing:show
npm run install:launchagent
npm run uninstall:launchagent
```

## Environment

- `PORT` (default `8787`)
- `BIND_HOST` (default `0.0.0.0`)
- `TAILSCALE_HOST` (used in pairing URI)
- `CODEX_COMMAND` (default `codex`)
- `TOKEN_STORE_PATH` (default `~/.codex-remote/devices.json`)
- `TLS_KEY_PATH` (optional)
- `TLS_CERT_PATH` (optional)
