#!/usr/bin/env node
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function resolveHostCandidates() {
  const candidates = [
    process.env.BIND_HOST,
    process.env.TAILSCALE_BIND_HOST,
    process.env.TAILSCALE_HOST,
  ].filter(Boolean);

  try {
    const { stdout } = await execFileAsync('/Applications/Tailscale.app/Contents/MacOS/Tailscale', ['ip', '-4']);
    const ip = stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (ip) {
      candidates.push(ip);
    }
  } catch {
    try {
      const { stdout } = await execFileAsync('tailscale', ['ip', '-4']);
      const ip = stdout
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (ip) {
        candidates.push(ip);
      }
    } catch {
      // Fall back to localhost below.
    }
  }

  candidates.push('127.0.0.1', 'localhost');
  return [...new Set(candidates)];
}

async function requestPairing(port) {
  const hostCandidates = await resolveHostCandidates();

  let lastError;
  for (const host of hostCandidates) {
    try {
      const response = await fetch(`http://${host}:${port}/v1/pairing/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });

      if (!response.ok) {
        lastError = new Error(`Failed to create pairing request from ${host}: ${response.status}`);
        continue;
      }

      return await response.json();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error('Failed to reach the companion on any expected host.');
}

async function main() {
  const port = Number.parseInt(process.env.PORT ?? '8787', 10);
  const payload = await requestPairing(port);
  const dir = await mkdtemp(join(tmpdir(), 'codex-remote-pairing-'));
  const htmlPath = join(dir, 'pairing.html');

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Codex Remote Pairing</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 24px; }
      img { width: 320px; height: 320px; border: 1px solid #ddd; border-radius: 8px; }
      code { display: block; margin-top: 16px; padding: 12px; background: #f5f5f5; border-radius: 8px; word-break: break-all; }
    </style>
  </head>
  <body>
    <h1>Codex Remote Pairing</h1>
    <p>Scan this QR code with the iOS app.</p>
    <img src="${payload.qrDataUrl}" alt="Pairing QR" />
    <code>${payload.pairingUri}</code>
  </body>
</html>`;

  await writeFile(htmlPath, html, 'utf8');
  await execFileAsync('open', [htmlPath]);

  // eslint-disable-next-line no-console
  console.log(`Pairing page opened: ${htmlPath}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
